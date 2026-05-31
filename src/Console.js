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

const CON_W = 0.52;
const CON_H = 0.08;
const CON_D = 0.30;

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
  };

  const anchor = group.userData.slotAnchor;
  anchor.position.set(cartSlotX, CON_H / 2 + CARTRIDGE_DIMS.H * 0.45, 0);
  group.add(anchor);

  const cardAnchor = group.userData.cardSlotAnchor;
  cardAnchor.position.set(cardSlotX, CON_H / 2 + CARD_DIMS.H * 0.45, 0);
  group.add(cardAnchor);

  return group;
}
