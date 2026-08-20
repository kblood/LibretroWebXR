// Unit tests for the rack's shared registries ([[src/ConsoleRegistry.js]]).
//
// WHY THIS SUITE EXISTS. src/main.js has no test coverage — nothing under
// scripts/ imports it — so "the tests stayed green" proves exactly nothing about
// a change made inside it. ConsoleRegistry is step 0 of the P2 #12 extraction
// (the prerequisite hoist that PowerMgr and the cord blocks both consume), and
// this suite is the safety net that makes the hoist worth doing: it drives the
// REAL module, not a copy of its logic. Copied-logic tests are worse than none
// during a refactor — they keep passing while the copy and the original drift.
//
// Pure logic: no DOM, no WebGL, no ports, no imports beyond the module itself.

import { createConsoleRegistry } from '../src/ConsoleRegistry.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

const makeGrab = () => {
  const added = [];
  return { added, addGrabbable: (o) => added.push(o) };
};

// --- 1. Power predicates: ABSENT means ON --------------------------------------
// This is the rule the whole power system rests on (a console nobody ever
// touched must render, not sit blanked), and it is why the predicates test
// `!== false` rather than truthiness.
{
  const r = createConsoleRegistry({ getGrabMgr: () => null });
  ok(r.isConsoleOn('console0') === true, 'unknown console reads as ON');
  ok(r.isTvOn('tv0') === true, 'unknown tv reads as ON');
  r.consolePowered.set('console0', false);
  ok(r.isConsoleOn('console0') === false, 'explicit false reads as OFF');
  r.consolePowered.set('console0', true);
  ok(r.isConsoleOn('console0') === true, 'back to true reads as ON');
  r.tvPowered.set('tv0', false);
  ok(r.isTvOn('tv0') === false, 'tv explicit false reads as OFF');
  // undefined is not false — a delete must restore the default, not blank the TV.
  r.tvPowered.delete('tv0');
  ok(r.isTvOn('tv0') === true, 'deleting the entry restores the ON default');
}

// --- 2. Each registry instance owns its own state ------------------------------
{
  const a = createConsoleRegistry({ getGrabMgr: () => null });
  const b = createConsoleRegistry({ getGrabMgr: () => null });
  a.consoleObjs.set('console0', {});
  a._consoleSystems.set('console0', 'nes');
  a.consolePowered.set('console0', false);
  ok(b.consoleObjs.size === 0, 'consoleObjs is per-instance');
  ok(b._consoleSystems.size === 0, '_consoleSystems is per-instance');
  ok(b.isConsoleOn('console0') === true, 'power state is per-instance');
  ok(a.consoleObjs instanceof Map && a._consoleSystems instanceof Map, 'both registries are Maps');
}

// --- 3. registerMovableProp reads grabMgr LATE ---------------------------------
// The whole reason the dependency is a getter: main.js's `grabMgr` is null when
// the registry is constructed and only assigned when buildCartridgeWorld runs.
// A value captured at construction would make this a permanent no-op.
{
  let grabMgr = null;
  const r = createConsoleRegistry({ getGrabMgr: () => grabMgr });
  const early = { userData: {} };
  r.registerMovableProp(early, 'console');
  ok(early.userData.editable === undefined, 'no grabMgr yet → registers nothing');
  ok(early.userData.kind === undefined, 'no grabMgr yet → does not even tag the prop');

  grabMgr = makeGrab();
  const obj = { userData: {} };
  r.registerMovableProp(obj, 'console');
  ok(obj.userData.kind === 'console', 'kind is tagged once grabMgr exists');
  ok(obj.userData.editable === true, 'prop is marked editable');
  ok(grabMgr.added.length === 1 && grabMgr.added[0] === obj, 'prop was handed to grabMgr');
}

// --- 4. registerMovableProp never overwrites an existing kind ------------------
// A TV cabinet that already declared itself 'tv' must not be relabelled by a
// caller passing a different kind — the tag drives grab/edit behaviour elsewhere.
{
  const grabMgr = makeGrab();
  const r = createConsoleRegistry({ getGrabMgr: () => grabMgr });
  const obj = { userData: { kind: 'tv' } };
  r.registerMovableProp(obj, 'console');
  ok(obj.userData.kind === 'tv', 'existing kind is preserved');
  ok(obj.userData.editable === true, 'editable is still set');
  ok(grabMgr.added.length === 1, 'still registered as grabbable');
}

// --- 5. A null prop is a no-op, not a crash ------------------------------------
// Call sites pass `consoleObjs.get(id)` and `scene.getTV(id)?.group` straight
// in, so undefined is a normal input here.
{
  const grabMgr = makeGrab();
  const r = createConsoleRegistry({ getGrabMgr: () => grabMgr });
  let threw = false;
  try { r.registerMovableProp(null, 'console'); r.registerMovableProp(undefined, 'tv'); }
  catch { threw = true; }
  ok(!threw, 'null/undefined props do not throw');
  ok(grabMgr.added.length === 0, 'nothing was registered');
}

console.log(`test-console-registry: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
