// Headless host-video smoke (M1.2, updated for M1.4): the room's HOST — the
// first peer in, as elected by the server — boots the room's game, publishes it
// on the shared `tv` state and broadcasts its emulator canvas; every other peer
// receives the WebRTC video track and would paint it onto its in-world TV.
// Proves the full signaling → peer-connection → media path for the game stream,
// fanned out to multiple clients, without a headset. The tail of the test covers
// M1.4 host MIGRATION: the host leaves, the longest-present remaining peer is
// promoted, and its receive-PC teardown lets it drive its own TV again.
//
// Like scripts/smoke-voice.mjs but for the video channel: the host captures
// `#canvas` via captureStream() (real media, no fake device needed) and is the
// sole offerer; clients answer and receive. The SIGNAL messages carry
// channel:'video' so they don't disturb the voice mesh.
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8799; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-video.mjs --ws=ws://localhost:8799/   # this
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/';
const WS = args.ws || 'ws://localhost:8799/';
const ROOM = args.room || 'videotest';
const urlFor = (nick) => `${APP}${APP.includes('?') ? '&' : '?'}session=${ROOM}&server=${encodeURIComponent(WS)}&nick=${nick}`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(2); }

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; } else { failed++; console.error(`  FAIL: ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-features=SharedArrayBuffer',
  // Headless loopback WebRTC: expose real host ICE candidates so cross-process
  // P2P completes on localhost (same as the voice smoke).
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

const browsers = [];
async function openPeer(nick) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(`  [${nick}]`, m.text()); });
  await page.goto(urlFor(nick), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 10000 });
  return page;
}

async function waitFor(page, fn, ms = 12000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await page.evaluate(fn)) return true;
    await sleep(250);
  }
  return false;
}

try {
  const host = await openPeer('Host');
  const client = await openPeer('Client');
  const cleo = await openPeer('Cleo');
  // Was `ok(true, ...)` — a literal that could only ever be green (the real
  // gate was openPeer() above throwing into the outer catch). Read each peer's
  // NetMgr instead, so the named check owns its own verdict.
  ok((await Promise.all([host, client, cleo].map((p) => p.evaluate(() => !!window.__net?.connected())))).every(Boolean),
     'three peers connected to the room server');
  ok(await waitFor(host, () => window.__net.peerCount() >= 2), 'host sees both clients');

  // M1.4: the first peer in is already the host — no tv write needed to earn it.
  ok(await waitFor(host, () => window.__net.isHost()), 'the first peer in the room is the elected host');
  ok((await client.evaluate(() => window.__net.isHost())) === false, 'a later joiner is not the host');
  // The host publishes what it is running, then broadcasts its canvas.
  await host.evaluate(() => window.__net.setObjectState('tv', { file: 'lwx-nes-pong.nes', core: 'fceumm', system: 'nes', title: 'Pong' }));
  ok(await host.evaluate(() => window.__net.startVideoBroadcast()), 'host captured its canvas and started broadcasting');
  ok(await waitFor(host, () => window.__net.video.sourcing()), 'host is sourcing a video stream');

  // Watch the negotiation timeline (helps diagnose ICE issues).
  for (let i = 0; i < 16; i++) {
    const hv = await host.evaluate(() => window.__net.video.peerStates());
    const cv = await client.evaluate(() => window.__net.video.peerStates());
    console.log(`  t+${i}s  Host=${JSON.stringify(hv)}  Client=${JSON.stringify(cv)}`);
    const done = await host.evaluate(() => window.__net.video.sendingCount() >= 2 && window.__net.video.connectedCount() >= 2)
      && await client.evaluate(() => window.__net.video.receivingCount() >= 1);
    if (done) break;
    await sleep(1000);
  }

  ok(await waitFor(host, () => window.__net.video.connectedCount() >= 2, 3000), 'host connected to both clients');
  ok(await waitFor(host, () => window.__net.video.sendingCount() >= 2, 3000), 'host is sending its track to both clients');
  ok(await waitFor(client, () => window.__net.video.connectedCount() >= 1, 3000), 'client connected to the host');
  ok(await waitFor(client, () => window.__net.video.receivingCount() >= 1, 3000), 'client receives the host game video');
  ok(await waitFor(cleo, () => window.__net.video.receivingCount() >= 1, 3000), 'second client also receives the host video (fan-out)');

  // A client is NOT the host and does not source its own broadcast video.
  ok((await client.evaluate(() => window.__net.video.amHost())) === false, 'client is not the host');
  ok((await client.evaluate(() => window.__net.video.sourcing())) === false, 'client is not sourcing video');

  // M1.4: a watcher does not run a core AT ALL — it never boots one (the old
  // model let it boot the same ROM and merely paused it, which is how two peers
  // ended up emulating independently). Assert on the rack, not on
  // window.__client.paused: that flag is false on an un-STARTED client too, so it
  // would pass vacuously either way.
  const noCore = () => (window.__rack?.live?.() || []).every((r) => !r.core);
  ok(await waitFor(client, noCore), 'client never booted a core while watching the host video');
  ok(await waitFor(cleo, noCore), 'second client also booted no core');

  // M1.4: a watcher writing the tv state must NOT steal the host role any more
  // (that old rule is what let two peers each think they were authoritative).
  await client.evaluate(() => window.__net.setObjectState('tv', { file: 'lwx-gb-snake.gb', core: 'gambatte', system: 'gb', title: 'Snake' }));
  await sleep(1200);
  ok((await client.evaluate(() => window.__net.video.amHost())) === false, 'a tv-state write does NOT promote a client to host');
  ok((await client.evaluate(() => (window.__rack?.live?.() || []).every((r) => !r.core))) === true,
    'the client still has no core of its own (still display-only)');

  // Real handover: the host LEAVES. The longest-present remaining peer (client,
  // which joined before cleo) is promoted; its receive PC is torn down,
  // onHostVideoEnded fires, and it resumes its own core to drive its own TV.
  await browsers[0].close();
  // Deferred by Hub.HOST_RECLAIM_MS (15 s) so a host that is merely reloading can
  // reclaim the role instead of a client being promoted and booting its own core.
  // The wait has to outlast that window or correct behaviour reads as a failure.
  ok(await waitFor(client, () => window.__net.video.amHost(), 25000), 'host left → the senior remaining peer is promoted');
  ok((await cleo.evaluate(() => window.__net.video.amHost())) === false, 'the junior peer was not promoted');
  ok(await waitFor(client, () => (window.__rack?.live?.() || []).some((r) => r.core && r.live), 60000),
    "the promoted peer boots the room's game itself after the host migration");
  ok(await waitFor(client, () => window.__net.video.receivingCount() === 0, 10000),
    'the promoted peer is no longer receiving a stream');
  // And the peer that STAYED a watcher must be re-served by the NEW host, with a
  // picture that actually decodes frames. Before M1.4 it kept a dead track from a
  // host that no longer existed, so its TV went black for the rest of the session.
  ok(await waitFor(cleo, () => window.__net.video.receivingCount() >= 1, 60000),
    'the remaining watcher regains video from the NEW host');
  ok(await waitFor(cleo, () => (window.__rack?.tvs?.() || []).some((t) => t.video), 15000),
    "the remaining watcher's TV is painting the new host's feed");
  const before = await cleo.evaluate(() => window.__net.video.hostVideo());
  await sleep(2500);
  const after = await cleo.evaluate(() => window.__net.video.hostVideo());
  ok(!!before && !!after && after.w > 0 && (after.frames ?? 0) > (before.frames ?? 0) && !after.paused,
    `the remaining watcher's picture is advancing (${JSON.stringify(after)})`);
  ok(await waitFor(cleo, noCore), 'the remaining watcher still never booted a core');
} catch (e) {
  failed++; console.error('  FAIL:', e.message);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
