// Headless TWO-CLIENT smoke for the shared-game invariant (M1.4). This is the
// test the older MP smokes were missing: they drive the TRANSPORT
// (window.__net.setObjectState('tv', …)) and so can pass while the real app
// behaves completely differently. Everything here goes through the REAL app path
// — window.__insertCartridge → handleCartridgeInserted → loadCartridge — which is
// how the two-machine session that exposed these bugs actually worked.
//
// The invariant it defends, in one line: **in a room there is exactly ONE running
// core, and it belongs to the host.**
//
// Covers, in order:
//   1. presence — both peers see each other's avatars
//   2. host election — the FIRST peer is host; the joiner is not (M1.4)
//   3. room handoff — the host publishes `room`; the joiner adopts that layout
//   4. host boots a game → the client does NOT boot a core of its own, receives
//      the host's video, and keeps its own core idle  ← the "two separate games" bug
//   4b. the client's in-world TV really is painting that stream and the picture
//      ADVANCES (receivingCount() alone passes over a frozen frame)
//   4c. the host LIVE-REBOOTS its console (gun arm → fresh canvas + replaceTrack):
//      the client's picture keeps advancing instead of freezing on the dead canvas
//   5. a CLIENT inserting a cartridge asks the host instead of booting locally
//   5b. every OTHER client boot path is suppressed too — the real #rom-input file
//      picker, __pickLocalRom, rack spawn, and a peripheral arm. Any one of these
//      booting locally re-creates the two-games bug through a side door.
//   6. host migration with a THIRD peer: the host leaves, the senior remaining
//      peer is promoted and runs the game itself, and the junior peer keeps
//      watching — now off the NEW host's stream.
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8797; node server/room-server.mjs         # terminal 1
//   npm run dev -- --port 5199                           # terminal 2
//   node scripts/smoke-shared-game.mjs --app=http://localhost:5199/ --ws=ws://localhost:8797/
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed --widget (join from the
// in-app header widget instead of ?session=, i.e. the path where the room handoff
// used to be skipped entirely) --shots=<dir> (write PNGs of both peers).

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5199/';
const WS = args.ws || 'ws://localhost:8797/';
const ROOM = args.room || `shared${Date.now().toString(36)}`;
const WIDGET = !!args.widget;
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
  // Headless loopback WebRTC: expose real host ICE candidates so the host→client
  // media path completes between two browser processes on one machine.
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

const browsers = [];
async function openPeer(nick, { session }) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`  [${nick}] PAGEERROR ${String(e).slice(0, 200)}`));
  const q = session
    ? `?session=${ROOM}&server=${encodeURIComponent(WS)}&nick=${nick}`
    : `?server=${encodeURIComponent(WS)}`;
  await page.goto(APP + q, { waitUntil: 'load' });
  // The world is built (games + the insert hook) — everything below drives the app.
  await page.waitForFunction(
    () => Array.isArray(window.__games) && window.__games.length > 0 && typeof window.__insertCartridge === 'function',
    { timeout: 60000 },
  );
  if (session) await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 20000 });
  return page;
}

async function widgetJoin(page, nick) {
  await page.evaluate((r, n) => {
    document.getElementById('mp-room-input').value = r;
    document.getElementById('mp-nick-input').value = n;
    document.getElementById('mp-join-btn').click();
  }, ROOM, nick);
  await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 20000 });
}

async function waitFor(page, fn, ms = 15000, ...a) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if (await page.evaluate(fn, ...a)) return true; } catch { /* mid-reload */ }
    await sleep(250);
  }
  return false;
}

// How many of THIS peer's consoles have a core running. The whole point of the
// host-authoritative model is that this is 1 on the host and 0 on a client.
const liveCores = (page) => page.evaluate(() =>
  (window.__rack?.live?.() || []).filter((r) => r.core && r.live).length);
const snap = (page) => page.evaluate(() => ({
  peers: window.__net?.peerCount?.() ?? null,
  avatars: window.__net?.avatarCount?.() ?? null,
  isHost: window.__net?.isHost?.() ?? null,
  hostId: (window.__net?.hostId?.() || '').slice(0, 8) || null,
  tv: window.__net?.objectState?.('tv')?.file ?? null,
  roomProps: (window.__net?.objectState?.('room')?.props || []).length,
  localProps: (window.__room?.props || []).length,
  cores: (window.__rack?.live?.() || []).map((r) => `${r.id}:${r.core || '-'}${r.live ? '' : '(paused)'}`),
  paused: window.__client?.paused ?? null,
  receiving: window.__net?.video?.receivingCount?.() ?? null,
  sending: window.__net?.video?.sendingCount?.() ?? null,
}));

async function shot(page, name) {
  if (!SHOTS) return;
  try { await page.screenshot({ path: `${SHOTS}/${name}.png` }); } catch { /* ok */ }
}

// Is a screen in this peer's world painting a remote host's <video> (TV.setVideo)
// rather than a local canvas? This is the difference between "a track arrived" and
// "the user is looking at the host's game".
const tvOnHostFeed = (page) => page.evaluate(() =>
  (window.__rack?.tvs?.() || []).some((t) => t.video));

// Does the host's picture actually MOVE? receivingCount() stays 1 over a frozen
// frame (decoder stalled, element auto-paused, host canvas replaced by a live
// reboot), which is exactly the failure mode the two-machine playtest saw. Sample
// the <video> twice and require decoded frames — or, where the browser does not
// expose them, playback time — to have advanced.
async function pictureAdvances(page, ms = 2500) {
  const read = () => page.evaluate(() => window.__net?.video?.hostVideo?.() ?? null);
  const a = await read();
  await sleep(ms);
  const b = await read();
  if (!a || !b) return { ok: false, why: 'no host <video> element', a, b };
  const dFrames = (b.frames ?? 0) - (a.frames ?? 0);
  const dTime = (b.time ?? 0) - (a.time ?? 0);
  // DECODED FRAMES, not currentTime: an audio-only stream (the msid bug this test
  // caught) ticks currentTime forever with videoWidth 0 and zero frames decoded.
  // Fall back to time only where the browser doesn't expose playback quality.
  const moved = (b.frames != null) ? dFrames > 0 : dTime > 0.1;
  const sized = (b.w ?? 0) > 0 && (b.h ?? 0) > 0;
  return { ok: moved && sized && !b.paused, dFrames, dTime, paused: b.paused, w: b.w, h: b.h };
}

try {
  console.log(`room=${ROOM}  join=${WIDGET ? 'widget' : '?session='}`);
  const A = await openPeer('Alice', { session: !WIDGET });
  if (WIDGET) await widgetJoin(A, 'Alice');
  await sleep(1500);
  const B = await openPeer('Bob', { session: !WIDGET });
  if (WIDGET) await widgetJoin(B, 'Bob');

  // --- 1. presence ----------------------------------------------------------
  ok(await waitFor(A, () => window.__net.peerCount() >= 1), 'Alice sees Bob in the roster');
  ok(await waitFor(B, () => window.__net.peerCount() >= 1), 'Bob sees Alice in the roster');
  ok(await waitFor(A, () => window.__net.avatarCount() >= 1), "Bob's avatar exists in Alice's scene");
  ok(await waitFor(B, () => window.__net.avatarCount() >= 1), "Alice's avatar exists in Bob's scene");

  // --- 2. host election (M1.4) ----------------------------------------------
  const aId = await A.evaluate(() => window.__net.selfId());
  ok(await waitFor(A, () => window.__net.isHost()), 'Alice (first in) is the room host');
  ok(await waitFor(B, (id) => window.__net.hostId() === id, 15000, aId), 'Bob agrees Alice is the host');
  ok((await B.evaluate(() => window.__net.isHost())) === false, 'Bob is NOT a host (display-only client)');

  // --- 3. room handoff ------------------------------------------------------
  ok(await waitFor(A, () => window.__net.objectState('room') != null), 'the host published its room layout');
  // The client's world must BE the host's room (adopted), not its own default.
  ok(await waitFor(B, () => {
    const hostRoom = window.__net.objectState('room');
    return !!hostRoom && (hostRoom.props || []).length === (window.__room?.props || []).length;
  }, 25000), "the client's room matches the host's published layout");

  // --- 4. host boots a game; the client must NOT boot one -------------------
  const game = await A.evaluate(() => {
    const g = window.__games.find((x) => x.system === 'nes' && /pong/i.test(x.title || x.file))
           || window.__games.find((x) => x.system === 'nes');
    return g ? { file: g.file, core: g.core, system: g.system, title: g.title } : null;
  });
  ok(!!game, `found an NES test cart to boot (${game?.file})`);
  await A.evaluate((g) => window.__insertCartridge(g), game);

  ok(await waitFor(A, () => (window.__rack.live() || []).some((r) => r.core && r.live), 30000), 'the host is running a core');
  ok(await waitFor(B, (f) => window.__net.objectState('tv')?.file === f, 20000, game.file), 'the client learned which game is on the room TV');
  ok(await waitFor(B, () => window.__net.video.receivingCount() >= 1, 30000), "the client receives the host's video stream");
  ok(await waitFor(A, () => window.__net.video.sendingCount() >= 1, 10000), 'the host is sending its canvas to the client');

  // THE invariant. Before this fix the client booted the same ROM into its own
  // core from applyRemoteTv → two independent games.
  await sleep(3000);
  const bCores = await liveCores(B);
  ok(bCores === 0, `the client runs NO core of its own (live cores on client = ${bCores})`);
  ok((await liveCores(A)) === 1, 'exactly one core is running in the room, on the host');
  // Stronger than "paused": a display-only client must never have BOOTED a core
  // at all. (window.__client.paused is false on an un-started client too, so
  // asserting on it alone would pass vacuously.)
  ok((await B.evaluate(() => (window.__rack?.live?.() || []).every((r) => !r.core))),
    'the client never booted a core into any console');

  console.log('\n  A', JSON.stringify(await snap(A)));
  console.log('  B', JSON.stringify(await snap(B)));
  await shot(A, 'host-playing');
  await shot(B, 'client-watching');

  // --- 4b. the client's TV really shows that stream, and it MOVES -------------
  ok(await waitFor(B, () => (window.__rack?.tvs?.() || []).some((t) => t.video), 15000),
    "the client's in-world TV is painting the host's video (not a local canvas)");
  const adv1 = await pictureAdvances(B);
  ok(adv1.ok, `the client's picture is advancing (${JSON.stringify(adv1)})`);

  // --- 4c. the host live-reboots its core; the client must not freeze ---------
  // Arming the light gun rebuilds the host's ConsoleRuntime with a FRESH canvas.
  // The old broadcast track dies with the old canvas, so without a
  // captureStream + sender.replaceTrack re-source the client keeps "receiving"
  // a track that never decodes another frame.
  const rebooted = await A.evaluate(async () => {
    try { await window.__armGun(); return window.__gunArmedState(); } catch (e) { return { error: String(e?.message || e) }; }
  });
  console.log('  host gun-arm reboot →', JSON.stringify(rebooted));
  await sleep(4000);
  ok((await liveCores(A)) === 1, 'the host still runs exactly one core after its live reboot');
  ok(await waitFor(B, () => window.__net.video.receivingCount() >= 1, 20000),
    "the client still has the host's track after the host's live reboot");
  const adv2 = await pictureAdvances(B, 3000);
  ok(adv2.ok, `the client's picture STILL advances across the host's live reboot (${JSON.stringify(adv2)})`);
  ok((await liveCores(B)) === 0, 'the client still runs no core of its own after the host reboot');
  await shot(B, 'client-watching-after-host-reboot');

  // --- 5. a client inserting a cart asks the host ---------------------------
  const other = await B.evaluate(() => {
    const g = window.__games.find((x) => x.system === 'nes' && !/pong/i.test(x.title || x.file));
    return g ? { file: g.file, core: g.core, system: g.system, title: g.title } : null;
  });
  if (other) {
    await B.evaluate((g) => window.__insertCartridge(g), other);
    ok(await waitFor(A, (f) => window.__net.objectState('tv')?.file === f, 40000, other.file),
      'a client cartridge insert is applied by the HOST (game switched on the host)');
    await sleep(2500);
    ok((await liveCores(B)) === 0, 'the client STILL runs no core after its own insert');
  } else {
    ok(true, '(skipped client-insert: only one NES cart in this collection)');
  }

  // --- 5b. every OTHER client boot path is suppressed too --------------------
  // handleCartridgeInserted is only ONE of the ways this app boots a core. Each of
  // these reaches bootOnPrimary/spawnConsole by a different route, and any one of
  // them still working on a client re-creates the two-independent-games bug.
  const hostTvBefore = await A.evaluate(() => window.__net.objectState('tv')?.file ?? null);

  // (i) the REAL "Load ROM" file picker — #rom-input's change handler.
  const LOCAL_ROM = resolve('public/roms/freeware/lwx-gb-snake.gb');
  if (existsSync(LOCAL_ROM)) {
    const input = await B.$('#rom-input');
    await input.uploadFile(LOCAL_ROM);
    await sleep(8000);
    ok((await liveCores(B)) === 0, 'the client\'s "Load ROM" file picker does NOT boot a core on the client');
    ok((await B.evaluate(() => (window.__rack?.live?.() || []).every((r) => !r.core))),
      'the file picker did not even leave a booted-then-paused core behind');
  } else {
    ok(false, `missing test ROM for the file-picker check (${LOCAL_ROM})`);
  }

  // (ii) the __pickLocalRom hook the harnesses use (same boot path, no dialog).
  const picked = await B.evaluate(async () => {
    try { await window.__pickLocalRom('smoke-client.nes', new Uint8Array(4096).buffer); return 'BOOTED'; }
    catch (e) { return String(e?.message || e); }
  });
  ok(/only the room host/i.test(picked), `__pickLocalRom refuses to boot on a client (${picked})`);

  // (iii) rack spawn — a client adding a console of its own would start a core.
  const spawned = await B.evaluate(async () => {
    try { await window.__rack.spawn('nes'); return 'SPAWNED'; }
    catch (e) { return String(e?.message || e); }
  });
  ok(/only the room host/i.test(spawned), `rack spawn refuses to run a console on a client (${spawned})`);
  // The Add-panel "Spawn Console" button is a UI action, so it declines with a
  // status line instead of throwing: assert on the OUTCOME (no console id, no core).
  const spawnedNext = await B.evaluate(async () => {
    const before = (window.__rack.live() || []).length;
    let id = 'THREW';
    try { id = await window.__rack.spawnNext(); } catch (e) { id = `threw:${e?.message || e}`; }
    return { id, before, after: (window.__rack.live() || []).length, status: document.getElementById('status')?.textContent || null };
  });
  ok(spawnedNext.id === null && spawnedNext.after === spawnedNext.before,
    `"Spawn Console" adds no console on a client (${JSON.stringify(spawnedNext)})`);

  // (iv) a peripheral arm. On a client this must NOT reboot a local core — it has
  // to travel to the host, which attaches the device to the running game (otherwise
  // the client's forwarded aim has nowhere to land).
  await A.evaluate(() => window.__disarmGun());
  await sleep(3500);
  await B.evaluate(() => window.__armGun());
  ok(await waitFor(A, () => !!window.__gunArmedState().consoleArmed, 30000),
    "a client arming the gun makes the HOST attach the light gun to the running game");
  await sleep(1500);
  ok((await liveCores(B)) === 0, 'arming the gun on a client booted no core on the client');
  ok((await liveCores(A)) === 1, 'the host is still the only machine running a core');
  ok((await A.evaluate(() => window.__net.objectState('tv')?.file ?? null)) === hostTvBefore,
    'none of the client boot paths changed which game the room is playing');

  // --- 6. host migration, with a THIRD peer left watching --------------------
  const C = await openPeer('Cleo', { session: !WIDGET });
  if (WIDGET) await widgetJoin(C, 'Cleo');
  ok(await waitFor(C, () => window.__net.video.receivingCount() >= 1, 40000),
    'a late third peer also receives the host video');
  ok((await liveCores(C)) === 0, 'the late joiner runs no core either');

  const wanted = await B.evaluate(() => window.__net.objectState('tv')?.file ?? null);
  const bId = await B.evaluate(() => window.__net.selfId());
  await browsers[0].close();
  // Deferred by Hub.HOST_RECLAIM_MS (15 s): a host that is only reloading reclaims
  // the role rather than a client being promoted into booting its own core.
  ok(await waitFor(B, () => window.__net.isHost(), 25000), 'the host left → the senior remaining peer is promoted');
  ok((await C.evaluate(() => window.__net.isHost())) === false, 'the junior peer was NOT promoted (seniority)');
  ok(await waitFor(C, (id) => window.__net.hostId() === id, 20000, bId), 'the junior peer agrees the senior peer is now host');
  // The room's game must not die with its host: the new host picks it up.
  ok(await waitFor(B, () => (window.__rack.live() || []).some((r) => r.core && r.live), 60000),
    `the promoted peer boots the room's game itself (${wanted})`);
  ok(await waitFor(B, () => window.__net.video.receivingCount() === 0, 15000),
    'the promoted peer is no longer showing a remote stream');
  // The whole point of migration: the peer that stayed keeps WATCHING, now off the
  // new host. Before the fix it was left with a dead track and a black TV.
  ok(await waitFor(C, () => window.__net.video.receivingCount() >= 1, 60000),
    'the remaining watcher regains video from the NEW host');
  ok(await waitFor(C, () => (window.__rack?.tvs?.() || []).some((t) => t.video), 15000),
    "the remaining watcher's TV is painting the new host's feed");
  const adv3 = await pictureAdvances(C, 3000);
  ok(adv3.ok, `the remaining watcher's picture advances after migration (${JSON.stringify(adv3)})`);
  ok((await liveCores(C)) === 0, 'the remaining watcher still never booted a core');
  await shot(B, 'client-promoted');
  await shot(C, 'watcher-after-migration');
} catch (e) {
  failed++; console.error('  FAIL exception:', e?.message || e);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
