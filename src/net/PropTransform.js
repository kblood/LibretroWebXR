// PropTransform: the WORLD-space bridge between a live THREE object and the
// THREE-free prop payload in [[src/net/PropSync.js]].
//
// WHY THIS EXISTS. A `prop:` payload is a ROOM position — every peer applies it
// to its own copy of the prop, which is a direct child of the scene root. But a
// prop that is currently being CARRIED is not a child of the scene root: GrabMgr
// re-parents it onto the holder's controller (_finalizeAttach → ctrl.attach), so
// its `.position` is a few centimetres from the CONTROLLER's origin. Serializing
// that as a room position published "6 cm in front of the world origin" — under
// the floor — to every other peer, ~20 Hz, for as long as the prop was held.
//
// For a gamepad that was invisible while it happened and then very visible the
// moment it stopped: GhostGamepadMgr hides a remotely-held pad and shows a ghost
// in the holder's hand, so the bogus pose was only revealed on RELEASE, when the
// real mesh was un-hidden wherever the last drag packet had left it. The holder,
// whose own copy never moved, saw it sitting exactly where they let go. That is
// the "released controller falls through the floor for everyone else" report.
//
// The fast path matters as much as the fix. A prop at rest IS a child of the
// scene root, so world == local and the local values are returned untouched.
// Taking the quaternion detour for those would re-normalise the Euler angles
// (rot [180,0,180] and [0,180,0] are the same orientation but not the same
// payload) and every peer would see a spurious "it moved" diff on a prop nobody
// touched. Pass `root` so this path can be recognised.

import * as THREE from 'three';
import { serializePropState } from './PropSync.js';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();

/**
 * Serialize `object`'s ROOM pose for the `prop:` channel.
 *
 * @param {object} prop        the prop descriptor (type + type-specific fields)
 * @param {THREE.Object3D} object  the live object
 * @param {object} [opts]
 * @param {THREE.Object3D} [opts.root]  the scene root; an object parented
 *        directly to it (or to nothing) is already in room space and is
 *        serialized verbatim. Omit it and every call takes the world path.
 * @param {number} [opts.roundTo]  forwarded to serializePropState
 */
export function propWorldPayload(prop, object, { root = null, roundTo } = {}) {
  const opts = roundTo === undefined ? {} : { roundTo };
  if (!object?.parent || object.parent === root) return serializePropState(prop, object, opts);
  object.getWorldPosition(_pos);
  object.getWorldQuaternion(_quat);
  _euler.setFromQuaternion(_quat, 'XYZ');
  return serializePropState(prop, object, { ...opts, transform: { position: _pos, rotation: _euler } });
}
