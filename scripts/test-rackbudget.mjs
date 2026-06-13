// Unit tests for src/RackBudget.js (pure rack admission policy).
//
// Run standalone:  node scripts/test-rackbudget.mjs
// Or via npm test: wired into package.json test chain.

import { planLive } from '../src/RackBudget.js';
import { DEFAULT_RACK_BUDGET, DEFAULT_MAX_LIVE } from '../src/systems.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`,
  JSON.stringify(got) === JSON.stringify(want));

console.log('--- defaults sanity ---');
ok('budget default is 4', DEFAULT_RACK_BUDGET === 4);
ok('maxLive default is 3', DEFAULT_MAX_LIVE === 3);

console.log('--- proven config: nes+gb+snes (1+1+2=4) all live ---');
{
  const r = planLive([
    { id: 'nes', weight: 1 },
    { id: 'gb', weight: 1 },
    { id: 'snes', weight: 2 },
  ]);
  eq('all three live', r.live.sort(), ['gb', 'nes', 'snes']);
  eq('none paused', r.paused, []);
  ok('liveWeight = 4', r.liveWeight === 4);
}

console.log('--- over budget by weight: 4th light core paused ---');
{
  const r = planLive([
    { id: 'snes', weight: 2 },
    { id: 'md', weight: 2 },
    { id: 'nes', weight: 1 },   // 2+2+1 = 5 > 4 → paused
  ]);
  eq('snes+md live (weight 4)', r.live, ['snes', 'md']);
  eq('nes paused', r.paused, ['nes']);
  ok('liveWeight = 4', r.liveWeight === 4);
}

console.log('--- maxLive cap: four weight-1 cores, only 3 live ---');
{
  const r = planLive([
    { id: 'a', weight: 1 }, { id: 'b', weight: 1 },
    { id: 'c', weight: 1 }, { id: 'd', weight: 1 },
  ], { budget: 10, maxLive: 3 });   // budget allows 4, cap stops at 3
  eq('three live', r.live, ['a', 'b', 'c']);
  eq('fourth paused', r.paused, ['d']);
}

console.log('--- focused console is always live, even over budget ---');
{
  const r = planLive([
    { id: 'light1', weight: 1 },
    { id: 'light2', weight: 1 },
    { id: 'heavy', weight: 9, focused: true },  // 9 > budget 4, but focused
  ]);
  ok('heavy (focused) is live', r.live.includes('heavy'));
  ok('heavy is first (highest priority)', r.live[0] === 'heavy');
  // After the focused 9-weight core, no budget remains for the others.
  eq('others paused', r.paused.sort(), ['light1', 'light2']);
}

console.log('--- focus wins the first slot, rest fill remaining budget ---');
{
  const r = planLive([
    { id: 'nes', weight: 1 },
    { id: 'snes', weight: 2, focused: true },
    { id: 'gb', weight: 1 },
  ]);
  // focus snes(2) first, then nes(1)=3, then gb(1)=4 → all fit budget 4.
  eq('snes first', r.live[0], 'snes');
  eq('all live', r.live.sort(), ['gb', 'nes', 'snes']);
  eq('none paused', r.paused, []);
}

console.log('--- empty / defaults ---');
{
  eq('empty → nothing', planLive([]).live, []);
  const r = planLive([{ id: 'x' }]); // weight defaults to 1
  eq('single defaults live', r.live, ['x']);
  ok('default weight 1', r.liveWeight === 1);
}

console.log('--- single heavy core within budget ---');
{
  const r = planLive([{ id: 'n64', weight: 3 }], { budget: 4 });
  eq('one heavy live', r.live, ['n64']);
  // a second core of weight 2 would push to 5 > 4
  const r2 = planLive([{ id: 'n64', weight: 3 }, { id: 'snes', weight: 2 }], { budget: 4 });
  eq('heavy live, snes paused', r2.live, ['n64']);
  eq('snes paused', r2.paused, ['snes']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
