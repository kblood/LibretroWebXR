// Unit tests for src/LocalRomLibrary.js — pure serialize/parse of the local-ROM
// library. No browser globals needed.
// Run standalone:  node scripts/test-localromlibrary.mjs
// Or via npm test: wired into package.json test chain.

import {
  addEntry, removeEntry, serialize, parse, toCartMeta,
} from '../src/LocalRomLibrary.js';

let pass = 0, fail = 0;

const ok = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}`); }
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL  ${name}\n  got:  ${g}\n  want: ${w}`); }
};

// ---------------------------------------------------------------------------
// addEntry — basic insert
// ---------------------------------------------------------------------------

console.log('--- addEntry: basic insert ---');
{
  const list = [];
  const meta = {
    file: 'game.sfc', system: 'snes', core: 'snes9x',
    title: 'Game', sha1: 'AABBCC1122AABBCC1122AABBCC1122AABBCC1122',
    rom: { sha1: 'AABBCC1122AABBCC1122AABBCC1122AABBCC1122', sources: ['opfs', 'pick'] },
  };
  const next = addEntry(list, meta);
  ok('returns new array', next !== list);
  ok('length 1 after insert', next.length === 1);
  eq('entry file', next[0].file, 'game.sfc');
  eq('entry system', next[0].system, 'snes');
  eq('entry sha1 lowercased', next[0].sha1, 'aabbcc1122aabbcc1122aabbcc1122aabbcc1122');
  eq('entry sources', next[0].sources, ['opfs', 'pick']);
}

// ---------------------------------------------------------------------------
// addEntry — dedupe by sha1 (same sha1 replaces in place)
// ---------------------------------------------------------------------------

console.log('--- addEntry: dedupe by sha1 ---');
{
  const sha1 = 'a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5';
  const e1 = { file: 'game.sfc', system: 'snes', core: 'snes9x', title: 'Old Title', sha1 };
  const e2 = { file: 'game.sfc', system: 'snes', core: 'snes9x', title: 'New Title', sha1 };
  const another = { file: 'other.gb', system: 'gb', core: 'gambatte', title: 'Other', sha1: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };

  let list = addEntry([], e1);
  list = addEntry(list, another);
  list = addEntry(list, e2); // same sha1 as e1, updated title
  ok('no duplicate added', list.length === 2);
  eq('updated in place — title changed', list[0].title, 'New Title');
  eq('second entry unchanged', list[1].file, 'other.gb');
}

// ---------------------------------------------------------------------------
// addEntry — SHA-1 case-insensitive dedupe
// ---------------------------------------------------------------------------

console.log('--- addEntry: sha1 is case-insensitive for dedupe ---');
{
  const sha1Lower = 'deadbeef01deadbeef01deadbeef01deadbeef01';
  const sha1Upper = 'DEADBEEF01DEADBEEF01DEADBEEF01DEADBEEF01';
  let list = addEntry([], { file: 'a.sfc', system: 'snes', core: 'snes9x', title: 'A', sha1: sha1Lower });
  list = addEntry(list, { file: 'a.sfc', system: 'snes', core: 'snes9x', title: 'A2', sha1: sha1Upper });
  ok('uppercase sha1 dedupes with lowercase', list.length === 1);
}

// ---------------------------------------------------------------------------
// addEntry — non-sha1 entries are NOT persisted
// ---------------------------------------------------------------------------

console.log('--- addEntry: non-sha1 entry is rejected ---');
{
  // No sha1 at all
  const list1 = addEntry([], { file: 'game.sfc', system: 'snes', core: 'snes9x', title: 'G', rom: { source: 'pick' } });
  ok('pick-only meta (no sha1) not added', list1.length === 0);

  // sha1 is empty string
  const list2 = addEntry([], { file: 'game.sfc', system: 'snes', core: 'snes9x', title: 'G', sha1: '' });
  ok('empty sha1 not added', list2.length === 0);

  // sha1 is null
  const list3 = addEntry([], { file: 'game.sfc', system: 'snes', core: 'snes9x', title: 'G', sha1: null });
  ok('null sha1 not added', list3.length === 0);

  // meta is null
  const list4 = addEntry([], null);
  ok('null meta not added', list4.length === 0);
}

// ---------------------------------------------------------------------------
// removeEntry
// ---------------------------------------------------------------------------

console.log('--- removeEntry ---');
{
  const sha1a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const sha1b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  let list = addEntry([], { file: 'a.sfc', system: 'snes', core: 'snes9x', title: 'A', sha1: sha1a });
  list = addEntry(list, { file: 'b.gb',  system: 'gb',   core: 'gambatte', title: 'B', sha1: sha1b });
  ok('starts with 2 entries', list.length === 2);

  const after = removeEntry(list, sha1a);
  ok('length 1 after remove', after.length === 1);
  eq('remaining entry is B', after[0].sha1, sha1b);

  // Removing a sha1 not in the list is a no-op
  const after2 = removeEntry(after, sha1a);
  ok('remove of absent sha1 is no-op', after2.length === 1);

  // Null sha1 is a no-op
  const after3 = removeEntry(after, null);
  ok('remove with null sha1 is no-op', after3.length === 1);
}

// ---------------------------------------------------------------------------
// serialize / parse round-trip
// ---------------------------------------------------------------------------

console.log('--- serialize/parse round-trip ---');
{
  const sha1 = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
  let list = addEntry([], { file: 'zelda.sfc', system: 'snes', core: 'snes9x', title: 'Zelda', sha1 });
  const obj = serialize(list);
  ok('schema present', typeof obj.schema === 'string' && obj.schema.startsWith('libretrowebxr/localroms'));
  ok('roms array', Array.isArray(obj.roms) && obj.roms.length === 1);

  // Round-trip via JSON (simulating localStorage write+read)
  const parsed = parse(JSON.parse(JSON.stringify(obj)));
  ok('round-trip length', parsed.length === 1);
  eq('round-trip file', parsed[0].file, 'zelda.sfc');
  eq('round-trip system', parsed[0].system, 'snes');
  eq('round-trip sha1', parsed[0].sha1, sha1);
  eq('round-trip sources', parsed[0].sources, ['opfs', 'pick']);
}

// ---------------------------------------------------------------------------
// parse tolerates corrupt / missing / wrong-schema input
// ---------------------------------------------------------------------------

console.log('--- parse: tolerates corrupt input ---');
{
  eq('null input', parse(null), []);
  eq('undefined input', parse(undefined), []);
  eq('empty object', parse({}), []);
  eq('string input', parse('not an object'), []);
  eq('array input', parse([]), []);
  eq('wrong schema', parse({ schema: 'something-else@1', roms: [] }), []);
  eq('no roms key', parse({ schema: 'libretrowebxr/localroms@1' }), []);
  eq('roms not array', parse({ schema: 'libretrowebxr/localroms@1', roms: 'oops' }), []);

  // Entries missing sha1 or file are filtered out silently
  const partial = {
    schema: 'libretrowebxr/localroms@1',
    roms: [
      { file: 'ok.sfc', system: 'snes', core: 'snes9x', title: 'OK',
        sha1: 'dddddddddddddddddddddddddddddddddddddddd', sources: ['opfs', 'pick'] },
      { file: 'no-sha1.sfc', system: 'snes' },       // missing sha1 → dropped
      { sha1: 'eeee0000eeee0000eeee0000eeee0000eeee0000' }, // missing file → dropped
      null,
      'garbage',
    ],
  };
  const filtered = parse(partial);
  ok('only valid entry survives corrupt input', filtered.length === 1);
  eq('surviving entry file', filtered[0].file, 'ok.sfc');
}

// ---------------------------------------------------------------------------
// parse: schema prefix match (future versions still load)
// ---------------------------------------------------------------------------

console.log('--- parse: schema prefix match ---');
{
  const futureSchema = {
    schema: 'libretrowebxr/localroms@99',
    roms: [{ file: 'f.sfc', system: 'snes', core: 'snes9x', title: 'F',
             sha1: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', sources: ['opfs', 'pick'] }],
  };
  const p = parse(futureSchema);
  ok('future schema version accepted', p.length === 1);
}

// ---------------------------------------------------------------------------
// toCartMeta
// ---------------------------------------------------------------------------

console.log('--- toCartMeta ---');
{
  const entry = {
    file: 'castlevania.nes', system: 'nes', core: 'nestopia',
    title: 'Castlevania', sha1: 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1',
    sources: ['opfs', 'pick'],
  };
  const meta = toCartMeta(entry);
  eq('meta.file', meta.file, 'castlevania.nes');
  eq('meta.system', meta.system, 'nes');
  eq('meta.core', meta.core, 'nestopia');
  eq('meta.title', meta.title, 'Castlevania');
  eq('meta.rom.sha1', meta.rom.sha1, 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1');
  eq('meta.rom.sources', meta.rom.sources, ['opfs', 'pick']);
  ok('no rom.source (sources[] is canonical)', !('source' in meta.rom));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
