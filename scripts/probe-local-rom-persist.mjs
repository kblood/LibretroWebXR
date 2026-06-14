// Headless smoke probe: verify that a locally-picked ROM is PERSISTED across
// page reloads — the core feature of the LocalRomLibrary.
//
// What it tests:
//   1. After window.__pickLocalRom(), the entry appears in localStorage
//      (window.__localRoms() returns it with the correct sha1).
//   2. After page.reload(), the world re-mints the cart automatically via
//      restoreLocalRoms() — a shelf cartridge for the ROM exists without
//      re-picking the file.
//   3. resolving the re-minted cart's meta reads from OPFS with ZERO
//      roms/<file> network requests (bytes are in OPFS, not fetched).
//   4. Cleanup: the saved entry is prunable (localStorage key can be cleared).
//
// Usage:
//   node scripts/probe-local-rom-persist.mjs [url]
//   url defaults to http://localhost:5173/
//
// Requires the dev server to be running:
//   npm run dev
//
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
  args: [
    '--enable-features=SharedArrayBuffer',
    '--no-sandbox',
  ],
});

const page = await browser.newPage();

// Collect page-level JS errors.
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// Track all requests — assert no roms/<filename> fetch for our test ROM.
const romFetches = [];
page.on('request', (req) => {
  const u = req.url();
  if (/\/roms\//.test(u)) romFetches.push(u);
});

const failedFetches = [];
page.on('response', async (resp) => {
  const u = resp.url();
  // 304 Not Modified is a cache hit (success); only count real failures (4xx/5xx).
  const s = resp.status();
  if (/\/roms\//.test(u) && s >= 400) {
    failedFetches.push({ url: u, status: s });
  }
});

try {
  await page.goto(URL, { waitUntil: 'load' });
} catch (e) {
  console.error(`ERROR: could not load ${URL}: ${e.message}`);
  console.error('Is `npm run dev` running?');
  await browser.close();
  process.exit(1);
}

// Wait for the world to initialise.
try {
  await page.waitForFunction(
    () => window.__rom && typeof window.__rom.cacheRom === 'function'
       && typeof window.__pickLocalRom === 'function'
       && typeof window.__localRoms === 'function'
       && window.__grab,
    { timeout: 30000 },
  );
} catch {
  console.error('ERROR: app did not finish initialising within 30s');
  await browser.close();
  process.exit(1);
}

// Snapshot fetches so we only count our test's requests.
const fetchesBefore = romFetches.length;

// ---------------------------------------------------------------------------
// Phase 1: pick a ROM, assert it persists in localStorage
// ---------------------------------------------------------------------------

const phase1 = await page.evaluate(async () => {
  const R = { pass: [], fail: [] };
  const assert = (name, cond, extra) => {
    if (cond) R.pass.push(name);
    else R.fail.push(extra ? `${name} — ${extra}` : name);
  };

  // Clear any leftover state from previous runs.
  try { localStorage.removeItem('libretrowebxr.localroms'); } catch {}

  // Create fake ROM bytes (512 bytes).
  const fakeBytes = new Uint8Array(512);
  for (let i = 0; i < 512; i++) fakeBytes[i] = (i * 7 + 3) & 0xff;

  // Simulate a file pick.
  let pickResult;
  try {
    pickResult = await window.__pickLocalRom('persist-test.sfc', fakeBytes.buffer);
  } catch (e) {
    R.fail.push(`__pickLocalRom threw: ${e.message}`);
    return R;
  }

  assert('pickResult has sha1', typeof pickResult?.sha1 === 'string' && pickResult.sha1.length === 40,
    `sha1 = ${JSON.stringify(pickResult?.sha1)}`);
  assert('pickResult sources include opfs', pickResult?.sources?.includes('opfs'),
    `sources = ${JSON.stringify(pickResult?.sources)}`);

  // Check localStorage via __localRoms() hook.
  const list = window.__localRoms();
  assert('__localRoms() returns array', Array.isArray(list),
    `type = ${typeof list}`);
  const entry = list.find((e) => e.sha1 === pickResult?.sha1);
  assert('entry appears in __localRoms()', !!entry,
    `list = ${JSON.stringify(list?.map((e) => e.sha1))}`);
  if (entry) {
    assert('entry.file matches', entry.file === 'persist-test.sfc',
      `got ${entry.file}`);
    assert('entry.system is snes', entry.system === 'snes',
      `got ${entry.system}`);
    assert('entry.sources is [opfs,pick]',
      JSON.stringify(entry.sources) === JSON.stringify(['opfs', 'pick']),
      `got ${JSON.stringify(entry.sources)}`);
  }

  // Return sha1 so phase 2 can check for the re-minted cart.
  R.sha1 = pickResult?.sha1 || null;
  return R;
});

// ---------------------------------------------------------------------------
// Phase 2: reload the page and assert the cart reappears
// ---------------------------------------------------------------------------

// Collect fetches from reload onward separately.
const fetchesBeforeReload = romFetches.length;

await page.reload({ waitUntil: 'load' });

// Wait for the world and restoreLocalRoms to run.
try {
  await page.waitForFunction(
    () => window.__grab && typeof window.__localRoms === 'function',
    { timeout: 30000 },
  );
} catch {
  console.error('ERROR: world did not re-initialise after reload within 30s');
  await browser.close();
  process.exit(1);
}

// Give restoreLocalRoms a moment to re-mint carts (it's async fire-and-forget).
await new Promise((r) => setTimeout(r, 2000));

const sha1FromPhase1 = phase1.sha1;

const phase2 = await page.evaluate(async (sha1) => {
  const R = { pass: [], fail: [] };
  const assert = (name, cond, extra) => {
    if (cond) R.pass.push(name);
    else R.fail.push(extra ? `${name} — ${extra}` : name);
  };

  // Check the library is still there after reload.
  const list = window.__localRoms();
  assert('__localRoms() non-empty after reload', Array.isArray(list) && list.length > 0,
    `list = ${JSON.stringify(list)}`);
  const entry = list?.find((e) => e.sha1 === sha1);
  assert('entry persisted across reload', !!entry,
    `sha1 searched: ${sha1}, list = ${JSON.stringify(list?.map((e) => e.sha1))}`);

  // Check that a shelf cartridge for this ROM was re-minted.
  const carts = window.__grab?.grabbables?.filter((o) =>
    o.userData?.kind === 'cartridge' && o.userData?.rom?.sha1 === sha1,
  ) || [];
  assert('shelf cart re-minted after reload', carts.length > 0,
    `carts with matching sha1: ${carts.length}`);

  if (carts.length > 0) {
    const cartMeta = {
      file:   carts[0].userData.file,
      core:   carts[0].userData.core,
      system: carts[0].userData.system,
      title:  carts[0].userData.title,
      rom:    carts[0].userData.rom,
    };
    // Resolving from OPFS must succeed.
    let resolved = null;
    let resolveErr = null;
    try { resolved = await window.__rom.resolve(cartMeta); }
    catch (e) { resolveErr = String(e?.message || e); }
    assert('resolve() from OPFS succeeds after reload', resolved instanceof ArrayBuffer,
      resolveErr ? `threw: ${resolveErr}` : `got ${typeof resolved}`);
  }

  // Cleanup: remove the test entry so subsequent runs start clean.
  try { localStorage.removeItem('libretrowebxr.localroms'); } catch {}

  return R;
}, sha1FromPhase1);

// ---------------------------------------------------------------------------
// Phase 3: assert no roms/<filename> fetch for our test ROM
// ---------------------------------------------------------------------------

const newRomFetches = romFetches.slice(fetchesBefore);
const testRomFetches = newRomFetches.filter((u) =>
  u.includes('persist-test') || u.includes('persist%20test'),
);
const noTestRomFetch = testRomFetches.length === 0;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passes = [...phase1.pass, ...phase2.pass];
const fails  = [...phase1.fail, ...phase2.fail];

if (noTestRomFetch) {
  passes.push('no roms/persist-test.sfc network request during test');
} else {
  fails.push(`roms/<test-file> was fetched (should never happen for OPFS): ${JSON.stringify(testRomFetches)}`);
}

if (failedFetches.length) {
  fails.push(`unexpected 4xx/5xx during test: ${JSON.stringify(failedFetches)}`);
}

if (pageErrors.length) {
  console.warn('  [page errors]:', pageErrors.slice(0, 3).join('; '));
}

console.log('\n=== probe-local-rom-persist results ===');
for (const p of passes) console.log(`  PASS  ${p}`);
for (const f of fails)  console.log(`  FAIL  ${f}`);
console.log(`\n${passes.length} passed, ${fails.length} failed`);

await browser.close();
process.exit(fails.length ? 1 : 0);
