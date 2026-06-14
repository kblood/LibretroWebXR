// Console: a box with a cartridge slot on top. Exposes a drop-zone position +
// quaternion the GrabMgr can snap a released cartridge to, and emits a
// 'cartridge-inserted' CustomEvent on its userData target so main.js can
// trigger the page-reload-with-state flow.
//
// The console sits on top of the TV stand. The slot is sized to accept any
// cartridge from Cartridge.js — they all share dimensions.

import * as THREE from 'three';
import { CARTRIDGE_DIMS } from './Cartridge.js';
import { CARD_DIMS } from './MemoryCard.js';
import { MAX_PORTS } from './systems.js';

const CON_W = 0.52;
const CON_H = 0.08;
const CON_D = 0.30;

// Controller ports: a row of labelled jacks on the console's front face, one
// per local player. A gamepad released near a port's anchor "plugs in" there
// ([[src/GrabMgr.js]]) and from then on drives that port's player number
// ([[src/CableMgr.js]]). setPorts(n) shows the first n and hides the rest —
// the current game's system decides n (portsForSystem in [[src/systems.js]]).
const PORT_SPACING = CON_W / MAX_PORTS;        // even spread across the width
const PORT_SEAT_FWD = CON_D / 2 + 0.13;        // how far in front a plug seats
const PORT_RADIUS = 0.16;                      // plug acceptance radius

export function createConsole({ position = new THREE.Vector3(0, 0.74, -2.4) } = {}) {
  const group = new THREE.Group();
  group.name = 'console';
  group.position.copy(position);

  // Main body — dark plastic.
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(CON_W, CON_H, CON_D),
    new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.55 }),
  );
  group.add(body);

  // Cartridge slot — recessed dark rectangle on top, slightly larger than a
  // cartridge pin section so insertion feels forgiving. Offset slightly to
  // the left so the memory-card slot fits to its right on the same surface.
  const cartSlotX = -CON_W * 0.18;
  const slotW = CARTRIDGE_DIMS.W + 0.012;
  const slotD = CARTRIDGE_DIMS.D + 0.008;
  const slot = new THREE.Mesh(
    new THREE.BoxGeometry(slotW, 0.008, slotD),
    new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 }),
  );
  slot.position.set(cartSlotX, CON_H / 2 + 0.001, 0);
  group.add(slot);

  // Memory-card slot — smaller dark rectangle on the right side of the top
  // surface. Cards drop in here for save / load.
  const cardSlotX = CON_W * 0.30;
  const cardSlotW = CARD_DIMS.W + 0.010;
  const cardSlotD = CARD_DIMS.D + 0.008;
  const cardSlot = new THREE.Mesh(
    new THREE.BoxGeometry(cardSlotW, 0.008, cardSlotD),
    new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 }),
  );
  cardSlot.position.set(cardSlotX, CON_H / 2 + 0.001, 0);
  group.add(cardSlot);

  // Power LED — green when a cart is inserted, red otherwise.
  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.006, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xaa2222, toneMapped: false }),
  );
  led.position.set(-CON_W / 2 + 0.03, CON_H / 2 + 0.003, CON_D / 2 - 0.02);
  group.add(led);

  // Decorative front strip.
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(CON_W * 0.85, 0.012, 0.004),
    new THREE.MeshStandardMaterial({ color: 0x555566, roughness: 0.4, metalness: 0.6 }),
  );
  strip.position.set(0, -CON_H / 4, CON_D / 2 + 0.002);
  group.add(strip);

  // Controller ports: MAX_PORTS labelled jacks across the front face, each with
  // a seat anchor a short way in front where a plugged gamepad rests. Built up
  // front; setPorts(n) below shows the first n. portUnits[i].group is toggled.
  const portUnits = [];
  const portAnchors = [];
  const portJacks = [];
  for (let i = 0; i < MAX_PORTS; i++) {
    const x = -CON_W / 2 + PORT_SPACING * (i + 0.5);
    const unit = new THREE.Group();

    // The jack: a small recessed dark square on the front face.
    const jack = new THREE.Mesh(
      new THREE.BoxGeometry(0.028, 0.020, 0.006),
      new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.85 }),
    );
    jack.position.set(x, 0, CON_D / 2 + 0.002);
    unit.add(jack);

    // Jack anchor: the world-space point a controller cord plugs INTO (the front
    // face of the jack). A child of the console group so it tracks the console;
    // the cord system ([[src/Cord.js]]) reads its world position each frame.
    const jackAnchor = new THREE.Object3D();
    jackAnchor.position.set(x, 0, CON_D / 2 + 0.006);
    group.add(jackAnchor);
    portJacks.push(jackAnchor);

    // P1..P4 label just above the jack, facing forward.
    const label = makeLabel(`P${i + 1}`, 0.020);
    label.position.set(x, CON_H / 2 - 0.012, CON_D / 2 + 0.004);
    unit.add(label);

    group.add(unit);
    portUnits.push(unit);

    // Seat anchor: where the gamepad snaps when plugged into this port.
    const seat = new THREE.Object3D();
    seat.position.set(x, CON_H / 2 + 0.012, PORT_SEAT_FWD);
    group.add(seat);
    portAnchors.push(seat);
  }

  // Drop-zone metadata in world space — populated below after add-to-scene.
  let _baseColor = 0xaa2222;
  let _pulseEndAt = 0;
  group.userData = {
    kind: 'console',
    led,
    setInserted(inserted) {
      _baseColor = inserted ? 0x22cc22 : 0xaa2222;
      if (performance.now() >= _pulseEndAt) led.material.color.setHex(_baseColor);
    },
    // Briefly tint the LED bright white, then revert. main.js calls this
    // every time a controller trigger forwards as a game button, so the
    // user can see VR→emulator input is wired up without opening devtools.
    pulse(color = 0xffffff, durationMs = 120) {
      led.material.color.setHex(color);
      _pulseEndAt = performance.now() + durationMs;
      setTimeout(() => {
        if (performance.now() >= _pulseEndAt - 5) led.material.color.setHex(_baseColor);
      }, durationMs);
    },
    // World-space anchors. Each is a child of the console group so its
    // transform follows the console; GrabMgr reads world position to decide
    // drop-snap. The cartridge sits with pins down and ~55% of the body
    // sticking out; the memory card likewise pins down, slightly shorter.
    slotAnchor: new THREE.Object3D(),
    slotRadius: 0.18,
    cardSlotAnchor: new THREE.Object3D(),
    cardSlotRadius: 0.14,

    // Controller ports (local multiplayer). portAnchors[i] is the seat for
    // port i; portRadius is the plug acceptance distance. activePorts is how
    // many are currently enabled (the current system's controller count).
    portAnchors,
    // Per-port jack anchors (front face) — where a controller cord visually
    // plugs in. Parallel to portAnchors (the seats a few cm in front/above).
    portJacks,
    portRadius: PORT_RADIUS,
    activePorts: MAX_PORTS,
    // Show the first n ports, hide the rest. GrabMgr only plugs into a port
    // whose index < activePorts, so a 1-port handheld can't seat player 2.
    setPorts(n) {
      const count = Math.max(1, Math.min(MAX_PORTS, n | 0));
      this.activePorts = count;
      portUnits.forEach((u, i) => { u.visible = i < count; });
    },
  };
  group.userData.setPorts(MAX_PORTS);

  const anchor = group.userData.slotAnchor;
  anchor.position.set(cartSlotX, CON_H / 2 + CARTRIDGE_DIMS.H * 0.45, 0);
  group.add(anchor);

  const cardAnchor = group.userData.cardSlotAnchor;
  cardAnchor.position.set(cardSlotX, CON_H / 2 + CARD_DIMS.H * 0.45, 0);
  group.add(cardAnchor);

  // Video-out anchor: where this console's video cord exits (back-right corner).
  // The cord runs from here to a TV's video-in jack; seating the plug there is
  // what makes that TV show this console ([[src/Patchbay.js]] connectVideo).
  const videoOut = new THREE.Object3D();
  videoOut.position.set(CON_W / 2 - 0.04, 0, -CON_D / 2 - 0.01);
  group.add(videoOut);
  group.userData.videoOutAnchor = videoOut;

  // Keyboard DIN jack: back-left of the console body, where a keyboard plug
  // snaps to route keystrokes to this console's emulator core. Visually a small
  // recessed dark circle, consistent with the controller port jacks but placed
  // on the rear face. [[src/Patchbay.js]] plugKeyboard/keyboardOf track the edge;
  // [[src/GrabMgr.js]] uses keyboardJack (world anchor) + keyboardJackRadius as
  // the snap target for plugKind === 'keyboard'.
  const kbdJackSocket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.014, 0.006, 10),
    new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.9 }),
  );
  kbdJackSocket.rotation.x = Math.PI / 2;   // face backward (−Z direction)
  kbdJackSocket.position.set(-CON_W / 2 + 0.04, 0, -CON_D / 2 - 0.001);
  group.add(kbdJackSocket);

  // World-space anchor a plug cord attaches INTO (the back-left of the rear face).
  const kbdJack = new THREE.Object3D();
  kbdJack.position.set(-CON_W / 2 + 0.04, 0, -CON_D / 2 - 0.006);
  group.add(kbdJack);
  group.userData.keyboardJack = kbdJack;
  group.userData.keyboardJackRadius = 0.19;  // plug acceptance radius (metres)

  return group;
}

// Tiny baked text plane for the P1..P4 port labels — same trick as the
// gamepad's button labels, kept local so Console has no cross-prop import.
function makeLabel(text, size) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#cfd6ff';
  ctx.font = 'bold 40px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  return new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
}
