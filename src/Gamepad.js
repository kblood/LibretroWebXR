// Virtual gamepad: a small handheld mesh you grab to "wake up" emulator
// input routing. The grip button is for grab/release ([[GrabMgr]]); while a
// controller is holding this mesh, that controller's trigger + thumbstick +
// face buttons forward to the emulator.
//
// Live visual feedback. Each visible input on the mesh reacts to the
// corresponding XR controller input:
//   - face A (red cylinder, labelled "A")     → Quest trigger
//   - face B (blue cylinder, labelled "B")    → Quest A/X face button
//   - Start strip (right of centre)           → Quest B/Y face button
//   - Select strip (left of centre)           → Quest thumbstick click
//   - D-pad cross (4 arms)                    → Quest thumbstick axes
// Pressed parts depress slightly (translate -Y) AND glow via emissive. The
// effect makes which button is firing self-evident in VR — combined with
// the [[src/DebugHud.js]] readout, the user can see both the raw XR
// gamepad state and the synthesised emulator button state at a glance.

import * as THREE from 'three';

const GP_W = 0.18;
const GP_H = 0.04;
const GP_D = 0.10;

const PRESS_DEPTH = 0.0035; // metres a button drops when pressed
const DPAD_THRESH = 0.4;    // axis magnitude before an arm lights up

export function createGamepad({ position = new THREE.Vector3(0.6, 0.78, -2.2) } = {}) {
  const group = new THREE.Group();
  group.name = 'gamepad';
  group.position.copy(position);

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.6, emissive: 0x000000, emissiveIntensity: 1.0 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(GP_W, GP_H, GP_D), bodyMat);
  group.add(body);

  // D-pad: a cross of FOUR separate arms so each can light up independently
  // when its axis exceeds DPAD_THRESH. Coloured grey at rest, cyan when
  // active.
  const dpad = buildDpad();
  dpad.group.position.set(-GP_W * 0.32, GP_H / 2 + 0.001, 0);
  group.add(dpad.group);

  // Face A (red, labelled A): forwards Quest trigger → NES A. Front
  // position so the user reads it as the "primary" fire button.
  const a = makeFaceButton({ color: 0xcc3333, label: 'A' });
  a.group.position.set(GP_W * 0.32, GP_H / 2 + 0.003, -0.012);
  group.add(a.group);

  // Face B (blue, labelled B): forwards Quest A/X → NES B (bomb).
  const b = makeFaceButton({ color: 0x3366cc, label: 'B' });
  b.group.position.set(GP_W * 0.32, GP_H / 2 + 0.003, 0.012);
  group.add(b.group);

  // Start / Select strips in the middle. Two short slabs side by side so
  // each lights independently.
  const start = makeStrip({ label: 'ST' });
  start.group.position.set(0.012, GP_H / 2 + 0.001, 0);
  group.add(start.group);
  const select = makeStrip({ label: 'SE' });
  select.group.position.set(-0.012, GP_H / 2 + 0.001, 0);
  group.add(select.group);

  group.userData = {
    kind: 'gamepad',
    setHeld(held) {
      bodyMat.emissive.setHex(held ? 0x004466 : 0x000000);
    },
    // Called per-frame from main.js once the active controller's gamepad
    // state has been read. Drives all the depress + glow animations.
    setInput({ a: aPressed = false, b: bPressed = false, start: stPressed = false, select: selPressed = false, axisX = 0, axisY = 0 } = {}) {
      a.setPressed(aPressed);
      b.setPressed(bPressed);
      start.setPressed(stPressed);
      select.setPressed(selPressed);
      dpad.setAxes(axisX, axisY);
    },
  };

  return group;
}

function makeFaceButton({ color, label }) {
  const g = new THREE.Group();
  const baseMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.0 });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.006, 20), baseMat);
  g.add(cap);

  // Tiny etched label so the user can read "A"/"B" at close range.
  const labelMesh = makeLabel(label, 0.008);
  labelMesh.rotation.x = -Math.PI / 2;
  labelMesh.position.y = 0.0035;
  g.add(labelMesh);

  const baseY = cap.position.y;
  return {
    group: g,
    setPressed(p) {
      cap.position.y = baseY + (p ? -PRESS_DEPTH : 0);
      baseMat.emissiveIntensity = p ? 1.2 : 0.0;
    },
  };
}

function makeStrip({ label }) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x555566, roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.0 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.004, 0.022), mat);
  g.add(slab);
  const labelMesh = makeLabel(label, 0.006);
  labelMesh.rotation.x = -Math.PI / 2;
  labelMesh.position.y = 0.003;
  g.add(labelMesh);
  const baseY = slab.position.y;
  return {
    group: g,
    setPressed(p) {
      slab.position.y = baseY + (p ? -PRESS_DEPTH * 0.6 : 0);
      mat.emissiveIntensity = p ? 0.8 : 0.0;
      mat.color.setHex(p ? 0x88ddff : 0x555566);
    },
  };
}

function buildDpad() {
  const g = new THREE.Group();
  const restColor = 0x222229;
  const activeColor = 0x88ddff;
  const restEmit = 0x000000;
  const activeEmit = 0x88ddff;

  // Each arm is a small box offset from centre. Up/Down on Z (because
  // the gamepad's "forward" is +Z); Left/Right on X.
  const armX = 0.013, armY = 0.008, armZ = 0.013;
  const arms = {};
  const make = (dx, dz) => {
    const mat = new THREE.MeshStandardMaterial({ color: restColor, roughness: 0.7, emissive: restEmit, emissiveIntensity: 0.0 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(armX, armY, armZ), mat);
    m.position.set(dx, 0, dz);
    g.add(m);
    return { mesh: m, mat };
  };
  arms.left  = make(-armX, 0);
  arms.right = make( armX, 0);
  arms.up    = make(0, -armZ); // -Z is "up" if gamepad faces away from user
  arms.down  = make(0,  armZ);

  // Centre cap so the cross looks coherent.
  const centre = new THREE.Mesh(
    new THREE.BoxGeometry(armX * 0.9, armY * 0.9, armZ * 0.9),
    new THREE.MeshStandardMaterial({ color: 0x33333a, roughness: 0.7 }),
  );
  g.add(centre);

  const setArm = ({ mesh, mat }, active) => {
    mat.color.setHex(active ? activeColor : restColor);
    mat.emissive.setHex(active ? activeEmit : restEmit);
    mat.emissiveIntensity = active ? 1.0 : 0.0;
    const baseY = 0;
    mesh.position.y = baseY + (active ? -PRESS_DEPTH * 0.5 : 0);
  };

  return {
    group: g,
    setAxes(x, y) {
      setArm(arms.left,  x <= -DPAD_THRESH);
      setArm(arms.right, x >=  DPAD_THRESH);
      setArm(arms.up,    y <= -DPAD_THRESH);
      setArm(arms.down,  y >=  DPAD_THRESH);
    },
  };
}

// 32x32 canvas baked into a tiny plane — used for the A/B/ST/SE labels on
// top of buttons. Cheap and crisp at the scale we use.
function makeLabel(text, size) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  return new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
}
