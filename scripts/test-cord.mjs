// Unit tests for src/Cord.js (pure cord-curve sampling).
//
// Covers:
//   • cordCurvePoints() endpoints match from/to exactly
//   • point count = segments + 1
//   • midpoint sags DOWN (lower Y than the straight-line midpoint)
//   • sag is clamped between sagMin and sagMax
//   • XZ stays on the straight line (sag is Y-only)
//   • a zero-length span degrades gracefully (sag clamped to sagMin)
//
// Run standalone:  node scripts/test-cord.mjs
// Or via npm test: wired into package.json test chain.

import { cordCurvePoints } from '../src/Cord.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL  ${name}`); } };
const near = (name, got, want, tol = 1e-9) => {
  if (Math.abs(got - want) <= tol) pass++;
  else { fail++; console.error(`FAIL  ${name}  got=${got}  want=${want}`); }
};

console.log('--- cordCurvePoints: endpoints ---');
{
  const from = { x: 0, y: 1, z: 0 }, to = { x: 1, y: 1, z: 0 };
  const pts = cordCurvePoints(from, to, { segments: 10 });
  ok('count = segments+1', pts.length === 11);
  near('first.x', pts[0].x, from.x);
  near('first.y', pts[0].y, from.y);
  near('first.z', pts[0].z, from.z);
  near('last.x', pts[pts.length - 1].x, to.x);
  near('last.y', pts[pts.length - 1].y, to.y);
  near('last.z', pts[pts.length - 1].z, to.z);
}

console.log('--- cordCurvePoints: sag ---');
{
  const from = { x: 0, y: 1, z: 0 }, to = { x: 2, y: 1, z: 0 };
  const pts = cordCurvePoints(from, to, { segments: 2 });
  // Middle sample is index 1; straight-line midpoint Y would be 1.0.
  ok('midpoint sags below straight line', pts[1].y < 1.0);
  near('midpoint x on the line', pts[1].x, 1.0);
  near('midpoint z on the line', pts[1].z, 0.0);
}

console.log('--- cordCurvePoints: sag clamp (long span) ---');
{
  const from = { x: 0, y: 2, z: 0 }, to = { x: 100, y: 2, z: 0 };
  const pts = cordCurvePoints(from, to, { segments: 2, sagMax: 0.35 });
  const droop = 2 - pts[1].y; // how far the midpoint dropped
  near('long-span sag clamped to sagMax', droop, 0.35, 1e-9);
}

console.log('--- cordCurvePoints: sag clamp (zero span) ---');
{
  const p = { x: 1, y: 1, z: 1 };
  const pts = cordCurvePoints(p, p, { segments: 2, sagMin: 0.02 });
  const droop = 1 - pts[1].y;
  near('zero-span sag clamped to sagMin', droop, 0.02, 1e-9);
}

console.log('--- cordCurvePoints: XZ stays on the line ---');
{
  const from = { x: -1, y: 1.5, z: -2 }, to = { x: 3, y: 0.8, z: 4 };
  const pts = cordCurvePoints(from, to, { segments: 8 });
  let onLine = true;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const wantX = from.x + (to.x - from.x) * t;
    const wantZ = from.z + (to.z - from.z) * t;
    if (Math.abs(pts[i].x - wantX) > 1e-9 || Math.abs(pts[i].z - wantZ) > 1e-9) onLine = false;
  }
  ok('all samples lie on the XZ line', onLine);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
