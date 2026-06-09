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
 * (`[[key, value]]`). Returns `[{ key, objId, holder, hand }]`, dropping:
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
