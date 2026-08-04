// Headless TWO-CLIENT smoke for M1.4d: **the HOST's "Load ROM" file picker must
// re-publish the room's `tv` key and re-point the video broadcast.**
//
// Why this exists as its own smoke: `smoke-shared-game.mjs` §5b drives `#rom-input`
// and `__pickLocalRom` only on the CLIENT (asserting they are *suppressed*), and its
// §4c live-reboot case goes through `rebootPrimaryConsole` (gun arm), which always
// re-broadcast. The HOST side of that same button was never exercised by any
// committed test — and it was broken: both picker paths called `bootOnPrimary()` and
// stopped, so the room kept advertising the PREVIOUS game while every watcher kept
// receiving the RETIRED canvas' capture (a track that stays `readyState:'live'`
// forever while painting nothing, so `sendingCount()`/`receivingCount()` both still
// read 1 and no diagnostic reported a fault). This is docs/MULTIPLAYER.md's
// two-browser manual test step 6, automated.
//
// Evidence channels (deliberately NOT "no error was thrown"):
//   • the room's published `tv` key, read on the WATCHER, must name the new file
//   • the watcher's <video> must DECODE NEW FRAMES after the host's pick, and its
//     videoWidth/Height must follow the new game's canvas (a frozen retired capture
//     keeps the old size forever)
//   • the host's `video.sourceCanvas()` must be the canvas of the runtime that is
//     actually running now
//   • the watcher must still run ZERO cores (the M1.4 invariant must survive)
//
// Both branches of `bootOnPrimary` are covered, in order:
//   phase 1  host boots an NES cart the normal way (cartridge → loadCartridge)
//   phase 2  host picks a .nes with the real #rom-input → CROSS-core branch
//            (a shelf cart is fceumm, a picked .nes detects as nestopia: fresh
//            runtime + fresh canvas — the frozen-picture half of the bug)
//   phase 3  host picks ANOTHER .nes → SAME-core branch (no swap, so only the
//            stale-`tv` half of the bug shows here)
//   phase 4  host picks a .gb → CROSS-core swap again, out of a fresh runtime
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8797; node server/room-server.mjs         # terminal 1
//   npm run dev -- --port 5199                           # terminal 2
//   node scripts/smoke-host-picker.mjs --app=http://localhost:5199/ --ws=ws://localhost:8797/
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed --shots=<dir>
//
// NEGATIVE CONTROL (this suite's history is full of vacuously-green tests, so this
// was actually done): with the M1.4d fix reverted in src/main.js, phases 2 and 3
// fail — the watcher's `tv` stays on the first cart and its picture freezes at the
// NES canvas size. See the commit message for the recorded before/after.

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5199/';
const WS = args.ws || 'ws://localhost:8797/';
const ROOM = args.room || `picker${Date.now().toString(36)}`;
const SHOTS = typeof args.shots === 'string' ? args.shots : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(2); }

// A shelf NES cart declares `fceumm`; a PICKED bare .nes detects as `nestopia`, so
// pick #1 is already a cross-core swap and pick #2 (another .nes) is the same-core
// branch. Pick #3 (.gb → gambatte) is a second cross-core swap from a fresh runtime.
const PICK_CROSS_CORE_1 = resolve('public/roms/freeware/lwx-nes-bomberman.nes');
const PICK_SAME_CORE = resolve('public/roms/freeware/lwx-nes-gallery.nes');
const PICK_CROSS_CORE_2 = resolve('public/roms/freeware/lwx-gb-snake.gb');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok   ${m}`); } else { failed++; console.error(`  FAIL ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-features=SharedArrayBuffer',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
];

const browsers = [];
async function openPeer(nick) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`  [${nick}] PAGEERROR ${String(e).slice(0, 200)}`));
  await page.goto(`${APP}?session=${ROOM}&server=${encodeURIComponent(WS)}&nick=${nick}`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => Array.isArray(window.__games) && window.__games.length > 0 && typeof window.__insertCartridge === 'function',
    { timeout: 60000 },
  );
  await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 20000 });
  return page;
}

async function waitFor(page, fn, ms = 15000, ...a) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if (await page.evaluate(fn, ...a)) return true; } catch { /* mid-reload */ }
    await sleep(250);
  }
  return false;
}

const liveCores = (page) => page.evaluate(() =>
  (window.__rack?.live?.() || []).filter((r) => r.core && r.live).length);
const hostVideo = (page) => page.evaluate(() => window.__net?.video?.hostVideo?.() ?? null);
const tvOf = (page) => page.evaluate(() => window.__net?.objectState?.('tv') ?? null);

// Did the watcher's picture ADVANCE (new frames decoded) over `ms`? A retired
// capture keeps readyState:'live' and currentTime ticking, so decoded frames are
// the only honest signal.
async function pictureAdvances(page, ms = 3000) {
  const a = await hostVideo(page);
  await sleep(ms);
  const b = await hostVideo(page);
  if (!a || !b) return { ok: false, why: 'no host <video> element', a, b };
  const dFrames = (b.frames ?? 0) - (a.frames ?? 0);
  const dTime = (b.time ?? 0) - (a.time ?? 0);
  const moved = (b.frames != null) ? dFrames > 0 : dTime > 0.1;
  const sized = (b.w ?? 0) > 0 && (b.h ?? 0) > 0;
  return { ok: moved && sized && !b.paused, dFrames, dTime, paused: b.paused, w: b.w, h: b.h };
}

// --- pixel evidence: is the watcher looking at the game the HOST is running? ----
// Frames-advancing proves "not frozen"; it does NOT prove "the right game" (before
// this fix the watcher's picture could keep ticking on the retired canvas). So take
// a coarse 8x6 RGB signature of the HOST's live canvas and of the WATCHER's TV
// video within the same moment and correlate them: same game ⇒ strongly positive,
// two different games ⇒ near zero. This is the "pixel correlation ≈ 0 against the
// host" symptom from docs/MULTIPLAYER.md, turned into an assertion.
const GRID_SIG = `(src, w, h) => {
  if (!src || !w || !h) return null;
  const GX = 8, GY = 6;
  const off = document.createElement('canvas');
  off.width = GX * 8; off.height = GY * 8;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, off.width, off.height);
  let data;
  try { data = ctx.getImageData(0, 0, off.width, off.height).data; }
  catch (e) { return null; }        // tainted canvas — surfaces as "no signature"
  const out = [];
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
    let sum = 0, n = 0;
    for (let y = gy * 8; y < (gy + 1) * 8; y++) for (let x = gx * 8; x < (gx + 1) * 8; x++) {
      const i = (y * off.width + x) * 4;
      sum += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114); n++;
    }
    out.push(sum / n);
  }
  return out;
}`;

// HOST side: the canvas its own TV is painting (i.e. the live runtime's canvas).
const hostCanvasSig = (page) => page.evaluate(`(() => {
  const sig = ${GRID_SIG};
  const tv = (window.__rack?.tvs?.() || []).find((t) => t.source);
  const c = tv ? document.getElementById(tv.source) : null;
  return c ? sig(c, c.width, c.height) : null;
})()`);

// WATCHER side: the remote host <video> its in-world TV is textured with.
const watcherTvSig = (page) => page.evaluate(`(() => {
  const sig = ${GRID_SIG};
  const t = (window.__scene?._tvs || []).find((x) => x.sourceVideo);
  const v = t?.sourceVideo;
  if (!v || !v.videoWidth) return null;
  return sig(v, v.videoWidth, v.videoHeight);
})()`);

function correlate(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  if (da === 0 || db === 0) return null;    // a flat (blank) image on either side
  return num / Math.sqrt(da * db);
}

// Best correlation over a few samples — WebRTC latency means the two grabs can be
// a frame or two apart, and an animated game moves between them.
async function watcherMatchesHost(host, watcher, tries = 6) {
  let best = null;
  for (let i = 0; i < tries; i++) {
    const h = await hostCanvasSig(host);
    const w = await watcherTvSig(watcher);
    const c = correlate(h, w);
    if (c != null && (best == null || c > best)) best = c;
    await sleep(500);
  }
  return best;
}

// Drive the REAL user-facing "Load ROM" button, not the __pickLocalRom debug hook:
// #rom-input's change handler is a separate code path with its own core detection,
// multi-file handling and disc sniffing.
async function pickWithRealInput(page, file) {
  const input = await page.$('#rom-input');
  if (!input) throw new Error('#rom-input not found in the page');
  await input.uploadFile(file);
}

async function shot(page, name) {
  if (!SHOTS) return;
  try { await page.screenshot({ path: `${SHOTS}/${name}.png` }); } catch { /* ok */ }
}

try {
  for (const f of [PICK_CROSS_CORE_1, PICK_SAME_CORE, PICK_CROSS_CORE_2]) {
    if (!existsSync(f)) { console.error(`missing test ROM: ${f}`); process.exit(2); }
  }
  console.log(`room=${ROOM}`);
  const A = await openPeer('Alice');          // first in → host
  await sleep(1500);
  const B = await openPeer('Bob');            // display-only watcher

  ok(await waitFor(A, () => window.__net.isHost()), 'Alice (first in) is the room host');
  ok(await waitFor(B, () => window.__net.isHost() === false && !!window.__net.hostId()),
    'Bob is a display-only client');

  // --- phase 1: the host boots a cart the ordinary way (loadCartridge) --------
  const cart = await A.evaluate(() => {
    const g = window.__games.find((x) => x.system === 'nes' && /pong/i.test(x.title || x.file))
           || window.__games.find((x) => x.system === 'nes');
    return g ? { file: g.file, core: g.core, system: g.system, title: g.title } : null;
  });
  ok(!!cart, `found an NES cart for the baseline boot (${cart?.file})`);
  await A.evaluate((g) => window.__insertCartridge(g), cart);
  ok(await waitFor(A, () => (window.__rack.live() || []).some((r) => r.core && r.live), 30000),
    'the host is running a core');
  ok(await waitFor(B, (f) => window.__net.objectState('tv')?.file === f, 25000, cart.file),
    'the watcher learned the cart game from the room `tv` key');
  ok(await waitFor(B, () => window.__net.video.receivingCount() >= 1, 40000),
    "the watcher receives the host's video");
  ok(await waitFor(B, () => (window.__rack?.tvs?.() || []).some((t) => t.video), 15000),
    "the watcher's in-world TV is painting the host's feed");
  const base = await pictureAdvances(B);
  ok(base.ok, `baseline: the watcher's picture advances (${JSON.stringify(base)})`);
  const baseCorr = await watcherMatchesHost(A, B);
  ok(baseCorr != null && baseCorr > 0.5,
    `baseline: the watcher's TV pixels match the HOST's canvas (corr=${baseCorr?.toFixed(3)})`);
  await shot(B, 'watcher-baseline');

  // --- phase 2: host picks a .nes with the REAL picker (CROSS-core) -----------
  // A shelf NES cart declares core `fceumm`, while a picked bare .nes detects as
  // `nestopia` — so this pick already takes bootOnPrimary's cross-core branch: a
  // FRESH runtime on a FRESH canvas, retiring the canvas the room was watching.
  console.log('\nphase 2: host picks lwx-nes-bomberman.nes via the real #rom-input (cross-core: fceumm → nestopia)');
  await pickWithRealInput(A, PICK_CROSS_CORE_1);
  await sleep(8000);
  const hostAfter2 = await A.evaluate(() => ({
    status: document.getElementById('status')?.textContent || null,
    cores: (window.__rack?.live?.() || []).map((r) => `${r.id}:${r.core}${r.live ? '' : '(paused)'}`),
  }));
  console.log('  host after pick →', JSON.stringify(hostAfter2));
  ok(!/error/i.test(hostAfter2.status || ''), `the host's pick reported no error (status: ${hostAfter2.status})`);
  ok((await liveCores(A)) === 1, 'the host is still running exactly one core after the pick');
  ok(await waitFor(B, () => /bomberman/i.test(window.__net.objectState('tv')?.file || ''), 30000),
    "M1.4d: the watcher sees the room `tv` key follow the host's picked ROM");
  const adv2 = await pictureAdvances(B);
  ok(adv2.ok, `the watcher's picture advances after the pick (${JSON.stringify(adv2)})`);
  const corr2 = await watcherMatchesHost(A, B);
  ok(corr2 != null && corr2 > 0.5,
    `M1.4d: the watcher's pixels ARE the host's newly-picked game (corr=${corr2?.toFixed(3)})`);
  ok((await liveCores(B)) === 0, 'the watcher still runs no core of its own');

  // --- phase 3: host picks ANOTHER .nes — bootOnPrimary's SAME-core branch ----
  // Both are nestopia now, so no runtime swap happens: the canvas (and therefore the
  // capture) is untouched and the picture never freezes. What was broken here is the
  // OTHER half of M1.4d — the room's `tv` key silently kept naming the previous game,
  // so a late joiner's Now Playing was wrong and a host migration booted the wrong ROM.
  console.log('\nphase 3: host picks lwx-nes-gallery.nes via the real #rom-input (same core: nestopia → nestopia)');
  await pickWithRealInput(A, PICK_SAME_CORE);
  await sleep(8000);
  const hostAfter3 = await A.evaluate(() => ({
    status: document.getElementById('status')?.textContent || null,
    cores: (window.__rack?.live?.() || []).map((r) => `${r.id}:${r.core}${r.live ? '' : '(paused)'}`),
  }));
  console.log('  host after same-core pick →', JSON.stringify(hostAfter3));
  ok(!/error/i.test(hostAfter3.status || ''), `the same-core pick reported no error (status: ${hostAfter3.status})`);
  ok(await waitFor(B, () => /gallery/i.test(window.__net.objectState('tv')?.file || ''), 30000),
    'M1.4d: the room `tv` key follows a SAME-core pick too (no runtime swap involved)');
  const corr3 = await watcherMatchesHost(A, B);
  ok(corr3 != null && corr3 > 0.5,
    `the watcher's pixels track the host across the same-core pick (corr=${corr3?.toFixed(3)})`);
  ok((await liveCores(B)) === 0, 'the watcher still runs no core of its own');

  // --- phase 4: host picks a .gb with the REAL picker (cross-core swap) -------
  // Cross-core ⇒ bootOnPrimary live-swaps to a FRESH runtime and a FRESH canvas.
  // The retired canvas' captureStream track stays 'live' while painting nothing, so
  // without a startVideoBroadcast() re-capture the watcher freezes here forever.
  console.log('\nphase 4: host picks lwx-gb-snake.gb via the real #rom-input (cross-core: nestopia → gambatte)');
  const beforeDims = await hostVideo(B);
  await pickWithRealInput(A, PICK_CROSS_CORE_2);
  ok(await waitFor(A, () => (window.__rack.live() || []).some((r) => r.core === 'gambatte' && r.live), 60000),
    'the host swapped to a fresh gambatte runtime');
  ok(await waitFor(B, () => /gb-snake/i.test(window.__net.objectState('tv')?.file || ''), 30000),
    'M1.4d: the watcher sees the room `tv` key follow the cross-core pick');
  ok(await waitFor(A, () => window.__net.video.sendingCount() >= 1, 20000),
    'the host is still sending video after the swap');
  // The host must now be capturing the canvas that is actually being drawn.
  const hostCap = await A.evaluate(() => ({
    source: window.__net?.video?.sourceCanvas?.() ?? null,
    tvs: (window.__rack?.tvs?.() || []).map((t) => ({ id: t.id, source: t.source, video: t.video })),
    live: (window.__rack?.live?.() || []).filter((r) => r.live).map((r) => `${r.id}:${r.core}`),
    tracks: window.__net?.video?.sourceTracks?.() ?? null,
  }));
  console.log('  host capture →', JSON.stringify(hostCap));
  ok(!!hostCap.source && (hostCap.tracks || []).some((t) => t === 'video:live'),
    `the host holds a live capture of a canvas (${hostCap.source} / ${JSON.stringify(hostCap.tracks)})`);
  // The capture must be the canvas the host's OWN TV is showing — i.e. the new
  // runtime's canvas, not the retired one.
  ok(hostCap.tvs.some((t) => t.source && t.source === hostCap.source),
    `the host captures the same canvas its TV is painting (${JSON.stringify(hostCap.tvs)})`);

  // THE assertion this whole file exists for: new frames, from the NEW game.
  const after = await pictureAdvances(B, 4000);
  ok(after.ok, `M1.4d: the watcher's picture ADVANCES across the host's cross-core pick (${JSON.stringify(after)})`);
  console.log(`  watcher video size: ${beforeDims?.w}x${beforeDims?.h} → ${after.w}x${after.h}`);
  // The decisive one: the watcher's pixels must be the game the host is running NOW.
  // A retired capture keeps decoding a stale picture, which correlates ~0 with the
  // host's fresh canvas — that was the whole M1.4d symptom.
  const afterCorr = await watcherMatchesHost(A, B, 8);
  ok(afterCorr != null && afterCorr > 0.5,
    `M1.4d: the watcher's TV pixels ARE the host's newly-picked game (corr=${afterCorr?.toFixed(3)})`);
  ok((await liveCores(B)) === 0, 'the watcher STILL runs no core of its own after the host\'s picks');
  ok((await liveCores(A)) === 1, 'exactly one core is running in the room, on the host');
  await shot(B, 'watcher-after-host-pick');
  await shot(A, 'host-after-pick');

  console.log('\n  host tv  ', JSON.stringify(await tvOf(A)));
  console.log('  watcher tv', JSON.stringify(await tvOf(B)));
} catch (e) {
  failed++;
  console.error('  FAIL harness error:', e?.stack || e);
} finally {
  for (const b of browsers) { try { await b.close(); } catch { /* ok */ } }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
