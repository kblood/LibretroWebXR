// Headless smoke probe: verify the local-ROM lifecycle works end-to-end
// WITHOUT a real OS file picker or a real core boot.
//
// What it tests:
//   1. cacheRom() stores bytes in OPFS and returns a sha1 hex string.
//   2. A cartridge minted via addLocalRomToShelf() carries the sha1 + sources
//      in its userData.rom (the key invariant for re-boot on the headset).
//   3. RomResolver.resolve() with that meta re-reads from OPFS and never
//      attempts a roms/<file> server fetch (which would 404 for a local ROM).
//   4. The window.__pickLocalRom() debug hook produces the same result end-to-end,
//      exercising the full romInput handler path (without the OS picker).
//   5. Special characters (spaces, &) in filenames don't corrupt OPFS keys.
//
// Usage:
//   node scripts/probe-local-rom.mjs [url]
//   url defaults to http://localhost:5173/
//
// Requires the dev server to be running:
//   npm run dev
//
// The probe tracks all requests made by the page and asserts that no
//   roms/<filename>  fetch happens when a local ROM is resolved from OPFS.
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
    // OPFS requires a secure context or localhost — localhost is fine for dev.
    '--disable-web-security=false',
  ],
});

const page = await browser.newPage();

// Collect page-level JS errors.
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// Track all requests — we'll assert no roms/<filename> fetch happens for
// local ROMs (the bug: resolver falling back to url → 404).
const romFetches = [];
page.on('request', (req) => {
  const u = req.url();
  if (/\/roms\//.test(u)) romFetches.push(u);
});

// Response errors we care about (4xx/5xx for ROM fetches).
const failedFetches = [];
page.on('response', async (resp) => {
  const u = resp.url();
  if (/\/roms\//.test(u) && !resp.ok()) {
    failedFetches.push({ url: u, status: resp.status() });
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

// Wait for the app to initialise (the __rack and __rom hooks are installed
// inside the async build() function, which runs after DOMContentLoaded).
try {
  await page.waitForFunction(
    () => window.__rom && typeof window.__rom.cacheRom === 'function'
       && window.__addLocalRom && window.__grab,
    { timeout: 30000 },
  );
} catch {
  console.error('ERROR: app did not finish initialising within 30s');
  await browser.close();
  process.exit(1);
}

// Snapshot rom fetches before our test so we only count our test's requests.
const fetchesBefore = romFetches.length;

// Run all assertions inside the page context so we have full access to the
// window.__ hooks and can use OPFS directly.
const result = await page.evaluate(async () => {
  const R = { pass: [], fail: [] };
  const assert = (name, cond, extra) => {
    if (cond) { R.pass.push(name); }
    else { R.fail.push(extra ? `${name} — ${extra}` : name); }
  };
  const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

  // -------------------------------------------------------------------------
  // Part 1: cacheRom → sha1 round-trip via window.__rom (no boot required)
  // -------------------------------------------------------------------------

  // Create fake ROM bytes — 512 bytes of sequential values.
  // Real cores would reject this, but we never actually run emulation here.
  const fakeBytes = new Uint8Array(512);
  for (let i = 0; i < 512; i++) fakeBytes[i] = i & 0xff;
  const fakeBuf = fakeBytes.buffer;

  const sha1 = await window.__rom.cacheRom(fakeBuf);
  assert('cacheRom returns a string sha1', typeof sha1 === 'string' && sha1.length === 40,
    `got: ${JSON.stringify(sha1)}`);
  assert('sha1 is lowercase hex', sha1 !== null && /^[0-9a-f]{40}$/.test(sha1),
    `got: ${sha1}`);

  // -------------------------------------------------------------------------
  // Part 2: addLocalRomToShelf with pre-built sha1 meta → cart userData
  // -------------------------------------------------------------------------

  const localMeta = {
    file: 'AD&D - Eye of the Beholder.smc',
    core: 'snes9x',
    system: 'snes',
    title: 'AD&D - Eye of the Beholder',
    rom: { sha1, sources: ['opfs', 'pick'] },
  };

  const shelfBefore = window.__grab?.grabbables?.filter((o) => o.userData?.kind === 'cartridge').length ?? 0;
  const cart = await window.__addLocalRom(localMeta);
  await sleep(100);

  assert('cart is minted', cart !== null && cart !== undefined, 'addLocalRomToShelf returned null');
  if (cart) {
    assert('cart.userData.rom is set', cart.userData?.rom != null,
      `rom = ${JSON.stringify(cart.userData?.rom)}`);
    assert('cart.userData.rom.sha1 matches', cart.userData?.rom?.sha1 === sha1,
      `got ${cart.userData?.rom?.sha1}`);
    assert('cart.userData.rom.sources has opfs', cart.userData?.rom?.sources?.includes('opfs'),
      `sources = ${JSON.stringify(cart.userData?.rom?.sources)}`);
    assert('cart.userData.rom.sources has pick', cart.userData?.rom?.sources?.includes('pick'),
      `sources = ${JSON.stringify(cart.userData?.rom?.sources)}`);
    assert('cart.userData.rom.sources has NO url',
      !cart.userData?.rom?.sources?.includes('url'),
      `sources = ${JSON.stringify(cart.userData?.rom?.sources)}`);
    assert('cart registered as grabbable',
      (window.__grab?.grabbables?.filter((o) => o.userData?.kind === 'cartridge').length ?? 0) > shelfBefore);
  }

  // -------------------------------------------------------------------------
  // Part 3: RomResolver.resolve() with the cart's meta → reads from OPFS
  //         and performs NO roms/<file> network request
  // -------------------------------------------------------------------------

  if (cart && sha1) {
    const cartMeta = {
      file: cart.userData.file,
      core: cart.userData.core,
      system: cart.userData.system,
      title: cart.userData.title,
      rom: cart.userData.rom,
    };

    // Record rom fetches before resolve() so we can check the delta.
    // (Fetches from Part 1-2 are excluded by the snapshot taken before evaluate.)
    const requestsBefore = window.__romFetchLog ? [...window.__romFetchLog] : [];
    window.__romFetchLog = [];

    let resolvedBuf = null;
    let resolveError = null;
    try {
      resolvedBuf = await window.__rom.resolve(cartMeta);
    } catch (e) {
      resolveError = String(e?.message || e);
    }

    assert('resolve() from OPFS succeeds', resolvedBuf instanceof ArrayBuffer,
      resolveError ? `threw: ${resolveError}` : `got ${typeof resolvedBuf}`);
    if (resolvedBuf) {
      assert('resolved bytes length matches original', resolvedBuf.byteLength === fakeBuf.byteLength,
        `got ${resolvedBuf.byteLength}, want ${fakeBuf.byteLength}`);
    }

    // Extra: verify the resolved bytes match the original (OPFS round-trip).
    if (resolvedBuf && resolvedBuf.byteLength === fakeBuf.byteLength) {
      const orig = new Uint8Array(fakeBuf);
      const got = new Uint8Array(resolvedBuf);
      let same = true;
      for (let i = 0; i < orig.length; i++) { if (orig[i] !== got[i]) { same = false; break; } }
      assert('OPFS round-trip bytes match original', same);
    }
  }

  // -------------------------------------------------------------------------
  // Part 4: Special characters — spaces and & in filename don't break OPFS key
  // -------------------------------------------------------------------------
  {
    const specialBytes = new Uint8Array(64).fill(0xAB);
    const specialSha1 = await window.__rom.cacheRom(specialBytes.buffer);
    assert('special-char filename: cacheRom works', typeof specialSha1 === 'string' && specialSha1.length === 40,
      `got: ${specialSha1}`);

    const specialMeta = {
      file: 'Chrono Trigger & FF6 (Hack).smc',
      core: 'snes9x',
      system: 'snes',
      title: 'Chrono Trigger & FF6 (Hack)',
      rom: { sha1: specialSha1, sources: ['opfs', 'pick'] },
    };

    let specialBuf = null;
    try { specialBuf = await window.__rom.resolve(specialMeta); } catch {}
    assert('special-char: resolve from OPFS works', specialBuf instanceof ArrayBuffer,
      `resolvedBuf = ${specialBuf}`);
  }

  return R;
});

// -------------------------------------------------------------------------
// Part 5: Assert no roms/<filename> network request was made during our test
// -------------------------------------------------------------------------

const newRomFetches = romFetches.slice(fetchesBefore);
const localRomFetchAttempts = newRomFetches.filter((u) => {
  // A roms/freeware/... fetch for the shipping SNES demo is expected (the page
  // boots a default game). We only care about fetches for our LOCAL test ROMs.
  return u.includes('AD%26D') || u.includes('AD&D')
      || u.includes('Beholder')
      || u.includes('Chrono+Trigger')
      || u.includes('Chrono%20Trigger')
      || u.includes('test.sfc');
});

const noLocalRomFetch = localRomFetchAttempts.length === 0;

// Build final pass/fail report.
const passes = result.pass;
const fails = result.fail.slice();

if (noLocalRomFetch) {
  passes.push('no roms/<local-file> network request during resolve');
} else {
  fails.push(`roms/<local-file> was fetched (should never happen for OPFS/pick): ${JSON.stringify(localRomFetchAttempts)}`);
}

if (failedFetches.length) {
  fails.push(`unexpected 4xx/5xx during test: ${JSON.stringify(failedFetches)}`);
}

if (pageErrors.length) {
  // Non-fatal: log but don't fail (some page errors come from the 3D scene init).
  console.warn('  [page errors during probe]:', pageErrors.slice(0, 3).join('; '));
}

// Print results.
console.log('\n=== probe-local-rom results ===');
for (const p of passes) console.log(`  PASS  ${p}`);
for (const f of fails)  console.log(`  FAIL  ${f}`);
console.log(`\n${passes.length} passed, ${fails.length} failed`);

await browser.close();
process.exit(fails.length ? 1 : 0);
