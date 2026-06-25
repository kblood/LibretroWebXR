// MouseSync: pure helpers for the in-world mouse PORT-binding sync over the STATE
// channel — the mouse analogue of [[src/net/GunSync.js]]. Same design: the mouse
// MESH rides the generic `prop:*` channel (it's a placeable prop), so this channel
// carries ONLY which console port the mouse is plugged into, layered additively on
// top of the prop sync. Mice get their own `mouse:` prefix so neither the gamepad
// nor the gun reconciler ever sees a mouse key.
//
// This is essential for 2-player split-pointer (The Settlers on Amiga): every peer
// must agree which mouse drives which Amiga port/player, so each mouse's
// console+port binding syncs. The mouse's libretro port is then derived locally
// from this cable port + the active two-mouse device (libretroMousePortFor in
// systems.js), exactly as the gun derives its aim port.
//
// Payload: { port } — the cable port (0-based) the mouse is plugged into, or -1
// when unplugged. Late joiners receive the full STATE snapshot and converge.

export const MOUSE_STATE_PREFIX = 'mouse:';

/** STATE key for a mouse port-binding entry. */
export function makeMouseStateKey(cableId) {
  return `${MOUSE_STATE_PREFIX}${cableId}`;
}

/** True if a STATE key is a mouse port-binding key. */
export function isMouseStateKey(key) {
  return typeof key === 'string' && key.startsWith(MOUSE_STATE_PREFIX);
}

/** Extract the cableId from a mouse state key, or null. */
export function cableIdFromMouseStateKey(key) {
  if (!isMouseStateKey(key)) return null;
  return key.slice(MOUSE_STATE_PREFIX.length);
}

/**
 * Build a globally-unique cableId for a peer-spawned mouse.
 * selfId: the peer's server-assigned id; counter: a local integer that increments
 * each time THIS peer spawns a mouse. Returns `mouse-<selfId>-<n>`.
 */
export function makePeerMouseId(selfId, counter) {
  const safe = String(selfId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mouse-${safe}-${counter}`;
}

/**
 * Given the full entries() snapshot of RoomObjects, return an array of
 * { cableId, port } for every `mouse:*` key that has a numeric port. The mouse
 * MESH is created/removed by the prop sync; this only describes the desired port
 * binding for mice that exist.
 */
export function parseMouseEntries(entries) {
  const result = [];
  for (const [key, value] of entries) {
    if (!isMouseStateKey(key)) continue;
    if (!value || typeof value.port !== 'number') continue;
    const cableId = cableIdFromMouseStateKey(key);
    if (cableId) result.push({ cableId, port: value.port });
  }
  return result;
}
