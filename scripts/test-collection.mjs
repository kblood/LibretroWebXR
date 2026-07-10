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
  cycleShelfCollection, cyclePortalTarget, SURFACE_OPTIONS, POSTER_OPTIONS, TIME_OF_DAY_OPTIONS,
} from '../src/EnvEditor.js';
import {
  uniqueId, existingIds, createProp, createPortal, addProp, addPortal,
  CREATABLE_PROP_TYPES,
} from '../src/PropCreator.js';
import { CableMgr, playerForPort } from '../src/CableMgr.js';
import { portsForSystem, MAX_PORTS } from '../src/systems.js';
import {
  RETROPAD_KEYS, EXTRA_PLAYER_KEYS, EXTRA_KEY_DEFS, RA_KEY_NAME,
} from '../src/ControllerMaps.js';
import { DEFAULT_BIND_CODES } from '../src/InputMgr.js';
import { looksLikeRoom, LAST_ROOM_KEY, ROOM_BRIDGE_KEY } from '../src/RoomPersistence.js';

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
  // cycleShelfCollection: advance a shelf's collection through an ordered key list.
  const keys = ['nes.json', 'snes.json', 'md.json'];
  const shelf = { type: 'shelf', id: 's1', collection: 'nes.json' };
  eq('cycleShelfCollection advances', cycleShelfCollection(shelf, keys), 'snes.json');
  eq('cycleShelfCollection writes back', shelf.collection, 'snes.json');
  cycleShelfCollection(shelf, keys); // → md.json
  eq('cycleShelfCollection wraps', cycleShelfCollection(shelf, keys), 'nes.json');
  eq('cycleShelfCollection unknown current starts at first',
     cycleShelfCollection({ collection: 'nope' }, keys), 'nes.json');
  eq('cycleShelfCollection single-entry is a no-op',
     cycleShelfCollection({ collection: 'only' }, ['only']), 'only');
  ok('cycleShelfCollection empty list leaves value',
     cycleShelfCollection({ collection: 'x' }, []) === 'x');
  ok('cycleShelfCollection tolerates bad prop', cycleShelfCollection(null, keys) === undefined);
}
{
  // cyclePortalTarget: same generic advance-through-a-key-list shape as
  // cycleShelfCollection, applied to a portal's `target` field (Task #4).
  const rooms = ['roms/bedroom.room.json', 'roms/arcade.room.json'];
  const portal = { type: 'portal', id: 'p1', target: 'roms/bedroom.room.json' };
  eq('cyclePortalTarget advances', cyclePortalTarget(portal, rooms), 'roms/arcade.room.json');
  eq('cyclePortalTarget writes back', portal.target, 'roms/arcade.room.json');
  eq('cyclePortalTarget wraps', cyclePortalTarget(portal, rooms), 'roms/bedroom.room.json');
  eq('cyclePortalTarget unknown current starts at first',
     cyclePortalTarget({ target: 'nope' }, rooms), 'roms/bedroom.room.json');
  eq('cyclePortalTarget single-entry is a no-op',
     cyclePortalTarget({ target: 'only.room.json' }, ['only.room.json']), 'only.room.json');
  ok('cyclePortalTarget empty list leaves value',
     cyclePortalTarget({ target: 'x' }, []) === 'x');
  ok('cyclePortalTarget tolerates bad prop', cyclePortalTarget(null, rooms) === undefined);
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

  // Furniture (Add mode): bookcase/cupboard/table are creatable + round-trip.
  for (const ft of ['bookcase', 'cupboard', 'table']) {
    ok(`CREATABLE list includes ${ft}`, CREATABLE_PROP_TYPES.includes(ft));
    const f = createProp(room, ft, { pos: [1, 0, -2], rot: [0, 90, 0] });
    ok(`createProp mints ${ft}`, f && f.type === ft);
    eq(`createProp ${ft} id`, f.id, `${ft}-1`);
    eq(`createProp ${ft} pos`, f.pos, [1, 0, -2]);
    ok(`normalizeProp keeps ${ft}`, normalizeProp({ type: ft, pos: [0, 0, 0] }) !== null);
  }

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

// --- systems: controller ports (local multiplayer) ------------------------
eq('portsForSystem snes = 4', portsForSystem('snes'), 4);
eq('portsForSystem gb (handheld) = 1', portsForSystem('gb'), 1);
eq('portsForSystem pce = 2', portsForSystem('pce'), 2);
eq('portsForSystem unknown → default 2', portsForSystem('zzz'), 2);
ok('portsForSystem never exceeds MAX_PORTS',
   Object.keys(SYSTEMS).every((s) => portsForSystem(s) <= MAX_PORTS && portsForSystem(s) >= 1));

// --- CableMgr (pure port↔player↔gamepad registry) -------------------------
eq('playerForPort 0 → P1', playerForPort(0), 1);
eq('playerForPort 3 → P4', playerForPort(3), 4);
{
  const cable = new CableMgr();
  eq('unplugged gamepad defaults to player 1', cable.playerOf('g1'), 1);
  eq('portOf unplugged → null', cable.portOf('g1'), null);

  eq('plug g1 into port 0', cable.plug('g1', 0), 0);
  eq('g1 now player 1', cable.playerOf('g1'), 1);
  eq('plug g2 into port 1 → player 2', (cable.plug('g2', 1), cable.playerOf('g2')), 2);
  eq('occupantOf port 1 is g2', cable.occupantOf('1' * 1), 'g2');
  eq('firstFreePort with 0,1 taken (4 ports) = 2', cable.firstFreePort(4), 2);
  eq('firstFreePort clamped to a 2-port system = null', cable.firstFreePort(2), null);

  // Re-plugging a gamepad moves it and frees its old port.
  cable.plug('g1', 2);
  eq('g1 moved to port 2 → player 3', cable.playerOf('g1'), 3);
  ok('old port 0 is free again', cable.isPortFree(0));

  // Plugging into an occupied port evicts the prior tenant.
  cable.plug('g3', 1);
  eq('g3 evicts g2 from port 1', cable.occupantOf(1), 'g3');
  eq('evicted g2 falls back to player 1', cable.playerOf('g2'), 1);

  // Unplug is idempotent and frees the port.
  cable.unplug('g3');
  ok('port 1 free after unplug', cable.isPortFree(1));
  cable.unplug('g3'); // no throw
  eq('plug rejects out-of-range port', cable.plug('gX', MAX_PORTS), null);
  eq('plug rejects null id', cable.plug(null, 0), null);
}

// --- Multiplayer key tables: no overlaps (the promised invariant) ---------
{
  // Player-1 codes: the VR dispatch table (RETROPAD_KEYS) + the keyboard
  // forward set (DEFAULT_BIND_CODES). Players 2-4 must avoid all of them and
  // each other, or one keypress would drive two players.
  const p1 = new Set([...Object.values(RETROPAD_KEYS).flat(), ...DEFAULT_BIND_CODES]);
  const seen = new Map(); // code -> owner label
  for (const c of p1) seen.set(c, 'P1');

  let overlaps = 0, missingDef = 0, missingRaName = 0;
  for (const p of [2, 3, 4]) {
    for (const [btn, code] of Object.entries(EXTRA_PLAYER_KEYS[p])) {
      if (seen.has(code)) { overlaps++; console.error(`  overlap: P${p}.${btn}=${code} clashes with ${seen.get(code)}`); }
      seen.set(code, `P${p}.${btn}`);
      if (!EXTRA_KEY_DEFS[code]) missingDef++;
      if (!RA_KEY_NAME[code]) missingRaName++;
    }
  }
  eq('no key overlaps across P1..P4', overlaps, 0);
  eq('every P2-4 code has an EXTRA_KEY_DEFS payload', missingDef, 0);
  eq('every P2-4 code has an RA_KEY_NAME', missingRaName, 0);
  // Each player exposes a full RetroPad button set.
  const BTNS = ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'X', 'Y', 'L', 'R', 'Start', 'Select'];
  ok('P2-4 each map all 12 RetroPad buttons',
     [2, 3, 4].every((p) => BTNS.every((b) => typeof EXTRA_PLAYER_KEYS[p][b] === 'string')));
}

// --- RoomPersistence (pure guards + key constants) -------------------------
{
  // looksLikeRoom: accepts valid room objects, rejects garbage.
  const validRoom = defaultRoom('roms/manifest.json');
  ok('looksLikeRoom accepts defaultRoom()', looksLikeRoom(validRoom));

  const parsed = parseRoom({ props: [], schema: 'libretrowebxr/room@1' });
  ok('looksLikeRoom accepts parseRoom() output', looksLikeRoom(parsed));

  const futureSchema = parseRoom({});
  futureSchema.schema = 'libretrowebxr/room@99';
  ok('looksLikeRoom accepts future minor version', looksLikeRoom(futureSchema));

  ok('looksLikeRoom rejects null', !looksLikeRoom(null));
  ok('looksLikeRoom rejects empty object', !looksLikeRoom({}));
  ok('looksLikeRoom rejects missing props array', !looksLikeRoom({ schema: 'libretrowebxr/room@1' }));
  ok('looksLikeRoom rejects wrong schema prefix', !looksLikeRoom({ props: [], schema: 'other/room@1' }));
  ok('looksLikeRoom rejects collection object', !looksLikeRoom({ games: [], schema: 'other' }));

  // Key constants are stable strings (callers stringify against these).
  ok('LAST_ROOM_KEY is a non-empty string', typeof LAST_ROOM_KEY === 'string' && LAST_ROOM_KEY.length > 0);
  ok('ROOM_BRIDGE_KEY is a non-empty string', typeof ROOM_BRIDGE_KEY === 'string' && ROOM_BRIDGE_KEY.length > 0);
  ok('LAST_ROOM_KEY !== ROOM_BRIDGE_KEY', LAST_ROOM_KEY !== ROOM_BRIDGE_KEY);

  // Round-trip: serialize a room → looksLikeRoom should accept the parsed-back form.
  const rt = parseRoom(serializeRoom(defaultRoom(), new Map()));
  ok('serialized+reparsed defaultRoom passes looksLikeRoom', looksLikeRoom(rt));
}

// --- (A) Configurable posters: expanded palette + custom URL round-trip -------
{
  // POSTER_OPTIONS now has 12 entries covering poster-1..6 + surface tints.
  ok('POSTER_OPTIONS has at least 10 entries (poster-1..6 + tints)', POSTER_OPTIONS.length >= 10);
  ok('POSTER_OPTIONS includes poster-3', POSTER_OPTIONS.includes('builtin:poster-3'));
  ok('POSTER_OPTIONS includes poster-6', POSTER_OPTIONS.includes('builtin:poster-6'));
  ok('POSTER_OPTIONS includes neon-purple', POSTER_OPTIONS.includes('builtin:neon-purple'));
  ok('POSTER_OPTIONS includes warm-amber',  POSTER_OPTIONS.includes('builtin:warm-amber'));

  // Cycling wraps correctly across the full expanded palette.
  const poster = { type: 'poster', id: 'p-test', texture: POSTER_OPTIONS.at(-1) };
  const wrapped = cyclePosterTexture(poster);
  eq('cyclePosterTexture wraps from last → first', wrapped, POSTER_OPTIONS[0]);

  // Custom URL: set a URL directly on the prop's `texture` field; it must
  // survive a serialize → parse round-trip (poster.texture is echoed verbatim).
  const room = parseRoom({
    id: 'poster-url-test', props: [
      { type: 'poster', id: 'p-custom', texture: 'https://example.org/img.png',
        size: [0.8, 1.1], pos: [0, 1.8, -3.94], rot: [0, 0, 0] },
    ],
  });
  const reparsed = parseRoom(serializeRoom(room, new Map()));
  const p = reparsed.props.find((x) => x.id === 'p-custom');
  ok('custom poster URL survives parse', !!p);
  eq('custom poster URL round-trips through serializer', p?.texture, 'https://example.org/img.png');

  // data URL (base64) also round-trips — needed for the file-picker path.
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const room2 = parseRoom({
    id: 'poster-data-test', props: [
      { type: 'poster', id: 'p-data', texture: dataUrl, pos: [0, 1.8, -3.94], rot: [0, 0, 0] },
    ],
  });
  const r2 = parseRoom(serializeRoom(room2, new Map()));
  eq('data URL round-trips', r2.props[0]?.texture, dataUrl);

  // Ensure cyclePosterTexture does NOT cycle over custom URLs — it only steps
  // through POSTER_OPTIONS. A custom URL gets replaced with the first palette
  // entry on the next cycle call. This is intentional: in-VR cycling is for
  // built-in styles; custom images are set (and cleared) from the desktop.
  const propWithCustom = { type: 'poster', id: 'p-cc', texture: 'https://custom.org/a.png' };
  const v = cyclePosterTexture(propWithCustom); // unknown → first in palette
  eq('cyclePosterTexture on unknown/custom URL → first palette entry', v, POSTER_OPTIONS[0]);
}

// --- (B) Shelves & bookcases: collection in descriptor + round-trip ----------
{
  // A shelf created via createProp with an explicit collection carries it.
  const room = parseRoom({ id: 'shelf-col', collections: ['a.collection.json', 'b.collection.json'], props: [] });
  const shelfA = createProp(room, 'shelf', { pos: [0, 1.25, -1.5], rot: [0, 90, 0] });
  shelfA.collection = 'a.collection.json';
  addProp(room, shelfA);

  const shelfB = createProp(room, 'shelf', { pos: [1, 1.25, -1.5], rot: [0, 90, 0] });
  shelfB.collection = 'b.collection.json';
  addProp(room, shelfB);

  eq('shelf-A collection set', shelfA.collection, 'a.collection.json');
  eq('shelf-B collection set', shelfB.collection, 'b.collection.json');

  // Both survive a round-trip.
  const out = serializeRoom(room, new Map());
  const back = parseRoom(out);
  const sA = back.props.find((p) => p.id === shelfA.id);
  const sB = back.props.find((p) => p.id === shelfB.id);
  eq('shelf-A collection round-trips', sA?.collection, 'a.collection.json');
  eq('shelf-B collection round-trips', sB?.collection, 'b.collection.json');

  // Cycling a shelf's collection through the ordered key list (same as existing
  // cycleShelfCollection tests, but now exercised on the persisted descriptor).
  const keys = roomCollectionRefs(room); // ['a.collection.json', 'b.collection.json']
  eq('roomCollectionRefs dedupes shelf refs', keys.length, 2);
  cycleShelfCollection(sA, keys);
  eq('cycleShelfCollection on persisted descriptor', sA.collection, 'b.collection.json');
}
{
  // Bookcase: same as shelf — collection field in descriptor, round-trips.
  const room = parseRoom({
    id: 'bc-col', collections: ['nes.collection.json'],
    props: [
      { type: 'bookcase', id: 'bc-1', collection: 'nes.collection.json',
        pos: [1, 0, -2], rot: [0, 0, 0] },
    ],
  });
  eq('bookcase props accepted by parseRoom', room.props.length, 1);
  eq('bookcase collection field preserved', room.props[0].collection, 'nes.collection.json');

  const out = serializeRoom(room, new Map());
  const back = parseRoom(out);
  eq('bookcase collection round-trips', back.props[0]?.collection, 'nes.collection.json');

  // cycleShelfCollection works on a bookcase prop (it only reads/writes
  // prop.collection — prop.type is irrelevant to the pure helper).
  const bc = back.props[0];
  const keys = ['nes.collection.json', 'snes.collection.json'];
  const next = cycleShelfCollection(bc, keys);
  eq('cycleShelfCollection on bookcase prop advances', next, 'snes.collection.json');
}
{
  // createProp for bookcase: no collection default → builder falls back to
  // room's first collection (same as shelf). Confirm descriptor is clean.
  const room = parseRoom({ id: 'bc-default', props: [] });
  const bc = createProp(room, 'bookcase', { pos: [0, 0, -2], rot: [0, 0, 0] });
  ok('new bookcase has no collection (builder falls back)', bc.collection === undefined);
  ok('CREATABLE list includes bookcase', CREATABLE_PROP_TYPES.includes('bookcase'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
