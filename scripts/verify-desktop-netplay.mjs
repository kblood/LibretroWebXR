// REAL-GPU verification of the desktop-netplay build (desktop.html).
// Headless software-GL can't exercise canvas.captureStream() frame pixels
// (see the "Add flat-screen desktop build with 2-player netplay" commit), so
// this always launches two HEADED (visible, real-GPU) browser windows: one
// hosts a bundled game, the other joins the same room and should receive +
// render the host's WebRTC video stream with genuinely live frames.
//
// Prereqs (start first):
//   $env:PORT=8799; node server/room-server.mjs
//   npm run dev
// Then: npm run verify-desktop-netplay

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/desktop.html';
const WS = args.ws || 'ws://localhost:8799/';
const ROOM = args.room || `verify-${Date.now()}`;
const urlFor = () => `${APP}?server=${encodeURIComponent(WS)}`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

const LAUNCH_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--enable-features=SharedArrayBuffer',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--window-size=900,700',
];

const browsers = [];
async function openPeer(label) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, args: LAUNCH_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [${label}][console]`, m.text()); });
  page.on('pageerror', (e) => console.log(`  [${label}][pageerror]`, e.message));
  await page.goto(urlFor(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__desktop, { timeout: 15000 });
  return page;
}

(async () => {
  console.log(`Room: ${ROOM}`);
  const host = await openPeer('host');
  const client = await openPeer('client');

  // --- Both connect FIRST (real user flow: Join/Host before picking a game --
  // becomeHost() only broadcasts tv-state when `net` already exists). ---
  await host.evaluate((room) => { document.getElementById('mp-room').value = room; }, ROOM);
  await host.click('#mp-connect');
  await host.waitForFunction(() => window.__desktop.net?.connected, { timeout: 15000 });
  ok(true, 'host connected to the room server');

  await client.evaluate((room) => { document.getElementById('mp-room').value = room; }, ROOM);
  await client.click('#mp-connect');
  await client.waitForFunction(() => window.__desktop.net?.connected, { timeout: 15000 });
  ok(true, 'client connected to the room server');

  // --- Host: pick a fast-booting bundled game (NES) — this claims tv-state ---
  await host.waitForFunction(() => document.getElementById('game-select')?.options.length > 1, { timeout: 15000 });
  const gameTitle = await host.evaluate(() => {
    const sel = document.getElementById('game-select');
    const opts = [...sel.options];
    const idx = opts.findIndex((o) => /NES/i.test(o.textContent));
    sel.selectedIndex = idx >= 0 ? idx : 1;
    sel.dispatchEvent(new Event('change'));
    return sel.options[sel.selectedIndex].textContent;
  });
  console.log(`Host booting: ${gameTitle}`);
  await host.waitForFunction(() => window.__desktop.booted(), { timeout: 20000 });
  ok(true, 'host booted a bundled game locally');

  await host.waitForFunction(() => window.__desktop.role() === 'host', { timeout: 15000 }).catch(async () => {
    console.log('  [host] role:', await host.evaluate(() => window.__desktop.role()));
    throw new Error('host never claimed host role');
  });
  ok(true, 'host claimed host role after loading a game');

  // Let a few frames render before we sample pixels.
  await sleep(3000);
  const hostPixels = await host.evaluate(() => {
    const c = document.getElementById('emu');
    const tmp = document.createElement('canvas');
    tmp.width = c.width; tmp.height = c.height;
    tmp.getContext('2d').drawImage(c, 0, 0);
    const data = tmp.getContext('2d').getImageData(0, 0, tmp.width, tmp.height).data;
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] || data[i + 1] || data[i + 2]) nonBlack++;
    }
    return { w: c.width, h: c.height, nonBlack, total: data.length / 4 };
  });
  console.log(`Host canvas: ${hostPixels.w}x${hostPixels.h}, ${hostPixels.nonBlack}/${hostPixels.total} non-black px`);
  ok(hostPixels.nonBlack > 0, 'host canvas has real rendered (non-black) pixels');
  await host.screenshot({ path: 'tmp/verify-desktop-host.png' });

  await client.waitForFunction(() => window.__desktop.role() === 'client', { timeout: 20000 }).catch(async () => {
    console.log('  [client] role:', await client.evaluate(() => window.__desktop.role()));
    throw new Error('client never resolved to client role');
  });
  ok(true, 'client resolved to client role (tv-state sync worked)');

  // --- Client should receive a real WebRTC video track and paint it ---
  await client.waitForFunction(() => {
    const v = document.querySelector('video.host-video');
    return v && v.readyState >= 2 && v.videoWidth > 0;
  }, { timeout: 20000 });
  const videoInfo = await client.evaluate(() => {
    const v = document.querySelector('video.host-video');
    return { w: v.videoWidth, h: v.videoHeight, readyState: v.readyState, paused: v.paused };
  });
  console.log(`Client host-video: ${videoInfo.w}x${videoInfo.h} readyState=${videoInfo.readyState} paused=${videoInfo.paused}`);
  ok(videoInfo.w > 0 && videoInfo.h > 0, 'client received a real WebRTC video track with nonzero dimensions');

  // Confirm the video is actually advancing (real frames, not a frozen first frame).
  // DECODED FRAMES, not just currentTime: an audio-only stream ticks currentTime
  // forever with no picture at all, which is how a real freeze hid here once.
  const quality = () => client.evaluate(() => {
    const v = document.querySelector('video.host-video');
    let frames = null;
    try { frames = v.getVideoPlaybackQuality?.()?.totalVideoFrames ?? null; } catch { /* ok */ }
    return { time: v.currentTime, frames, w: v.videoWidth };
  });
  const q0 = await quality();
  await sleep(1500);
  const q1 = await quality();
  console.log(`Client video: t ${q0.time.toFixed(2)} -> ${q1.time.toFixed(2)}, frames ${q0.frames} -> ${q1.frames}`);
  ok(q1.time > q0.time, 'client video is actively playing (currentTime advances)');
  ok(q1.w > 0 && (q1.frames == null || q1.frames > q0.frames),
    'client video is DECODING new frames (not a frozen or audio-only stream)');

  // The host's game AUDIO rides the same peer connection since M1.4 — before that a
  // joined client watched a completely mute picture.
  const audio = await client.evaluate(() => ({
    receivingAudio: window.__desktop.net_debug()?.video?.receivingAudio?.() ?? null,
    remote: window.__desktop.audio?.hasRemote?.() ?? null,
  }));
  console.log('Client audio:', JSON.stringify(audio));
  ok(audio.receivingAudio === true, 'client receives the host GAME AUDIO track');
  ok(audio.remote === true, "the client is playing the host's audio through its own graph");
  await client.screenshot({ path: 'tmp/verify-desktop-client.png' });

  // --- M1.4 display-only latch: a peer that booted its OWN game before joining --
  // Up to here the client never booted anything, so "the client isn't emulating"
  // was trivially true. The real reported failure is the OTHER order: play solo,
  // THEN join — and then that the latch RELEASES again on promotion (a stuck latch
  // would leave a promoted peer frozen, which is worse than the original bug).
  // See src/desktop/main.js's displayOnlyLatch.
  console.log('\n--- display-only latch (solo boot → join → promotion) ---');
  await client.evaluate(() => document.getElementById('mp-connect').click());   // leave
  await client.waitForFunction(() => !window.__desktop.net, { timeout: 10000 });
  await client.evaluate(() => {
    const sel = document.getElementById('game-select');
    const opts = [...sel.options];
    const idx = opts.findIndex((o) => /NES/i.test(o.textContent));
    sel.selectedIndex = idx >= 0 ? idx : 1;
    sel.dispatchEvent(new Event('change'));
  });
  await client.waitForFunction(() => window.__desktop.booted(), { timeout: 30000 });
  await sleep(2500);
  ok(await client.evaluate(() => window.__desktop.mayRun() && !window.__desktop.paused()),
    'solo: the ex-client boots and runs its own game (positive control)');

  await client.evaluate((room) => { document.getElementById('mp-room').value = room; }, ROOM);
  await client.click('#mp-connect');
  await client.waitForFunction(() => window.__desktop.role() === 'client', { timeout: 20000 });
  await sleep(2000);
  const watching = await client.evaluate(() => ({ mayRun: window.__desktop.mayRun(), paused: window.__desktop.paused() }));
  ok(watching.mayRun === false, 'joined: mayRunLocalCore() false (display-only)');
  ok(watching.paused === true, 'joined: our own core is STOPPED, not running behind the feed');

  // The host leaves for good. The server holds the room hostless for its reclaim
  // window (HOST_RECLAIM_MS) and only then promotes the senior remaining peer —
  // our watcher. Assert BOTH halves: nothing resumes during the hostless window,
  // and the latch does release on the actual promotion.
  const hostBrowser = browsers.splice(browsers.indexOf(host.browser()), 1)[0];
  await hostBrowser.close();
  await sleep(4000);                             // inside the reclaim window
  const hostless = await client.evaluate(() => ({
    role: window.__desktop.role(), hostId: window.__desktop.net?.hostId() ?? null,
    mayRun: window.__desktop.mayRun(), paused: window.__desktop.paused(),
  }));
  console.log(`  client mid-reclaim-window: ${JSON.stringify(hostless)}`);
  ok(hostless.mayRun === false && hostless.paused === true,
    'reclaim window: the watcher stays stopped instead of resuming its own copy');

  await client.waitForFunction(() => window.__desktop.role() === 'host', { timeout: 60000, polling: 1000 });
  await sleep(3000);
  const promoted = await client.evaluate(() => ({ mayRun: window.__desktop.mayRun(), paused: window.__desktop.paused() }));
  console.log(`  client after promotion: ${JSON.stringify(promoted)}`);
  ok(promoted.mayRun === true, 'promoted: the latch released');
  ok(promoted.paused === false, 'promoted: our core actually runs again (no stuck pause)');

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const b of browsers) await b.close();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  for (const b of browsers) await b.close().catch(() => {});
  process.exit(2);
});
