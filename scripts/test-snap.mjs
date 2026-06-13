// Unit tests for src/Snap.js — the pure nearest-jack snap decision.
// Run standalone:  node scripts/test-snap.mjs   (also wired into npm test)

import { nearestAnchor } from '../src/Snap.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
