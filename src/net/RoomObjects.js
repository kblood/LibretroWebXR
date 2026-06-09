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

export class RoomObjects {
  constructor() {
    this._state = new Map(); // key -> { value, id }
  }

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
    const changed = !prev || JSON.stringify(prev.value) !== JSON.stringify(value);
    if (value === null) this._state.delete(key);
    else this._state.set(key, { value, id });
    return { key, value, id, changed };
  }

  get(key) { return this._state.has(key) ? this._state.get(key).value : null; }

  /** Owner (setter peer id) of a key, or null. */
  ownerOf(key) { return this._state.get(key)?.id ?? null; }

  has(key) { return this._state.has(key); }

  /** All [key, value] pairs. */
  entries() { return [...this._state.entries()].map(([k, v]) => [k, v.value]); }

  get size() { return this._state.size; }

  clear() { this._state.clear(); }
}
