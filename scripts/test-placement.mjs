// Unit tests for src/Placement.js
//
// Covers:
//   • roomBoundsFromDims()   — correct inner extents
//   • clampToRoom()          — inside-room invariant; outside points pushed in
//   • snapToSurface() floor  — Y set to RESTING_Y, XZ untouched
//   • snapToSurface() wall   — nearest wall chosen, depth offset applied, yaw correct
//   • DEFAULT_ROOM_BOUNDS    — matches the 6×8×3.2 m room in SceneMgr
//   • footprintForKind()     — known kinds + fallback
//
// Run standalone:  node scripts/test-placement.mjs
// Or via npm test: wired into package.json test chain.

import {
  roomBoundsFromDims, clampToRoom, snapToSurface,
  RESTING_Y, POSTER_DEPTH_OFFSET, SURFACE_KIND,
  DEFAULT_ROOM_BOUNDS, footprintForKind,
} from '../src/Placement.js';

let pass = 0, fail = 0;

const ok = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}`); }
};

const near = (name, got, want, tol = 1e-9) => {
  if (Math.abs(got - want) <= tol) { pass++; }
  else { fail++; console.error(`FAIL  ${name}  got=${got}  want=${want}`); }
};

const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL  ${name}\n  got:  ${g}\n  want: ${w}`); }
};

// ---------------------------------------------------------------------------
// roomBoundsFromDims
// ---------------------------------------------------------------------------

{
  const b = roomBoundsFromDims({ w: 6, d: 8, h: 3.2 });
  near('bounds minX', b.minX, -3);
  near('bounds maxX', b.maxX,  3);
  near('bounds minZ', b.minZ, -4);
  near('bounds maxZ', b.maxZ,  4);
  near('bounds floorY', b.floorY, 0);
  near('bounds ceilY',  b.ceilY,  3.2);
}

// DEFAULT_ROOM_BOUNDS matches the 6×8×3.2 m room
{
  const b = DEFAULT_ROOM_BOUNDS;
  near('DEFAULT minX', b.minX, -3);
  near('DEFAULT maxX', b.maxX,  3);
  near('DEFAULT minZ', b.minZ, -4);
  near('DEFAULT maxZ', b.maxZ,  4);
}

// ---------------------------------------------------------------------------
// clampToRoom
// ---------------------------------------------------------------------------

const BOUNDS = roomBoundsFromDims({ w: 6, d: 8, h: 3.2 });
const MARGIN = 0.2;

// Points already inside → unchanged
{
  const p = { x: 0, y: 1.0, z: 0 };
  const c = clampToRoom(p, BOUNDS, MARGIN);
  near('clamp inside X', c.x, 0);
  near('clamp inside Z', c.z, 0);
  near('clamp Y unchanged', c.y, p.y); // clamp never touches Y
}

// Point to the left of the left wall
{
  const p = { x: -99, y: 1.0, z: 0 };
  const c = clampToRoom(p, BOUNDS, MARGIN);
  near('clamp left wall', c.x, BOUNDS.minX + MARGIN);
}

// Point to the right of the right wall
{
  const p = { x: 99, y: 1.0, z: 0 };
  const c = clampToRoom(p, BOUNDS, MARGIN);
  near('clamp right wall', c.x, BOUNDS.maxX - MARGIN);
}

// Point behind the back wall
{
  const p = { x: 0, y: 1.0, z: -99 };
  const c = clampToRoom(p, BOUNDS, MARGIN);
  near('clamp back wall', c.z, BOUNDS.minZ + MARGIN);
}

// Point past the front wall
{
  const p = { x: 0, y: 1.0, z: 99 };
  const c = clampToRoom(p, BOUNDS, MARGIN);
  near('clamp front wall', c.z, BOUNDS.maxZ - MARGIN);
}

// Corner: both X and Z outside
{
  const p = { x: 100, y: 2.0, z: -100 };
  const c = clampToRoom(p, BOUNDS, MARGIN);
  near('clamp corner X', c.x, BOUNDS.maxX - MARGIN);
  near('clamp corner Z', c.z, BOUNDS.minZ + MARGIN);
}

// Immutability: original pos not mutated
{
  const p = { x: 99, y: 0, z: 99 };
  clampToRoom(p, BOUNDS, MARGIN);
  near('clamp does not mutate X', p.x, 99);
}

// ---------------------------------------------------------------------------
// snapToSurface — floor kinds
// ---------------------------------------------------------------------------

for (const kind of ['shelf', 'console', 'gamepad', 'bookcase', 'cupboard', 'table', 'portal']) {
  const p = { x: 1.0, y: 2.5, z: -1.5 };
  const { pos, yaw } = snapToSurface(p, BOUNDS, kind);
  near(`floor snap ${kind} Y = RESTING_Y`, pos.y, RESTING_Y[kind] ?? 0);
  near(`floor snap ${kind} X unchanged`,   pos.x, p.x);
  near(`floor snap ${kind} Z unchanged`,   pos.z, p.z);
  near(`floor snap ${kind} yaw = 0`,       yaw,   0);
  ok(`SURFACE_KIND ${kind} = floor`, SURFACE_KIND[kind] === 'floor');
}

// ---------------------------------------------------------------------------
// snapToSurface — wall snap (poster)
// ---------------------------------------------------------------------------

// Nearest wall: back (Z = minZ = -4).  Place point near back wall.
{
  const p = { x: 0.5, y: 1.5, z: -3.8 };
  const { pos, yaw } = snapToSurface(p, BOUNDS, 'poster');
  near('wall snap back: Z = minZ + offset', pos.z, BOUNDS.minZ + POSTER_DEPTH_OFFSET);
  near('wall snap back: X unchanged', pos.x, p.x);
  near('wall snap back: yaw = 0', yaw, 0); // faces +Z (into the room)
}

// Nearest wall: front (Z = maxZ = +4). Place point near front wall.
{
  const p = { x: 0.5, y: 1.5, z: 3.8 };
  const { pos, yaw } = snapToSurface(p, BOUNDS, 'poster');
  near('wall snap front: Z = maxZ - offset', pos.z, BOUNDS.maxZ - POSTER_DEPTH_OFFSET);
  near('wall snap front: yaw = π', yaw, Math.PI);
}

// Nearest wall: left (X = minX = -3). Place point near left wall.
{
  const p = { x: -2.9, y: 1.5, z: 0 };
  const { pos, yaw } = snapToSurface(p, BOUNDS, 'poster');
  near('wall snap left: X = minX + offset', pos.x, BOUNDS.minX + POSTER_DEPTH_OFFSET);
  near('wall snap left: Z unchanged', pos.z, p.z);
  near('wall snap left: yaw = -π/2', yaw, -Math.PI / 2);
}

// Nearest wall: right (X = maxX = +3). Place point near right wall.
{
  const p = { x: 2.9, y: 1.5, z: 0 };
  const { pos, yaw } = snapToSurface(p, BOUNDS, 'poster');
  near('wall snap right: X = maxX - offset', pos.x, BOUNDS.maxX - POSTER_DEPTH_OFFSET);
  near('wall snap right: yaw = +π/2', yaw, Math.PI / 2);
}

// Wall snap Y is preserved (poster height stays as-is)
{
  const p = { x: 0, y: 1.8, z: -3.9 };
  const { pos } = snapToSurface(p, BOUNDS, 'poster');
  near('wall snap Y preserved', pos.y, 1.8);
}

// Immutability: original pos not mutated by snapToSurface
{
  const p = { x: 0, y: 1.5, z: -3.9 };
  snapToSurface(p, BOUNDS, 'poster');
  near('snap does not mutate z', p.z, -3.9);
}

// ---------------------------------------------------------------------------
// footprintForKind
// ---------------------------------------------------------------------------

{
  const fp = footprintForKind('shelf');
  ok('footprint shelf width > 0', fp.width > 0);
  ok('footprint shelf depth > 0', fp.depth > 0);
}
{
  const fp = footprintForKind('poster');
  ok('footprint poster width > 0', fp.width > 0);
}
{
  const fp = footprintForKind('unknown_prop_xyz');
  ok('footprint unknown falls back', fp.width > 0 && fp.depth > 0);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
