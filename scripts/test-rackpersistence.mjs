// Unit tests for src/RackPersistence.js — pure serialize/parse of the rack save.
// Run standalone:  node scripts/test-rackpersistence.mjs  (also in npm test)

import { serializeRack, parseRack, isEmptyRack } from '../src/RackPersistence.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`,
  JSON.stringify(got) === JSON.stringify(want));

console.log('--- serialize keeps only the persistable fields ---');
{
  const d = serializeRack(
    [{ system: 'nes', file: 'pong.nes', core: 'nestopia', title: 'Pong', extra: 'drop me' }],
    [{ tv: 'tv0', console: 'console0' }, { tv: 'tv1', console: 'console1' }],
  );
  ok('schema set', d.schema === 'libretrowebxr/rack@1');
  eq('console fields', d.consoles[0], { system: 'nes', file: 'pong.nes', core: 'nestopia', title: 'Pong' });
  eq('video kept', d.video, [{ tv: 'tv0', console: 'console0' }, { tv: 'tv1', console: 'console1' }]);
}

console.log('--- null console edge becomes null ---');
{
  const d = serializeRack([], [{ tv: 'tv1', console: null }, { tv: 'tv2' }]);
  eq('null + missing normalized', d.video, [{ tv: 'tv1', console: null }, { tv: 'tv2', console: null }]);
}

console.log('--- round-trip serialize → JSON → parse ---');
{
  const d = serializeRack(
    [{ system: 'gb', file: 'snake.gb', core: 'gambatte', title: 'Snake' }],
    [{ tv: 'tv0', console: 'console0' }],
  );
  const p = parseRack(JSON.parse(JSON.stringify(d)));
  eq('consoles survive', p.consoles, [{ system: 'gb', file: 'snake.gb', core: 'gambatte', title: 'Snake' }]);
  eq('video survives', p.video, [{ tv: 'tv0', console: 'console0' }]);
}

console.log('--- parse rejects non-rack objects ---');
{
  ok('null', parseRack(null) === null);
  ok('no schema', parseRack({ consoles: [] }) === null);
  ok('wrong schema', parseRack({ schema: 'something/else@1' }) === null);
}

console.log('--- parse drops console entries missing system/file ---');
{
  const p = parseRack({ schema: 'libretrowebxr/rack@1', consoles: [
    { system: 'nes', file: 'a.nes' },
    { system: 'nes' },        // no file → dropped
    { file: 'b.nes' },        // no system → dropped
  ] });
  ok('only the complete entry kept', p.consoles.length === 1 && p.consoles[0].file === 'a.nes');
  ok('title defaults to file', p.consoles[0].title === 'a.nes');
}

console.log('--- layout (transforms + power) round-trips ---');
{
  const layout = {
    transforms: {
      console0: { pos: [1, 0.74, -2], rot: [0, 0.5, 0] },
      tv0: { pos: [1, 1.5, -3.6], rot: [0, 0, 0] },
    },
    power: { console0: true, tv1: false },
  };
  const d = serializeRack(
    [{ system: 'nes', file: 'a.nes', core: 'fceumm', title: 'A' }],
    [{ tv: 'tv0', console: 'console0' }],
    layout,
  );
  const p = parseRack(JSON.parse(JSON.stringify(d)));
  eq('transforms survive', p.layout.transforms.console0, { pos: [1, 0.74, -2], rot: [0, 0.5, 0] });
  eq('rot defaults when missing', parseRack(JSON.parse(JSON.stringify(
    serializeRack([{ system: 'nes', file: 'a.nes' }], [], { transforms: { tv0: { pos: [0, 1, -2] } } }),
  ))).layout.transforms.tv0.rot, [0, 0, 0]);
  ok('power off preserved', p.layout.power.tv1 === false);
  ok('power on preserved', p.layout.power.console0 === true);
}

console.log('--- layout is optional / omitted cleanly ---');
{
  const d = serializeRack([{ system: 'nes', file: 'a.nes' }], []);
  ok('no layout key when not provided', !('layout' in d));
  ok('parse yields null layout', parseRack(JSON.parse(JSON.stringify(d))).layout === null);
  // Malformed layout entries are dropped, not fatal.
  const p = parseRack({ schema: 'libretrowebxr/rack@1',
    consoles: [{ system: 'nes', file: 'a.nes' }],
    layout: { transforms: { bad: { pos: [1, 2] }, good: { pos: [0, 0, 0] } }, power: { x: 1 } } });
  ok('bad transform dropped', !('bad' in p.layout.transforms));
  ok('good transform kept', !!p.layout.transforms.good);
  ok('power coerced to bool', p.layout.power.x === true);
}

console.log('--- isEmptyRack ---');
{
  ok('empty when no consoles', isEmptyRack(serializeRack([], [{ tv: 'tv0', console: 'console0' }])));
  ok('not empty with a console', !isEmptyRack(serializeRack([{ system: 'nes', file: 'a.nes' }], [])));
  ok('null is empty', isEmptyRack(null));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
