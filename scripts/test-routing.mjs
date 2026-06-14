// Unit tests for src/Routing.js — console-aware routing policy.
// Run standalone:  node scripts/test-routing.mjs   (also wired into npm test)

import { computeRouting } from '../src/Routing.js';

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}`); }
};

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

/** Make a minimal fake controller object. */
function makeCtrl(id) { return { _id: id }; }

/**
 * Build the standard injected accessors from a plain description.
 *
 * @param {object} opts
 * @param {Map<ctrl, string|null>} opts.heldMap  ctrl → cableId (null = holds nothing)
 * @param {Set<ctrl>}              opts.freeSet   controllers that hold nothing
 * @param {Map<string, {consoleId:string,player:number}|null>} opts.seats
 *        cableId → seat or null (null = unplugged)
 */
function makeAccessors({ heldMap = new Map(), freeSet = new Set(), seats = new Map() } = {}) {
  return {
    heldObject(ctrl) {
      const cableId = heldMap.get(ctrl);
      if (cableId == null) return null;
      return { userData: { kind: 'gamepad', cableId } };
    },
    isControllerFree(ctrl) { return freeSet.has(ctrl); },
    playerOf(cableId) { return seats.has(cableId) ? seats.get(cableId) : null; },
  };
}

// ---------------------------------------------------------------------------
// 1. No held gamepad → []
// ---------------------------------------------------------------------------
console.log('--- none held → []');
{
  const [c0, c1] = [makeCtrl('c0'), makeCtrl('c1')];
  const acc = makeAccessors({ freeSet: new Set([c0, c1]) });
  const r = computeRouting({ controllers: [c0, c1], ...acc });
  ok('empty array', Array.isArray(r) && r.length === 0);
}

// ---------------------------------------------------------------------------
// 2. One held + UNPLUGGED (playerOf→null) → []   ← THE bug-fix assertion
// ---------------------------------------------------------------------------
console.log('--- one held + unplugged → [] (bug fix)');
{
  const [c0, c1] = [makeCtrl('c0'), makeCtrl('c1')];
  const heldMap = new Map([[c0, 'gp-1']]);
  const freeSet = new Set([c1]);
  const seats = new Map([['gp-1', null]]);   // explicitly unplugged
  const acc = makeAccessors({ heldMap, freeSet, seats });
  const r = computeRouting({ controllers: [c0, c1], ...acc });
  ok('unplugged held → empty', r.length === 0);
  // Must NOT silently route to player 1
  ok('does not contain player 1', !r.some(e => e.player === 1));
  ok('does not contain consoleId', !r.some(e => e.consoleId != null));
}

// ---------------------------------------------------------------------------
// 3. One held + plugged (console0, player 1) + one free → both hands same seat
// ---------------------------------------------------------------------------
console.log('--- one held + plugged + one free → holding+free both on {console0, 1}');
{
  const [c0, c1] = [makeCtrl('c0'), makeCtrl('c1')];
  const heldMap = new Map([[c0, 'gp-1']]);
  const freeSet = new Set([c1]);
  const seats = new Map([['gp-1', { consoleId: 'console0', player: 1 }]]);
  const acc = makeAccessors({ heldMap, freeSet, seats });
  const r = computeRouting({ controllers: [c0, c1], ...acc });
  ok('two entries', r.length === 2);
  const holding = r.find(e => e.hand === 'holding');
  const free    = r.find(e => e.hand === 'free');
  ok('holding entry exists',         holding != null);
  ok('free entry exists',            free    != null);
  ok('holding.ctrl = c0',            holding?.ctrl === c0);
  ok('free.ctrl = c1',               free?.ctrl    === c1);
  ok('holding consoleId = console0', holding?.consoleId === 'console0');
  ok('free    consoleId = console0', free?.consoleId    === 'console0');
  ok('holding player = 1',           holding?.player === 1);
  ok('free    player = 1',           free?.player    === 1);
}

// ---------------------------------------------------------------------------
// 4. One held + plugged into console1 as player 2 → driving {console1, 2}
// ---------------------------------------------------------------------------
console.log('--- one held + plugged into console1 / player 2');
{
  const [c0] = [makeCtrl('c0')];
  const heldMap = new Map([[c0, 'gp-2']]);
  const freeSet = new Set();
  const seats = new Map([['gp-2', { consoleId: 'console1', player: 2 }]]);
  const acc = makeAccessors({ heldMap, freeSet, seats });
  const r = computeRouting({ controllers: [c0], ...acc });
  ok('one entry',              r.length === 1);
  ok('hand = holding',         r[0]?.hand      === 'holding');
  ok('consoleId = console1',   r[0]?.consoleId === 'console1');
  ok('player = 2',             r[0]?.player    === 2);
  ok('ctrl = c0',              r[0]?.ctrl      === c0);
}

// ---------------------------------------------------------------------------
// 5. Two held, both plugged into DIFFERENT consoles → each drives its OWN seat
//    gp-1→{console0,1}, gp-2→{console1,1}
//    BUG-SCENARIO: controller 2 must NOT drive console0/player1
// ---------------------------------------------------------------------------
console.log('--- two held, different consoles → each drives own seat');
{
  const [c0, c1] = [makeCtrl('c0'), makeCtrl('c1')];
  const heldMap = new Map([[c0, 'gp-1'], [c1, 'gp-2']]);
  const freeSet = new Set();
  const seats = new Map([
    ['gp-1', { consoleId: 'console0', player: 1 }],
    ['gp-2', { consoleId: 'console1', player: 1 }],
  ]);
  const acc = makeAccessors({ heldMap, freeSet, seats });
  const r = computeRouting({ controllers: [c0, c1], ...acc });
  ok('two entries',                  r.length === 2);
  const e0 = r.find(e => e.ctrl === c0);
  const e1 = r.find(e => e.ctrl === c1);
  ok('c0 drives console0',           e0?.consoleId === 'console0');
  ok('c0 player = 1',                e0?.player    === 1);
  ok('c1 drives console1',           e1?.consoleId === 'console1');
  ok('c1 player = 1 (its own seat)', e1?.player    === 1);
  // The key assertion: c1 must NOT be routed to console0
  ok('c1 does NOT drive console0',   e1?.consoleId !== 'console0');
  ok('both hand=holding',            r.every(e => e.hand === 'holding'));
}

// ---------------------------------------------------------------------------
// 6. Two held, one plugged + one unplugged → only plugged one appears
// ---------------------------------------------------------------------------
console.log('--- two held, one unplugged → only plugged appears');
{
  const [c0, c1] = [makeCtrl('c0'), makeCtrl('c1')];
  const heldMap = new Map([[c0, 'gp-1'], [c1, 'gp-X']]);
  const freeSet = new Set();
  const seats = new Map([
    ['gp-1', { consoleId: 'console0', player: 1 }],
    ['gp-X', null],   // unplugged
  ]);
  const acc = makeAccessors({ heldMap, freeSet, seats });
  const r = computeRouting({ controllers: [c0, c1], ...acc });
  ok('only one entry',       r.length === 1);
  ok('entry is c0',          r[0]?.ctrl      === c0);
  ok('consoleId = console0', r[0]?.consoleId === 'console0');
  ok('player = 1',           r[0]?.player    === 1);
  ok('c1 not present',       !r.some(e => e.ctrl === c1));
}

// ---------------------------------------------------------------------------
// 7. Every returned entry has the required fields: ctrl, consoleId, player, hand
// ---------------------------------------------------------------------------
console.log('--- every entry has required fields');
{
  const [c0, c1, c2] = [makeCtrl('c0'), makeCtrl('c1'), makeCtrl('c2')];
  // Two held (c0 + c1), c2 is free
  const heldMap = new Map([[c0, 'gp-1'], [c1, 'gp-2']]);
  const freeSet = new Set([c2]);
  const seats = new Map([
    ['gp-1', { consoleId: 'console0', player: 1 }],
    ['gp-2', { consoleId: 'console0', player: 2 }],
  ]);
  const acc = makeAccessors({ heldMap, freeSet, seats });
  const r = computeRouting({ controllers: [c0, c1, c2], ...acc });
  ok('non-empty', r.length > 0);
  for (const e of r) {
    ok(`entry has ctrl (${e.ctrl?._id})`,      'ctrl'      in e);
    ok(`entry has consoleId (${e.ctrl?._id})`, 'consoleId' in e && e.consoleId != null);
    ok(`entry has player (${e.ctrl?._id})`,    'player'    in e && typeof e.player === 'number');
    ok(`entry has hand (${e.ctrl?._id})`,      'hand'      in e && (e.hand === 'holding' || e.hand === 'free'));
  }
}

// ---------------------------------------------------------------------------
// 8. Two held, both on SAME console different players → each drives its own player
// ---------------------------------------------------------------------------
console.log('--- two held, same console different players');
{
  const [c0, c1] = [makeCtrl('c0'), makeCtrl('c1')];
  const heldMap = new Map([[c0, 'gp-1'], [c1, 'gp-2']]);
  const freeSet = new Set();
  const seats = new Map([
    ['gp-1', { consoleId: 'console0', player: 1 }],
    ['gp-2', { consoleId: 'console0', player: 2 }],
  ]);
  const acc = makeAccessors({ heldMap, freeSet, seats });
  const r = computeRouting({ controllers: [c0, c1], ...acc });
  ok('two entries',   r.length === 2);
  const e0 = r.find(e => e.ctrl === c0);
  const e1 = r.find(e => e.ctrl === c1);
  ok('c0 player=1',   e0?.player === 1);
  ok('c1 player=2',   e1?.player === 2);
  ok('same console',  e0?.consoleId === e1?.consoleId);
}

// ---------------------------------------------------------------------------
// 9. Two held, BOTH unplugged → []
// ---------------------------------------------------------------------------
console.log('--- two held, both unplugged → []');
{
  const [c0, c1] = [makeCtrl('c0'), makeCtrl('c1')];
  const heldMap = new Map([[c0, 'gp-X'], [c1, 'gp-Y']]);
  const freeSet = new Set();
  const seats = new Map([['gp-X', null], ['gp-Y', null]]);
  const acc = makeAccessors({ heldMap, freeSet, seats });
  const r = computeRouting({ controllers: [c0, c1], ...acc });
  ok('empty (both unplugged)', r.length === 0);
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
