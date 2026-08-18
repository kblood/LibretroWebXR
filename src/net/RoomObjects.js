// RoomObjects: the client-side registry of shared room-object state (M0.5) —
// arbitrary key→value entries that everyone in the room agrees on, e.g.
// `tv` → the loaded game descriptor, or `hold:<cartId>` → who holds a cart.
// Pure bookkeeping (no THREE / no socket), mirroring [[src/net/PresenceState.js]]:
// all the "what's the shared state" logic lives here and is unit-tested;
// [[src/net/NetMgr.js]] feeds it decoded STATE messages and fans changes out to
// the scene via a callback.
//
// Last-writer-wins: each key holds the most recent { value, id } (id = the peer
// that set it, stamped by the server). A `value` of null clears the key. The
// server persists the same map per room and replays it to late joiners, so a
// peer that walks in mid-session converges to the same state.

import { MSG } from './NetProtocol.js';

// How many values sameStateValue() will look at before it gives up and answers
// "different". STATE values are small by construction — a hold is
// { holder, hand }, a prop is a transform, the biggest realistic one is a room
// descriptor — but the server admits values up to 256 KiB (server/Hub.js), and
// this compare runs on the render thread for every STATE message a peer sends
// (up to 600/s per socket). A budget makes the worst case O(budget) instead of
// O(payload): past it we report "changed", which is the SAFE answer (consumers
// re-apply idempotently; the only cost is one extra reconcile). Sized well above
// anything this app sends and well below what a peer can make us walk.
const COMPARE_BUDGET = 2048;

/**
 * Cheap structural equality for STATE values, replacing a pair of
 * JSON.stringify() calls per applied message (PERF-4(b), second half): two full
 * serialisations of a peer-supplied value, allocated and thrown away on the XR
 * render thread, is a peer-reachable main-thread burn — and the strings were
 * only ever compared, never kept.
 *
 * Deliberately NOT a general deep-equal: it answers "changed" for anything it
 * cannot decide cheaply (over budget, exotic objects), which is the safe way to
 * be wrong. Two knowing divergences from the JSON compare, neither of which can
 * hide a real update:
 *   • it reports CHANGED where JSON said no-op — `{a: undefined}` vs `{}`, or
 *     NaN vs null (JSON serialised both to "null"). Costs one extra reconcile.
 *   • it reports UNCHANGED for a pure key REORDER, which JSON called a change.
 *     The stored value is identical, so there is nothing for a consumer to see.
 */
function sameStateValue(a, b, budget = { n: COMPARE_BUDGET }) {
  // Charged BEFORE the identity check: an array of ten thousand equal numbers
  // short-circuits on `a === b` per element but is still ten thousand
  // comparisons, and bounding total work is the point.
  if (budget.n-- <= 0) return false;              // too big to judge → "changed"
  if (a === b) return true;                       // primitives + identity
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameStateValue(a[i], b[i], budget)) return false;
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameStateValue(a[k], b[k], budget)) return false;
  }
  return true;
}

export class RoomObjects {
  constructor() {
    this._state = new Map(); // key -> { value, id }
    // PERF-4(b): a monotonic "the map is not what it was" counter. Per-frame
    // consumers (the four ghost-sync ticks in main.js) used to rebuild their
    // whole view of this map EVERY RENDERED FRAME; the key count is
    // peer-reachable (the server admits 4096 STATE keys per room and the client
    // applies any key it is sent), so that cost was one peer's choice, not ours.
    // With a version they can memoise and do two integer compares instead.
    // Bumped only when the stored map actually differs — never on an echo.
    this._version = 0;
  }

  /** Bumped whenever the stored map changes (see the constructor's note). */
  get version() { return this._version; }

  /**
   * Apply a decoded STATE message. Returns { key, value, id, changed } so the
   * caller can react only when something actually changed (avoids re-applying
   * an echo / idempotent replay). A null value deletes the key.
   */
  apply(msg) {
    if (!msg || msg.type !== MSG.STATE || typeof msg.key !== 'string') return null;
    const key = msg.key;
    const value = msg.value ?? null;
    const id = msg.id == null ? null : String(msg.id);
    const prev = this._state.get(key);
    const existed = prev !== undefined;
    const changed = !existed || !sameStateValue(prev.value, value);
    // The owner is part of the map's content (ownerOf drives the leave-clear
    // rules), so a re-set of the same value by a DIFFERENT peer still has to
    // move the version even though `changed` — which is about the VALUE, and is
    // the flag every existing consumer reads — stays false.
    const ownerChanged = existed && prev.id !== id && value !== null;
    if (value === null) this._state.delete(key);
    else this._state.set(key, { value, id });
    // Clearing a key that was never here leaves the map identical: don't bump.
    if ((changed || ownerChanged) && (existed || value !== null)) this._version++;
    return { key, value, id, changed };
  }

  get(key) { return this._state.has(key) ? this._state.get(key).value : null; }

  /** Owner (setter peer id) of a key, or null. */
  ownerOf(key) { return this._state.get(key)?.id ?? null; }

  has(key) { return this._state.has(key); }

  /**
   * All [key, value] pairs, as a fresh array the caller may keep or mutate.
   * Deliberately NOT cached: the per-frame consumers that made this hot now
   * memoise on `version` instead (see main.js's shared hold view), and handing
   * every caller the same array instance would trade a copy for an aliasing
   * hazard. Prefer entriesWithPrefix() when you only want one namespace.
   */
  entries() { return [...this._state.entries()].map(([k, v]) => [k, v.value]); }

  /**
   * Lazily yield the [key, value] pairs whose key starts with `prefix`, without
   * materialising the whole map first. The `hold:gp:` / `hold:gun:` /
   * `hold:mouse:` consumers used to build a full array of every room-state key
   * and then filter it down to the handful they wanted — with 4096 keys in the
   * room (the server's per-room cap) that is 4096 allocations to find maybe two.
   * [[src/net/HoldState.js]]'s parseHolds takes any iterable of pairs, so this
   * drops straight in.
   */
  *entriesWithPrefix(prefix) {
    for (const [k, v] of this._state) {
      if (k.startsWith(prefix)) yield [k, v.value];
    }
  }

  get size() { return this._state.size; }

  clear() {
    if (this._state.size) this._version++;
    this._state.clear();
  }
}
