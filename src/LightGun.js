// Light-gun prop: a grabbable pistol you point at a TV to shoot gun games
// (Duck Hunt-style). Mirrors the [[src/Gamepad.js]] prop contract so
// [[src/GrabMgr]] handles it identically: a THREE.Group with userData.kind,
// a cordAnchor (the cable to a console controller port), and setHeld().
//
// What's gun-specific:
//   • barrelTip   — an Object3D at the muzzle; its world position is the aim
//                   ray origin.
//   • getAimRay() — fills a THREE.Ray with the world-space barrel ray (origin =
//                   muzzle, direction = the gun's local -Z "forward"). The
//                   [[src/LightGunMgr.js]] raycasts this against the TV screen
//                   meshes, converts the hit to canvas u,v, and calls the hit
//                   console's EmulatorClient.sendLightgun().
//   • setTriggered(on) — trigger depress + muzzle-flash feedback while firing.
//
// The barrel points along the group's local -Z so a natural "point away from
// you" grip aims down-range; GrabMgr seats the held pose so the muzzle leads.

import * as THREE from 'three';

const ORANGE = 0xff7733;   // classic toy-gun orange (NES Zapper homage)
const GREY = 0x33333a;

export function createLightGun({ position = new THREE.Vector3(-0.6, 0.78, -2.2) } = {}) {
  const group = new THREE.Group();
  group.name = 'lightgun';
  group.position.copy(position);

  const bodyMat = new THREE.MeshStandardMaterial({ color: GREY, roughness: 0.5, emissive: 0x000000, emissiveIntensity: 1.0 });
  const accentMat = new THREE.MeshStandardMaterial({ color: ORANGE, roughness: 0.45 });

  // Barrel: a box along -Z (forward). Front face is the muzzle.
  const barrelLen = 0.16, barrelW = 0.03, barrelH = 0.035;
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(barrelW, barrelH, barrelLen), bodyMat);
  barrel.position.set(0, 0, -barrelLen / 2);
  group.add(barrel);

  // Muzzle ring (orange) at the front so the aim end reads clearly.
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(barrelW * 0.6, barrelW * 0.6, 0.012, 16), accentMat);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 0, -barrelLen - 0.004);
  group.add(muzzle);

  // Top sight rib — a thin raised strip to sight down the barrel.
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.006, barrelLen * 0.8), accentMat);
  sight.position.set(0, barrelH / 2 + 0.003, -barrelLen / 2);
  group.add(sight);

  // Grip: angled down/back from the barrel rear, like a pistol stock.
  const gripLen = 0.09;
  const grip = new THREE.Mesh(new THREE.BoxGeometry(barrelW, gripLen, 0.04), bodyMat);
  grip.position.set(0, -gripLen / 2 + 0.005, 0.02);
  grip.rotation.x = -0.32; // tilt the grip back for a natural hold
  group.add(grip);

  // Trigger: a small accent tab under the body that depresses while firing.
  const triggerMat = new THREE.MeshStandardMaterial({ color: ORANGE, roughness: 0.4, emissive: ORANGE, emissiveIntensity: 0.0 });
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.018, 0.006), triggerMat);
  trigger.position.set(0, -0.018, -0.01);
  group.add(trigger);
  const triggerBaseRot = trigger.rotation.x;

  // Muzzle flash: an emissive cone at the muzzle, hidden until a shot. A short
  // burst makes firing legible in VR (and to a screenshot in tests).
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.0, depthWrite: false });
  const flash = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.05, 12), flashMat);
  flash.rotation.x = -Math.PI / 2;           // cone points -Z (down-range)
  flash.position.set(0, 0, -barrelLen - 0.03);
  flash.visible = false;
  group.add(flash);

  // Aim ray origin: the muzzle tip.
  const barrelTip = new THREE.Object3D();
  barrelTip.position.set(0, 0, -barrelLen - 0.01);
  group.add(barrelTip);

  // Cord exit: base of the grip (the cable runs to a console controller port).
  const cordAnchor = new THREE.Object3D();
  cordAnchor.position.set(0, -gripLen + 0.005, 0.03);
  group.add(cordAnchor);

  // Scratch objects reused each frame (no per-frame allocation in the hot path).
  const _o = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const FORWARD = new THREE.Vector3(0, 0, -1);

  let _flashTtl = 0;

  group.userData = {
    kind: 'lightgun',
    cordAnchor,
    barrelTip,
    // Snap-to-controller pose applied by GrabMgr on grab (see its _tryGrab):
    // identity rotation puts the gun's local -Z (barrel forward) exactly on
    // the controller's own -Z, the same axis its aiming laser is drawn along
    // (SceneMgr._initControllers), so the barrel points wherever the
    // controller points instead of keeping its pre-grab world rotation.
    alignToController: true,
    /**
     * Fill `outRay` (THREE.Ray) with the world-space barrel ray: origin at the
     * muzzle, direction along the gun's local -Z. Returns outRay.
     */
    getAimRay(outRay) {
      barrelTip.getWorldPosition(_o);
      group.getWorldQuaternion(_q);
      _d.copy(FORWARD).applyQuaternion(_q).normalize();
      outRay.origin.copy(_o);
      outRay.direction.copy(_d);
      return outRay;
    },
    setHeld(held) {
      bodyMat.emissive.setHex(held ? 0x223344 : 0x000000);
    },
    /** Trigger-held visual: depress the trigger + light it. */
    setTriggered(on) {
      trigger.rotation.x = triggerBaseRot + (on ? 0.5 : 0);
      triggerMat.emissiveIntensity = on ? 1.0 : 0.0;
    },
    /** Pop a brief muzzle flash on the rising edge of a shot. */
    fireFlash() {
      _flashTtl = 0.08; // seconds
      flash.visible = true;
      flashMat.opacity = 0.9;
    },
    /** Per-frame: decay the muzzle flash. dt in seconds. */
    tick(dt) {
      if (_flashTtl > 0) {
        _flashTtl -= dt;
        flashMat.opacity = Math.max(0, _flashTtl / 0.08) * 0.9;
        if (_flashTtl <= 0) flash.visible = false;
      }
    },
  };

  return group;
}
