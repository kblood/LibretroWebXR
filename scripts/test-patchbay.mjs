// Unit tests for src/Patchbay.js (pure AV-rack patch graph).
//
// Covers the invariants the 3D/runtime sides depend on:
//   • controller ⇄ console port: one port per controller, one controller per
//     port, re-plug moves/evicts, port→player mapping
//   • per-console isolation (same port index on different consoles is distinct)
//   • firstFreePort honours each console's own port count
//   • console → TV video: a TV samples ≤1 console, a console fans out to many
//   • node removal cascades to its edges
//
// Run standalone:  node scripts/test-patchbay.mjs
// Or via npm test: wired into package.json test chain.

import { Patchbay, playerForPort } from '../src/Patchbay.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`,
  JSON.stringify(got) === JSON.stringify(want));

console.log('--- playerForPort ---');
eq('port 0 -> player 1', playerForPort(0), 1);
eq('port 3 -> player 4', playerForPort(3), 4);

console.log('--- controller plug basics ---');
{
  const pb = new Patchbay();
  pb.addConsole('nesA', { ports: 4 });
  eq('plug returns slot', pb.plugController('g1', 'nesA', 0), { consoleId: 'nesA', port: 0 });
  eq('portOf', pb.portOf('g1'), { consoleId: 'nesA', port: 0 });
  eq('playerOf = port+1', pb.playerOf('g1'), { consoleId: 'nesA', player: 1 });
  eq('occupantOf', pb.occupantOf('nesA', 0), 'g1');
  ok('port 0 not free', !pb.isPortFree('nesA', 0));
  ok('port 1 free', pb.isPortFree('nesA', 1));
}

console.log('--- one port per controller (re-plug moves) ---');
{
  const pb = new Patchbay();
  pb.addConsole('nesA', { ports: 4 });
  pb.plugController('g1', 'nesA', 0);
  pb.plugController('g1', 'nesA', 2);
  eq('moved to port 2', pb.portOf('g1'), { consoleId: 'nesA', port: 2 });
  ok('old port 0 freed', pb.isPortFree('nesA', 0));
  eq('only one occupancy', pb.controllersOf('nesA'),
    [{ controllerId: 'g1', port: 2, player: 3 }]);
}

console.log('--- one controller per port (re-plug evicts) ---');
{
  const pb = new Patchbay();
  pb.addConsole('nesA', { ports: 4 });
  pb.plugController('g1', 'nesA', 1);
  pb.plugController('g2', 'nesA', 1);
  eq('g2 now in port 1', pb.occupantOf('nesA', 1), 'g2');
  eq('g1 evicted', pb.portOf('g1'), null);
}

console.log('--- unplug ---');
{
  const pb = new Patchbay();
  pb.addConsole('nesA', { ports: 4 });
  pb.plugController('g1', 'nesA', 0);
  pb.unplugController('g1');
  eq('portOf null after unplug', pb.portOf('g1'), null);
  eq('playerOf null after unplug', pb.playerOf('g1'), null);
  ok('port free again', pb.isPortFree('nesA', 0));
  ok('unplug unknown is no-op', (pb.unplugController('nope'), true));
}

console.log('--- per-console isolation ---');
{
  const pb = new Patchbay();
  pb.addConsole('nesA', { ports: 4 });
  pb.addConsole('snesB', { ports: 4 });
  pb.plugController('g1', 'nesA', 0);
  pb.plugController('g2', 'snesB', 0);
  eq('same port idx, different consoles', pb.occupantOf('nesA', 0), 'g1');
  eq('snesB port 0 is g2', pb.occupantOf('snesB', 0), 'g2');
  eq('g1 drives nesA p1', pb.playerOf('g1'), { consoleId: 'nesA', player: 1 });
  eq('g2 drives snesB p1', pb.playerOf('g2'), { consoleId: 'snesB', player: 1 });
}

console.log('--- firstFreePort honours port count ---');
{
  const pb = new Patchbay();
  pb.addConsole('gb', { ports: 2 });
  eq('first free is 0', pb.firstFreePort('gb'), 0);
  pb.plugController('g1', 'gb', 0);
  eq('first free is 1', pb.firstFreePort('gb'), 1);
  pb.plugController('g2', 'gb', 1);
  eq('full 2-port -> null', pb.firstFreePort('gb'), null);
  ok('cannot plug port 2 on a 2-port console', pb.plugController('g3', 'gb', 2) === null);
  eq('unknown console -> null', pb.firstFreePort('ghost'), null);
}

console.log('--- firstFreePort maxPorts clamp (dynamic activePorts) ---');
{
  const pb = new Patchbay();
  pb.addConsole('nesA', { ports: 4 });   // registered full-width
  pb.plugController('g1', 'nesA', 0);
  // Only 2 ports enabled this game: next free within range is 1, not 2/3.
  eq('clamped first free is 1', pb.firstFreePort('nesA', 2), 1);
  pb.plugController('g2', 'nesA', 1);
  eq('clamped full at 2 ports -> null', pb.firstFreePort('nesA', 2), null);
  // Re-enabling all 4 ports finds port 2 — seated controllers were not pruned.
  eq('widening finds port 2', pb.firstFreePort('nesA', 4), 2);
}

console.log('--- shrinking ports prunes out-of-range plugs ---');
{
  const pb = new Patchbay();
  pb.addConsole('md', { ports: 4 });
  pb.plugController('g1', 'md', 3);
  pb.addConsole('md', { ports: 2 });   // re-declare with fewer ports
  eq('g1 (port 3) pruned', pb.portOf('g1'), null);
  eq('port count updated', pb.portsOf('md'), 2);
}

console.log('--- video: TV samples one console ---');
{
  const pb = new Patchbay();
  pb.addConsole('nesA'); pb.addConsole('snesB'); pb.addTV('tv1');
  eq('connect returns edge', pb.connectVideo('nesA', 'tv1'), { consoleId: 'nesA', tvId: 'tv1' });
  eq('tv1 source = nesA', pb.sourceOf('tv1'), 'nesA');
  pb.connectVideo('snesB', 'tv1');     // re-point the TV
  eq('tv1 source swapped to snesB', pb.sourceOf('tv1'), 'snesB');
  eq('nesA no longer displayed', pb.displaysOf('nesA'), []);
  eq('snesB displayed on tv1', pb.displaysOf('snesB'), ['tv1']);
}

console.log('--- video: console fans out to many TVs ---');
{
  const pb = new Patchbay();
  pb.addConsole('nesA');
  pb.connectVideo('nesA', 'tv1');
  pb.connectVideo('nesA', 'tv2');
  eq('both TVs show nesA', pb.displaysOf('nesA').sort(), ['tv1', 'tv2']);
  pb.disconnectVideo('tv1');
  eq('tv1 detached', pb.sourceOf('tv1'), null);
  eq('only tv2 left', pb.displaysOf('nesA'), ['tv2']);
}

console.log('--- removal cascades ---');
{
  const pb = new Patchbay();
  pb.addConsole('nesA', { ports: 4 });
  pb.plugController('g1', 'nesA', 0);
  pb.connectVideo('nesA', 'tv1');
  pb.removeConsole('nesA');
  eq('controller freed when console removed', pb.portOf('g1'), null);
  eq('tv source cleared when console removed', pb.sourceOf('tv1'), null);
  ok('console gone from listing', !pb.consoles().includes('nesA'));

  const pb2 = new Patchbay();
  pb2.addConsole('nesA'); pb2.connectVideo('nesA', 'tv1');
  pb2.removeTV('tv1');
  eq('removing TV clears its source', pb2.sourceOf('tv1'), null);
  eq('console no longer lists removed TV', pb2.displaysOf('nesA'), []);
}

console.log('--- listings + auto-register ---');
{
  const pb = new Patchbay();
  pb.plugController('g1', 'nesA', 0);   // both auto-registered
  pb.connectVideo('nesA', 'tv1');       // tv auto-registered
  ok('console auto-registered', pb.consoles().includes('nesA'));
  ok('controller auto-registered', pb.controllers().includes('g1'));
  ok('tv auto-registered', pb.tvs().includes('tv1'));
}

console.log('--- guards ---');
{
  const pb = new Patchbay();
  eq('plug null controller -> null', pb.plugController(null, 'nesA', 0), null);
  eq('connect null tv -> null', pb.connectVideo('nesA', null), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
