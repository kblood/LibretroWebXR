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

const APP = 'http://localhost:5173/desktop.html';
const WS = 'ws://localhost:8799/';
const ROOM = `verify-${Date.now()}`;
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
  const t0 = await client.evaluate(() => document.querySelector('video.host-video').currentTime);
  await sleep(1000);
  const t1 = await client.evaluate(() => document.querySelector('video.host-video').currentTime);
  console.log(`Client video currentTime: ${t0.toFixed(2)} -> ${t1.toFixed(2)}`);
  ok(t1 > t0, 'client video is actively playing (currentTime advances)');
  await client.screenshot({ path: 'tmp/verify-desktop-client.png' });

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const b of browsers) await b.close();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  for (const b of browsers) await b.close().catch(() => {});
  process.exit(2);
});
