// Headless host-video smoke (M1.2): the HOST boots the room's game (claims the
// shared `tv` state) and broadcasts its emulator canvas; every other peer
// receives the WebRTC video track and would paint it onto its in-world TV.
// Proves the full signaling → peer-connection → media path for the game stream,
// fanned out to multiple clients, without a headset.
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
  ok(true, 'three peers connected to the room server');
  ok(await waitFor(host, () => window.__net.peerCount() >= 2), 'host sees both clients');

  // Host boots the room's game → becomes the tv-state owner (host) → broadcasts.
  await host.evaluate(() => window.__net.setObjectState('tv', { file: 'lwx-nes-pong.nes', core: 'fceumm', system: 'nes', title: 'Pong' }));
  ok(await waitFor(host, () => window.__net.isHost()), 'tv-state owner reports itself as host');
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

  // M1.2 follow-up: a watcher pauses its OWN core while showing the host's
  // streamed frames (it isn't authoritative and isn't displayed → no point
  // burning CPU/battery emulating it). The local core is exposed as
  // window.__client; .paused reflects the emscripten main-loop pause.
  ok(await waitFor(client, () => window.__client && window.__client.paused === true),
    'client paused its local core while watching the host video');
  ok(await waitFor(cleo, () => window.__client && window.__client.paused === true),
    'second client also paused its local core');

  // Resume path: when a watcher takes over as host (claims the tv state →
  // becomes the tv-state owner), the video handover closes its receive PC,
  // fires onHostVideoEnded, and it resumes its local core to drive its own TV.
  // Use a DIFFERENT game than the host's so it isn't a no-op (setObjectState
  // skips an unchanged value), which would leave ownership with the old host.
  await client.evaluate(() => window.__net.setObjectState('tv', { file: 'lwx-gb-snake.gb', core: 'gambatte', system: 'gb', title: 'Snake' }));
  ok(await waitFor(client, () => window.__net.video.amHost()), 'client became the new host after claiming tv state');
  ok(await waitFor(client, () => window.__client && window.__client.paused === false),
    'client resumed its local core after the host handover');
} catch (e) {
  failed++; console.error('  FAIL:', e.message);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
