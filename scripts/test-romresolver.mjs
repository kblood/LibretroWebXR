// Unit tests for src/RomResolver.js — pure/Node-testable surface.
// Run standalone:  node scripts/test-romresolver.mjs
// Or via npm test: wired into package.json test chain.

import {
  fileBaseName,
  wantedFileName,
  fileNameMatches,
  romUrlFor,
  sourceOrder,
  cacheKey,
  resolutionPlan,
  resolve,
  isLocalRomMeta,
  isUnresolvableHere,
  verifyRomIntegrity,
  sha1Hex,
} from '../src/RomResolver.js';

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
// fileBaseName
// ---------------------------------------------------------------------------

console.log('--- fileBaseName ---');
{
  ok('forward slash', fileBaseName('roms/snes/game.sfc') === 'game.sfc');
  ok('back slash', fileBaseName('C:\\ROMs\\snes\\game.sfc') === 'game.sfc');
  ok('mixed separators', fileBaseName('roms\\sub/game.sfc') === 'game.sfc');
  ok('no directory', fileBaseName('game.sfc') === 'game.sfc');
  ok('empty string', fileBaseName('') === '');
  ok('null', fileBaseName(null) === '');
  ok('undefined', fileBaseName(undefined) === '');
  ok('trailing slash', fileBaseName('roms/') === '');
}

// ---------------------------------------------------------------------------
// wantedFileName
// ---------------------------------------------------------------------------

console.log('--- wantedFileName ---');
{
  // rom.path wins
  eq('rom.path wins', wantedFileName({ rom: { path: 'roms/super mario.sfc', filename: 'other.smc', url: 'x.sfc' } }), 'super mario.sfc');
  // rom.filename is second priority
  eq('rom.filename second', wantedFileName({ rom: { filename: 'game.smc' }, file: 'fallback.smc' }), 'game.smc');
  // meta.file is the last resort
  eq('meta.file fallback', wantedFileName({ file: 'fallback.smc' }), 'fallback.smc');
  // nothing → empty string
  eq('nothing', wantedFileName({}), '');
  eq('null meta', wantedFileName(null), '');
  // path with backslash in rom.path
  eq('back slash rom.path', wantedFileName({ rom: { path: 'C:\\Games\\game.sfc' } }), 'game.sfc');
}

// ---------------------------------------------------------------------------
// fileNameMatches
// ---------------------------------------------------------------------------

console.log('--- fileNameMatches ---');
{
  ok('exact match', fileNameMatches('game.sfc', 'game.sfc'));
  ok('case-insensitive wanted upper', fileNameMatches('GAME.SFC', 'game.sfc'));
  ok('case-insensitive candidate upper', fileNameMatches('game.sfc', 'GAME.SFC'));
  ok('both upper', fileNameMatches('GAME.SFC', 'GAME.SFC'));
  ok('path in wanted', fileNameMatches('roms/game.sfc', 'game.sfc'));
  ok('path in candidate', fileNameMatches('game.sfc', 'sub/game.sfc'));
  ok('no match', !fileNameMatches('game.sfc', 'other.sfc'));
  ok('empty wanted → false', !fileNameMatches('', 'game.sfc'));
  ok('null wanted → false', !fileNameMatches(null, 'game.sfc'));
  ok('empty candidate', !fileNameMatches('game.sfc', ''));
}

// ---------------------------------------------------------------------------
// romUrlFor
// ---------------------------------------------------------------------------

console.log('--- romUrlFor ---');
{
  // Absolute http
  eq('http url', romUrlFor({ rom: { url: 'http://example.com/game.sfc' } }), 'http://example.com/game.sfc');
  // Absolute https
  eq('https url', romUrlFor({ rom: { url: 'https://example.com/game.sfc' } }), 'https://example.com/game.sfc');
  // HTTPS case-insensitive prefix
  eq('HTTPS prefix', romUrlFor({ rom: { url: 'HTTPS://example.com/game.sfc' } }), 'HTTPS://example.com/game.sfc');
  // Rooted path is used as-is
  eq('rooted path', romUrlFor({ rom: { url: '/roms/game.sfc' } }), '/roms/game.sfc');
  // Bare relative → roms/ base
  eq('bare relative', romUrlFor({ rom: { url: 'game.sfc' } }), 'roms/game.sfc');
  // Custom base
  eq('custom base', romUrlFor({ rom: { url: 'game.sfc' } }, { base: 'content/roms/' }), 'content/roms/game.sfc');
  // Falls back to meta.file
  eq('meta.file bare', romUrlFor({ file: 'game.sfc' }), 'roms/game.sfc');
  // rom.url preferred over meta.file
  eq('rom.url over meta.file', romUrlFor({ rom: { url: 'rom.sfc' }, file: 'other.sfc' }), 'roms/rom.sfc');
  // Nothing → null
  eq('no url no file', romUrlFor({}), null);
  eq('null meta', romUrlFor(null), null);
}

// ---------------------------------------------------------------------------
// sourceOrder
// ---------------------------------------------------------------------------

console.log('--- sourceOrder ---');
{
  // Explicit sources array
  eq('rom.sources[]', sourceOrder({ rom: { sources: ['local', 'url'] } }), ['local', 'url']);
  // Empty sources array falls through to next rule
  eq('empty sources[] falls through', sourceOrder({ rom: { sources: [], url: 'x.sfc' } }), ['url']);
  // Single rom.source
  eq('single rom.source', sourceOrder({ rom: { source: 'local' } }), ['local']);
  // URL derivable → ['url']
  eq('url derivable', sourceOrder({ file: 'game.sfc' }), ['url']);
  eq('rom.url derivable', sourceOrder({ rom: { url: 'http://example.com/g.sfc' } }), ['url']);
  // Nothing → ['pick']
  eq('no url → pick', sourceOrder({}), ['pick']);
  eq('null meta → pick', sourceOrder(null), ['pick']);
  // rom.sources is not mutated (slice copy)
  {
    const orig = ['url', 'local'];
    const meta = { rom: { sources: orig } };
    const result = sourceOrder(meta);
    result.push('pick');
    ok('rom.sources not mutated', meta.rom.sources.length === 2);
  }
}

// ---------------------------------------------------------------------------
// cacheKey
// ---------------------------------------------------------------------------

console.log('--- cacheKey ---');
{
  eq('sha1 present', cacheKey({ rom: { sha1: 'AABBCC1122' } }), 'sha1-aabbcc1122');
  eq('sha1 lowercased', cacheKey({ rom: { sha1: 'DEADBEEF' } }), 'sha1-deadbeef');
  eq('sha1 already lower', cacheKey({ rom: { sha1: 'abc123' } }), 'sha1-abc123');
  eq('no sha1', cacheKey({ rom: {} }), null);
  eq('no rom', cacheKey({}), null);
  eq('null meta', cacheKey(null), null);
}

// ---------------------------------------------------------------------------
// resolutionPlan
// ---------------------------------------------------------------------------

console.log('--- resolutionPlan ---');
{
  // Full SNES entry with sha1 + file
  {
    const meta = {
      title: 'Super Game',
      file: 'super_game.sfc',
      rom: { sha1: 'AABBCCDD11', sources: ['local', 'url'] },
    };
    const plan = resolutionPlan(meta);
    eq('plan sha1', plan.sha1, 'AABBCCDD11');
    eq('plan cacheKey', plan.cacheKey, 'sha1-aabbccdd11');
    eq('plan order', plan.order, ['local', 'url']);
    eq('plan url', plan.url, 'roms/super_game.sfc');
    eq('plan wantedFile', plan.wantedFile, 'super_game.sfc');
  }
  // Minimal CC0-style entry (no sha1, bare file)
  {
    const meta = { file: 'pong.a26' };
    const plan = resolutionPlan(meta);
    eq('plan no sha1', plan.sha1, null);
    eq('plan no cacheKey', plan.cacheKey, null);
    eq('plan order url', plan.order, ['url']);
    eq('plan url bare', plan.url, 'roms/pong.a26');
    eq('plan wantedFile bare', plan.wantedFile, 'pong.a26');
  }
  // Entry with nothing
  {
    const plan = resolutionPlan({});
    eq('empty plan sha1', plan.sha1, null);
    eq('empty plan cacheKey', plan.cacheKey, null);
    eq('empty plan order', plan.order, ['pick']);
    eq('empty plan url', plan.url, null);
    eq('empty plan wantedFile', plan.wantedFile, null);
  }
  // null meta
  {
    const plan = resolutionPlan(null);
    eq('null meta plan sha1', plan.sha1, null);
    eq('null meta plan cacheKey', plan.cacheKey, null);
    eq('null meta plan order', plan.order, ['pick']);
    eq('null meta plan url', plan.url, null);
    eq('null meta plan wantedFile', plan.wantedFile, null);
  }
}

// ---------------------------------------------------------------------------
// resolve() — injected fetchImpl (no OPFS, no sha1, safe in Node)
// ---------------------------------------------------------------------------

console.log('--- resolve() with injected fetchImpl ---');

const FAKE_BUF = new ArrayBuffer(8);
const okFetch = async (_url) => ({ ok: true, status: 200, arrayBuffer: async () => FAKE_BUF });
const notFoundFetch = async (_url) => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

// Success path: meta with a file url, fetchImpl succeeds.
{
  const meta = { title: 'Test Game', file: 'test.sfc' };
  let buf;
  try {
    buf = await resolve(meta, { fetchImpl: okFetch });
    ok('resolve url success returns ArrayBuffer', buf instanceof ArrayBuffer);
    ok('resolve url success byteLength = 8', buf.byteLength === 8);
  } catch (e) {
    fail++; console.error(`FAIL  resolve url success threw: ${e.message}`);
  }
}

// Force source:'url' explicitly.
{
  const meta = { title: 'Test Game', file: 'test.sfc' };
  let buf;
  try {
    buf = await resolve(meta, { source: 'url', fetchImpl: okFetch });
    ok('resolve forced url returns ArrayBuffer', buf instanceof ArrayBuffer);
  } catch (e) {
    fail++; console.error(`FAIL  resolve forced url threw: ${e.message}`);
  }
}

// 404 → should throw with aggregated message containing the status.
{
  // Ensure only 'url' is in the source order so we get a clean single-source failure.
  const meta = { title: 'Missing ROM', rom: { url: 'roms/missing.sfc' } };
  // sourceOrder → ['url'] because romUrlFor returns a value.
  try {
    await resolve(meta, { fetchImpl: notFoundFetch });
    fail++; console.error('FAIL  resolve 404 should have thrown');
  } catch (e) {
    ok('resolve 404 throws', e instanceof Error);
    ok('resolve 404 message contains title', e.message.includes('Missing ROM'));
    ok('resolve 404 message contains status 404', e.message.includes('404'));
    ok('resolve 404 message contains source "url"', e.message.includes('url:'));
  }
}

// 404 with forced source:'url' — same aggregated error.
{
  const meta = { title: 'Forced Miss', file: 'miss.sfc' };
  try {
    await resolve(meta, { source: 'url', fetchImpl: notFoundFetch });
    fail++; console.error('FAIL  resolve forced 404 should have thrown');
  } catch (e) {
    ok('resolve forced 404 throws Error', e instanceof Error);
    ok('resolve forced 404 message has "Forced Miss"', e.message.includes('Forced Miss'));
    ok('resolve forced 404 message has 404', e.message.includes('404'));
  }
}

// No url and no fetchImpl for opfs/local/pick → resolve pick fails in Node
// (document is undefined). Verify error lists source in aggregated message.
{
  const meta = { title: 'No URL Game', rom: { source: 'pick' } };
  try {
    await resolve(meta, {});
    fail++; console.error('FAIL  resolve pick-in-Node should have thrown');
  } catch (e) {
    ok('resolve pick-in-Node throws', e instanceof Error);
    ok('resolve pick-in-Node message contains "pick:"', e.message.includes('pick:'));
    ok('resolve pick-in-Node message contains title', e.message.includes('No URL Game'));
  }
}

// ---------------------------------------------------------------------------
// verifyRomIntegrity / resolve() — declared sha1 is actually enforced, not
// just used as a cache key.
// ---------------------------------------------------------------------------

console.log('--- verifyRomIntegrity ---');
{
  // No declared sha1 → no-op, whatever the bytes are.
  try {
    await verifyRomIntegrity(FAKE_BUF, { rom: {} });
    ok('verifyRomIntegrity no-op with no declared sha1', true);
  } catch (e) {
    fail++; console.error(`FAIL  verifyRomIntegrity no-op threw: ${e.message}`);
  }

  const trueSha1 = await sha1Hex(FAKE_BUF);

  try {
    await verifyRomIntegrity(FAKE_BUF, { rom: { sha1: trueSha1 } });
    ok('verifyRomIntegrity passes on matching sha1', true);
  } catch (e) {
    fail++; console.error(`FAIL  verifyRomIntegrity matching threw: ${e.message}`);
  }

  try {
    await verifyRomIntegrity(FAKE_BUF, { rom: { sha1: trueSha1.toUpperCase() } });
    ok('verifyRomIntegrity is case-insensitive', true);
  } catch (e) {
    fail++; console.error(`FAIL  verifyRomIntegrity case-insensitive threw: ${e.message}`);
  }

  try {
    await verifyRomIntegrity(FAKE_BUF, { rom: { sha1: '0000000000000000000000000000000000000a' } });
    fail++; console.error('FAIL  verifyRomIntegrity should have thrown on mismatch');
  } catch (e) {
    ok('verifyRomIntegrity throws on mismatch', e instanceof Error);
    ok('verifyRomIntegrity mismatch message mentions sha1', e.message.includes('sha1 mismatch'));
  }
}

console.log('--- resolve() enforces declared sha1 ---');
{
  const trueSha1 = await sha1Hex(FAKE_BUF);

  // Correct declared sha1 alongside a url source → resolves normally.
  {
    const meta = { title: 'Verified Game', file: 'test.sfc', rom: { sha1: trueSha1 } };
    try {
      const buf = await resolve(meta, { fetchImpl: okFetch });
      ok('resolve succeeds when fetched bytes match declared sha1', buf instanceof ArrayBuffer);
    } catch (e) {
      fail++; console.error(`FAIL  resolve with matching sha1 threw: ${e.message}`);
    }
  }

  // Wrong declared sha1 → resolve rejects even though the fetch itself succeeded (200 OK).
  {
    const meta = { title: 'Tampered Game', file: 'test.sfc', rom: { sha1: '1111111111111111111111111111111111111a' } };
    try {
      await resolve(meta, { fetchImpl: okFetch });
      fail++; console.error('FAIL  resolve should reject bytes that fail sha1 verification');
    } catch (e) {
      ok('resolve rejects sha1-mismatched bytes', e instanceof Error);
      ok('resolve mismatch message names the source', e.message.includes('url:'));
      ok('resolve mismatch message mentions sha1', e.message.includes('sha1 mismatch'));
    }
  }
}

// ---------------------------------------------------------------------------
// isUnresolvableHere — pre-flight "you don't have this ROM" classification.
// Node has no OPFS (navigator.storage is undefined), so every local-only
// entry here behaves like a browser that's never cached the bytes — exactly
// the cross-peer scenario this predicate exists to catch. The one case it
// canNOT exercise in Node is "local-only AND actually OPFS-cached" (needs a
// real browser); that path is headless-browser-verified separately via the
// existing --rom= pick-and-cache flow (see the debug harness notes).
// ---------------------------------------------------------------------------

console.log('--- isUnresolvableHere ---');
{
  // Shipping CC0 game: no `rom` block at all → always resolvable (url source).
  ok('shipping game (no rom block) is resolvable',
    !(await isUnresolvableHere({ file: 'freeware/lwx-snes-demo.sfc', title: 'LWX Demo' })));

  // Explicit url source → resolvable, regardless of sha1.
  ok('explicit url source is resolvable',
    !(await isUnresolvableHere({ file: 'game.sfc', rom: { source: 'url', sha1: 'deadbeef' } })));

  // Local-only (opfs+pick), sha1 declared, but Node has no OPFS → unresolvable here.
  ok('local-only with sha1, no OPFS in this env → unresolvable',
    await isUnresolvableHere({ file: 'game.sfc', rom: { sha1: 'a1b2c3', sources: ['opfs', 'pick'] } }));

  // Local-only, NO declared sha1 → can never be OPFS-verified → unresolvable.
  ok('local-only with no sha1 → unresolvable',
    await isUnresolvableHere({ file: 'game.sfc', rom: { source: 'pick' } }));

  // Sanity: doesn't throw on a bare/null-ish meta.
  ok('null meta does not throw', !(await isUnresolvableHere(null)));
  ok('empty meta does not throw', !(await isUnresolvableHere({})));
}

// ---------------------------------------------------------------------------
// isLocalRomMeta — picked/OPFS-only ROMs (no server URL fallback)
// ---------------------------------------------------------------------------

console.log('--- isLocalRomMeta ---');
{
  // The canonical post-cacheRom meta: opfs first, pick as fallback.
  ok('opfs+pick is local',
    isLocalRomMeta({ file: 'game.sfc', rom: { sha1: 'abc', sources: ['opfs', 'pick'] } }));

  // OPFS only (sha1 known but cacheRom-only)
  ok('opfs-only is local',
    isLocalRomMeta({ file: 'game.sfc', rom: { sha1: 'abc', sources: ['opfs'] } }));

  // pick-only (OPFS unavailable on this device)
  ok('pick-only is local',
    isLocalRomMeta({ file: 'game.sfc', rom: { source: 'pick' } }));

  // pick only via sources array
  ok('pick-only sources[] is local',
    isLocalRomMeta({ file: 'game.sfc', rom: { sources: ['pick'] } }));

  // url-containing entries are NOT local (server ROM)
  ok('url alone is NOT local',
    !isLocalRomMeta({ file: 'game.sfc' }));
  ok('url source is NOT local',
    !isLocalRomMeta({ file: 'game.sfc', rom: { source: 'url' } }));
  ok('opfs+url mix is NOT local',
    !isLocalRomMeta({ file: 'game.sfc', rom: { sources: ['opfs', 'url'] } }));
  ok('local-folder source is NOT local',
    !isLocalRomMeta({ file: 'game.sfc', rom: { source: 'local' } }));

  // null / empty — no explicit rom source → NOT local (could be any unspecced entry)
  ok('null meta → NOT local', !isLocalRomMeta(null));
  ok('empty meta → NOT local', !isLocalRomMeta({}));
  ok('rom block with no source → NOT local', !isLocalRomMeta({ rom: {} }));
}

// ---------------------------------------------------------------------------
// Local-ROM lifecycle round-trip (pure logic, no browser APIs)
//
// This verifies the key invariant from the Quest bug:
//   picked ROM meta with sha1 + sources=['opfs','pick']
//   → sourceOrder NEVER contains 'url'
//   → cacheKey returns a valid key
//   → resolutionPlan reflects it correctly
//   → cart.userData.rom round-trip: the same object passed to createCartridge
//     is what the cart carries, and GrabMgr forwards it verbatim on insert
// ---------------------------------------------------------------------------

console.log('--- local-ROM round-trip (core invariant) ---');
{
  // Simulate what romInput handler produces after a successful cacheRom:
  const sha1 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const pickedMeta = {
    file: 'AD&D - Eye of the Beholder.smc',
    core: 'snes9x',
    system: 'snes',
    title: 'AD&D - Eye of the Beholder',
    rom: { sha1, sources: ['opfs', 'pick'] },
  };

  // sourceOrder must be ['opfs','pick'] — never ['url'].
  const order = sourceOrder(pickedMeta);
  eq('picked-ROM sourceOrder', order, ['opfs', 'pick']);
  ok('picked-ROM order has no url', !order.includes('url'));

  // cacheKey must resolve to the sha1-prefixed key.
  eq('picked-ROM cacheKey', cacheKey(pickedMeta), `sha1-${sha1}`);

  // resolutionPlan must reflect opfs+pick, no url source.
  const plan = resolutionPlan(pickedMeta);
  eq('picked-ROM plan order', plan.order, ['opfs', 'pick']);
  ok('picked-ROM plan has sha1', plan.sha1 === sha1);
  // url in the plan is the fallback URL that would be built from meta.file;
  // it IS populated (romUrlFor uses meta.file) but the source ORDER never
  // contains 'url', so the resolver never fetches it.
  ok('picked-ROM plan url exists (but not used)', plan.url !== null);

  // isLocalRomMeta confirms this is a local-only entry.
  ok('picked-ROM isLocalRomMeta', isLocalRomMeta(pickedMeta));

  // --- Simulate cart.userData round-trip ---
  // createCartridge stores meta.rom as cart.userData.rom.
  // GrabMgr forwards it on insert: { file, core, system, title, rom: cart.userData.rom || undefined }
  // Verify the forwarded meta still resolves correctly.
  const cartUserDataRom = pickedMeta.rom; // what Cartridge.js stores
  const insertedMeta = {
    file: pickedMeta.file,
    core: pickedMeta.core,
    system: pickedMeta.system,
    title: pickedMeta.title,
    rom: cartUserDataRom || undefined,
  };
  eq('cart round-trip sourceOrder', sourceOrder(insertedMeta), ['opfs', 'pick']);
  ok('cart round-trip no url', !sourceOrder(insertedMeta).includes('url'));
  eq('cart round-trip cacheKey', cacheKey(insertedMeta), `sha1-${sha1}`);
  ok('cart round-trip isLocal', isLocalRomMeta(insertedMeta));

  // --- Fallback when OPFS is unavailable (cacheRom returns null) ---
  const noCacheMeta = {
    file: 'game.sfc',
    core: 'snes9x',
    system: 'snes',
    title: 'Game',
    rom: { source: 'pick' }, // what romInput sets when sha1 = null
  };
  eq('no-opfs sourceOrder', sourceOrder(noCacheMeta), ['pick']);
  ok('no-opfs no url', !sourceOrder(noCacheMeta).includes('url'));
  ok('no-opfs isLocal', isLocalRomMeta(noCacheMeta));
  eq('no-opfs cacheKey', cacheKey(noCacheMeta), null); // no sha1 → no opfs key

  // --- Confirm that a plain file-only meta (shipping ROM) is NOT affected ---
  const shippingMeta = { file: 'freeware/lwx-snes-demo.sfc', core: 'snes9x', system: 'snes', title: 'LWX Demo' };
  eq('shipping sourceOrder', sourceOrder(shippingMeta), ['url']);
  ok('shipping isLocal false', !isLocalRomMeta(shippingMeta));
}

// ---------------------------------------------------------------------------
// Special characters in romUrlFor (filenames with spaces and ampersands)
// The sha1-keyed OPFS path is safe; only the url fallback uses raw filename.
// Assert the URL is at least built (encoding is the caller's job) and that
// local-ROM meta never reaches fromUrl in the resolver.
// ---------------------------------------------------------------------------

console.log('--- special chars in romUrlFor ---');
{
  const specialMeta = { file: 'AD&D - Eye of the Beholder.smc' };
  const url = romUrlFor(specialMeta);
  // URL is built using the raw filename — contains the special chars.
  ok('special chars url built', url === 'roms/AD&D - Eye of the Beholder.smc');
  // A picked version of the same file (with sha1) never hits fromUrl.
  const pickedSpecial = {
    file: 'AD&D - Eye of the Beholder.smc',
    rom: { sha1: 'deadbeef01', sources: ['opfs', 'pick'] },
  };
  ok('special chars picked not url', !sourceOrder(pickedSpecial).includes('url'));
  ok('special chars picked isLocal', isLocalRomMeta(pickedSpecial));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
