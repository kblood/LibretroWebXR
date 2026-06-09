// Headless voice smoke (M0.4): opens TWO Chrome pages with FAKE microphones,
// joins them to the same room, enables voice on both, and asserts the WebRTC
// mesh connects and each side actually receives the other's audio track (which
// VoiceMgr attaches to the peer's avatar head). Proves the full signaling →
// peer-connection → media path without a headset or a real mic.
//
// Prereqs (start first): a room server WITH signal support + the vite dev server.
//   $env:PORT=8798; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-voice.mjs                        # this
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/';
const WS = args.ws || 'ws://localhost:8798/';
const ROOM = args.room || 'voicetest';
const urlFor = (nick) => `${APP}${APP.includes('?') ? '&' : '?'}session=${ROOM}&server=${encodeURIComponent(WS)}&nick=${nick}`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(2); }

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error(`  FAIL: ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--use-fake-device-for-media-stream',   // synthetic mic, no hardware
  '--use-fake-ui-for-media-stream',       // auto-grant getUserMedia
  '--autoplay-policy=no-user-gesture-required',
  '--enable-features=SharedArrayBuffer',
  // Headless loopback WebRTC: Chrome otherwise hides local IPs behind mDNS
  // `.local` candidates that don't resolve, so cross-process ICE never
  // completes. Disabling it exposes real host candidates → localhost P2P works.
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

// Two SEPARATE browsers (not two tabs): each page is genuinely foreground, so
// neither throttles its rAF/pose loop — the robust pattern for a P2P test.
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
  const a = await openPeer('Ava');
  const b = await openPeer('Ben');
  ok(true, 'both peers connected to the room server');

  // Each should see the other in the roster (presence working).
  ok(await waitFor(a, () => window.__net.peerCount() >= 1), 'Ava sees Ben in the roster');
  ok(await waitFor(b, () => window.__net.peerCount() >= 1), 'Ben sees Ava in the roster');

  // Enable voice on both (fake mic auto-granted).
  const aOn = await a.evaluate(() => window.__net.enableVoice());
  const bOn = await b.evaluate(() => window.__net.enableVoice());
  ok(aOn && bOn, 'both peers enabled voice (got a mic)');

  // Watch the negotiation timeline (helps diagnose ICE issues).
  for (let i = 0; i < 16; i++) {
    const av = await a.evaluate(() => window.__net.voice.peerStates());
    const bv = await b.evaluate(() => window.__net.voice.peerStates());
    console.log(`  t+${i}s  Ava=${JSON.stringify(av)}  Ben=${JSON.stringify(bv)}`);
    const aConn = await a.evaluate(() => window.__net.voice.connectedCount() >= 1 && window.__net.voice.receivingCount() >= 1);
    const bConn = await b.evaluate(() => window.__net.voice.connectedCount() >= 1 && window.__net.voice.receivingCount() >= 1);
    if (aConn && bConn) break;
    await sleep(1000);
  }

  ok(await waitFor(a, () => window.__net.voice.connectedCount() >= 1, 2000), 'Ava\'s peer connection reached connected');
  ok(await waitFor(b, () => window.__net.voice.connectedCount() >= 1, 2000), 'Ben\'s peer connection reached connected');
  ok(await waitFor(a, () => window.__net.voice.receivingCount() >= 1, 2000), 'Ava receives Ben\'s audio stream (positional)');
  ok(await waitFor(b, () => window.__net.voice.receivingCount() >= 1, 2000), 'Ben receives Ava\'s audio stream (positional)');
} catch (e) {
  failed++; console.error('  FAIL:', e.message);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
