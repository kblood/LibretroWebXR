// Unit tests for src/RackMgr.js — the live/paused orchestration over the budget.
// Uses fake runtimes (no browser/cores needed): each fake records pause/resume.
//
// Run standalone:  node scripts/test-rackmgr.mjs
// Or via npm test: wired into package.json test chain.

import { RackMgr } from '../src/RackMgr.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`,
  JSON.stringify(got) === JSON.stringify(want));

// Minimal ConsoleRuntime stand-in.
function fakeRuntime(id, weight, { loaded = true, live = true } = {}) {
  return {
    id, weight, _loaded: loaded, _live: live,
    inputs: [],
    isLoaded() { return this._loaded; },
    isLive() { return this._live; },
    pause() { this._live = false; },
    resume() { this._live = true; },
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
