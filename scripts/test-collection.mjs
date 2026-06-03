// Node smoke-test for the Phase R data layer (systems / ArtResolver /
// Collection). Pure logic, no browser. Run: node scripts/test-collection.mjs
// Exit 0 = all pass, 1 = a failure.

import { coreForFile, systemForFile, systemForName, SYSTEMS, CORES } from '../src/systems.js';
import { baseName, stripTags, sanitizeThumbName, boxartCandidates } from '../src/ArtResolver.js';
import { normalizeGame, parseCollection } from '../src/Collection.js';
import { romUrlFor, sourceOrder, cacheKey, fileBaseName, wantedFileName, fileNameMatches, resolve as resolveRom } from '../src/RomResolver.js';
import { parseRoom, defaultRoom, normalizeProp, normalizePortal, roomCollectionRefs, vec3 } from '../src/RoomLoader.js';
import { serializeRoom, round } from '../src/RoomSerializer.js';
import {
  nextInCycle, ensureEnvironment, cycleSurface, cycleTimeOfDay, cyclePosterTexture,
  SURFACE_OPTIONS, POSTER_OPTIONS, TIME_OF_DAY_OPTIONS,
} from '../src/EnvEditor.js';
import {
  uniqueId, existingIds, createProp, createPortal, addProp, addPortal,
  CREATABLE_PROP_TYPES,
} from '../src/PropCreator.js';

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

// --- RomResolver (pure parts) ---------------------------------------------
eq('romUrlFor relative → roms/', romUrlFor({ file: 'freeware/lwx-snake.prg' }), 'roms/freeware/lwx-snake.prg');
eq('romUrlFor absolute http kept', romUrlFor({ file: 'https://x.org/a.nes' }), 'https://x.org/a.nes');
eq('romUrlFor rooted path kept', romUrlFor({ file: '/cdn/a.gb' }), '/cdn/a.gb');
eq('romUrlFor rom.url overrides file', romUrlFor({ file: 'a.gb', rom: { url: 'https://x.org/b.gb' } }), 'https://x.org/b.gb');
eq('romUrlFor nothing → null', romUrlFor({ title: 'x' }), null);

eq('sourceOrder default url', sourceOrder({ file: 'a.nes' }), ['url']);
eq('sourceOrder explicit source', sourceOrder({ file: 'a.nes', rom: { source: 'local' } }), ['local']);
eq('sourceOrder explicit sources[] wins', sourceOrder({ file: 'a.nes', rom: { sources: ['opfs', 'url'] } }), ['opfs', 'url']);
eq('sourceOrder no url → pick', sourceOrder({ rom: { source: undefined } }), ['pick']);

eq('cacheKey from sha1 (lowercased)', cacheKey({ rom: { sha1: 'ABCdef123' } }), 'sha1-abcdef123');
eq('cacheKey none → null', cacheKey({ file: 'a.nes' }), null);

eq('fileBaseName posix', fileBaseName('freeware/sub/Game (USA).nes'), 'Game (USA).nes');
eq('fileBaseName windows', fileBaseName('C:\\roms\\Game.gb'), 'Game.gb');
eq('wantedFileName prefers rom.path', wantedFileName({ file: 'a.gb', rom: { path: 'gb/Tobu Tobu Girl.gb' } }), 'Tobu Tobu Girl.gb');
eq('wantedFileName falls back to file', wantedFileName({ file: 'sub/a.gb' }), 'a.gb');
ok('fileNameMatches case-insensitive basename', fileNameMatches('sub/Mario.NES', 'other/mario.nes'));
ok('fileNameMatches rejects mismatch', !fileNameMatches('a.nes', 'b.nes'));
ok('fileNameMatches rejects empty', !fileNameMatches('', 'b.nes'));

// resolve() url path with an injected fetch (no browser; opfs/local absent →
// skipped because no sha1). Confirms the orchestrator returns the fetched bytes.
{
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const fetchImpl = async (url) => {
    ok('resolve fetched the roms/-relative url', url === 'roms/freeware/lwx-snake.prg');
    return { ok: true, arrayBuffer: async () => bytes };
  };
  const got = await resolveRom({ file: 'freeware/lwx-snake.prg' }, { fetchImpl });
  ok('resolve returns the fetched ArrayBuffer', got === bytes);
}
{
  // A failing fetch surfaces as a thrown error (no other source to fall back to).
  const fetchImpl = async () => ({ ok: false, status: 404 });
  let threw = false;
  try { await resolveRom({ file: 'a.nes' }, { fetchImpl }); }
  catch { threw = true; }
  ok('resolve throws when the only source fails', threw);
}

// --- RoomLoader (pure room parsing) ---------------------------------------
eq('vec3 fills missing comps', vec3([1, 2]), [1, 2, 0]);
eq('vec3 non-array → default triple', vec3(undefined, 0), [0, 0, 0]);

{
  const p = normalizeProp({ type: 'Shelf', pos: [1, 2, 3] }, 0);
  eq('normalizeProp lowercases type', p.type, 'shelf');
  eq('normalizeProp fills id', p.id, 'shelf-1');
  eq('normalizeProp keeps pos', p.pos, [1, 2, 3]);
  eq('normalizeProp defaults rot', p.rot, [0, 0, 0]);
  ok('normalizeProp drops unknown type', normalizeProp({ type: 'bogus' }) === null);
  ok('normalizeProp preserves extras (collection/half)',
     normalizeProp({ type: 'shelf', collection: 'c', half: 'left' }).half === 'left');
}
{
  ok('normalizePortal needs target', normalizePortal({ pos: [0, 0, 0] }) === null);
  const pt = normalizePortal({ target: 'roms/x.room.json', pos: [1, 0, 1] }, 2);
  eq('portal id default', pt.id, 'portal-3');
  eq('portal default radius', pt.radius, 0.6);
}
{
  const room = parseRoom({
    schema: 'libretrowebxr/room@1', id: 'r', title: 'R',
    collections: ['a.collection.json'],
    props: [
      { type: 'shelf', collection: 'b.collection.json' },
      { type: 'console', pos: [0, 0.7, -2] },
      { type: 'oops' },
    ],
    portals: [{ target: 'r2.room.json' }, { /* no target */ }],
    environment: { surfaces: { wallpaper: 'builtin:retro-blue' } },
  }, { sourceLabel: 'r' });
  eq('parseRoom drops bad prop', room.props.length, 2);
  eq('parseRoom drops targetless portal', room.portals.length, 1);
  eq('parseRoom keeps environment', room.environment.surfaces.wallpaper, 'builtin:retro-blue');
  eq('roomCollectionRefs merges top-level + shelf, deduped',
     roomCollectionRefs(room), ['a.collection.json', 'b.collection.json']);
}
{
  const room = parseRoom({}, { sourceLabel: 'empty' });
  eq('parseRoom tolerates empty: props', room.props, []);
  eq('parseRoom tolerates empty: portals', room.portals, []);
  eq('parseRoom defaults schema', room.schema, 'libretrowebxr/room@1');
  eq('parseRoom labels from sourceLabel', room.id, 'empty');
}
{
  const r = defaultRoom('roms/manifest.json');
  const shelves = r.props.filter((p) => p.type === 'shelf');
  eq('defaultRoom has two shelves', shelves.length, 2);
  eq('defaultRoom shelves split left/right', shelves.map((s) => s.half), ['left', 'right']);
  ok('defaultRoom has a console', r.props.some((p) => p.type === 'console'));
  ok('defaultRoom has a gamepad', r.props.some((p) => p.type === 'gamepad'));
  eq('defaultRoom references the collection', r.collections, ['roms/manifest.json']);
  eq('defaultRoom collection refs', roomCollectionRefs(r), ['roms/manifest.json']);
}

// --- RoomSerializer (pure room export, inverse of parseRoom) --------------
// Key-order-insensitive deep compare: the serializer re-emits canonical keys
// in its own order, so a literal JSON.stringify diff would be spurious.
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
};
const deepEq = (name, got, want) => eq(name, canon(got), canon(want));

eq('round to 3dp', round(1.23456), 1.235);
eq('round normalizes -0 → 0', round(-0.0001), 0);
eq('round non-finite → 0', round(NaN), 0);

{
  // Identity round-trip: parse → serialize (no moves) → parse must match.
  const raw = {
    schema: 'libretrowebxr/room@1', id: 'rt', title: 'Round Trip', author: 'tester',
    collections: ['roms/manifest.json'],
    environment: { surfaces: { wallpaper: 'builtin:retro-blue', floor: 'builtin:wood' } },
    props: [
      { type: 'shelf', id: 's-left', collection: 'roms/manifest.json', half: 'left', pos: [-2.85, 1.25, -1.5], rot: [0, 90, 0] },
      { type: 'console', id: 'c1', pos: [0, 0.74, -2.4] },
      { type: 'tv', id: 'tv1', shader: 'crt' },
      { type: 'poster', id: 'p1', texture: 'builtin:poster-1', size: [0.8, 1.1], pos: [-1.7, 1.8, -3.94] },
    ],
    portals: [{ id: 'to-arcade', target: 'roms/arcade.room.json', radius: 0.6, pos: [2.7, 0, 1], rot: [0, -90, 0] }],
  };
  const parsed = parseRoom(raw, { sourceLabel: 'rt' });
  const reparsed = parseRoom(serializeRoom(parsed, new Map()), { sourceLabel: 'rt' });
  deepEq('serializeRoom identity round-trip', reparsed, parsed);
  ok('serializeRoom keeps author', serializeRoom(parsed).author === 'tester');
  ok('serializeRoom preserves tv shader extra',
     serializeRoom(parsed).props.find((p) => p.id === 'tv1').shader === 'crt');
}
{
  // defaultRoom also round-trips (built-in layout exports cleanly).
  const dr = defaultRoom('roms/manifest.json');
  const back = parseRoom(serializeRoom(dr, new Map()));
  eq('defaultRoom round-trips: prop count', back.props.length, dr.props.length);
  eq('defaultRoom round-trips: shelf halves', back.props.filter((p) => p.type === 'shelf').map((s) => s.half), ['left', 'right']);
}
{
  // Live transforms override only the named prop's pos/rot; others untouched.
  const parsed = parseRoom({
    props: [
      { type: 'console', id: 'c1', pos: [0, 0.74, -2.4] },
      { type: 'gamepad', id: 'g1', pos: [0.55, 0.78, -2.15] },
    ],
  });
  const tf = new Map([['c1', { pos: [1.111111, 2, 3], rot: [0, 45.5, 0] }]]);
  const out = serializeRoom(parsed, tf);
  const c1 = out.props.find((p) => p.id === 'c1');
  const g1 = out.props.find((p) => p.id === 'g1');
  eq('serializeRoom applies live pos (rounded)', c1.pos, [1.111, 2, 3]);
  eq('serializeRoom applies live rot', c1.rot, [0, 45.5, 0]);
  eq('serializeRoom leaves unmoved prop', g1.pos, [0.55, 0.78, -2.15]);
}

// --- EnvEditor (pure E.2 env cycling) -------------------------------------
eq('nextInCycle wraps', nextInCycle('builtin:dark', SURFACE_OPTIONS), SURFACE_OPTIONS[0]);
eq('nextInCycle advances', nextInCycle('builtin:retro-blue', SURFACE_OPTIONS), 'builtin:retro-green');
eq('nextInCycle unknown → first', nextInCycle('nope', SURFACE_OPTIONS), SURFACE_OPTIONS[0]);
{
  const env = ensureEnvironment({});
  ok('ensureEnvironment creates surfaces/lighting', env.surfaces && env.lighting);
  const room = {};
  ensureEnvironment(room);
  ok('ensureEnvironment mutates the room in place', !!room.environment.surfaces);
}
{
  // Cycle wallpaper from a known value; floor independent; lamps preserved.
  const room = { environment: { surfaces: { wallpaper: 'builtin:retro-blue' }, lighting: { timeOfDay: 'day', lamps: [{ pos: [0, 2, 0] }] } } };
  eq('cycleSurface advances wallpaper', cycleSurface(room, 'wallpaper'), 'builtin:retro-green');
  eq('cycleSurface writes back', room.environment.surfaces.wallpaper, 'builtin:retro-green');
  eq('cycleSurface floor starts at first', cycleSurface(room, 'floor'), SURFACE_OPTIONS[0]);
  eq('cycleTimeOfDay advances', cycleTimeOfDay(room), 'evening');
  eq('cycleTimeOfDay preserves lamps', room.environment.lighting.lamps.length, 1);
}
{
  const room = {};
  // First cycle on a bare room creates env and picks the first option.
  eq('cycleSurface on empty room → first', cycleSurface(room, 'wallpaper'), SURFACE_OPTIONS[0]);
  eq('cycleTimeOfDay on empty room → first', cycleTimeOfDay(room), TIME_OF_DAY_OPTIONS[0]);
}
{
  const poster = { type: 'poster', id: 'p1', texture: 'builtin:poster-1' };
  eq('cyclePosterTexture advances', cyclePosterTexture(poster), 'builtin:poster-2');
  eq('cyclePosterTexture writes back', poster.texture, 'builtin:poster-2');
  ok('cyclePosterTexture tolerates bad prop', cyclePosterTexture(null) === undefined);
}
{
  // End-to-end: edit the descriptor, then export must reflect the edits.
  const room = parseRoom({
    id: 'edit', collections: ['roms/manifest.json'],
    environment: { surfaces: { wallpaper: 'builtin:retro-blue' } },
    props: [{ type: 'poster', id: 'p1', texture: 'builtin:poster-1', pos: [-1.7, 1.8, -3.9] }],
  });
  cycleSurface(room, 'wallpaper');                 // → retro-green
  cycleTimeOfDay(room);                            // env had no lighting → day
  cyclePosterTexture(room.props.find((p) => p.id === 'p1')); // → poster-2
  const out = serializeRoom(room, new Map());
  eq('export captures wallpaper edit', out.environment.surfaces.wallpaper, 'builtin:retro-green');
  eq('export captures lighting edit', out.environment.lighting.timeOfDay, 'day');
  eq('export captures poster edit', out.props.find((p) => p.id === 'p1').texture, 'builtin:poster-2');
}

// --- PropCreator (pure E.3 prop/portal minting) ---------------------------
{
  const room = parseRoom({
    id: 'e3', collections: ['roms/manifest.json'],
    props: [{ type: 'shelf', id: 'shelf-1', pos: [0, 1, 0], rot: [0, 0, 0] }],
    portals: [{ id: 'portal-1', target: 'roms/arcade.room.json', pos: [0, 0, 0] }],
  });
  // existingIds gathers props + portals.
  ok('existingIds spans props + portals',
     existingIds(room).has('shelf-1') && existingIds(room).has('portal-1'));
  // uniqueId skips taken ids (shelf-1 exists → shelf-2).
  eq('uniqueId avoids collision', uniqueId(room, 'shelf'), 'shelf-2');
  eq('uniqueId fresh type starts at 1', uniqueId(room, 'console'), 'console-1');

  // createProp mints a normalized prop (degrees rot, type defaults) without appending.
  const poster = createProp(room, 'poster', { pos: [1, 1.5, -3.9], rot: [0, 45, 0] });
  eq('createProp id', poster.id, 'poster-1');
  eq('createProp type', poster.type, 'poster');
  eq('createProp pos', poster.pos, [1, 1.5, -3.9]);
  eq('createProp rot (degrees, preserved)', poster.rot, [0, 45, 0]);
  eq('createProp poster default texture', poster.texture, 'builtin:poster-1');
  ok('createProp did NOT append yet', room.props.length === 1);
  ok('createProp rejects un-creatable type', createProp(room, 'tv') === null);
  ok('createProp rejects garbage type', createProp(room, 'zzz') === null);
  ok('CREATABLE list excludes tv/model',
     !CREATABLE_PROP_TYPES.includes('tv') && !CREATABLE_PROP_TYPES.includes('model'));

  // addProp appends; the new prop survives a serialize→parse round-trip.
  addProp(room, poster);
  eq('addProp appended', room.props.length, 2);
  const reparsed = parseRoom(serializeRoom(room, new Map()));
  ok('created poster round-trips through serializer',
     reparsed.props.some((p) => p.id === 'poster-1' && p.texture === 'builtin:poster-1'));

  // Portals: createPortal needs a target; uniqueId keeps numbering distinct.
  ok('createPortal needs a target', createPortal(room, {}) === null);
  const portal = createPortal(room, { target: 'roms/bedroom.room.json', pos: [2, 0, 1] });
  eq('createPortal unique id', portal.id, 'portal-2');
  eq('createPortal target', portal.target, 'roms/bedroom.room.json');
  eq('createPortal default radius', portal.radius, 0.6);
  addPortal(room, portal);
  eq('addPortal appended', room.portals.length, 2);
  const rp2 = parseRoom(serializeRoom(room, new Map()));
  ok('created portal round-trips', rp2.portals.some((p) => p.id === 'portal-2'));
}
{
  // A shelf created in-VR carries no collection → builder falls back to the
  // room's first collection (so it shows content). Descriptor stays clean.
  const room = parseRoom({ id: 'e3b', props: [] });
  const shelf = createProp(room, 'shelf', { pos: [-2, 1.25, -1.5], rot: [0, 90, 0] });
  ok('new shelf has no collection (builder fills it)', shelf.collection === undefined);
  eq('new shelf id', shelf.id, 'shelf-1');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
