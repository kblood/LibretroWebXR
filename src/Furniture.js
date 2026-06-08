// Furniture — decorative, movable room props for the in-VR editor's "Add" mode
// (bookcase / cupboard / table). Unlike a `shelf` (which holds cartridges via
// [[src/Shelf.js]]), these are plain set-dressing you arrange to furnish a room;
// wiring a bookcase to actually hold a collection is a noted follow-up.
//
// Each factory returns a THREE.Group whose ORIGIN sits at the floor-contact
// point (bottom-centre, geometry built upward from y=0), so a `pos` of
// `[x, 0, z]` stands the piece on the floor. `userData.kind` tags the type so
// the editor and serializer can identify it; the group is built like the other
// scene factories (Shelf/Console) — pure geometry, standard lit materials.

import * as THREE from 'three';

const WOOD = () => new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.8 });
const DARK_WOOD = () => new THREE.MeshStandardMaterial({ color: 0x4a3320, roughness: 0.85 });
const DOOR = () => new THREE.MeshStandardMaterial({ color: 0x5a3e24, roughness: 0.7 });
const METAL = () => new THREE.MeshStandardMaterial({ color: 0x9a9aa2, roughness: 0.4, metalness: 0.6 });

const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

/**
 * A tall open bookcase: two side panels, top/bottom, a thin back, and a few
 * fixed internal shelves. ~0.9 W × 1.8 H × 0.3 D.
 */
export function createBookcase({ position = new THREE.Vector3(0, 0, 0), rotationY = 0 } = {}) {
  const W = 0.9, H = 1.8, D = 0.3, T = 0.03;
  const group = new THREE.Group();
  group.name = 'bookcase';
  group.position.copy(position);
  group.rotation.y = rotationY;
  group.userData.kind = 'bookcase';

  const sideL = box(T, H, D, WOOD()); sideL.position.set(-(W / 2 - T / 2), H / 2, 0);
  const sideR = box(T, H, D, WOOD()); sideR.position.set(W / 2 - T / 2, H / 2, 0);
  const top = box(W, T, D, WOOD()); top.position.set(0, H - T / 2, 0);
  const bottom = box(W, T, D, WOOD()); bottom.position.set(0, T / 2, 0);
  const back = box(W, H, 0.01, DARK_WOOD()); back.position.set(0, H / 2, -D / 2 + 0.005);
  group.add(sideL, sideR, top, bottom, back);

  // Three evenly spaced internal shelves between bottom and top.
  const innerW = W - 2 * T;
  for (let i = 1; i <= 3; i++) {
    const shelf = box(innerW, T, D, WOOD());
    shelf.position.set(0, (H * i) / 4, 0);
    group.add(shelf);
  }
  return group;
}

/**
 * A low cupboard: a closed box carcass with two front doors + round handles.
 * ~0.8 W × 0.9 H × 0.4 D.
 */
export function createCupboard({ position = new THREE.Vector3(0, 0, 0), rotationY = 0 } = {}) {
  const W = 0.8, H = 0.9, D = 0.4, T = 0.03;
  const group = new THREE.Group();
  group.name = 'cupboard';
  group.position.copy(position);
  group.rotation.y = rotationY;
  group.userData.kind = 'cupboard';

  const sideL = box(T, H, D, WOOD()); sideL.position.set(-(W / 2 - T / 2), H / 2, 0);
  const sideR = box(T, H, D, WOOD()); sideR.position.set(W / 2 - T / 2, H / 2, 0);
  const top = box(W, T, D, WOOD()); top.position.set(0, H - T / 2, 0);
  const bottom = box(W, T, D, WOOD()); bottom.position.set(0, T / 2, 0);
  const back = box(W, H, 0.01, DARK_WOOD()); back.position.set(0, H / 2, -D / 2 + 0.005);
  group.add(sideL, sideR, top, bottom, back);

  // Two doors on the front face, each half the width, with a centre handle.
  const doorW = W / 2 - 0.015;
  const doorH = H - 2 * T - 0.01;
  for (const sign of [-1, 1]) {
    const door = box(doorW, doorH, 0.02, DOOR());
    door.position.set(sign * (doorW / 2 + 0.005), H / 2, D / 2 - 0.01);
    group.add(door);
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), METAL());
    handle.position.set(sign * 0.02, H / 2, D / 2 + 0.01);
    group.add(handle);
  }
  return group;
}

/**
 * A simple four-legged table: a rectangular top on four square legs.
 * ~1.0 W × 0.74 H × 0.6 D.
 */
export function createTable({ position = new THREE.Vector3(0, 0, 0), rotationY = 0 } = {}) {
  const W = 1.0, H = 0.74, D = 0.6, TOP_T = 0.04, LEG = 0.06;
  const group = new THREE.Group();
  group.name = 'table';
  group.position.copy(position);
  group.rotation.y = rotationY;
  group.userData.kind = 'table';

  const top = box(W, TOP_T, D, WOOD());
  top.position.set(0, H - TOP_T / 2, 0);
  group.add(top);

  const legH = H - TOP_T;
  const ox = W / 2 - LEG / 2 - 0.02;
  const oz = D / 2 - LEG / 2 - 0.02;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = box(LEG, legH, LEG, DARK_WOOD());
      leg.position.set(sx * ox, legH / 2, sz * oz);
      group.add(leg);
    }
  }
  return group;
}
