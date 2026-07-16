// Unit tests for src/Snap.js — the pure nearest-jack snap decision.
// Run standalone:  node scripts/test-snap.mjs   (also wired into npm test)

import { nearestAnchor, nearestAnchorAlongRay } from '../src/Snap.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL  ${name}`); } };

const jacks = [
  { id: 'tv0', x: 0, y: 1.5, z: -3.6 },
  { id: 'tv1', x: 2.6, y: 1.5, z: -3.6 },
  { id: 'tv2', x: 5.0, y: 1.5, z: -3.6 },
];

console.log('--- picks the closest within radius ---');
{
  const r = nearestAnchor({ x: 0.1, y: 1.5, z: -3.6 }, jacks, 0.3);
  ok('nearest is tv0', r && r.id === 'tv0');
  ok('dist ~0.1', r && Math.abs(r.dist - 0.1) < 1e-6);
}

console.log('--- returns null when nothing is within radius ---');
{
  const r = nearestAnchor({ x: 1.0, y: 1.5, z: -3.6 }, jacks, 0.3);
  ok('no jack within 0.3m', r === null);
}

console.log('--- picks tv1 when plug is dragged near it ---');
{
  const r = nearestAnchor({ x: 2.5, y: 1.55, z: -3.55 }, jacks, 0.3);
  ok('nearest is tv1', r && r.id === 'tv1');
}

console.log('--- accept filter excludes occupied jacks ---');
{
  const occupied = new Set(['tv0']);
  // Radius 3m so the next-nearest free jack (tv1 at 2.55) IS in range: the
  // filter must skip the closer-but-occupied tv0 and pick tv1.
  const r = nearestAnchor({ x: 0.05, y: 1.5, z: -3.6 }, jacks, 3.0,
    (a) => !occupied.has(a.id));
  ok('skips occupied tv0', r && r.id === 'tv1');
}

console.log('--- accept filter with no free jack in range → null ---');
{
  const occupied = new Set(['tv0']);
  const r = nearestAnchor({ x: 0.05, y: 1.5, z: -3.6 }, jacks, 0.5,
    (a) => !occupied.has(a.id));
  ok('null when only in-range jack is occupied', r === null);
}

console.log('--- empty / missing inputs are safe ---');
{
  ok('no anchors', nearestAnchor({ x: 0, y: 0, z: 0 }, [], 1) === null);
  ok('null point', nearestAnchor(null, jacks, 1) === null);
  ok('null anchors', nearestAnchor({ x: 0, y: 0, z: 0 }, null, 1) === null);
}

console.log('--- exactly at the radius boundary is excluded (strict <) ---');
{
  const r = nearestAnchor({ x: 0.3, y: 1.5, z: -3.6 }, [{ id: 'a', x: 0, y: 1.5, z: -3.6 }], 0.3);
  ok('boundary excluded', r === null);
}

// --- nearestAnchorAlongRay -------------------------------------------------

console.log('--- ray hits an anchor within tolerance ---');
{
  const r = nearestAnchorAlongRay(
    { x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, jacks,
    { maxDist: 5, maxPerp: 0.3 },
  );
  ok('hits tv0', r && r.id === 'tv0');
  ok('along ~3.6', r && Math.abs(r.along - 3.6) < 1e-6);
  ok('perp ~0', r && r.perp < 1e-6);
}

console.log('--- ray misses beyond maxPerp ---');
{
  // Aim straight down -Z from x=1: perpendicular distance to every jack's
  // x is at least 1m, well past a 0.3m tolerance.
  const r = nearestAnchorAlongRay(
    { x: 1, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, jacks,
    { maxDist: 5, maxPerp: 0.3 },
  );
  ok('no anchor within maxPerp', r === null);
}

console.log('--- ray misses beyond maxDist ---');
{
  const r = nearestAnchorAlongRay(
    { x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, jacks,
    { maxDist: 2, maxPerp: 0.3 },
  );
  ok('tv0 at 3.6m is past maxDist=2', r === null);
}

console.log('--- ray behind the anchor (negative projection) is excluded ---');
{
  const r = nearestAnchorAlongRay(
    { x: 0, y: 1.5, z: -5 }, { x: 0, y: 0, z: -1 }, jacks,
    { maxDist: 5, maxPerp: 0.3 },
  );
  ok('tv0 is behind the ray origin', r === null);
}

console.log('--- picks the most precisely aimed-at anchor among several ---');
{
  // Ray points exactly at tv1 (perp=0); widen maxPerp so tv0/tv2 are also
  // technically within tolerance — tv1 must still win on smallest perp dist.
  const r = nearestAnchorAlongRay(
    { x: 2.5, y: 1.5, z: 0 }, { x: 0.1, y: 0, z: -3.6 }, jacks,
    { maxDist: 10, maxPerp: 3.0 },
  );
  ok('picks tv1 (smallest perpendicular distance)', r && r.id === 'tv1');
  ok('perp ~0', r && r.perp < 1e-6);
}

console.log('--- accept filter excludes anchors from ray matching ---');
{
  const occupied = new Set(['tv0']);
  const r = nearestAnchorAlongRay(
    { x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, jacks,
    { maxDist: 5, maxPerp: 0.3, accept: (a) => !occupied.has(a.id) },
  );
  ok('skips occupied tv0', r === null);
}

console.log('--- empty / missing inputs are safe (ray) ---');
{
  ok('no anchors', nearestAnchorAlongRay({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, [], {}) === null);
  ok('null origin', nearestAnchorAlongRay(null, { x: 0, y: 0, z: -1 }, jacks, {}) === null);
  ok('null dir', nearestAnchorAlongRay({ x: 0, y: 0, z: 0 }, null, jacks, {}) === null);
  ok('zero-length dir', nearestAnchorAlongRay({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, jacks, {}) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
