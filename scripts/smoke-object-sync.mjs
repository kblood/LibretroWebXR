// Headless room-object sync smoke (M0.5): opens two Chrome pages joined to the
// same room and exercises the shared STATE channel end-to-end through the real
// app + room server — set a value on one peer, see it on the other; bidirectional
// last-writer-wins on FREE keys; the M1.4 **host-owned** keys (`tv`, `room`,
// `shelf:*`) rejecting a client's write and correcting it back; a LATE joiner
// converging via the server's state snapshot; and clearing a key propagating.
// This is the *network* part (protocol → Hub persist → snapshot → client
// registry); the shared-game behaviour on top of it lives in
// scripts/smoke-shared-game.mjs and scripts/smoke-room-inherit.mjs.
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8797; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-object-sync.mjs --ws=ws://localhost:8797/   # this
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/';
const WS = args.ws || 'ws://localhost:8797/';
const ROOM = args.room || 'objtest';
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

// Poll a page-side predicate (state arrives asynchronously over the socket).
// Extra args are forwarded to page.evaluate (closures don't cross into the page).
async function waitFor(page, fn, ms = 8000, ...evalArgs) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await page.evaluate(fn, ...evalArgs)) return true;
    await sleep(150);
  }
  return false;
}

const PONG = { file: 'roms/freeware/lwx-pong.nes', core: 'nestopia', system: 'nes', title: 'LWX Pong' };
const SNAKE = { file: 'roms/freeware/lwx-snake.gb', core: 'gambatte', system: 'gb', title: 'LWX Snake' };

try {
  const a = await openPeer('Ava');
  const b = await openPeer('Ben');
  // Was `ok(true, ...)` — a literal that could only ever be green (the real
  // gate was openPeer() above throwing into the outer catch). Read each peer's
  // NetMgr instead, so the named check owns its own verdict.
  ok((await Promise.all([a, b].map((p) => p.evaluate(() => !!window.__net?.connected())))).every(Boolean),
     'both peers connected to the room server');

  ok(await waitFor(a, () => window.__net.peerCount() >= 1), 'Ava sees Ben in the roster');
  ok(await waitFor(b, () => window.__net.peerCount() >= 1), 'Ben sees Ava in the roster');

  // Ava is the first peer in, so she is the room's elected HOST (M1.4).
  ok(await waitFor(a, () => window.__net.isHost()), 'Ava (first in) is the room host');

  // The host sets the shared TV state → Ben must receive it.
  await a.evaluate((tv) => window.__net.setObjectState('tv', tv), PONG);
  ok(await waitFor(b, (f) => window.__net.objectState('tv')?.file === f, 8000, PONG.file),
    'Ben receives the host\'s TV state over the channel');
  ok(await a.evaluate((f) => window.__net.objectState('tv')?.file === f, PONG.file),
    'the host\'s own registry reflects the value she set');

  // `tv` is a HOST-OWNED key since M1.4 (Hub.isHostOwnedKey): a client writing it
  // is rejected and corrected back, so the room can never have two peers each
  // believing they decide what is playing. Not last-writer-wins any more.
  await b.evaluate((tv) => window.__net.setObjectState('tv', tv), SNAKE);
  await sleep(1500);
  ok(await a.evaluate((f) => window.__net.objectState('tv')?.file === f, PONG.file),
    'a CLIENT cannot overwrite the host-owned tv state');
  ok(await waitFor(b, (f) => window.__net.objectState('tv')?.file === f, 8000, PONG.file),
    'the rejected writer is corrected back to the host\'s value');

  // Bidirectional last-writer-wins still applies to the FREE keys (prop:*, pose,
  // holds …) — that's the generic behaviour this smoke exists to cover.
  const KEY = 'prop:smoke-object-sync';
  await a.evaluate((k) => window.__net.setObjectState(k, { pos: [1, 2, 3] }), KEY);
  ok(await waitFor(b, (k) => window.__net.objectState(k)?.pos?.[0] === 1, 8000, KEY),
    'Ben receives Ava\'s prop state over the channel');
  await b.evaluate((k) => window.__net.setObjectState(k, { pos: [9, 9, 9] }), KEY);
  ok(await waitFor(a, (k) => window.__net.objectState(k)?.pos?.[0] === 9, 8000, KEY),
    'Ava converges to Ben\'s overwrite (last-writer-wins on a free key)');

  // LATE JOINER: Cara joins after state exists → must converge from the snapshot.
  const c = await openPeer('Cara');
  ok(await waitFor(c, (f) => window.__net.objectState('tv')?.file === f, 8000, PONG.file),
    'a late joiner converges to the current TV state via the server snapshot');
  ok(await waitFor(c, (k) => window.__net.objectState(k)?.pos?.[0] === 9, 8000, KEY),
    'the late joiner also gets the free-key state from the snapshot');

  // Clearing a key propagates to everyone (from the owner in each case).
  await a.evaluate(() => window.__net.setObjectState('tv', null));
  ok(await waitFor(b, () => window.__net.objectState('tv') === null), 'clearing the key propagates to Ben');
  ok(await waitFor(c, () => window.__net.objectState('tv') === null), 'clearing the key propagates to the late joiner');
  await b.evaluate((k) => window.__net.setObjectState(k, null), KEY);
  ok(await waitFor(c, (k) => window.__net.objectState(k) === null, 8000, KEY),
    'clearing a free key propagates too');
} catch (e) {
  failed++; console.error('  FAIL:', e.message);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
