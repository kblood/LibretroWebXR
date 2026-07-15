// Unit tests for the light-gun-specific behavior of [[src/GrabMgr.js]]:
//  - a gameplay grab snaps the gun's barrel onto the controller's own -Z (the
//    axis its aiming laser is drawn along), regardless of the gun's rest pose
//  - an edit-mode ('move') grab does NOT snap rotation — picking the gun up to
//    reposition it must not reorient it
//  - two controllers can't both end up "holding" the same free-standing prop
//    when they hover it in the same tick (held-map desync)
//  - onObjectReleased fires on release, so main.js can clear network hold state
//  - a light gun locked by a remote peer (isRemotelyHeld) can't be grabbed locally
//
// Runs in Node against the real GrabMgr + createLightGun (THREE math only, no
// DOM/WebXR needed — grab targets are forced via _hover instead of raycasting
// real geometry).

import * as THREE from 'three';
import { GrabMgr } from '../src/GrabMgr.js';
import { createLightGun } from '../src/LightGun.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

function makeCtrl(pos, rot) {
  const c = new THREE.Group();
  c.position.set(...pos);
  c.rotation.set(...rot);
  return c;
}

function makeConsole() {
  const c = new THREE.Group();
  c.userData.slotAnchor = new THREE.Object3D();
  c.add(c.userData.slotAnchor);
  c.userData.setInserted = () => {};
  return c;
}

console.log('--- gameplay grab aligns gun barrel with controller forward');
{
  const scene = new THREE.Scene();
  const gun = createLightGun({ position: new THREE.Vector3(-0.62, 0.78, -2.15) });
  gun.rotation.set(0.4, 2.1, -0.3); // resting at an arbitrary, non-aligned tilt
  scene.add(gun);
  const ctrl = makeCtrl([1.0, 1.6, -1.0], [-0.6, 1.2, 0.15]);
  scene.add(ctrl);
  scene.updateMatrixWorld(true);

  const mgr = new GrabMgr({ scene, controllers: [ctrl], console: makeConsole(), isEditMode: () => false });
  mgr.addGrabbable(gun);
  mgr._hover.set(ctrl, gun); // force the grab target deterministically
  mgr._tryGrab(ctrl);
  scene.updateMatrixWorld(true);

  ok(mgr.held.get(ctrl) === gun, 'gameplay grab registers held');
  const ray = new THREE.Ray();
  gun.userData.getAimRay(ray);
  const ctrlQuat = new THREE.Quaternion();
  ctrl.getWorldQuaternion(ctrlQuat);
  const ctrlFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ctrlQuat).normalize();
  ok(Math.abs(ray.direction.dot(ctrlFwd) - 1) < 1e-6, 'gun barrel aligns with controller forward after grab');
}

console.log('--- edit-mode grab preserves rest rotation');
{
  const scene = new THREE.Scene();
  const gun = createLightGun({ position: new THREE.Vector3(-0.62, 0.78, -2.15) });
  gun.userData.editable = true;
  const restQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 2.1, -0.3));
  gun.quaternion.copy(restQuat);
  scene.add(gun);
  const ctrl = makeCtrl([1.0, 1.6, -1.0], [-0.6, 1.2, 0.15]);
  scene.add(ctrl);
  scene.updateMatrixWorld(true);

  const mgr = new GrabMgr({ scene, controllers: [ctrl], console: makeConsole(), isEditMode: () => true, getMode: () => 'move' });
  mgr.addGrabbable(gun);
  mgr._hover.set(ctrl, gun);
  mgr._tryGrab(ctrl);
  scene.updateMatrixWorld(true);

  ok(mgr.held.get(ctrl) === gun, 'edit-mode grab still registers held');
  const worldQuat = new THREE.Quaternion();
  gun.getWorldQuaternion(worldQuat);
  ok(worldQuat.angleTo(restQuat) < 1e-6, 'edit-mode grab does not reorient the gun (picking up to reposition ≠ aiming)');
}

console.log('--- two controllers cannot both grab the same free object in one frame');
{
  const scene = new THREE.Scene();
  const gun = createLightGun({ position: new THREE.Vector3(-0.62, 0.78, -2.15) });
  scene.add(gun);
  const ctrlA = makeCtrl([0, 1.6, -1.9], [0, 0, 0]);
  const ctrlB = makeCtrl([0, 1.6, -1.9], [0, 0, 0]);
  scene.add(ctrlA); scene.add(ctrlB);
  scene.updateMatrixWorld(true);

  const mgr = new GrabMgr({ scene, controllers: [ctrlA, ctrlB], console: makeConsole(), isEditMode: () => false });
  mgr.addGrabbable(gun);
  // Simulate tick() giving both controllers the same hover target in the same frame.
  mgr._hover.set(ctrlA, gun);
  mgr._hover.set(ctrlB, gun);
  mgr._tryGrab(ctrlA);
  mgr._tryGrab(ctrlB); // must be a no-op: gun is already held by ctrlA

  ok(mgr.held.size === 1, 'only one controller ends up holding the gun');
  ok(mgr.held.get(ctrlA) === gun && !mgr.held.has(ctrlB), 'the first grab wins; the second is refused');
}

console.log('--- onObjectReleased fires symmetrically with onObjectGrabbed');
{
  const scene = new THREE.Scene();
  const gun = createLightGun({ position: new THREE.Vector3(-0.62, 0.78, -2.15) });
  scene.add(gun);
  const ctrl = makeCtrl([0, 1.6, -1.9], [0, 0, 0]);
  scene.add(ctrl);
  scene.updateMatrixWorld(true);

  const grabbed = [];
  const released = [];
  const mgr = new GrabMgr({
    scene, controllers: [ctrl], console: makeConsole(), isEditMode: () => false,
    onObjectGrabbed: (obj, hand) => grabbed.push({ kind: obj.userData?.kind, hand }),
    onObjectReleased: (obj, hand) => released.push({ kind: obj.userData?.kind, hand }),
  });
  mgr.addGrabbable(gun);
  mgr._hover.set(ctrl, gun);
  mgr._tryGrab(ctrl);
  ok(grabbed.length === 1 && grabbed[0].kind === 'lightgun', 'onObjectGrabbed fires once for the gun');

  mgr._release(ctrl);
  ok(released.length === 1 && released[0].kind === 'lightgun', 'onObjectReleased fires once for the gun on release');
}

console.log('--- a remotely-held light gun is excluded from arm-range grab candidates');
{
  // _nearestInArmRange is what tick() ultimately feeds into _hover (and what
  // _tryGrab falls back to directly) — testing it directly avoids relying on
  // real raycast geometry for a deterministic, non-flaky assertion.
  const scene = new THREE.Scene();
  const gun = createLightGun({ position: new THREE.Vector3(-0.62, 0.78, -2.15) });
  gun.userData.cableId = 'gun-remote-1';
  scene.add(gun);
  const ctrl = makeCtrl([-0.62, 0.78, -2.15], [0, 0, 0]); // co-located: well within ARM_RANGE
  scene.add(ctrl);
  scene.updateMatrixWorld(true);

  const lockedMgr = new GrabMgr({
    scene, controllers: [ctrl], console: makeConsole(), isEditMode: () => false,
    isRemotelyHeld: (cableId) => cableId === 'gun-remote-1',
  });
  lockedMgr.addGrabbable(gun);
  ok(lockedMgr._nearestInArmRange(ctrl) === null, 'a remotely-held gun is excluded from arm-range candidates');

  const freeMgr = new GrabMgr({ scene, controllers: [ctrl], console: makeConsole(), isEditMode: () => false });
  freeMgr.addGrabbable(gun);
  ok(freeMgr._nearestInArmRange(ctrl) === gun, 'control: the same gun IS a candidate when not remotely held');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
