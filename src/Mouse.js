// Mouse prop: a grabbable in-world mouse you move to drive a console's libretro
// MOUSE device (RETRO_DEVICE_MOUSE). Mirrors the [[src/LightGun.js]] / [[src/Gamepad.js]]
// prop contract so [[src/GrabMgr]] handles it identically: a THREE.Group with
// userData.kind, a cordAnchor (the cable to a console controller port), and setHeld().
//
// What's mouse-specific:
//   • It feeds RELATIVE motion, so the manager ([[src/MouseMgr.js]]) tracks the
//     prop's world position frame-to-frame and sends the delta — there is no aim
//     ray. The prop only needs to be grabbable and report buttons.
//   • buttonState — the held-button bitmask (1=left, 2=right) the manager reads
//     from the holding controller's trigger/squeeze; setButtons(mask) lights the
//     pressed button caps for legible VR feedback.
//
// Visually it's a small rounded mouse body with two button caps and a scroll
// nub, scaled for a hand in VR. The cord exits the FRONT (toward -Z, "up the
// desk") like a real mouse lead, and runs to the console port jack.

import * as THREE from 'three';

const SHELL = 0x2a2a30;   // dark grey mouse shell
const CAP = 0x44444c;     // button caps
const ACCENT = 0x66ccff;  // lit-button accent (cyan, distinct from the gun orange)

export function createMouse({ position = new THREE.Vector3(-0.35, 0.78, -2.2) } = {}) {
  const group = new THREE.Group();
  group.name = 'mouse';
  group.position.copy(position);

  const shellMat = new THREE.MeshStandardMaterial({ color: SHELL, roughness: 0.45, metalness: 0.05, emissive: 0x000000, emissiveIntensity: 1.0 });
  const capMatL = new THREE.MeshStandardMaterial({ color: CAP, roughness: 0.4, emissive: ACCENT, emissiveIntensity: 0.0 });
  const capMatR = new THREE.MeshStandardMaterial({ color: CAP, roughness: 0.4, emissive: ACCENT, emissiveIntensity: 0.0 });

  // Body: a flattened, slightly elongated dome. A scaled sphere reads as a mouse
  // shell without a custom mesh; length is along Z (front = -Z).
  const bodyW = 0.05, bodyH = 0.028, bodyL = 0.08;
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), shellMat);
  body.scale.set(bodyW, bodyH, bodyL);
  body.position.set(0, 0, 0);
  group.add(body);

  // Two button caps at the front-top, split left/right.
  const capGeo = new THREE.BoxGeometry(bodyW * 0.46, 0.006, bodyL * 0.42);
  const capL = new THREE.Mesh(capGeo, capMatL);
  capL.position.set(-bodyW * 0.26, bodyH * 0.55, -bodyL * 0.30);
  group.add(capL);
  const capR = new THREE.Mesh(capGeo, capMatR);
  capR.position.set(bodyW * 0.26, bodyH * 0.55, -bodyL * 0.30);
  group.add(capR);

  // Scroll nub between the caps.
  const nub = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.012, 10), new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.6 }));
  nub.rotation.z = Math.PI / 2;
  nub.position.set(0, bodyH * 0.62, -bodyL * 0.30);
  group.add(nub);

  // Cord exit: the front-center of the body (the lead runs to a console port).
  const cordAnchor = new THREE.Object3D();
  cordAnchor.position.set(0, 0, -bodyL * 0.52);
  group.add(cordAnchor);

  // A small reference point at the body centre — MouseMgr tracks ITS world
  // position frame-to-frame to derive relative motion (no aim ray).
  const tracker = new THREE.Object3D();
  group.add(tracker);

  group.userData = {
    kind: 'mouse',
    cordAnchor,
    tracker,
    // Last button bitmask the manager set (1=left, 2=right). Public so MouseMgr
    // can read/dedupe; setButtons() is the visual+state setter.
    buttonState: 0,
    setHeld(held) {
      shellMat.emissive.setHex(held ? 0x143040 : 0x000000);
    },
    /** Light the pressed button caps. mask: bit0=left, bit1=right. */
    setButtons(mask) {
      this.buttonState = mask & 0x3;
      capMatL.emissiveIntensity = (mask & 1) ? 1.0 : 0.0;
      capMatR.emissiveIntensity = (mask & 2) ? 1.0 : 0.0;
    },
    /** No per-frame visual decay needed; present for prop-contract parity. */
    tick(_dt) {},
  };

  return group;
}
