// Headless TWO-CLIENT smoke for the OTHER half of the shared-room model (M1.4):
// **the host owns the room and the shelf.** A joining peer does not bring its own
// layout or its own games — it inherits the host's, including collections the host
// only has locally, and it follows the host when the host changes rooms.
//
// This is the dimension scripts/smoke-shared-game.mjs cannot cover: there both
// peers build the SAME default room from the same URL, so "the rooms match" is
// nearly vacuous. Here the host deliberately has a DIFFERENT room and shelf from
// what the client would have built on its own.
//
// Covers, in order:
//   1. an authored room (?room=…) on the host is adopted by a BARE-URL client —
//      room id, props, and the actual cartridges standing on the shelf
//   2. a cart that exists only in the HOST's local library (OPFS/picker, no URL a
//      client could fetch) still appears on the client's shelf, host-owned
//   3. a CLIENT inserting a cart the host does not have is refused (nack) and the
//      host's running game survives — before this it triggered a host-side boot
//      of a missing file, killing the room's picture
//   4. a host whose shelf came from a DROPPED *.collection.json (the documented
//      sharing path, whose room descriptor names an unfetchable `dropped:<id>`)
//      still hands that shelf to clients
//   5. the client follows the host through SEVERAL room changes, not just the
//      first (the adoption one-shot used to latch after one)
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8798; node server/room-server.mjs        # terminal 1
//   npx vite --port 5198                                # terminal 2
//   node scripts/smoke-room-inherit.mjs --app=http://127.0.0.1:5198/ --ws=ws://127.0.0.1:8798/
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed --shots=<dir>

import puppeteer from 'puppeteer-core';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5199/';
const WS = args.ws || 'ws://localhost:8797/';
const ROOM = args.room || `inherit${Date.now().toString(36)}`;
const SHOTS = typeof args.shots === 'string' ? args.shots : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(2); }

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok   ${m}`); } else { failed++; console.error(`  FAIL ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-features=SharedArrayBuffer',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

const browsers = [];
async function ready(page) {
  await page.waitForFunction(
    () => Array.isArray(window.__games) && typeof window.__insertCartridge === 'function',
    { timeout: 60000 },
  );
  await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 25000 });
}
async function openPeer(nick, query) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`  [${nick}] PAGEERROR ${String(e).slice(0, 200)}`));
  await page.goto(APP + query, { waitUntil: 'load' });
  await ready(page);
  return page;
}

async function waitFor(page, fn, ms = 20000, ...a) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.evaluate(fn, ...a)) return true; } catch { /* mid-reload */ }
    await sleep(250);
  }
  return false;
}

// What the user would actually SEE as "the shelf": the live cartridge objects in
// the scene, not the collection JSON behind them.
const shelfCarts = (page) => page.evaluate(() => {
  const out = [];
  window.__scene.scene.traverse((o) => { if (o.userData?.kind === 'cartridge') out.push(o.userData.file); });
  return out.sort();
});
const info = (page) => page.evaluate(() => ({
  roomId: window.__room?.id ?? null,
  props: (window.__room?.props || []).map((p) => `${p.type}:${p.id}`).sort(),
  isHost: window.__net?.isHost?.() ?? null,
  publishedRoomId: window.__net?.objectState?.('room')?.id ?? null,
  tv: window.__net?.objectState?.('tv')?.file ?? null,
  cores: (window.__rack?.live?.() || []).map((r) => `${r.id}:${r.core || '-'}${r.live ? '' : '(paused)'}`),
  status: document.getElementById('status')?.textContent ?? null,
}));
const liveCores = (page) => page.evaluate(() =>
  (window.__rack?.live?.() || []).filter((r) => r.core && r.live).length);

// Reload the host with a dropped payload in sessionStorage — byte-for-byte what
// installDragAndDrop / "Import Room" does with a dropped file.
async function hostDrop(page, kind, obj) {
  await page.evaluate((k, text) => {
    sessionStorage.setItem('libretrowebxr.dropped', JSON.stringify({ kind: k, text }));
    location.reload();
  }, kind, JSON.stringify(obj));
  await sleep(1500);
  await ready(page);
  await sleep(2500);
}
const mkRoom = (id, posterId) => ({
  schema: 'libretrowebxr/room@1', id, title: id, collections: ['roms/manifest.json'],
  props: [
    { type: 'shelf', id: `${id}-shelf`, collection: 'roms/manifest.json', pos: [0, 1.25, -3.7], rot: [0, 0, 0] },
    { type: 'console', id: 'console-1', pos: [0, 0.74, -2.4] },
    { type: 'gamepad', id: 'gamepad-1', pos: [0.55, 0.78, -2.15] },
    { type: 'poster', id: posterId, pos: [1.5, 1.6, -3.9] },
  ],
  portals: [],
});

try {
  console.log(`room=${ROOM}`);
  const q = (nick) => `session=${ROOM}&server=${encodeURIComponent(WS)}&nick=${nick}`;

  // --- 1. an authored host room is adopted by a bare-URL client --------------
  const A = await openPeer('Alice', `?room=roms/arcade.room.json&${q('Alice')}`);
  ok(await waitFor(A, () => window.__net.isHost()), 'Alice (first in) is the room host');
  // window.__room lands at the END of the world build, after __games — wait for it
  // rather than snapshotting a half-built world.
  ok(await waitFor(A, () => window.__room?.id === 'arcade', 30000), 'the host is in its authored room (arcade)');
  const aInfo = await info(A);

  const B = await openPeer('Bob', `?${q('Bob')}`);          // bare URL: default room
  ok((await B.evaluate(() => window.__net.isHost())) === false, 'Bob is a client');
  ok(await waitFor(B, () => window.__room?.id === 'arcade', 30000),
    "the client adopted the HOST's room id, not the one its own URL asked for");
  const bInfo = await info(B);
  ok(JSON.stringify(bInfo.props) === JSON.stringify(aInfo.props),
    `client props == host props (${bInfo.props.length} vs ${aInfo.props.length})`);
  const aCarts = await shelfCarts(A);
  ok(await waitFor(B, (want) => {
    const out = []; window.__scene.scene.traverse((o) => { if (o.userData?.kind === 'cartridge') out.push(o.userData.file); });
    return JSON.stringify(out.sort()) === want;
  }, 25000, JSON.stringify(aCarts)),
    `the client's shelf carries the host's carts (${aCarts.length})`);

  // --- 2. a HOST-ONLY local cart still reaches the client's shelf ------------
  // Through the REAL "Load ROM" picker, so the cart carries genuine local
  // provenance (OPFS sha1 / 'pick'). A synthetic meta with no `rom` block is NOT
  // a local ROM by isLocalRomMeta() and would never be published — the host only
  // advertises games whose bytes it can actually serve.
  const SEED = resolve('public/roms/freeware/lwx-nes-pong.nes');
  const HOST_PICK = join(mkdtempSync(join(tmpdir(), 'lwx-hostpick-')), 'HostPickedOnly.nes');
  if (existsSync(SEED)) copyFileSync(SEED, HOST_PICK);
  ok(existsSync(HOST_PICK), `staged a host-only ROM file (${HOST_PICK})`);
  const hostInput = await A.$('#rom-input');
  await hostInput.uploadFile(HOST_PICK);
  const hasCart = (f) => {
    const out = []; window.__scene.scene.traverse((o) => { if (o.userData?.kind === 'cartridge') out.push(o.userData.file); });
    return out.includes(f);
  };
  ok(await waitFor(A, hasCart, 40000, 'HostPickedOnly.nes'),
    "the host's own shelf shows the cart it just picked off its disk");
  ok(await waitFor(B, hasCart, 30000, 'HostPickedOnly.nes'),
    "the client sees the host's local-only cart on the shelf (no ROM bytes crossed the wire)");
  ok((await B.evaluate((f) => {
    let src = null;
    window.__scene.scene.traverse((o) => { if (o.userData?.kind === 'cartridge' && o.userData.file === f) src = o.userData.rom?.source ?? null; });
    return src;
  }, 'HostPickedOnly.nes')) === 'host', "the inherited cart is marked host-owned (rom.source='host')");
  ok((await liveCores(B)) === 0, 'inheriting the shelf booted nothing on the client');

  // --- 3. a client cart the host does not have is refused, not booted --------
  const game = await A.evaluate(() => {
    const g = window.__games.find((x) => x.system === 'nes');
    return g ? { file: g.file, core: g.core, system: g.system, title: g.title } : null;
  });
  ok(!!game, `found a cart for the host to run (${game?.file})`);
  await A.evaluate((g) => window.__insertCartridge(g), game);
  ok(await waitFor(A, () => (window.__rack.live() || []).some((r) => r.core && r.live), 40000),
    'the host is running its game');
  await sleep(1500);

  await B.evaluate(() => window.__addLocalRom({
    file: 'ClientOnlyLocal.smc', system: 'snes', core: 'snes9x', title: 'Client Only Local',
  }));
  await sleep(500);
  await B.evaluate(() => window.__insertCartridge({
    file: 'ClientOnlyLocal.smc', system: 'snes', core: 'snes9x', title: 'Client Only Local',
  }));
  ok(await waitFor(B, () => (window.__wireRx('insert-nack') || []).some((d) => d?.file === 'ClientOnlyLocal.smc'), 25000),
    'the host NACKs a cart it does not own, and the client hears it');
  ok(await waitFor(B, () => /can.t play/i.test(document.getElementById('status')?.textContent || ''), 5000),
    'the client is TOLD the host cannot play it (not left waiting forever)');
  ok((await liveCores(A)) === 1, "the host's game survives a client asking for a ROM it does not have");
  ok((await A.evaluate(() => window.__net.objectState('tv')?.file ?? null)) === game.file,
    "the room TV still names the host's game");
  ok((await liveCores(B)) === 0, 'the client booted nothing of its own');

  // --- 4. a shelf that came from a DROPPED collection is still inherited -----
  // Its room descriptor names `dropped:hostdrop`, which no client can fetch: the
  // host has to publish the collection's CONTENT for the shelf to survive the trip.
  await hostDrop(A, 'collection', {
    schema: 'libretrowebxr/collection@1', id: 'hostdrop', title: "Alice's Collection",
    games: [
      { file: 'freeware/lwx-nes-pong.nes', system: 'nes', title: 'HOSTDROP Pong' },
      { file: 'freeware/lwx-gb-snake.gb', system: 'gb', title: 'HOSTDROP Snake' },
    ],
  });
  ok(await waitFor(A, () => window.__net.isHost(), 20000), 'the host keeps the host role across its own reload (sid reclaim)');
  const dropCarts = await shelfCarts(A);
  ok(dropCarts.filter((f) => /lwx-(nes-pong|gb-snake)/.test(f)).length === 2,
    `the host shelf shows its dropped collection (${dropCarts.length} carts)`);
  ok(await waitFor(B, (want) => {
    const out = []; window.__scene.scene.traverse((o) => { if (o.userData?.kind === 'cartridge') out.push(o.userData.file); });
    return JSON.stringify(out.sort()) === want;
  }, 30000, JSON.stringify(dropCarts)),
    "the client inherits the host's DROPPED-collection shelf (unfetchable ref)");
  if (SHOTS) {
    try { await A.screenshot({ path: `${SHOTS}/host-dropped-shelf.png` }); } catch { /* ok */ }
    try { await B.screenshot({ path: `${SHOTS}/client-inherited-shelf.png` }); } catch { /* ok */ }
  }

  // --- 5. the client follows SEVERAL host room changes -----------------------
  for (const [n, id] of [['#1', 'roomA'], ['#2', 'roomB'], ['#3', 'roomC']]) {
    await hostDrop(A, 'room', mkRoom(id, `poster-${id}`));
    ok(await waitFor(B, (want) => window.__room?.id === want, 30000, id),
      `the client follows the host's room change ${n} (${id})`);
  }

  // --- 6. an in-place EDIT to the host's room, with no reload ----------------
  // Loading a whole room descriptor republishes at build time; adding a prop in
  // Add mode mutates the live room instead. That path is covered only by the
  // periodic host-side watcher, so assert it separately from the reload cases.
  const beforeProps = (await info(A)).props.length;
  await A.evaluate(() => window.__add.table());
  ok(await waitFor(A, (n) => (window.__room?.props || []).length === n + 1, 10000, beforeProps),
    'the host added a prop to its live room');
  ok(await waitFor(B, (n) => (window.__net.objectState('room')?.props || []).length === n + 1, 20000, beforeProps),
    "the host republished its room after an in-place edit (no reload)");
  ok(await waitFor(B, (n) => (window.__room?.props || []).length >= n + 1, 30000, beforeProps),
    "the client's own world picked up the host's live room edit");
  console.log('  final:', JSON.stringify(await info(A)), '/', JSON.stringify(await info(B)));
} catch (e) {
  failed++; console.error('  FAIL exception:', e?.stack || e);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
