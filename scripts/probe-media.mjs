// Headless smoke probe: verify that the medium dispatcher (createMedia) routes
// C64/VIC-20 disk games to Floppy and console games to Cartridge, that both
// have kind:'cartridge' (so existing grab/insert/shelf code works), and that
// the medium field is set correctly for future slot-matching.
//
// Exercises the real THREE/main.js build via window.__addLocalRom and the
// window.__grab.grabbables list, without booting any actual core.
//
// Usage:
//   node scripts/probe-media.mjs [url]
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

// Wait for the app to initialise — __addLocalRom and __grab are the hooks we need.
try {
  await page.waitForFunction(
    () => typeof window.__addLocalRom === 'function' && window.__grab && window.__games,
    { timeout: 30000 },
  );
} catch {
  console.error('ERROR: app did not finish initialising within 30s');
  await browser.close();
  process.exit(1);
}

const result = await page.evaluate(async () => {
  const R = { pass: [], fail: [] };
  const assert = (name, cond, extra) => {
    if (cond) { R.pass.push(name); }
    else { R.fail.push(extra ? `${name} — ${extra}` : name); }
  };
  const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

  const countBefore = window.__grab.grabbables.filter((o) => o.userData?.kind === 'cartridge').length;

  // -------------------------------------------------------------------------
  // 1. C64 disk game (.prg) → floppy medium
  // -------------------------------------------------------------------------
  const c64Meta = {
    file: 'freeware/lwx-demo.prg',
    system: 'c64',
    core: 'vice_x64',
    title: 'LibretroWebXR C64 Demo',
    color: '#5a8a5a',
    rom: { source: 'url' },
  };
  const c64Cart = await window.__addLocalRom(c64Meta);
  await sleep(100);

  assert('C64 disk: cart minted', c64Cart != null, 'addLocalRomToShelf returned null');
  if (c64Cart) {
    assert('C64 disk: userData.kind === cartridge',
      c64Cart.userData?.kind === 'cartridge',
      `got ${JSON.stringify(c64Cart.userData?.kind)}`);
    assert('C64 disk: userData.medium === floppy',
      c64Cart.userData?.medium === 'floppy',
      `got ${JSON.stringify(c64Cart.userData?.medium)}`);
    assert('C64 disk: userData.file set', c64Cart.userData?.file === 'freeware/lwx-demo.prg');
    assert('C64 disk: userData.system set', c64Cart.userData?.system === 'c64');
    assert('C64 disk: userData.pinAxis set',
      c64Cart.userData?.pinAxis != null, 'pinAxis missing');
    assert('C64 disk: registered as grabbable',
      window.__grab.grabbables.filter((o) => o.userData?.kind === 'cartridge').length > countBefore);
  }

  // -------------------------------------------------------------------------
  // 2. VIC-20 demo (.prg) → floppy medium
  // -------------------------------------------------------------------------
  const vic20Meta = {
    file: 'freeware/lwx-vic20-demo.prg',
    system: 'vic20',
    core: 'vice_xvic',
    title: 'LibretroWebXR VIC-20 Demo',
    color: '#8a7a3a',
    rom: { source: 'url' },
  };
  const vic20Cart = await window.__addLocalRom(vic20Meta);
  await sleep(100);

  assert('VIC-20 demo: cart minted', vic20Cart != null);
  if (vic20Cart) {
    assert('VIC-20 demo: userData.kind === cartridge', vic20Cart.userData?.kind === 'cartridge');
    assert('VIC-20 demo: userData.medium === floppy', vic20Cart.userData?.medium === 'floppy',
      `got ${JSON.stringify(vic20Cart.userData?.medium)}`);
  }

  // -------------------------------------------------------------------------
  // 3. SNES game (.sfc) → cartridge medium
  // -------------------------------------------------------------------------
  const snesMeta = {
    file: 'freeware/lwx-snes-demo.sfc',
    system: 'snes',
    core: 'snes9x',
    title: 'LWX SNES Demo',
    color: '#3a2a6a',
    rom: { source: 'url' },
  };
  const snesCart = await window.__addLocalRom(snesMeta);
  await sleep(100);

  assert('SNES game: cart minted', snesCart != null);
  if (snesCart) {
    assert('SNES game: userData.kind === cartridge', snesCart.userData?.kind === 'cartridge');
    assert('SNES game: userData.medium === cartridge', snesCart.userData?.medium === 'cartridge',
      `got ${JSON.stringify(snesCart.userData?.medium)}`);
  }

  // -------------------------------------------------------------------------
  // 4. NES game (.nes) → cartridge medium
  // -------------------------------------------------------------------------
  const nesMeta = {
    file: 'freeware/lwx-nes-pong.nes',
    system: 'nes',
    core: 'nestopia',
    title: 'LWX Pong',
    color: '#3a3a8a',
    rom: { source: 'url' },
  };
  const nesCart = await window.__addLocalRom(nesMeta);
  await sleep(100);

  assert('NES game: cart minted', nesCart != null);
  if (nesCart) {
    assert('NES game: userData.kind === cartridge', nesCart.userData?.kind === 'cartridge');
    assert('NES game: userData.medium === cartridge', nesCart.userData?.medium === 'cartridge',
      `got ${JSON.stringify(nesCart.userData?.medium)}`);
  }

  // -------------------------------------------------------------------------
  // 5. C64 cartridge (.crt) → cartridge medium (extension overrides system default)
  // -------------------------------------------------------------------------
  const crtMeta = {
    file: 'game.crt',
    system: 'c64',
    core: 'vice_x64',
    title: 'C64 Cartridge Game',
    color: '#5a5a8a',
    rom: { source: 'url' },
  };
  const crtCart = await window.__addLocalRom(crtMeta);
  await sleep(100);

  assert('C64 .crt: cart minted', crtCart != null);
  if (crtCart) {
    assert('C64 .crt: userData.kind === cartridge', crtCart.userData?.kind === 'cartridge');
    assert('C64 .crt: userData.medium === cartridge',
      crtCart.userData?.medium === 'cartridge',
      `got ${JSON.stringify(crtCart.userData?.medium)} — .crt must override floppy system default`);
  }

  // -------------------------------------------------------------------------
  // 6. Verify existing shelf games from the collection have correct mediums.
  //    The default manifest has c64/vic20 .prg games which should be floppies,
  //    and nes/snes/gb/etc which should be cartridges.
  // -------------------------------------------------------------------------
  const allGrabbables = window.__grab.grabbables.filter((o) => o.userData?.kind === 'cartridge');
  const floppyCount  = allGrabbables.filter((o) => o.userData?.medium === 'floppy').length;
  const cartCount    = allGrabbables.filter((o) => o.userData?.medium === 'cartridge').length;

  // From the manifest: 3 floppy games (lwx-demo.prg, lwx-snake.prg, lwx-vic20-demo.prg)
  // + 3 we just added (c64, vic20, crt) = at least those. Plus 4+ cartridges from shelf + ours.
  assert('at least one floppy-medium object exists', floppyCount >= 1,
    `floppyCount = ${floppyCount}`);
  assert('at least one cartridge-medium object exists', cartCount >= 1,
    `cartCount = ${cartCount}`);

  // All grabbables of kind cartridge must have a medium field.
  const missingMedium = allGrabbables.filter((o) => !o.userData?.medium);
  assert('all kind:cartridge grabbables have a medium field', missingMedium.length === 0,
    `${missingMedium.length} missing: ${missingMedium.map((o) => o.userData?.file).join(', ')}`);

  // All mediums must be either 'cartridge' or 'floppy'.
  const badMedium = allGrabbables.filter((o) => !['cartridge','floppy'].includes(o.userData?.medium));
  assert('all mediums are cartridge or floppy', badMedium.length === 0,
    badMedium.map((o) => `${o.userData?.file}:${o.userData?.medium}`).join(', '));

  // -------------------------------------------------------------------------
  // 7. Grab simulation: simulate the GrabMgr dispatching on kind='cartridge'.
  //    Both our floppy and cartridge objects must match kind === 'cartridge'.
  // -------------------------------------------------------------------------
  if (c64Cart && snesCart) {
    assert('grab dispatch: c64 floppy dispatches as cartridge',
      c64Cart.userData?.kind === 'cartridge');
    assert('grab dispatch: snes cartridge dispatches as cartridge',
      snesCart.userData?.kind === 'cartridge');
    // Both have pinAxis set correctly for insert mechanics.
    assert('insert axis: c64 floppy has pinAxis', c64Cart.userData?.pinAxis != null);
    assert('insert axis: snes cartridge has pinAxis', snesCart.userData?.pinAxis != null);
  }

  // -------------------------------------------------------------------------
  // 8. Shelf games from __games list: check the minted shelf carts (pre-built
  //    from manifest when the room loaded) also have the correct mediums.
  // -------------------------------------------------------------------------
  const games = window.__games || [];
  const c64ShelfCarts = allGrabbables.filter((o) => o.userData?.system === 'c64'
                                                   && o.userData?.medium === 'floppy');
  const snesShelfCarts = allGrabbables.filter((o) => o.userData?.system === 'snes'
                                                    && o.userData?.medium === 'cartridge');
  // The manifest has c64 games → should have been minted as floppies on the shelf.
  const c64GameCount = games.filter((g) => g.system === 'c64').length;
  assert('shelf: c64 games are minted as floppy medium',
    c64GameCount === 0 || c64ShelfCarts.length > 0,
    `c64 games in collection: ${c64GameCount}, with floppy medium: ${c64ShelfCarts.length}`);
  // Same for SNES.
  const snesGameCount = games.filter((g) => g.system === 'snes').length;
  assert('shelf: snes games are minted as cartridge medium',
    snesGameCount === 0 || snesShelfCarts.length > 0,
    `snes games in collection: ${snesGameCount}, with cartridge medium: ${snesShelfCarts.length}`);

  return R;
});

// Print results.
console.log('\n=== probe-media results ===');
for (const p of result.pass) console.log(`  PASS  ${p}`);
for (const f of result.fail) console.log(`  FAIL  ${f}`);

if (pageErrors.length) {
  console.warn('\n  [page errors]:', pageErrors.slice(0, 5).join('; '));
}

console.log(`\n${result.pass.length} passed, ${result.fail.length} failed`);

await browser.close();
process.exit(result.fail.length ? 1 : 0);
