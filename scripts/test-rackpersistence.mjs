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

console.log('--- isEmptyRack ---');
{
  ok('empty when no consoles', isEmptyRack(serializeRack([], [{ tv: 'tv0', console: 'console0' }])));
  ok('not empty with a console', !isEmptyRack(serializeRack([{ system: 'nes', file: 'a.nes' }], [])));
  ok('null is empty', isEmptyRack(null));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
