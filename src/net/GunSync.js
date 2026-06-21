// GunSync: pure helpers for the light-gun PORT-binding sync over the STATE
// channel — the gun analogue of [[src/net/GamepadSync.js]], with one deliberate
// difference. A gamepad's EXISTENCE rides the `gamepad:` channel (which creates
// and destroys gamepad meshes). A light gun's existence already rides the generic
// `prop:*` channel (it's a placeable prop), so this channel carries ONLY which
// console port the gun is plugged into — layered additively on top of the prop
// sync. Sharing the `gamepad:` channel would make the gamepad reconciler try to
// spawn a pad mesh for a gun id, so guns get their own `gun:` prefix.
//
// ID scheme: `gun-<selfId>-<n>` — globally unique across peers (a bare counter
// collides when two peers spawn at once). The default boot gun is deterministic
// (every peer builds it locally) and is not broadcast via this mechanism; only
// its port binding is, keyed by its stable local cableId.
//
// Payload: { port } — the cable port (0-based) the gun is plugged into, or -1
// when unplugged. Late joiners receive the full STATE snapshot and converge; the
// gun's libretro aim port is then derived locally from this cable port + the
// active two-gun device (see libretroGunPortFor in systems.js).

export const GUN_STATE_PREFIX = 'gun:';

/** STATE key for a gun port-binding entry. */
export function makeGunStateKey(cableId) {
  return `${GUN_STATE_PREFIX}${cableId}`;
}

/** True if a STATE key is a gun port-binding key. */
export function isGunStateKey(key) {
  return typeof key === 'string' && key.startsWith(GUN_STATE_PREFIX);
}

/** Extract the cableId from a gun state key, or null. */
export function cableIdFromGunStateKey(key) {
  if (!isGunStateKey(key)) return null;
  return key.slice(GUN_STATE_PREFIX.length);
}

/**
 * Build a globally-unique cableId for a peer-spawned light gun.
 * selfId: the peer's server-assigned id (any string); counter: a local integer
 * that increments each time THIS peer spawns a gun. Returns `gun-<selfId>-<n>`.
 */
export function makePeerGunId(selfId, counter) {
  const safe = String(selfId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `gun-${safe}-${counter}`;
}

/**
 * Given the full entries() snapshot of RoomObjects, return an array of
 * { cableId, port } for every `gun:*` key that has a numeric port. Unlike
 * GamepadSync there is no create/remove diff — the gun MESH is created/removed by
 * the prop sync; this only describes the desired port binding for guns that exist.
 */
export function parseGunEntries(entries) {
  const result = [];
  for (const [key, value] of entries) {
    if (!isGunStateKey(key)) continue;
    if (!value || typeof value.port !== 'number') continue;
    const cableId = cableIdFromGunStateKey(key);
    if (cableId) result.push({ cableId, port: value.port });
  }
  return result;
}
