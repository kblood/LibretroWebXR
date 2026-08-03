// Unit tests for src/RackMgr.js — the live/paused orchestration over the budget.
// Uses fake runtimes (no browser/cores needed): each fake records pause/resume.
//
// Run standalone:  node scripts/test-rackmgr.mjs
// Or via npm test: wired into package.json test chain.

import { RackMgr } from '../src/RackMgr.js';
import { ConsoleRuntime } from '../src/ConsoleRuntime.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`,
  JSON.stringify(got) === JSON.stringify(want));

// Minimal ConsoleRuntime stand-in. setCanRun/runAllowed mirror the real class so
// the "a display-only client runs zero cores" gate can be tested with fakes.
function fakeRuntime(id, weight, { loaded = true, live = true } = {}) {
  return {
    id, weight, _loaded: loaded, _live: live, _canRun: null,
    inputs: [],
    isLoaded() { return this._loaded; },
    isLive() { return this._live; },
    setCanRun(fn) { this._canRun = fn || null; return this; },
    runAllowed() { return this._canRun ? this._canRun(this) !== false : true; },
    pause() { this._live = false; },
    resume() { if (!this.runAllowed()) { this._live = false; return false; } this._live = true; return true; },
    sendInput(...a) { this.inputs.push(a); },
    dispose() { this._disposed = true; },
  };
}

console.log('--- add / get / count ---');
{
  const rack = new RackMgr();
  rack.add(fakeRuntime('a', 1));
  rack.add(fakeRuntime('b', 2));
  ok('count 2', rack.count() === 2);
  ok('has a', rack.has('a'));
  eq('ids', rack.ids().sort(), ['a', 'b']);
}

console.log('--- applyBudget keeps within-budget cores live ---');
{
  const rack = new RackMgr();           // default budget 4, maxLive 3
  rack.add(fakeRuntime('nes', 1));
  rack.add(fakeRuntime('gb', 1));
  rack.add(fakeRuntime('snes', 2));
  const plan = rack.applyBudget();
  eq('all live', plan.live.sort(), ['gb', 'nes', 'snes']);
  ok('all runtimes live', rack.runtimes().every((r) => r.isLive()));
}

console.log('--- applyBudget pauses the over-budget core ---');
{
  const rack = new RackMgr();
  rack.add(fakeRuntime('snes', 2));
  rack.add(fakeRuntime('md', 2));
  const nes = rack.add(fakeRuntime('nes', 1));   // 2+2+1 = 5 > 4
  rack.applyBudget();
  ok('nes paused', !nes.isLive());
  ok('snes live', rack.get('snes').isLive());
  ok('md live', rack.get('md').isLive());
}

console.log('--- focus keeps a heavy core live and demotes others ---');
{
  const rack = new RackMgr();
  const l1 = rack.add(fakeRuntime('l1', 1));
  const l2 = rack.add(fakeRuntime('l2', 1));
  const heavy = rack.add(fakeRuntime('heavy', 9));
  rack.setFocus('heavy');
  rack.applyBudget();
  ok('heavy (focused) live', heavy.isLive());
  ok('l1 paused (no budget left)', !l1.isLive());
  ok('l2 paused (no budget left)', !l2.isLive());
}

console.log('--- changing focus re-plans (paused core resumes) ---');
{
  const rack = new RackMgr({ budget: 2, maxLive: 1 }); // only ONE live at a time
  const a = rack.add(fakeRuntime('a', 1));
  const b = rack.add(fakeRuntime('b', 1));
  rack.setFocus('a');
  rack.applyBudget();
  ok('a live', a.isLive());
  ok('b paused', !b.isLive());
  rack.setFocus('b');
  rack.applyBudget();
  ok('after focus swap: b live', b.isLive());
  ok('after focus swap: a paused', !a.isLive());
}

console.log('--- unloaded consoles do not consume budget ---');
{
  const rack = new RackMgr({ budget: 2, maxLive: 3 });
  rack.add(fakeRuntime('loaded1', 2));
  rack.add(fakeRuntime('blank', 2, { loaded: false }));  // not booted yet
  const plan = rack.applyBudget();
  eq('only loaded competes', plan.live, ['loaded1']);
  ok('blank not in plan', !plan.live.includes('blank') && !plan.paused.includes('blank'));
}

console.log('--- budget disabled keeps every console live (powerful machine) ---');
{
  const rack = new RackMgr({ budget: 2, maxLive: 1 });
  rack.setBudgetEnabled(false);
  const a = rack.add(fakeRuntime('a', 2));
  const b = rack.add(fakeRuntime('b', 2));
  const c = rack.add(fakeRuntime('c', 2));        // way over budget/maxLive
  const plan = rack.applyBudget();
  eq('all live when disabled', plan.live.sort(), ['a', 'b', 'c']);
  ok('none paused', plan.paused.length === 0);
  ok('runtimes live', a.isLive() && b.isLive() && c.isLive());
}

console.log('--- re-enabling the budget resumes pausing ---');
{
  const rack = new RackMgr({ budget: 2, maxLive: 1 });
  rack.setBudgetEnabled(false);
  rack.add(fakeRuntime('a', 2));
  const b = rack.add(fakeRuntime('b', 2));
  rack.setFocus('a');
  rack.applyBudget();
  ok('b live while disabled', b.isLive());
  rack.setBudgetEnabled(true);
  rack.applyBudget();
  ok('b paused after re-enable', !b.isLive());
}

console.log('--- single console never paused (>1 rule) ---');
{
  const rack = new RackMgr({ budget: 1, maxLive: 1 });
  const only = rack.add(fakeRuntime('only', 9));  // heavier than budget
  rack.applyBudget();
  ok('lone heavy console stays live', only.isLive());
}

console.log('--- sendInput routes to the named console only ---');
{
  const rack = new RackMgr();
  const a = rack.add(fakeRuntime('a', 1));
  const b = rack.add(fakeRuntime('b', 1));
  rack.sendInput('a', 'keydown', 'ArrowRight', 'ArrowRight', 39, 0);
  ok('a got the input', a.inputs.length === 1);
  ok('b got nothing', b.inputs.length === 0);
}

// M1.4 — the display-only netplay client. RackMgr.applyBudget() used to RESUME
// whatever main.js had paused when this machine became a watcher, so one gaze
// shift or one Auto-pause toggle put the watcher back to emulating its own copy of
// the host's game behind the host's video feed ("each computer runs its own
// game"). allowRun is the hard gate; these tests are its negative control.
console.log('--- allowRun:false suspends the whole rack (display-only client) ---');
{
  let allowed = true;
  const rack = new RackMgr({ allowRun: () => allowed });
  const a = rack.add(fakeRuntime('console0', 1));
  const b = rack.add(fakeRuntime('console1', 1));
  rack.applyBudget();
  ok('both live while allowed', a.isLive() && b.isLive());

  allowed = false;
  const plan = rack.applyBudget();
  ok('console0 paused when running is denied', !a.isLive());
  ok('console1 paused too (secondary consoles are not exempt)', !b.isLive());
  eq('plan reports nothing live', plan.live, []);
  ok('plan flags the suspension', plan.suspended === true);

  // The exact reported repro: the perf budget is toggled OFF, whose branch used to
  // resume every loaded console unconditionally.
  rack.setBudgetEnabled(false);
  rack.applyBudget();
  ok('budget-disabled branch cannot resume either', !a.isLive() && !b.isLive());
  rack.setBudgetEnabled(true);

  // …and a single-console rack, which took the same resume-everything branch.
  const solo = new RackMgr({ allowRun: () => false });
  const only = solo.add(fakeRuntime('console0', 1, { live: false }));
  solo.applyBudget();
  ok('lone console stays paused when denied', !only.isLive());

  // Promotion: the gate opens and the budget brings the rack back.
  allowed = true;
  rack.applyBudget();
  ok('promotion re-runs the rack', a.isLive() && b.isLive());
}

console.log('--- the gate reaches DIRECT runtime.resume() (power switch) ---');
{
  let allowed = false;
  const rack = new RackMgr({ allowRun: () => allowed });
  const r = rack.add(fakeRuntime('console0', 1, { live: false }));
  ok('add() injected the gate', r.runAllowed() === false);
  ok('resume() refused', r.resume() === false);
  ok('still paused', !r.isLive());
  allowed = true;
  ok('resume() allowed once promoted', r.resume() === true);
  ok('now live', r.isLive());
}

console.log('--- allowRun fails OPEN (never brick solo play) ---');
{
  const thrower = new RackMgr({ allowRun: () => { throw new Error('boom'); } });
  const r = thrower.add(fakeRuntime('console0', 1, { live: false }));
  const warn = console.warn; console.warn = () => {};   // the warning IS expected
  try { thrower.applyBudget(); } finally { console.warn = warn; }
  ok('a throwing predicate is treated as "allowed"', r.isLive());
  const none = new RackMgr();
  ok('no predicate = allowed', none.runAllowed() === true);
}

// Same gate, but against the REAL ConsoleRuntime rather than the fake above, so a
// drift between the two can't hide the regression. Adopt mode needs no document.
console.log('--- the REAL ConsoleRuntime honours the gate ---');
{
  const fakeClient = { paused: true, pause() { this.paused = true; }, resume() { this.paused = false; }, ready: true };
  let allowed = false;
  const rack = new RackMgr({ allowRun: () => allowed });
  const rt = rack.add(new ConsoleRuntime({ id: 'console0', adopt: { client: fakeClient, canvas: {} } }));
  ok('ConsoleRuntime.resume() refused while denied', rt.resume() === false);
  ok('the underlying client stayed paused', fakeClient.paused === true);
  ok('isLive() false', rt.isLive() === false);
  // A refused resume must also RE-ASSERT the pause, so a core that was already
  // running when the gate closed gets stopped by the next resume attempt too.
  fakeClient.paused = false;
  rt.resume();
  ok('a refused resume re-asserts the pause', fakeClient.paused === true);
  // The budget must not resurrect it either (adopt+ready ⇒ isLoaded() true).
  ok('isLoaded via adopt', rt.isLoaded() === true);
  rack.applyBudget();
  ok('applyBudget left it paused', fakeClient.paused === true);
  allowed = true;
  ok('resume() allowed after promotion', rt.resume() === true);
  ok('client running', fakeClient.paused === false);
  // No predicate at all (solo play / other tests): always allowed.
  const solo = new ConsoleRuntime({ id: 'c', adopt: { client: { pause() {}, resume() {} }, canvas: {} } });
  ok('no predicate = allowed', solo.runAllowed() === true && solo.resume() === true);
}

console.log('--- pauseAll stops every runtime regardless of loaded/budget ---');
{
  const rack = new RackMgr();
  const a = rack.add(fakeRuntime('console0', 1));
  const b = rack.add(fakeRuntime('console1', 1, { loaded: false }));   // mid-boot
  const c = rack.add(fakeRuntime('console2', 1, { live: false }));     // already paused
  const stopped = rack.pauseAll('display-only-client');
  ok('console0 paused', !a.isLive());
  ok('an UNLOADED (mid-boot) runtime is paused too', !b.isLive());
  eq('reports only the ones it actually stopped', stopped.sort(), ['console0', 'console1']);
  ok('already-paused console untouched', !c.isLive());
}

console.log('--- remove disposes + frees focus ---');
{
  const rack = new RackMgr();
  const a = rack.add(fakeRuntime('a', 1));
  rack.setFocus('a');
  rack.remove('a');
  ok('disposed', a._disposed === true);
  ok('count 0', rack.count() === 0);
  ok('focus cleared', rack.focusedId() === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
