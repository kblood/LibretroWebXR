// Headless held-object sync smoke (M0): proves that when one peer holds a
// cartridge, the others show a ghost of it (in the holder's avatar hand) and hide
// their own copy — and that the ghost is removed both on release and when the
// holder disconnects, plus that a late joiner converges from the server snapshot.
// Exercises the network + reconcile path (real app + room server); the actual
// VR grab gesture that triggers the broadcast is the headset-only part.
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8797; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-held.mjs --ws=ws://localhost:8797/   # this
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/';
const WS = args.ws || 'ws://localhost:8797/';
const ROOM = args.room || 'heldtest';
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
  // __ghost is exposed during world build (before the headless buildMemoryCards stall).
  await page.waitForFunction(() => !!window.__ghost && !!window.__grab, { timeout: 10000 });
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
  const a = await openPeer('Ava');
  const b = await openPeer('Ben');
  ok(true, 'both peers connected');
  ok(await waitFor(a, () => window.__net.peerCount() >= 1), 'Ava sees Ben');
  ok(await waitFor(b, () => window.__net.peerCount() >= 1), 'Ben sees Ava');

  // Pick a real cartridge file from the shared room (both peers built the same one).
  const file = await b.evaluate(() => {
    const carts = (window.__grab?.grabbables || []).filter((o) => o.userData?.kind === 'cartridge');
    return carts.length ? carts[0].userData.file : null;
  });
  ok(!!file, `found a cartridge to hold (${file})`);

  // Ava "grabs" it (the broadcast a real VR grab would make).
  const aId = await a.evaluate(() => window.__net.selfId());
  await a.evaluate(([f, id]) => window.__net.setObjectState('hold:' + f, { holder: id, hand: 'left' }), [file, aId]);

  ok(await waitFor(b, (f) => window.__ghost.has(f), 8000, file), 'Ben shows a ghost for the cart Ava holds');
  ok(await b.evaluate(() => window.__ghost.count() >= 1), 'Ben has exactly the one ghost');
  ok(await waitFor(b, () => window.__ghost.hidden() >= 1), 'Ben hid his local copy of the held cart');
  ok(!(await a.evaluate(() => window.__ghost.count() > 0)), 'Ava shows no ghost for her own held cart');

  // Late joiner converges from the snapshot.
  const c = await openPeer('Cara');
  ok(await waitFor(c, (f) => window.__ghost.has(f), 8000, file), 'a late joiner shows the ghost from the snapshot');

  // Release: Ava clears the hold → ghost disappears, cart reappears.
  await a.evaluate((f) => window.__net.setObjectState('hold:' + f, null), file);
  ok(await waitFor(b, () => window.__ghost.count() === 0), 'releasing removes Ben\'s ghost');
  ok(await waitFor(b, () => window.__ghost.hidden() === 0), 'releasing unhides Ben\'s cart');

  // Re-hold, then DISCONNECT the holder → server clears the hold for everyone.
  await a.evaluate(([f, id]) => window.__net.setObjectState('hold:' + f, { holder: id, hand: 'left' }), [file, aId]);
  ok(await waitFor(b, () => window.__ghost.count() === 1), 'ghost reappears after re-hold');
  await a.browser().close();
  browsers.splice(browsers.indexOf(a.browser()), 1);
  ok(await waitFor(b, () => window.__ghost.count() === 0, 10000), 'ghost removed when the holder disconnects');
  ok(await waitFor(b, () => window.__ghost.hidden() === 0, 10000), 'cart unhidden when the holder disconnects');
} catch (e) {
  failed++; console.error('  FAIL:', e.message);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
