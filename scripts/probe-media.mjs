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

  // SNAPSHOT THE SHELF BEFORE WE TOUCH IT. Sections 6 and 8 below are about what
  // the APP minted from the collection; if they measure the live grabbable list
  // they also count the five carts this probe is about to inject in steps 1-5, so
  // their ">= 1" thresholds are satisfied by the probe's own side effects and stay
  // green with shelf minting completely broken. Keep the pre-existing set, and
  // assert the shelf claims against THAT.
  const shelfBefore = window.__grab.grabbables.filter((o) => o.userData?.kind === 'cartridge');
  const countBefore = shelfBefore.length;

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
  // Counted over the PRE-EXISTING shelf only (see the snapshot at the top): the
  // manifest ships 3 floppy games (lwx-demo.prg, lwx-snake.prg, lwx-vic20-demo.prg)
  // and a dozen cartridges, so both counts are real claims about shelf minting.
  // Counting `allGrabbables` here instead made both thresholds unfalsifiable —
  // steps 1-5 above inject a floppy AND a cartridge before this line runs.
  const floppyCount  = shelfBefore.filter((o) => o.userData?.medium === 'floppy').length;
  const cartCount    = shelfBefore.filter((o) => o.userData?.medium === 'cartridge').length;

  assert('the shelf minted at least one floppy-medium object', floppyCount >= 1,
    `floppyCount = ${floppyCount} of ${shelfBefore.length} pre-existing shelf carts`);
  assert('the shelf minted at least one cartridge-medium object', cartCount >= 1,
    `cartCount = ${cartCount} of ${shelfBefore.length} pre-existing shelf carts`);

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
  // These four used to be byte-identical re-reads of `userData.kind`/`pinAxis`
  // already asserted in sections 1 and 3, under a heading claiming to "simulate
  // the GrabMgr dispatching" while invoking no GrabMgr code at all — so a floppy
  // that GrabMgr refused to consider grabbable passed the "grab dispatch" check.
  // Call the REAL predicate (GrabMgr#_isCandidate, the play-mode/edit-mode
  // dispatcher every grab goes through) and the real registration list instead.
  if (c64Cart && snesCart) {
    assert('grab dispatch: GrabMgr accepts the c64 floppy as a play-mode target',
      window.__grab._isCandidate(c64Cart) === true,
      'GrabMgr#_isCandidate said no — a minted floppy that cannot be picked up');
    assert('grab dispatch: GrabMgr accepts the snes cartridge as a play-mode target',
      window.__grab._isCandidate(snesCart) === true,
      'GrabMgr#_isCandidate said no — a minted cartridge that cannot be picked up');
    assert('grab dispatch: both minted media are registered with GrabMgr',
      window.__grab.grabbables.includes(c64Cart) && window.__grab.grabbables.includes(snesCart));
    // pinAxis is what the insert mechanic aligns on; assert it on the objects
    // GrabMgr just agreed are grabbable, so the two facts are checked together.
    assert('insert axis: c64 floppy has pinAxis', c64Cart.userData?.pinAxis != null);
    assert('insert axis: snes cartridge has pinAxis', snesCart.userData?.pinAxis != null);
  }

  // -------------------------------------------------------------------------
  // 8. Shelf games from __games list: check the minted shelf carts (pre-built
  //    from manifest when the room loaded) also have the correct mediums.
  // -------------------------------------------------------------------------
  // Shelf carts only — `shelfBefore`, not `allGrabbables`, or the c64 floppy and
  // the SNES cartridge this probe injected in steps 1 and 3 satisfy both claims
  // on their own.
  const games = window.__games || [];
  const c64ShelfCarts = shelfBefore.filter((o) => o.userData?.system === 'c64'
                                                  && o.userData?.medium === 'floppy');
  const snesShelfCarts = shelfBefore.filter((o) => o.userData?.system === 'snes'
                                                   && o.userData?.medium === 'cartridge');
  // The default manifest ships 2 c64 and 3 snes titles. The old form was
  // `c64GameCount === 0 || c64ShelfCarts.length > 0`, which is green when shelf
  // minting is entirely broken AND when the collection is empty — a fixture that
  // loaded no games passed the shelf-minting test. A collection with no c64/snes
  // game is a broken fixture, so say so and fail on it instead of escaping.
  const c64GameCount = games.filter((g) => g.system === 'c64').length;
  assert('fixture: the loaded collection has c64 games to mint', c64GameCount > 0,
    'no c64 game in window.__games — wrong/empty collection, the shelf claim below would be vacuous');
  assert('shelf: c64 games are minted as floppy medium', c64ShelfCarts.length > 0,
    `c64 games in collection: ${c64GameCount}, shelf carts with floppy medium: ${c64ShelfCarts.length}`);

  const snesGameCount = games.filter((g) => g.system === 'snes').length;
  assert('fixture: the loaded collection has snes games to mint', snesGameCount > 0,
    'no snes game in window.__games — wrong/empty collection, the shelf claim below would be vacuous');
  assert('shelf: snes games are minted as cartridge medium', snesShelfCarts.length > 0,
    `snes games in collection: ${snesGameCount}, shelf carts with cartridge medium: ${snesShelfCarts.length}`);

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
