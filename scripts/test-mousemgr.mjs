// Unit tests for the pure MouseMgr helpers ([[src/MouseMgr.js]]):
//   • worldDeltaToMouse — world hand motion → integer libretro mouse deltas
//   • buttonsFromController — XR controller buttons → L/R bitmask
//   • stickToMouse — thumbstick deflection → continuous per-tick libretro deltas
//   • stickAxesFromController — XR controller → xr-standard thumbstick axes
// Pure logic only — no scene, no DOM. Run: node scripts/test-mousemgr.mjs
import { worldDeltaToMouse, buttonsFromController, stickToMouse, stickAxesFromController } from '../src/MouseMgr.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } };

// --- worldDeltaToMouse: axis mapping -----------------------------------------
// World X right (+) → screen right (+dx). World +Z (mouse pulled toward user) →
// screen down (+dy); world -Z (pushed away) → screen up (-dy). World Y ignored.
const gain = 1000;
eq('rest → 0,0', worldDeltaToMouse(0, 0, 0, gain), { dx: 0, dy: 0 });
eq('right 0.01m → +dx', worldDeltaToMouse(0.01, 0, 0, gain), { dx: 10, dy: 0 });
eq('left 0.01m → -dx', worldDeltaToMouse(-0.01, 0, 0, gain), { dx: -10, dy: 0 });
eq('pull back +Z → +dy (down)', worldDeltaToMouse(0, 0, 0.01, gain), { dx: 0, dy: 10 });
eq('push fwd -Z → -dy (up)', worldDeltaToMouse(0, 0, -0.01, gain), { dx: 0, dy: -10 });
eq('lift (world Y) ignored', worldDeltaToMouse(0, 0.5, 0, gain), { dx: 0, dy: 0 });
eq('diagonal', worldDeltaToMouse(0.005, 0, 0.005, gain), { dx: 5, dy: 5 });
eq('rounds to integer', worldDeltaToMouse(0.0034, 0, 0, gain), { dx: 3, dy: 0 });

// --- clamp: a teleport-sized delta is capped to MAX_STEP (default 120) --------
{
  const r = worldDeltaToMouse(10, 0, -10, 1400); // huge motion
  ok('dx clamped to +120', r.dx === 120);
  ok('dy clamped to -120', r.dy === -120);
}
// Custom maxStep honoured.
eq('custom maxStep clamps', worldDeltaToMouse(1, 0, 0, 1000, 50), { dx: 50, dy: 0 });

// --- default gain produces sane on-screen travel ------------------------------
// A 0.5 m hand sweep at the default gain should cross a ~720px Amiga screen
// (summed over frames). One 0.5 m step (unclamped concept) → 700px; per-frame it's
// clamped, but the helper's gain is the right order of magnitude.
{
  const oneStep = worldDeltaToMouse(0.001, 0, 0, 1400); // ~1.4px per mm
  ok('default-ish gain ~1.4px/mm', oneStep.dx === 1);
}

// --- buttonsFromController: trigger→left(1), squeeze→right(2) ------------------
const mk = (b0, b1) => ({ userData: { inputSource: { gamepad: { buttons: [{ pressed: b0 }, { pressed: b1 }] } } } });
eq('no controller → 0', buttonsFromController(null), 0);
eq('no gamepad → 0', buttonsFromController({ userData: {} }), 0);
eq('trigger only → 1 (left)', buttonsFromController(mk(true, false)), 1);
eq('squeeze only → 2 (right)', buttonsFromController(mk(false, true)), 2);
eq('both → 3', buttonsFromController(mk(true, true)), 3);
eq('neither → 0', buttonsFromController(mk(false, false)), 0);

// --- stickToMouse: thumbstick → continuous per-tick libretro deltas ---------
// Same screen-space convention as worldDeltaToMouse: +dx=right, +dy=down.
// xr-standard axes[3]=-1 for "pushed forward" maps directly to -dy (up),
// mirroring worldDeltaToMouse's push-mouse-forward(-Z)→-dy(up) convention.
{
  const dt = 1; // 1s, so speed alone (minus deadzone/clamp) sets the output
  eq('centred stick → 0,0', stickToMouse(0, 0, dt, 900, 0.15, 999), { dx: 0, dy: 0 });
  eq('inside deadzone → 0,0', stickToMouse(0.1, -0.1, dt, 900, 0.15, 999), { dx: 0, dy: 0 });
  ok('full-right ramps to full speed', stickToMouse(1, 0, dt, 900, 0.15, 999).dx === 900);
  ok('full-left → -speed', stickToMouse(-1, 0, dt, 900, 0.15, 999).dx === -900);
  ok('full-forward(-1) → up (negative dy)', stickToMouse(0, -1, dt, 900, 0.15, 999).dy === -900);
  ok('full-back(+1) → down (positive dy)', stickToMouse(0, 1, dt, 900, 0.15, 999).dy === 900);
  // Half-deflection (past the deadzone) ramps smoothly, not a jump.
  const half = stickToMouse(0.5, 0, dt, 900, 0.15, 999).dx;
  ok('half-deflection lands strictly between 0 and full speed', half > 0 && half < 900);
}
// dt scales the output — a shorter tick moves proportionally less.
eq('dt halves the per-tick delta', stickToMouse(1, 0, 0.5, 900, 0, 999), { dx: 450, dy: 0 });
// The clamp still applies (protects against a huge dt spike, e.g. a
// backgrounded tab resuming) — same MAX_STEP-style guard as worldDeltaToMouse.
{
  const r = stickToMouse(1, 1, 10, 900, 0, 120); // 10s dt would be 9000px unclamped
  ok('dx clamped', r.dx === 120);
  ok('dy clamped', r.dy === 120);
}

// --- stickAxesFromController: xr-standard axes[2]/[3] extraction ------------
const mkAxes = (x, y) => ({ userData: { inputSource: { gamepad: { axes: [0, 0, x, y] } } } });
eq('no controller → 0,0', stickAxesFromController(null), { x: 0, y: 0 });
eq('no gamepad → 0,0', stickAxesFromController({ userData: {} }), { x: 0, y: 0 });
eq('short axes array → 0,0', stickAxesFromController({ userData: { inputSource: { gamepad: { axes: [0, 0] } } } }), { x: 0, y: 0 });
eq('reads axes[2]/[3]', stickAxesFromController(mkAxes(0.4, -0.7)), { x: 0.4, y: -0.7 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
