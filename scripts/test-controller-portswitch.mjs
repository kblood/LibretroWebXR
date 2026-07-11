// Integration tests: a controller's cable moving between ports/consoles MID-
// SESSION must be immediately reflected by input routing — the old console
// stops receiving its input, the new console (and player number) starts, and
// any free hand "following" a held gamepad's seat (see [[src/Routing.js]])
// follows the move too. Unlike scripts/test-routing.mjs (which drives
// computeRouting from fake, static accessors) and scripts/test-patchbay.mjs
// (which checks the patch graph in isolation), this wires a REAL Patchbay
// into REAL computeRouting calls across a live re-plug, the same combination
// GameInputMgr drives every frame from the 3D grab/cable system.
// Run: node scripts/test-controller-portswitch.mjs
import { Patchbay } from '../src/Patchbay.js';
import { computeRouting } from '../src/Routing.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`,
  JSON.stringify(got) === JSON.stringify(want));

function makeCtrl(id) { return { _id: id }; }

// Build the accessors computeRouting expects, backed by a real Patchbay + a
// simple held/free description (mirrors what main.js's grabMgr provides live).
function accessorsFor(pb, { heldMap = new Map(), freeSet = new Set() } = {}) {
  return {
    heldObject(ctrl) {
      const cableId = heldMap.get(ctrl);
      if (cableId == null) return null;
      return { userData: { kind: 'gamepad', cableId } };
    },
    isControllerFree(ctrl) { return freeSet.has(ctrl); },
    playerOf(cableId) { return pb.playerOf(cableId); },
  };
}

// ---------------------------------------------------------------------------
// 1. One held controller moves from console0/port0 to console1/port1 mid-
//    session: routing must follow to the NEW console/player and stop driving
//    the old one, with no page reload or re-registration needed.
// ---------------------------------------------------------------------------
console.log('--- held controller switches console mid-session ---');
{
  const pb = new Patchbay();
  pb.addConsole('console0', { ports: 4 });
  pb.addConsole('console1', { ports: 4 });
  pb.plugController('gp-1', 'console0', 0);

  const [ctrl] = [makeCtrl('c0')];
  const heldMap = new Map([[ctrl, 'gp-1']]);
  const acc = accessorsFor(pb, { heldMap });

  let r = computeRouting({ controllers: [ctrl], ...acc });
  eq('before move: drives console0', r[0]?.consoleId, 'console0');
  eq('before move: player 1', r[0]?.player, 1);

  // Live re-plug: the SAME gamepad's cable moves to a different console/port.
  pb.plugController('gp-1', 'console1', 1);

  r = computeRouting({ controllers: [ctrl], ...acc });
  eq('after move: drives console1', r[0]?.consoleId, 'console1');
  eq('after move: player 2', r[0]?.player, 2);
  ok('after move: no entry still targets console0', !r.some(e => e.consoleId === 'console0'));
}

// ---------------------------------------------------------------------------
// 2. A FREE hand following a single held gamepad's seat must follow the same
//    live move (two-hands-one-player couch-co-op feel survives a port switch).
// ---------------------------------------------------------------------------
console.log('--- free hand follows the held controller across a console switch ---');
{
  const pb = new Patchbay();
  pb.addConsole('console0', { ports: 4 });
  pb.addConsole('console1', { ports: 4 });
  pb.plugController('gp-1', 'console0', 0);

  const [holdCtrl, freeCtrl] = [makeCtrl('hold'), makeCtrl('free')];
  const heldMap = new Map([[holdCtrl, 'gp-1']]);
  const freeSet = new Set([freeCtrl]);
  const acc = accessorsFor(pb, { heldMap, freeSet });

  let r = computeRouting({ controllers: [holdCtrl, freeCtrl], ...acc });
  ok('before move: both hands on console0', r.every(e => e.consoleId === 'console0'));

  pb.plugController('gp-1', 'console1', 2); // move to console1, port 2 (player 3)

  r = computeRouting({ controllers: [holdCtrl, freeCtrl], ...acc });
  ok('after move: both hands now on console1', r.every(e => e.consoleId === 'console1'));
  ok('after move: both hands player 3', r.every(e => e.player === 3));
  ok('after move: nothing left on console0', !r.some(e => e.consoleId === 'console0'));
}

// ---------------------------------------------------------------------------
// 3. Two controllers SWAP consoles with each other: each must drive its OWN
//    new seat post-swap, never the other's (or its own former) console.
// ---------------------------------------------------------------------------
console.log('--- two held controllers swap consoles with each other ---');
{
  const pb = new Patchbay();
  pb.addConsole('console0', { ports: 4 });
  pb.addConsole('console1', { ports: 4 });
  pb.plugController('gp-1', 'console0', 0);
  pb.plugController('gp-2', 'console1', 0);

  const [c0, c1] = [makeCtrl('c0'), makeCtrl('c1')];
  const heldMap = new Map([[c0, 'gp-1'], [c1, 'gp-2']]);
  const acc = accessorsFor(pb, { heldMap });

  let r = computeRouting({ controllers: [c0, c1], ...acc });
  eq('before swap: c0 -> console0', r.find(e => e.ctrl === c0)?.consoleId, 'console0');
  eq('before swap: c1 -> console1', r.find(e => e.ctrl === c1)?.consoleId, 'console1');

  // Swap the cables between the two consoles.
  pb.plugController('gp-1', 'console1', 3);
  pb.plugController('gp-2', 'console0', 3);

  r = computeRouting({ controllers: [c0, c1], ...acc });
  eq('after swap: c0 -> console1', r.find(e => e.ctrl === c0)?.consoleId, 'console1');
  eq('after swap: c1 -> console0', r.find(e => e.ctrl === c1)?.consoleId, 'console0');
  eq('after swap: c0 player 4', r.find(e => e.ctrl === c0)?.player, 4);
  eq('after swap: c1 player 4', r.find(e => e.ctrl === c1)?.player, 4);
}

// ---------------------------------------------------------------------------
// 4. Unplugging mid-session (not a move, a removal) drives NOTHING — no
//    silent fallback to player 1 on whatever console used to hold it.
// ---------------------------------------------------------------------------
console.log('--- held controller unplugged mid-session -> drives nothing ---');
{
  const pb = new Patchbay();
  pb.addConsole('console0', { ports: 4 });
  pb.plugController('gp-1', 'console0', 0);

  const [ctrl] = [makeCtrl('c0')];
  const heldMap = new Map([[ctrl, 'gp-1']]);
  const acc = accessorsFor(pb, { heldMap });

  let r = computeRouting({ controllers: [ctrl], ...acc });
  eq('before unplug: drives console0', r[0]?.consoleId, 'console0');

  pb.unplugController('gp-1');

  r = computeRouting({ controllers: [ctrl], ...acc });
  eq('after unplug: routes nothing', r, []);
}

// ---------------------------------------------------------------------------
// 5. Re-plugging a DIFFERENT controller into a vacated port must not inherit
//    any stale state from whoever used to occupy it.
// ---------------------------------------------------------------------------
console.log('--- new controller plugged into a vacated port drives cleanly ---');
{
  const pb = new Patchbay();
  pb.addConsole('console0', { ports: 4 });
  pb.plugController('gp-1', 'console0', 1);
  pb.plugController('gp-1', 'console0', 3); // gp-1 moves away, port 1 now free
  pb.plugController('gp-2', 'console0', 1); // a different gamepad takes port 1

  const [c1, c2] = [makeCtrl('c1'), makeCtrl('c2')];
  const heldMap = new Map([[c1, 'gp-1'], [c2, 'gp-2']]);
  const acc = accessorsFor(pb, { heldMap });

  const r = computeRouting({ controllers: [c1, c2], ...acc });
  eq('gp-1 (moved) drives player 4', r.find(e => e.ctrl === c1)?.player, 4);
  eq('gp-2 (new occupant of port 1) drives player 2', r.find(e => e.ctrl === c2)?.player, 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
