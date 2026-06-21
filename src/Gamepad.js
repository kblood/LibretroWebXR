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
  const a = makeFaceButton({ color: 0xcc3333, label: 'A', id: 'a' });
  a.group.position.set(GP_W * 0.32, GP_H / 2 + 0.003, -0.012);
  group.add(a.group);

  // Face B (blue, labelled B): forwards Quest A/X → NES B (bomb).
  const b = makeFaceButton({ color: 0x3366cc, label: 'B', id: 'b' });
  b.group.position.set(GP_W * 0.32, GP_H / 2 + 0.003, 0.012);
  group.add(b.group);

  // Start / Select strips in the middle. Two short slabs side by side so
  // each lights independently.
  const start = makeStrip({ label: 'ST', id: 'start' });
  start.group.position.set(0.012, GP_H / 2 + 0.001, 0);
  group.add(start.group);
  const select = makeStrip({ label: 'SE', id: 'select' });
  select.group.position.set(-0.012, GP_H / 2 + 0.001, 0);
  group.add(select.group);

  // Cord-exit anchor: where the controller cable leaves the body (top edge,
  // the +Z "away from player" side, like a real pad). The cord system
  // ([[src/Cord.js]]) reads this anchor's world position each frame to draw the
  // rope to the console jack it's plugged into.
  const cordAnchor = new THREE.Object3D();
  cordAnchor.position.set(0, GP_H / 2, GP_D / 2);
  group.add(cordAnchor);

  // Click-to-test registry: maps each logical button id to its part (so a
  // controller pointed at the pad can press it without grabbing the pad — see
  // the gamepad-click raycast in main.js) and lists the raycastable cap meshes.
  const clickButtons = {
    a, b, start, select,
    up: dpad.arms.up, down: dpad.arms.down, left: dpad.arms.left, right: dpad.arms.right,
  };
  const clickMeshes = [a.cap, b.cap, start.cap, select.cap,
    dpad.arms.up.mesh, dpad.arms.down.mesh, dpad.arms.left.mesh, dpad.arms.right.mesh];

  group.userData = {
    kind: 'gamepad',
    cordAnchor,
    // Exposed for the click-to-test path: the cap meshes to raycast and a way to
    // drive a single button's pressed / hover visual by its logical id.
    clickMeshes,
    pressButton(id, pressed) { clickButtons[id]?.setPressed?.(!!pressed); },
    hoverButton(id, hovered) { clickButtons[id]?.setHover?.(!!hovered); },
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

function makeFaceButton({ color, label, id }) {
  const g = new THREE.Group();
  const baseMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.0 });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.006, 20), baseMat);
  cap.userData.gpButton = id; // raycast target id for click-to-test
  g.add(cap);

  // Tiny etched label so the user can read "A"/"B" at close range.
  const labelMesh = makeLabel(label, 0.008);
  labelMesh.rotation.x = -Math.PI / 2;
  labelMesh.position.y = 0.0035;
  g.add(labelMesh);

  const baseY = cap.position.y;
  let pressed = false, hovered = false;
  const apply = () => {
    cap.position.y = baseY + (pressed ? -PRESS_DEPTH : 0);
    baseMat.emissiveIntensity = pressed ? 1.2 : (hovered ? 0.45 : 0.0);
  };
  return {
    group: g, cap,
    setPressed(p) { pressed = p; apply(); },
    setHover(h) { hovered = h; apply(); },
  };
}

function makeStrip({ label, id }) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x555566, roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.0 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.004, 0.022), mat);
  slab.userData.gpButton = id; // raycast target id for click-to-test
  g.add(slab);
  const labelMesh = makeLabel(label, 0.006);
  labelMesh.rotation.x = -Math.PI / 2;
  labelMesh.position.y = 0.003;
  g.add(labelMesh);
  const baseY = slab.position.y;
  let pressed = false, hovered = false;
  const apply = () => {
    slab.position.y = baseY + (pressed ? -PRESS_DEPTH * 0.6 : 0);
    mat.emissiveIntensity = pressed ? 0.8 : (hovered ? 0.35 : 0.0);
    mat.color.setHex(pressed ? 0x88ddff : (hovered ? 0x6f8fa0 : 0x555566));
  };
  return {
    group: g, cap: slab,
    setPressed(p) { pressed = p; apply(); },
    setHover(h) { hovered = h; apply(); },
  };
}

function buildDpad() {
  const g = new THREE.Group();
  const restColor = 0x222229;
  const activeColor = 0x88ddff;
  const restEmit = 0x000000;
  const activeEmit = 0x88ddff;

  // Each arm is a small box offset from centre. Up/Down on Z (because
  // the gamepad's "forward" is +Z); Left/Right on X. Each arm tracks its own
  // pressed/hover state so click-to-test can drive a single direction while the
  // physical-axis path (setAxes) drives them as a set — they never run at once
  // (axes only fire for the held pad; clicks only for an un-held pad).
  const armX = 0.013, armY = 0.008, armZ = 0.013;
  const make = (dx, dz, id) => {
    const mat = new THREE.MeshStandardMaterial({ color: restColor, roughness: 0.7, emissive: restEmit, emissiveIntensity: 0.0 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(armX, armY, armZ), mat);
    mesh.position.set(dx, 0, dz);
    mesh.userData.gpButton = id; // raycast target id for click-to-test
    g.add(mesh);
    let pressed = false, hovered = false;
    const apply = () => {
      mat.color.setHex(pressed ? activeColor : restColor);
      mat.emissive.setHex(pressed ? activeEmit : restEmit);
      mat.emissiveIntensity = pressed ? 1.0 : (hovered ? 0.4 : 0.0);
      mesh.position.y = pressed ? -PRESS_DEPTH * 0.5 : 0;
    };
    return {
      mesh,
      setPressed(p) { pressed = p; apply(); },
      setHover(h) { hovered = h; apply(); },
    };
  };
  const arms = {
    left:  make(-armX, 0, 'left'),
    right: make( armX, 0, 'right'),
    up:    make(0, -armZ, 'up'),   // -Z is "up" if gamepad faces away from user
    down:  make(0,  armZ, 'down'),
  };

  // Centre cap so the cross looks coherent.
  const centre = new THREE.Mesh(
    new THREE.BoxGeometry(armX * 0.9, armY * 0.9, armZ * 0.9),
    new THREE.MeshStandardMaterial({ color: 0x33333a, roughness: 0.7 }),
  );
  g.add(centre);

  return {
    group: g,
    arms,
    setAxes(x, y) {
      arms.left.setPressed(x <= -DPAD_THRESH);
      arms.right.setPressed(x >=  DPAD_THRESH);
      arms.up.setPressed(y <= -DPAD_THRESH);
      arms.down.setPressed(y >=  DPAD_THRESH);
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
