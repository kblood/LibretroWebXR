// Shelf: a wooden plank with slots for cartridges. Cartridges are placed
// upright, pins down, spaced along the plank. Each cartridge's
// userData.homePosition / homeQuaternion are filled in here so the GrabMgr
// can snap a released-in-empty-space cartridge back to its slot.

import * as THREE from 'three';
import { CARTRIDGE_DIMS } from './Cartridge.js';

export const SHELF_DEPTH = 0.18;
export const SHELF_THICK = 0.025;
const SLOT_SPACING = CARTRIDGE_DIMS.W + 0.04;
const PLANK_PADDING = 0.06; // padding at each end of the plank

/** Plank width for N cartridges — shared by createShelf, addCartridgeToShelf,
 * and RoomBuilder (sizing the cover-plaque sign to match). */
export function plankWidthFor(count) {
  return Math.max(SLOT_SPACING * count + PLANK_PADDING * 2, 0.6);
}

export function createShelf(cartridges, { position = new THREE.Vector3(0, 1.2, -2.4), rotationY = 0 } = {}) {
  const group = new THREE.Group();
  group.name = 'shelf';
  group.position.copy(position);
  group.rotation.y = rotationY;

  const plankW = plankWidthFor(cartridges.length);

  // Plank — warm wood look. Slight bevel via secondary darker box below.
  const plank = new THREE.Mesh(
    new THREE.BoxGeometry(plankW, SHELF_THICK, SHELF_DEPTH),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.8 }),
  );
  group.add(plank);

  // Bracket strip behind (suggests it's mounted to the wall).
  const bracket = new THREE.Mesh(
    new THREE.BoxGeometry(plankW, SHELF_THICK * 0.6, 0.01),
    new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 }),
  );
  bracket.position.set(0, SHELF_THICK * 0.2, -SHELF_DEPTH / 2 - 0.005);
  group.add(bracket);

  // Distribute the cartridges along the plank, sitting upright on top.
  const startX = -(cartridges.length - 1) * SLOT_SPACING / 2;
  cartridges.forEach((cart, i) => {
    const x = startX + i * SLOT_SPACING;
    const y = SHELF_THICK / 2 + CARTRIDGE_DIMS.H / 2;
    const z = 0;
    cart.position.set(x, y, z);
    cart.quaternion.identity();
    // Slight back-lean so the labels face the user — feels more like a
    // store display than a sterile lineup.
    cart.rotation.x = -0.08;
    group.add(cart);
  });

  return group;
}

// Call after the shelf has been added to the scene (so world transforms are
// final) to record each cartridge's "home". GrabMgr snaps a cartridge back
// here when released away from the console slot.
export function lockShelfHomes(shelf) {
  shelf.updateMatrixWorld(true);
  shelf.children.forEach((cart) => {
    if (cart.userData?.kind !== 'cartridge') return;
    cart.userData.homePosition = cart.getWorldPosition(new THREE.Vector3());
    cart.userData.homeQuaternion = cart.getWorldQuaternion(new THREE.Quaternion());
  });
}

/**
 * Append a cartridge to an existing shelf, reposition the whole row so the
 * new cart fits, and re-lock all homes. Call lockShelfHomes separately if the
 * shelf's world transform has changed since it was placed; this helper calls
 * updateMatrixWorld internally.
 *
 * The cartridge is added as a child of the shelf group (same as createShelf),
 * so `shelf.remove(cart)` / re-parenting is the caller's responsibility if
 * the cart is later grabbed.
 *
 * Returns the cart for convenience.
 */
export function addCartridgeToShelf(shelf, cart) {
  // Collect existing carts so we can reposition the full row.
  const existing = shelf.children.filter((c) => c.userData?.kind === 'cartridge');
  const all = [...existing, cart];

  // Widen the plank and bracket to fit the new count (mirrors createShelf).
  // createShelf adds plank first, then bracket — both are non-cartridge Mesh children.
  const plankW = plankWidthFor(all.length);
  const nonCartMeshes = shelf.children.filter((c) => c.isMesh && !c.userData?.kind);
  const [plank, bracket] = nonCartMeshes; // plank at index 0, bracket at index 1
  if (plank) {
    plank.geometry.dispose();
    plank.geometry = new THREE.BoxGeometry(plankW, SHELF_THICK, SHELF_DEPTH);
  }
  if (bracket) {
    bracket.geometry.dispose();
    bracket.geometry = new THREE.BoxGeometry(plankW, SHELF_THICK * 0.6, 0.01);
  }

  // Re-centre all carts (same slot layout as createShelf).
  const startX = -(all.length - 1) * SLOT_SPACING / 2;
  all.forEach((c, i) => {
    const x = startX + i * SLOT_SPACING;
    const y = SHELF_THICK / 2 + CARTRIDGE_DIMS.H / 2;
    c.position.set(x, y, 0);
    c.quaternion.identity();
    c.rotation.x = -0.08; // same back-lean as createShelf
    if (!shelf.children.includes(c)) shelf.add(c);
  });

  lockShelfHomes(shelf);
  return cart;
}
