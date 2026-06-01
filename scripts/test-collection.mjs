// Node smoke-test for the Phase R data layer (systems / ArtResolver /
// Collection). Pure logic, no browser. Run: node scripts/test-collection.mjs
// Exit 0 = all pass, 1 = a failure.

import { coreForFile, systemForFile, systemForName, SYSTEMS, CORES } from '../src/systems.js';
import { baseName, stripTags, sanitizeThumbName, boxartCandidates } from '../src/ArtResolver.js';
import { normalizeGame, parseCollection } from '../src/Collection.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); };
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } };

// --- systems ---------------------------------------------------------------
eq('coreForFile mario.smc', coreForFile('mario.smc')?.name, 'snes9x');
eq('coreForFile game.nes', coreForFile('game.nes')?.name, 'nestopia');
eq('coreForFile .bin → atari default', coreForFile('x.bin')?.name, 'stella2014');
eq('coreForFile override', coreForFile('x.bin', 'picodrive')?.name, 'picodrive');
eq('coreForFile unknown ext', coreForFile('x.zzz'), null);
eq('systemForFile halo.a26', systemForFile('halo.a26'), 'atari2600');
eq('systemForName "Super Nintendo"', systemForName('Super Nintendo'), 'snes');
eq('systemForName "My SNES Games" (loose)', systemForName('My SNES Games'), 'snes');
eq('systemForName junk', systemForName('Dreamcast'), null);
ok('every system default core exists', Object.values(SYSTEMS).every(s => CORES[s.defaultCore]));

// --- ArtResolver -----------------------------------------------------------
eq('baseName path+ext', baseName('freeware/Super Mario (USA).nes'), 'Super Mario (USA)');
eq('stripTags', stripTags('Zelda (USA) (Rev A) [!]'), 'Zelda');
eq('sanitize forbidden', sanitizeThumbName('A/B:C?D'), 'A_B_C_D');
{
  const sys = SYSTEMS.nes;
  const cands = boxartCandidates({ file: 'smb3.nes', title: 'Super Mario Bros 3 (USA)' }, sys);
  ok('candidates non-empty', cands.length >= 2);
  ok('candidate is libretro-thumbnails URL', cands[0].startsWith('https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Nintendo_Entertainment_System/'));
  ok('tag-stripped candidate present', cands.some(u => u.includes('Super%20Mario%20Bros%203.png')));
}
{
  const explicit = boxartCandidates({ title: 'X', boxart: 'https://example.org/x.png' }, null);
  eq('explicit boxart wins, no repo', explicit, ['https://example.org/x.png']);
}

// --- Collection normalization ---------------------------------------------
{
  const g = normalizeGame({ file: 'freeware/halo2600.a26', title: 'Halo 2600' });
  eq('normalize detects system', g.system, 'atari2600');
  eq('normalize fills core', g.core, 'stella2014');
  ok('normalize builds boxartList', Array.isArray(g.boxartList) && g.boxartList.length >= 1);
}
{
  // legacy manifest shape (cartridges[]) + explicit core/system kept
  const c = parseCollection({ cartridges: [
    { file: 'mario.smc', system: 'snes', core: 'snes9x', title: 'SMW' },
    { title: 'no file — dropped' },
  ]});
  eq('parseCollection keeps valid, drops fileless', c.games.length, 1);
  eq('parseCollection preserves explicit core', c.games[0].core, 'snes9x');
}
{
  // collection schema (games[]) with omitted core → auto-filled
  const c = parseCollection({ id: 'x', title: 'X', games: [
    { file: 'a.gb', title: 'Tobu' },
  ]});
  eq('collection auto-core from system default', c.games[0].core, 'gambatte');
  eq('collection auto-system', c.games[0].system, 'gb');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
