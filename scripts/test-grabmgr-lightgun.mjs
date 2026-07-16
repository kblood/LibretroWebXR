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

console.log('--- right-hand ray-grab beyond arm-range enters distance-hold instead of instant-attach');
{
  const scene = new THREE.Scene();
  const gun = createLightGun({ position: new THREE.Vector3(0.2, 1.6, -2.0) });
  scene.add(gun);
  const ctrlLeft = makeCtrl([-0.2, 1.6, 0], [0, 0, 0]);
  const ctrlRight = makeCtrl([0.2, 1.6, 0], [0, 0, 0]);
  scene.add(ctrlLeft); scene.add(ctrlRight);
  scene.updateMatrixWorld(true);

  const mgr = new GrabMgr({ scene, controllers: [ctrlLeft, ctrlRight], console: makeConsole(), isEditMode: () => false });
  mgr.addGrabbable(gun);
  mgr._hover.set(ctrlRight, gun); // force a ray-hit target
  mgr._tryGrab(ctrlRight);

  ok(mgr.held.get(ctrlRight) === gun, 'right-hand ray-grab registers held');
  ok(mgr._holdDistance.has(ctrlRight), 'enters distance-hold instead of an instant attach');
  ok(gun.parent === scene, 'gun stays parented to the scene, not the controller, while distance-held');
}

console.log('--- left-hand ray-grabs keep today\'s instant-attach (no stick assigned to reel them in)');
{
  const scene = new THREE.Scene();
  const gun = createLightGun({ position: new THREE.Vector3(-0.2, 1.6, -2.0) });
  scene.add(gun);
  const ctrlLeft = makeCtrl([-0.2, 1.6, 0], [0, 0, 0]);
  const ctrlRight = makeCtrl([0.2, 1.6, 0], [0, 0, 0]);
  scene.add(ctrlLeft); scene.add(ctrlRight);
  scene.updateMatrixWorld(true);

  const mgr = new GrabMgr({ scene, controllers: [ctrlLeft, ctrlRight], console: makeConsole(), isEditMode: () => false });
  mgr.addGrabbable(gun);
  mgr._hover.set(ctrlLeft, gun);
  mgr._tryGrab(ctrlLeft);

  ok(mgr.held.get(ctrlLeft) === gun, 'left-hand ray-grab registers held');
  ok(!mgr._holdDistance.has(ctrlLeft), 'left hand never enters distance-hold');
  ok(gun.parent === ctrlLeft, 'left-hand ray-grab instant-attaches exactly like today');
}

console.log('--- right-stick pulls a distance-held object in, magnetizing into a real grab');
{
  const scene = new THREE.Scene();
  const gun = createLightGun({ position: new THREE.Vector3(0.2, 1.6, -0.6) }); // 0.6m from ctrlRight
  scene.add(gun);
  const ctrlLeft = makeCtrl([-0.2, 1.6, 0], [0, 0, 0]);
  const ctrlRight = makeCtrl([0.2, 1.6, 0], [0, 0, 0]);
  scene.add(ctrlLeft); scene.add(ctrlRight);
  scene.updateMatrixWorld(true);

  const mgr = new GrabMgr({ scene, controllers: [ctrlLeft, ctrlRight], console: makeConsole(), isEditMode: () => false });
  mgr.addGrabbable(gun);
  mgr._hover.set(ctrlRight, gun);
  mgr._tryGrab(ctrlRight);
  ok(mgr._holdDistance.has(ctrlRight), 'starts in distance-hold');
  const initialDistance = mgr._holdDistance.get(ctrlRight).distance;

  // Simulate the right stick pulled fully back (xr-standard axes[3] = +1 → reels in).
  ctrlRight.userData.inputSource = { gamepad: { axes: [0, 0, 0, 1] } };
  mgr.tick(50); // one 50ms tick
  ok(mgr._holdDistance.has(ctrlRight), 'still distance-held after one small pull');
  ok(mgr._holdDistance.get(ctrlRight).distance < initialDistance, 'pulling back shrinks the hold distance');

  for (let i = 0; i < 10 && mgr._holdDistance.has(ctrlRight); i++) mgr.tick(50);

  ok(!mgr._holdDistance.has(ctrlRight), 'pulling far enough magnetizes into a real grab');
  ok(mgr.held.get(ctrlRight) === gun, 'still held after magnetizing');
  ok(gun.parent === ctrlRight, 'gun is now rigidly attached to the controller');
}

console.log('--- gamepad ray-grabs skip distance-hold entirely (stick is claimed for RetroPad input)');
{
  const scene = new THREE.Scene();
  const gp = new THREE.Object3D();
  gp.userData.kind = 'gamepad';
  gp.position.set(0.2, 1.6, -2.0);
  scene.add(gp);
  const ctrlLeft = makeCtrl([-0.2, 1.6, 0], [0, 0, 0]);
  const ctrlRight = makeCtrl([0.2, 1.6, 0], [0, 0, 0]);
  scene.add(ctrlLeft); scene.add(ctrlRight);
  scene.updateMatrixWorld(true);

  const mgr = new GrabMgr({ scene, controllers: [ctrlLeft, ctrlRight], console: makeConsole(), isEditMode: () => false });
  mgr.addGrabbable(gp);
  mgr._hover.set(ctrlRight, gp);
  mgr._tryGrab(ctrlRight);

  ok(mgr.held.get(ctrlRight) === gp, 'right-hand gamepad ray-grab registers held');
  ok(!mgr._holdDistance.has(ctrlRight), 'gamepad grabs never enter distance-hold');
  ok(gp.parent === ctrlRight, 'gamepad instant-attaches exactly like today');
}

console.log('--- edit-mode grabs skip distance-hold even for the right controller');
{
  const scene = new THREE.Scene();
  const gun = createLightGun({ position: new THREE.Vector3(0.2, 1.6, -2.0) });
  gun.userData.editable = true;
  scene.add(gun);
  const ctrlLeft = makeCtrl([-0.2, 1.6, 0], [0, 0, 0]);
  const ctrlRight = makeCtrl([0.2, 1.6, 0], [0, 0, 0]);
  scene.add(ctrlLeft); scene.add(ctrlRight);
  scene.updateMatrixWorld(true);

  const mgr = new GrabMgr({
    scene, controllers: [ctrlLeft, ctrlRight], console: makeConsole(),
    isEditMode: () => true, getMode: () => 'move',
  });
  mgr.addGrabbable(gun);
  mgr._hover.set(ctrlRight, gun);
  mgr._tryGrab(ctrlRight);

  ok(mgr.held.get(ctrlRight) === gun, 'edit-mode right-hand grab still registers held');
  ok(!mgr._holdDistance.has(ctrlRight), 'edit mode never enters distance-hold');
  ok(gun.parent === ctrlRight, 'edit-mode grab instant-attaches exactly like today');
}

console.log('--- point-and-place: releasing a cartridge while aiming at a slot places it there despite being far away');
{
  const scene = new THREE.Scene();
  const consoleObj = makeConsole();
  consoleObj.position.set(0, 1.2, -2);
  scene.add(consoleObj);

  const ctrl = makeCtrl([0, 1.2, 0], [0, 0, 0]); // aims straight down -Z, through the slot
  scene.add(ctrl);

  const cart = new THREE.Object3D();
  cart.userData.kind = 'cartridge';
  cart.userData.homePosition = new THREE.Vector3(9, 9, 9);
  cart.userData.homeQuaternion = new THREE.Quaternion();
  cart.position.set(10, 10, 10);
  scene.add(cart);
  scene.updateMatrixWorld(true);

  let inserted = null;
  const mgr = new GrabMgr({
    scene, controllers: [ctrl], console: consoleObj, isEditMode: () => false,
    onCartridgeInserted: (info) => { inserted = info; },
  });
  mgr.addGrabbable(cart);
  mgr.held.set(ctrl, cart); // simulate an already-held cartridge, far from the slot
  mgr._release(ctrl);

  ok(inserted !== null, 'onCartridgeInserted fires via ray-match even though the cart is far from the slot');
  const slotWorld = new THREE.Vector3();
  consoleObj.userData.slotAnchor.getWorldPosition(slotWorld);
  const cartWorld = new THREE.Vector3();
  cart.getWorldPosition(cartWorld);
  ok(cartWorld.distanceTo(slotWorld) < 1e-6, 'cartridge snapped exactly to the slot anchor');
}

console.log('--- point-and-place: aiming a held gamepad at a port plugs it in despite being far away');
{
  const scene = new THREE.Scene();
  const consoleObj = makeConsole();
  const portAnchor = new THREE.Object3D();
  consoleObj.add(portAnchor);
  portAnchor.position.set(0, 0, -2); // 2m in front of the console's own origin
  consoleObj.userData.portAnchors = [portAnchor];
  consoleObj.userData.activePorts = 1;
  scene.add(consoleObj);

  const ctrl = makeCtrl([0, 0, 0], [0, 0, 0]); // aims straight down -Z, through the port anchor
  scene.add(ctrl);

  const gp = new THREE.Object3D();
  gp.userData.kind = 'gamepad';
  gp.userData.cableId = 'gp-1';
  gp.position.set(10, 10, 10); // nowhere near the port
  scene.add(gp);
  scene.updateMatrixWorld(true);

  const fakeCable = {
    isPortFree: () => true,
    portOf: () => (fakeCable._plugged ? fakeCable._plugged.port : null),
    plug: (cableId, port) => { fakeCable._plugged = { cableId, port }; },
  };
  let plugged = null;
  const mgr = new GrabMgr({
    scene, controllers: [ctrl], console: consoleObj, cable: fakeCable, isEditMode: () => false,
    onGamepadPlugged: (obj) => { plugged = obj; },
  });
  mgr.addGrabbable(gp);
  mgr.held.set(ctrl, gp); // simulate an already-held gamepad, far from the port
  mgr._release(ctrl);

  ok(fakeCable._plugged && fakeCable._plugged.port === 0, 'ray-match plugs the gamepad into the aimed-at port');
  ok(plugged === gp, 'onGamepadPlugged fires via the ray match');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
