// HoldState: the pure rules for the "who is holding which object" slice of room
// state (M0 held-object sync). Held objects ride the same generic STATE channel
// ([[src/net/RoomObjects.js]]) under the `hold:` key namespace — a cartridge with
// id <objId> held by peer P is the entry `hold:<objId>` → { holder, hand }.
//
// Owner-scoped: a `hold:` key belongs to the peer that set it, so the server
// clears it when that peer leaves (see server/Hub.js) — a held cartridge can't
// stay stuck in a departed player's hand. No THREE / no socket here, so the
// key-shaping and the self/presence filtering are unit-tested; [[src/GhostCartMgr.js]]
// turns the result into ghost meshes.

export const HOLD_PREFIX = 'hold:';

/** The STATE key for holding the object with id `objId` (e.g. a cartridge file). */
export function makeHoldKey(objId) { return `${HOLD_PREFIX}${objId}`; }

/** True for keys in the hold namespace (owner-scoped → cleared on owner leave). */
export function isHoldKey(key) { return typeof key === 'string' && key.startsWith(HOLD_PREFIX); }

/**
 * Extract the holds a peer should *render* from a RoomObjects entry list
 * (`[[key, value]]` — any ITERABLE of pairs, so RoomObjects.entriesWithPrefix()'s
 * lazy generator can be passed straight in without materialising the whole map).
 * Returns `[{ key, objId, holder, hand }]`, dropping:
 *  - non-`hold:` keys and malformed/cleared values,
 *  - our own holds (`holder === selfId`) — we hold the real object, not a ghost,
 *  - holds whose holder isn't currently present (a stale entry in the brief
 *    window before the server's leave-clear arrives), when `presentIds` is given.
 */
export function parseHolds(entries, { selfId = null, presentIds = null } = {}) {
  const self = selfId == null ? null : String(selfId);
  const present = presentIds == null ? null
    : (presentIds instanceof Set ? presentIds : new Set([...presentIds].map(String)));
  const out = [];
  for (const [key, value] of entries || []) {
    if (!isHoldKey(key) || !value || typeof value !== 'object') continue;
    const holder = value.holder == null ? null : String(value.holder);
    if (holder == null) continue;
    if (self != null && holder === self) continue;
    if (present && !present.has(holder)) continue;
    out.push({ key, objId: key.slice(HOLD_PREFIX.length), holder, hand: value.hand ?? null });
  }
  return out;
}

/**
 * A version-keyed cache of the hold slices the render loop consumes (PERF-4(b)).
 *
 * Four ghost-sync ticks (carts, gamepads, guns, mice) each used to copy the
 * WHOLE room-state map and build their own present-peer Set every rendered
 * frame. In a normal room that is noise; the reason it is a real XR
 * frame-budget threat is that the key count is not ours to choose — the client
 * applies any STATE key off the wire with no allowlist and the server admits
 * 4096 keys per room, so one peer setting 4096 junk keys made every other
 * headset allocate ~16k arrays and run ~45k callbacks per frame, milliseconds of
 * GC on the render thread for state that has nothing to do with holds.
 *
 * update() re-parses only when one of TWO monotonic counters moves, and both are
 * load-bearing:
 *   • objects.version       — a STATE key actually changed.
 *   • presence.rosterVersion — someone joined/left/timed out (or our own id
 *     landed). A peer LEAVING changes `presentIds` without touching a single
 *     state key, and the ghost managers' sweep over the shrunken hold list is
 *     what unhides a LOCAL prop that peer was holding. Key on state alone and
 *     the COR-2/COR-8 bug is back: the prop stays invisible for the rest of the
 *     build.
 * The SOURCE objects are part of the key too — leave+rejoin builds a fresh
 * NetMgr whose counters restart at 0, which must not read as "unchanged".
 *
 * The managers' sync() still runs every frame with these arrays, so the tolerant
 * reconcile (a hold whose holder's avatar hand isn't spawned yet retries next
 * tick) is unchanged; only the parsing is skipped. The returned arrays are
 * READ-ONLY by contract — they are shared between all consumers until the next
 * change, and every ghost manager only reads them.
 *
 * @param {{name:string, prefix:string, remap?:(objId:string)=>string|null}[]} slices
 */
export class HoldView {
  constructor(slices = []) {
    this.slices = slices;
    this.holds = {};              // name -> parsed holds (read-only for callers)
    for (const s of slices) this.holds[s.name] = [];
    this.presentIds = new Set();
    // How many times the parse actually ran. Not decoration: "N frames, one
    // parse" is the whole claim of this class, and it is what the test asserts.
    this.recomputes = 0;
    this._objects = null;
    this._presence = null;
    this._state = -1;
    this._roster = -1;
  }

  /** @returns {object} the memoised `holds` map (same object every call). */
  update(objects, presence) {
    const state = objects.version;
    const roster = presence.rosterVersion;
    if (this._objects === objects && this._presence === presence
        && this._state === state && this._roster === roster) return this.holds;
    this._objects = objects;
    this._presence = presence;
    this._state = state;
    this._roster = roster;
    // Both come straight from PresenceState's roster-versioned cache — no copy.
    this.presentIds = presence.idSet();
    const opts = { selfId: presence.selfId, presentIds: this.presentIds };
    for (const s of this.slices) {
      const parsed = parseHolds(objects.entriesWithPrefix(s.prefix), opts);
      // `||`, not `??`: a remap that yields null OR an empty id keeps the raw
      // objId, exactly as the four hand-written call sites did.
      this.holds[s.name] = s.remap
        ? parsed.map((h) => ({ ...h, objId: s.remap(h.objId) || h.objId }))
        : parsed;
    }
    this.recomputes++;
    return this.holds;
  }
}
