// Headless client-side smoke for M0 presence: loads the real app in Chrome with
// ?session set, points it at a running room server, then injects a SECOND peer
// (a plain browser WebSocket inside the page — no extra deps) that joins the same
// room and sends a pose. Asserts the app's NetMgr connected, saw the peer, and
// spawned an avatar for it.
//
// Prereqs (start both first): a room server and the vite dev server.
//   $env:PORT=8798; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-presence.mjs                     # this
//
// Flags: --app=<url> (default http://localhost:5173/) --ws=<url> (default
// ws://localhost:8798/) --room=<id> --screenshot=<path> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/';
const WS = args.ws || 'ws://localhost:8798/';
const ROOM = args.room || 'smoke';
const URL = `${APP}${APP.includes('?') ? '&' : '?'}session=${ROOM}&server=${encodeURIComponent(WS)}&nick=Host`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(2); }

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error(`  FAIL: ${m}`); } };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: ['--no-sandbox', '--enable-features=SharedArrayBuffer'] });
const page = await browser.newPage();
page.setDefaultTimeout(15000);
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });

try {
  console.log(`# loading ${URL}`);
  await page.goto(URL, { waitUntil: 'load' });

  // Wait for the app's own NetMgr to connect to the room server.
  await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 10000 });
  ok(true, 'app NetMgr connected to the room server');

  // Inject a second peer from inside the page (browser-native WebSocket, raw
  // protocol JSON — server stamps the id), join the same room, send one pose.
  const result = await page.evaluate(async (wsBase, room) => {
    const url = `${wsBase}${wsBase.includes('?') ? '&' : '?'}room=${encodeURIComponent(room)}`;
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ghost ws error')); });
    ws.send(JSON.stringify({ type: 'join', nick: 'Ghost', color: '#ff66aa' }));
    ws.send(JSON.stringify({ type: 'pose', head: [1.0, 1.6, -2.0, 0, 0, 0, 1], left: null, right: null }));
    await new Promise((r) => setTimeout(r, 1000)); // let pose arrive + a few rAF ticks
    return { connected: window.__net.connected(), peers: window.__net.peerCount(), avatars: window.__net.avatarCount(), names: window.__net.peers().map((p) => p.nick) };
  }, WS, ROOM);

  console.log('# __net:', result);
  ok(result.peers >= 1, 'app sees the injected peer (peerCount ≥ 1)');
  ok(result.avatars >= 1, 'app spawned an avatar for the peer (avatarCount ≥ 1)');
  ok(result.names.includes('Ghost'), 'peer nick "Ghost" propagated through JOIN');

  if (args.screenshot) { await page.screenshot({ path: args.screenshot }); console.log(`# screenshot: ${args.screenshot}`); }
} catch (e) {
  failed++; console.error('  FAIL:', e.message);
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
