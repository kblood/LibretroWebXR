// GamepadSync: pure helpers for shared-gamepad EXISTENCE sync over the STATE
// channel. When a peer spawns a new gamepad via the Add menu, it broadcasts its
// existence as a `gamepad:<id>` STATE key so all current and future peers can
// create the matching local object and assign the same port/player number.
//
// ID scheme: `gp-<selfId>-<n>` — globally unique across all peers (a bare
// incrementing counter collides when two peers spawn at the same time). The
// default gamepad (`gp-1`) is deterministic (every peer builds it locally from
// room.json) and is NOT broadcast via this mechanism.
//
// Lifecycle: when the spawner disconnects, the Hub clears their `gamepad:` keys
// (same extension as the `hold:` auto-clear) so abandoned pads don't pile up.
// Late joiners receive the full state snapshot from the server and converge.
//
// Payload: { port } — the console port the pad is plugged into, chosen by the
// spawner as the first free slot so all peers agree on the player number.
// Out of scope: pose sync and net-synced cord repatch (noted for later).

export const GAMEPAD_STATE_PREFIX = 'gamepad:';

/** STATE key for a gamepad existence entry. */
export function makeGamepadStateKey(cableId) {
  return `${GAMEPAD_STATE_PREFIX}${cableId}`;
}

/** True if a STATE key is a gamepad existence key. */
export function isGamepadStateKey(key) {
  return typeof key === 'string' && key.startsWith(GAMEPAD_STATE_PREFIX);
}

/** Extract the cableId from a gamepad state key, or null. */
export function cableIdFromStateKey(key) {
  if (!isGamepadStateKey(key)) return null;
  return key.slice(GAMEPAD_STATE_PREFIX.length);
}

/**
 * Build a globally-unique cableId for a peer-spawned gamepad.
 * selfId: the peer's server-assigned id (any string); counter: a local
 * integer that increments each time THIS peer spawns a pad.
 * Returns a string like `gp-<selfId>-<counter>`.
 */
export function makePeerGamepadId(selfId, counter) {
  // Sanitise selfId to keep the format unambiguous (no colons/spaces).
  const safe = String(selfId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `gp-${safe}-${counter}`;
}

/**
 * Given the full entries() snapshot of RoomObjects, return an array of
 * { cableId, port } for every `gamepad:*` key that has a non-null value.
 * This is the desired set of peer-spawned gamepads that should exist locally.
 */
export function parseGamepadEntries(entries) {
  const result = [];
  for (const [key, value] of entries) {
    if (!isGamepadStateKey(key)) continue;
    if (!value || typeof value.port !== 'number') continue;
    const cableId = cableIdFromStateKey(key);
    if (cableId) result.push({ cableId, port: value.port });
  }
  return result;
}

/**
 * Compute the diff between the desired set (from parseGamepadEntries) and the
 * locally-known set (a Set or Map of cableIds). Returns { toAdd, toRemove }
 * where toAdd is an array of { cableId, port } and toRemove is an array of
 * cableIds. The default gamepad (whose id does NOT start with `gp-` + selfId
 * or any peer prefix) is NEVER in the desired set, so it is never removed.
 *
 * `localIds` is an iterable of cableId strings that currently exist locally.
 * `defaultIds` is an optional Set of cableIds that are always-present (never
 * added/removed by this sync). Typically just `new Set(['gp-1'])`.
 */
export function diffGamepadSync({ desired, localIds, defaultIds = new Set() }) {
  const desiredMap = new Map(desired.map((d) => [d.cableId, d]));
  const localSet = new Set(localIds);

  const toAdd = [];
  for (const d of desired) {
    if (!localSet.has(d.cableId)) toAdd.push(d);
  }

  const toRemove = [];
  for (const id of localSet) {
    if (defaultIds.has(id)) continue; // never remove default gamepads
    if (!desiredMap.has(id)) toRemove.push(id);
  }

  return { toAdd, toRemove };
}
