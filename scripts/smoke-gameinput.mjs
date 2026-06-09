// Headless game-input transport smoke (M1.0): proves a non-host peer's RetroPad
// inputs are relayed DIRECTLY to the designated host (and to no one else) over the
// room socket. This is the host-authoritative input spine; injecting the received
// inputs into the host's core (M1.1) and the host video stream (M1.2) come later.
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8797; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-gameinput.mjs --ws=ws://localhost:8797/   # this
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/';
const WS = args.ws || 'ws://localhost:8797/';
const ROOM = args.room || 'gameinput';
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
  const clientId = await client.evaluate(() => window.__net.selfId());

  // Client drives "player 2" on the host: press A, press Up, release A.
  await client.evaluate((to) => {
    window.__net.sendGameInput({ to, player: 2, btn: 'faceA', down: true });
    window.__net.sendGameInput({ to, player: 2, btn: 'Up', down: true });
    window.__net.sendGameInput({ to, player: 2, btn: 'faceA', down: false });
  }, hostId);

  ok(await waitFor(host, () => window.__net.recvInputs().length >= 3), 'host received the input frames');

  const recv = await host.evaluate(() => window.__net.recvInputs());
  ok(recv.every((e) => e.from === clientId), 'every input is stamped with the client id (anti-spoof)');
  ok(recv.some((e) => e.player === 2 && e.btn === 'faceA' && e.down === true), 'press A delivered intact');
  ok(recv.some((e) => e.player === 2 && e.btn === 'Up' && e.down === true), 'press Up delivered intact');
  ok(recv.some((e) => e.player === 2 && e.btn === 'faceA' && e.down === false), 'release A delivered intact');

  // Directed, not broadcast: the bystander must NOT have received the inputs.
  await sleep(500);
  ok((await bystander.evaluate(() => window.__net.recvInputs().length)) === 0, 'bystander received nothing (directed relay)');
} catch (e) {
  failed++; console.error('  FAIL:', e.message);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
