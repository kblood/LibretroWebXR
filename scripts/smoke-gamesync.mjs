// Headless host-resolution smoke (M1.1, updated for M1.4): proves the
// host-authoritative input path resolves the HOST from the SERVER's election
// (the longest-present peer — no longer "whoever last wrote the shared `tv`
// state"), then relays a client's input directly to that host (and to no one
// else).
//
// M1.0 (scripts/smoke-gameinput.mjs) verified the raw INPUT transport with an
// explicit `to`. M1.1 adds the wiring that DECIDES who `to` is: whoever owns the
// shared `tv` state (the peer that booted the room's game) is the host, and a
// non-host forwards its captured input there. Here we drive that at the transport
// level via window.__net (available pre-stall) — the host boots the game by
// claiming `tv` state, the client reads net.hostId() and forwards, the host
// receives. The keycode INJECTION on the host (GameInputMgr.setRemoteButton →
// client.sendInput) and the controller→logical CAPTURE both need real XR
// gamepads, so they're covered by `npm test` (scripts/test-multiplayer.mjs)
// rather than here, same XR-headless caveat as the edit-mode menus.
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8797; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-gamesync.mjs --ws=ws://localhost:8797/   # this
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/';
const WS = args.ws || 'ws://localhost:8797/';
const ROOM = args.room || 'gamesync';
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
const LAUNCH_ARGS = ['--no-sandbox', '--enable-features=SharedArrayBuffer'];

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

async function waitFor(page, fn, ms = 8000, ...evalArgs) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await page.evaluate(fn, ...evalArgs)) return true;
    await sleep(150);
  }
  return false;
}

try {
  const host = await openPeer('Host');
  const client = await openPeer('Client');
  const bystander = await openPeer('Bystander');
  ok(true, 'three peers connected');
  ok(await waitFor(client, () => window.__net.peerCount() >= 2), 'client sees the others');

  const hostId = await host.evaluate(() => window.__net.selfId());

  // M1.4: the host is decided the instant HELLO lands — the FIRST peer in the
  // room is it, with no game booted and nobody having written `tv`.
  ok(await waitFor(host, () => window.__net.isHost()), 'the first peer in the room is the host (no game needed)');
  ok(await waitFor(client, (id) => window.__net.hostId() === id, 8000, hostId), 'client resolves the elected host id');
  ok((await client.evaluate(() => window.__net.isHost())) === false, 'client is not the host');
  ok((await bystander.evaluate(() => window.__net.isHost())) === false, 'bystander is not the host either');

  // The old rule is gone: a client writing the shared `tv` state must NOT make it
  // the host. (Writing it is a host-only action in the app; here we poke the
  // transport directly to prove the ELECTION, not the app gate.)
  await client.evaluate(() => window.__net.setObjectState('tv', { file: 'lwx-gb-snake.gb', core: 'gambatte', system: 'gb', title: 'Snake' }));
  await sleep(800);
  ok((await client.evaluate(() => window.__net.isHost())) === false, 'writing tv state does NOT make a client the host');
  ok((await client.evaluate(() => window.__net.hostId())) === hostId, 'the host is unchanged after a tv-state write');
  ok((await host.evaluate(() => window.__net.isHost())) === true, 'the elected host keeps the role');

  // forwardGameInput routes to the resolved host with no explicit `to`.
  await client.evaluate(() => {
    window.__net.forwardGameInput({ player: 2, btn: 'A', down: true });
    window.__net.forwardGameInput({ player: 2, btn: 'Up', down: true });
    window.__net.forwardGameInput({ player: 2, btn: 'A', down: false });
  });
  ok(await waitFor(host, () => window.__net.recvInputs().length >= 3), 'host received the forwarded input frames');

  const clientId = await client.evaluate(() => window.__net.selfId());
  const recv = await host.evaluate(() => window.__net.recvInputs());
  ok(recv.every((e) => e.from === clientId), 'every forwarded input is stamped with the client id (anti-spoof)');
  ok(recv.some((e) => e.player === 2 && e.btn === 'A' && e.down === true), 'press A delivered to the resolved host');
  ok(recv.some((e) => e.player === 2 && e.btn === 'Up' && e.down === true), 'press Up delivered to the resolved host');

  // The host does NOT forward its own input (it injects locally instead).
  ok((await host.evaluate(() => window.__net.forwardGameInput({ player: 1, btn: 'A', down: true }))) === false, 'host self-forward is a no-op');

  // Directed, not broadcast: the bystander must NOT have received the inputs.
  await sleep(500);
  ok((await bystander.evaluate(() => window.__net.recvInputs().length)) === 0, 'bystander received nothing (directed relay)');

  // M1.4 migration: the host leaves → the longest-present remaining peer (the
  // client, which joined before the bystander) is promoted by the server.
  // Deliberately DEFERRED by Hub.HOST_RECLAIM_MS (15 s): a host that is merely
  // reloading its own page must be able to reclaim the role instead of a client
  // being promoted and booting a core of its own. So this wait has to outlast
  // that window — a shorter timeout fails on correct behaviour.
  await browsers[0].close();
  ok(await waitFor(client, () => window.__net.isHost(), 25000), 'host left → the longest-present remaining peer is promoted');
  const newHost = await client.evaluate(() => window.__net.selfId());
  ok(await waitFor(bystander, (id) => window.__net.hostId() === id, 10000, newHost), 'the bystander agrees on the new host');
  ok((await bystander.evaluate(() => window.__net.isHost())) === false, 'the junior peer was NOT promoted');
} catch (e) {
  failed++; console.error('  FAIL:', e.message);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
