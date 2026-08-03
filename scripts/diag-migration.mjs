// Diagnostic, not a test: after a host MIGRATION, how long does the remaining
// watcher take to get real decoded frames off the NEW host? smoke-shared-game
// measures this with a fixed 3 s window immediately after `receivingCount()>=1`,
// which is green on localhost but RED against the deployed build. This tells us
// which it is: a harness that measures too early over real network latency, or a
// production-only failure where the renegotiated stream never delivers media.
//
// Prints a per-second timeline of the watcher's host <video> (decoded frames,
// dimensions) plus the promoted peer's receiving count, for 90 s.
//
// It found a real one: against production the watcher sat at 0 frames / 0x0 for
// 90 s and the promoted peer never dropped its dead stream, because the LIVE room
// server was two months stale (no host election, no wire()). Run it against both
// --app=http://localhost:<port>/ and the deployed URL and compare the timelines;
// that side-by-side is what separated "harness measures too early" from "the
// deployment is broken". See server/README.md.
//
// Usage: node scripts/diag-migration.mjs --app=<url> --ws=<url>

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5399/';
const WS = args.ws || 'ws://localhost:8897/';
const ROOM = `mig${Date.now().toString(36)}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAUNCH = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
  '--enable-features=SharedArrayBuffer', '--disable-features=WebRtcHideLocalIpsWithMdns'];

const browsers = [];
async function openPeer(nick) {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH });
  browsers.push(b);
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log(`  [${nick}] PAGEERROR ${String(e).slice(0, 160)}`));
  await p.goto(`${APP}?session=${ROOM}&server=${encodeURIComponent(WS)}&nick=${nick}`, { waitUntil: 'load' });
  await p.waitForFunction(() => Array.isArray(window.__games) && window.__games.length > 0
    && typeof window.__insertCartridge === 'function', { timeout: 90000 });
  await p.waitForFunction(() => window.__net?.connected(), { timeout: 30000 });
  return p;
}
const waitFor = async (page, fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.evaluate(fn)) return true; } catch { /* mid-reload */ }
    await sleep(250);
  }
  return false;
};

try {
  console.log(`room=${ROOM} app=${APP}`);
  const A = await openPeer('Alice');
  const g = await A.evaluate(() => {
    const x = window.__games.find((q) => q.system === 'nes' && /pong/i.test(q.title || q.file))
           || window.__games.find((q) => q.system === 'nes');
    return { file: x.file, core: x.core, system: x.system, title: x.title };
  });
  await A.evaluate((m) => window.__insertCartridge(m), g);
  await sleep(2000);
  const B = await openPeer('Bob');
  await sleep(2000);
  const C = await openPeer('Cleo');
  console.log(`host booted ${g.file}; waiting for both watchers to receive…`);
  console.log(`  B receiving: ${await waitFor(B, () => window.__net.video.receivingCount() >= 1, 60000)}`);
  console.log(`  C receiving: ${await waitFor(C, () => window.__net.video.receivingCount() >= 1, 60000)}`);
  const pre = await C.evaluate(() => window.__net.video.hostVideo());
  console.log(`  C pre-migration video: ${JSON.stringify(pre)}`);

  console.log('\n--- closing the host (A) ---');
  const t0 = Date.now();
  await browsers[0].close();
  console.log(`  B promoted: ${await waitFor(B, () => window.__net.isHost(), 40000)} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`  B runs a core: ${await waitFor(B, () => (window.__rack.live() || []).some((r) => r.core && r.live), 60000)} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  console.log('\n  t(s)  B.recv  C.recv  C.frames  C.w x C.h  C.paused');
  let firstFrames = null, firstSized = null, bZero = null;
  for (let i = 0; i < 90; i++) {
    const t = ((Date.now() - t0) / 1000).toFixed(1);
    let brecv = null, crecv = null, v = null;
    try { brecv = await B.evaluate(() => window.__net.video.receivingCount()); } catch {}
    try { crecv = await C.evaluate(() => window.__net.video.receivingCount()); } catch {}
    try { v = await C.evaluate(() => window.__net.video.hostVideo()); } catch {}
    if (bZero === null && brecv === 0) bZero = t;
    if (firstFrames === null && (v?.frames ?? 0) > 0) firstFrames = t;
    if (firstSized === null && (v?.w ?? 0) > 0) firstSized = t;
    console.log(`  ${t.padStart(5)}  ${String(brecv).padStart(6)}  ${String(crecv).padStart(6)}  `
      + `${String(v?.frames ?? '-').padStart(8)}  ${String(v?.w ?? '-')}x${String(v?.h ?? '-')}  ${v?.paused}`);
    if (firstFrames !== null && Number(t) - Number(firstFrames) > 5) break;
    await sleep(1000);
  }
  console.log('\nSUMMARY');
  console.log(`  promoted peer's receivingCount hit 0 at: ${bZero ?? 'NEVER (within the loop)'}`);
  console.log(`  watcher's first nonzero videoWidth at:   ${firstSized ?? 'NEVER'}`);
  console.log(`  watcher's first decoded frame at:        ${firstFrames ?? 'NEVER'}`);
} catch (e) { console.error('EXCEPTION', e); }
finally {
  for (const b of browsers) { try { await b.close(); } catch {} }
}
