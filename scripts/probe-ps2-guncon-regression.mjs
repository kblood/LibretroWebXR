// Real-app PS2 regression guard (2026-07-26 spot-check, following the
// 2026-07-24 review's Phase A/B facade changes to RuntimeEmulatorClient.js /
// main.js / RetroArchConfig.js / runtime/*). Unlike PSX/N64, PS2's `play`
// core has NO `execution: 'worker'` in systems.js — it stays on the classic
// main-thread EmulatorClient delegate, routed through RuntimeEmulatorClient
// the same as every "classic" core. This probe exists because that facade
// (the exact thing P0-1 broke — sendLightgun/sendMouse forwarding silently
// went missing app-wide) is now shared by every core, PS2 included, and
// nothing in this repo previously verified PS2 through the REAL app flow —
// see docs/research/psx-ps2-n64-review-2026-07-24.md's PS2 testing-plan note:
// "the PS2 verification suite currently isn't in the repo at all" (the prior
// verification lived in gitignored tmp/verify-ps2-*.mjs scripts, never
// committed). This is the first committed, durable PS2 real-app probe.
//
// What it does, all through the real app (real vite dev server, real
// index.html, real main.js — no bypass harness, no direct WorkerEmulatorClient/
// EmulatorClient import):
//   1. Boots games/ps2-guncon-range (public/roms/freeware/lwx-ps2-guncon-range.elf,
//      registered in public/roms/manifest.json as `core:"play"`, `"lightgun":true`)
//      via window.__pickLocalRom — the same code path the real romInput
//      file-picker uses (mirrors scripts/probe-lightgun-regression.mjs).
//   2. Confirms RuntimeEmulatorClient ends up in 'main' mode (not 'worker' —
//      PS2 has no execution:'worker' in systems.js) and ready.
//   3. Renders a few real frames, then takes BOTH a real page.screenshot()
//      (CDP-level, composited pixels — works regardless of preserveDrawingBuffer,
//      per the "canvas readback reads back black" gotcha documented in
//      docs/PS2_CORE_BUILD.md) AND an in-page non-black pixel count computed by
//      drawing that same screenshot into an offscreen 2D canvas via Image/
//      drawImage/getImageData (avoids ever calling gl.readPixels directly).
//      Saved to tmp/probe-ps2-guncon-regression.png for visual review.
//   4. Arms the GunCon2 via the real in-app hook (window.__armGun — the exact
//      function the in-VR gun-grab handler calls), a LIVE reboot that
//      reconnects the gun on SYSTEMS.ps2.lightgun's port (0).
//   5. Fires the gun via window.__gunFire (injects a fake XR controller, runs
//      ONE real LightGunMgr.tick() — the exact per-frame path that calls
//      client.sendLightgun(...)), both on-screen and off-screen, mirroring
//      probe-lightgun-regression.mjs's two call sites.
//   6. Asserts NO pageerror / NO console error through the whole sequence —
//      the P0-1 regression signature is a bare "client.sendLightgun is not a
//      function" TypeError from this exact chain.
//
// Usage:
//   npm run probe:ps2-guncon
//   node scripts/probe-ps2-guncon-regression.mjs
//
// Exit code: 0 = all assertions passed, 1 = at least one failed / setup error.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5197;
const BASE = `http://localhost:${PORT}/`;
const ROM = resolve(ROOT, 'public', 'roms', 'freeware', 'lwx-ps2-guncon-range.elf');
const CORE_JS = resolve(ROOT, 'public', 'cores', 'play_libretro.js');
const CORE_WASM = resolve(ROOT, 'public', 'cores', 'play_libretro.wasm');
const SCREENSHOT_PATH = resolve(ROOT, 'tmp', 'probe-ps2-guncon-regression.png');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) {
  console.error('ERROR: no Chrome/Edge binary found');
  process.exit(1);
}
const missing = [ROM, CORE_JS, CORE_WASM].filter((p) => !existsSync(p));
if (missing.length) {
  console.error('ERROR: required build artifact(s) missing (public/cores/ is gitignored — fetch/build the play core first):');
  for (const p of missing) console.error(`  ${p}`);
  process.exit(2);
}
mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const romB64 = readFileSync(ROM).toString('base64');

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

let browser;
try {
  if (!(await waitForServer(BASE))) throw new Error('vite dev server never came up');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 1024, height: 768 });

  // The exact signal this probe exists to catch: an uncaught exception (the
  // P0-1-shaped TypeError) surfacing from the page during the gun call chain,
  // or a console 'error' logged as a result of one.
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(BASE, { waitUntil: 'load' });

  const ready = await page.waitForFunction(
    () => !!window.__client && typeof window.__pickLocalRom === 'function'
       && typeof window.__armGun === 'function' && typeof window.__gunArmedState === 'function'
       && typeof window.__gunFire === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with pick/gun-test hooks ready', ready);
  if (!ready) throw new Error('app never finished initialising');

  // --- Step 1: load games/ps2-guncon-range via the real pick path ---
  const boot = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    try { await window.__pickLocalRom('lwx-ps2-guncon-range.elf', buf.buffer); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, romB64);
  ok('games/ps2-guncon-range boots via the real pick path', boot.ok, boot.reason || '');
  if (!boot.ok) throw new Error(boot.reason || 'boot failed');

  // Give the "play" core real time: Jitter's Wasm JIT + Play!'s own boot
  // sequence take noticeably longer to reach steady rendering than the
  // 8/16-bit cores every other probe in this repo targets.
  const bootedReady = await page.waitForFunction(
    () => window.__client?.ready === true,
    { timeout: 45000 },
  ).then(() => true).catch(() => false);
  const finalState = await page.evaluate(() => ({
    mode: window.__client?.mode ?? null,
    ready: !!window.__client?.ready,
  }));
  ok('client ended up ready', bootedReady, `finalState=${JSON.stringify(finalState)}`);
  ok('client stayed on the main-thread delegate (PS2 has no execution:"worker")', finalState.mode === 'main',
     `mode=${finalState.mode}`);

  await sleep(4000); // let a real handful of GS frames render before capture

  // --- Step 2: visual evidence — real composited screenshot + non-black check ---
  const shot = await page.screenshot({ encoding: 'base64' }).catch((e) => { throw e; });
  writeFileSync(SCREENSHOT_PATH, Buffer.from(shot, 'base64'));
  const pixelStats = await page.evaluate((dataUrl) => new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nonBlack++;
      }
      res({ totalPixels: d.length / 4, nonBlack });
    };
    img.onerror = () => res({ totalPixels: 0, nonBlack: 0, error: true });
    img.src = 'data:image/png;base64,' + dataUrl;
  }), shot);
  ok('screenshot captured to tmp/probe-ps2-guncon-regression.png', existsSync(SCREENSHOT_PATH));
  // Loose threshold: the app chrome (menus, VR room geometry, TV bezel) is
  // already non-black on its own, so this only needs to rule out a fully
  // blank/black page — real per-content pixel-level verification (the actual
  // GS render surface) was already established in docs/PS2_CORE_BUILD.md via
  // dedicated diagnostic scripts; this is a coarse "did SOMETHING render"
  // regression guard for the real end-to-end app page.
  ok('captured frame is not entirely black (real content rendering)',
     pixelStats.nonBlack > pixelStats.totalPixels * 0.01,
     `nonBlack=${pixelStats.nonBlack}/${pixelStats.totalPixels}`);

  // --- Step 3: arm the GunCon2 via the real in-app hook (live reboot) ---
  const armRes = await page.evaluate(async () => {
    try { await window.__armGun(); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ok('__armGun() (the real gun-grab handler) resolves without throwing', armRes.ok, armRes.reason || '');
  await sleep(2500); // PS2 boot is slower than 8/16-bit cores; give the live reboot time

  const armState = await page.evaluate(() => window.__gunArmedState());
  ok('GunCon2 device is connected on the console after arming', armState.consoleArmed === true,
     `state=${JSON.stringify(armState)}`);
  ok('armed system is ps2', armState.system === 'ps2', `system=${armState.system}`);

  // --- Step 4: fire the gun through the REAL per-frame call chain ---
  // window.__gunFire injects a fake XR controller and runs ONE real
  // LightGunMgr.tick(), which calls client.sendLightgun(...) exactly like the
  // production render loop does — the exact chain P0-1 broke app-wide.
  const fireOnScreen = await page.evaluate(() => {
    try {
      const r = window.__gunFire({ x: 0, y: 1.2, z: -1 }, { x: 0, y: 1.2, z: -2 }, true);
      return { ok: true, result: r };
    } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ok('on-screen gun fire (trigger held) does not throw', fireOnScreen.ok, fireOnScreen.reason || `result=${fireOnScreen.result}`);

  const fireRelease = await page.evaluate(() => {
    try {
      const r = window.__gunFire({ x: 0, y: 1.2, z: -1 }, { x: 0, y: 1.2, z: -2 }, false);
      return { ok: true, result: r };
    } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ok('trigger release does not throw', fireRelease.ok, fireRelease.reason || `result=${fireRelease.result}`);

  const fireOffScreen = await page.evaluate(() => {
    try {
      // Way outside any TV geometry — the off-screen call path, the OTHER
      // call site to client.sendLightgun() (mirrors LightGunMgr.js's two
      // sendLightgun call sites, same as probe-lightgun-regression.mjs).
      const r = window.__gunFire({ x: 500, y: 500, z: 500 }, { x: 501, y: 500, z: 500 }, true);
      return { ok: true, result: r };
    } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ok('off-screen gun fire does not throw', fireOffScreen.ok, fireOffScreen.reason || `result=${fireOffScreen.result}`);
  await sleep(300);

  // --- Step 5: the actual regression assertions ---
  ok('NO pageerror during boot/arm/fire', pageErrors.length === 0, JSON.stringify(pageErrors));
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error during boot/arm/fire', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  vite.kill();
  try { process.kill(-vite.pid); } catch (_) {}
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length && results.length ? 0 : 1);
