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
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
