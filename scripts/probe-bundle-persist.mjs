// Headless smoke probe: verify the multi-file content-bundle OPFS cache (C4,
// 2026-07-27) actually round-trips real bytes through the browser's real
// Origin-Private File System — the one part of src/RomResolver.js's
// cacheBundle/hasBundleCached/restoreBundleFiles that node --test can't touch
// (see scripts/test-romresolver.mjs's comment on isUnresolvableHere for why).
//
// What it tests:
//   1. cacheBundle() writes every companion file (including one with a
//      subdirectory path, e.g. 'Disc/game.cue') into OPFS.
//   2. hasBundleCached() reports true for the exact file list right after.
//   3. Bytes read back via restoreBundleFiles() match exactly what was
//      written (a real File in each {path, source} pair, not a stub).
//   4. Survives a page reload (OPFS is origin-persistent, not page-scoped).
//   5. Evicting ONE companion file makes hasBundleCached() report false
//      (partial eviction correctly treated as fully gone) and
//      restoreBundleFiles() returns null (not a partial list).
//
// Usage:
//   node scripts/probe-bundle-persist.mjs [url]
//   url defaults to http://localhost:5173/
//
// Requires the dev server to be running:  npm run dev
// Exit code: 0 = all assertions passed, 1 = at least one failed.

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:5173/';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) {
  console.error('ERROR: no Chrome/Edge binary found');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
});

const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  await page.goto(URL, { waitUntil: 'load' });
} catch (e) {
  console.error(`ERROR: could not load ${URL}: ${e.message}`);
  console.error('Is `npm run dev` running?');
  await browser.close();
  process.exit(1);
}

try {
  await page.waitForFunction(
    () => window.__rom && typeof window.__rom.cacheBundle === 'function'
       && typeof window.__rom.hasBundleCached === 'function'
       && typeof window.__rom.restoreBundleFiles === 'function',
    { timeout: 30000 },
  );
} catch {
  console.error('ERROR: app did not finish initialising within 30s');
  await browser.close();
  process.exit(1);
}

const CONTENT_ID = 'sha256:probe-bundle-test';
const FILES = ['Disc/game.cue', 'Disc/game.bin']; // one path with a subdirectory

// ---------------------------------------------------------------------------
// Phase 1: cache a synthetic bundle, verify it's immediately readable back
// ---------------------------------------------------------------------------

const phase1 = await page.evaluate(async (contentId, files) => {
  const R = { pass: [], fail: [] };
  const assert = (name, cond, extra) => {
    if (cond) R.pass.push(name); else R.fail.push(extra ? `${name} — ${extra}` : name);
  };

  const cueBytes = new TextEncoder().encode('FILE "game.bin" BINARY\n TRACK 01 MODE2/2352');
  const binBytes = new Uint8Array(2048);
  for (let i = 0; i < binBytes.length; i++) binBytes[i] = (i * 13 + 7) & 0xff;
  const sourceMap = new Map([[files[0], cueBytes], [files[1], binBytes]]);

  const ok = await window.__rom.cacheBundle(contentId, sourceMap);
  assert('cacheBundle reports success', ok === true);

  const cached = await window.__rom.hasBundleCached(contentId, files);
  assert('hasBundleCached true right after caching', cached === true);

  const named = await window.__rom.restoreBundleFiles(contentId, files);
  assert('restoreBundleFiles returns an entry per file', Array.isArray(named) && named.length === 2,
    `got ${JSON.stringify(named?.length)}`);
  if (named) {
    const cueEntry = named.find((e) => e.path === files[0]);
    const binEntry = named.find((e) => e.path === files[1]);
    assert('cue entry present with a real File', cueEntry?.source instanceof File);
    assert('bin entry present with a real File', binEntry?.source instanceof File);
    if (cueEntry) {
      const roundTripCue = new Uint8Array(await cueEntry.source.arrayBuffer());
      assert('cue bytes match exactly', roundTripCue.length === cueBytes.length
        && roundTripCue.every((b, i) => b === cueBytes[i]));
    }
    if (binEntry) {
      const roundTripBin = new Uint8Array(await binEntry.source.arrayBuffer());
      assert('bin bytes match exactly (2048 bytes incl. subdirectory path)',
        roundTripBin.length === binBytes.length && roundTripBin.every((b, i) => b === binBytes[i]));
    }
  }

  // A companion NOT in the cached set is correctly reported missing.
  const missing = await window.__rom.hasBundleCached(contentId, [...files, 'Disc/not-cached.bin']);
  assert('hasBundleCached false when any companion is absent', missing === false);
  const missingNamed = await window.__rom.restoreBundleFiles(contentId, [...files, 'Disc/not-cached.bin']);
  assert('restoreBundleFiles returns null (not partial) when any companion is absent', missingNamed === null);

  return R;
}, CONTENT_ID, FILES);

// ---------------------------------------------------------------------------
// Phase 2: reload — OPFS is origin-persistent, must survive
// ---------------------------------------------------------------------------

await page.reload({ waitUntil: 'load' });
try {
  await page.waitForFunction(
    () => window.__rom && typeof window.__rom.hasBundleCached === 'function',
    { timeout: 30000 },
  );
} catch {
  console.error('ERROR: world did not re-initialise after reload within 30s');
  await browser.close();
  process.exit(1);
}

const phase2 = await page.evaluate(async (contentId, files) => {
  const R = { pass: [], fail: [] };
  const assert = (name, cond, extra) => {
    if (cond) R.pass.push(name); else R.fail.push(extra ? `${name} — ${extra}` : name);
  };

  const stillCached = await window.__rom.hasBundleCached(contentId, files);
  assert('bundle survives a page reload', stillCached === true);
  return R;
}, CONTENT_ID, FILES);

// ---------------------------------------------------------------------------
// Phase 3: partial eviction — delete one companion file directly via OPFS,
// confirm hasBundleCached correctly treats the WHOLE bundle as gone.
// ---------------------------------------------------------------------------

const phase3 = await page.evaluate(async (contentId, files) => {
  const R = { pass: [], fail: [] };
  const assert = (name, cond, extra) => {
    if (cond) R.pass.push(name); else R.fail.push(extra ? `${name} — ${extra}` : name);
  };

  try {
    const root = await navigator.storage.getDirectory();
    const bundleDir = await root.getDirectoryHandle(`bundle-${contentId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    const discDir = await bundleDir.getDirectoryHandle('Disc');
    await discDir.removeEntry('game.bin');
  } catch (e) {
    R.fail.push(`setup: could not evict companion file: ${e.message}`);
    return R;
  }

  const afterEviction = await window.__rom.hasBundleCached(contentId, files);
  assert('hasBundleCached false after one companion is evicted', afterEviction === false);
  const namedAfterEviction = await window.__rom.restoreBundleFiles(contentId, files);
  assert('restoreBundleFiles returns null (not a partial list) after eviction', namedAfterEviction === null);

  // Cleanup: remove the whole bundle directory so subsequent runs start clean.
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(`bundle-${contentId.replace(/[^a-zA-Z0-9_-]/g, '_')}`, { recursive: true });
  } catch {}

  return R;
}, CONTENT_ID, FILES);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passes = [...phase1.pass, ...phase2.pass, ...phase3.pass];
const fails  = [...phase1.fail, ...phase2.fail, ...phase3.fail];

if (pageErrors.length) console.warn('  [page errors]:', pageErrors.slice(0, 3).join('; '));

console.log('\n=== probe-bundle-persist results ===');
for (const p of passes) console.log(`  PASS  ${p}`);
for (const f of fails)  console.log(`  FAIL  ${f}`);
console.log(`\n${passes.length} passed, ${fails.length} failed`);

await browser.close();
process.exit(fails.length ? 1 : 0);
