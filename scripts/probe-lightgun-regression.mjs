// Permanent CI-style regression guard for P0-1 (2026-07-24 review):
// RuntimeEmulatorClient — the facade that replaced EmulatorClient app-wide
// when worker-execution cores were added — silently stopped forwarding
// sendLightgun/sendMouse. Every gun/mouse call site (LightGunMgr.js:126/132,
// MouseMgr.js, main.js) throws the instant a gun/mouse fires. This slipped
// through because every existing gun/mouse test stubs the client instead of
// driving a real one — see scripts/test-runtime-facade.mjs for the unit-level
// guard and this script for the real end-to-end one.
//
// Unlike the tmp/verify-*.mjs de-risk scripts this generalises (which are
// gitignored, throwaway, and use extensive pixel analysis to prove real HIT/
// MISS scoring), this script boots the REAL app (real dev server, real
// index.html, real main.js — no bypass harness) and only needs to prove the
// gun call chain doesn't throw. It's intentionally narrow so it stays cheap
// and durable as a permanent `npm run probe:lightgun` regression gate.
//
// What it does:
//   1. Boots the real app against a real vite dev server.
//   2. Loads games/nes-gallery (public/roms/freeware/lwx-nes-gallery.nes) — a
//      small, shipping, CC0 NES light-gun title — via the real pick path
//      (window.__pickLocalRom, the same code the romInput file-picker uses).
//   3. Arms the light gun via the real in-app hook (window.__armGun — the
//      exact function the in-VR gun-grab handler calls) — a LIVE reboot that
//      reconnects the NES Zapper on the console's port.
//   4. Fires the gun via __testApi.gun.fire(), which injects a fake XR controller
//      and runs ONE real LightGunMgr.tick() — the exact per-frame path
//      (LightGunMgr.js:126/132) that calls client.sendLightgun(...). Fires
//      both an on-screen shot and an off-screen (reload) shot, since P0-1
//      broke both call sites.
//   5. Asserts NO 'pageerror' event and NO console 'error' message occurred
//      during arm+fire — the actual regression signature is a bare
//      "client.sendLightgun is not a function" TypeError thrown from this
//      exact chain.
//
// Usage:
//   npm run probe:lightgun
//   node scripts/probe-lightgun-regression.mjs [url]
//   url defaults to spawning its own dev server on a dedicated port.
//
// Exit code: 0 = all assertions passed, 1 = at least one failed / setup error.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5193;
const BASE = `http://localhost:${PORT}/`;
const ROM = resolve(ROOT, 'public', 'roms', 'freeware', 'lwx-nes-gallery.nes');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) {
  console.error('ERROR: no Chrome/Edge binary found');
  process.exit(1);
}
if (!existsSync(ROM)) {
  console.error(`ERROR: test ROM not found at ${ROM}`);
  process.exit(1);
}

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
  page.setDefaultTimeout(40000);

  // The exact signal this probe exists to catch: an uncaught exception (the
  // P0-1 TypeError) surfacing from the page during the gun call chain, or a
  // console 'error' logged as a result of one.
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
       && typeof window.__testApi?.gun?.fire === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with gun-test hooks ready', ready);
  if (!ready) throw new Error('app never finished initialising');

  // --- Step 1: load the gallery via the real pick path (no gun connected yet) ---
  const boot = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    try { await window.__pickLocalRom('lwx-nes-gallery.nes', buf.buffer); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, romB64);
  ok('games/nes-gallery boots via the real pick path', boot.ok, boot.reason || '');
  await sleep(1200);

  // --- Step 2: arm the light gun via the real in-app hook (live reboot) ---
  const armRes = await page.evaluate(async () => {
    try { await window.__armGun(); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ok('__armGun() (the real gun-grab handler) resolves without throwing', armRes.ok, armRes.reason || '');
  await sleep(1800);

  const armState = await page.evaluate(() => window.__gunArmedState());
  ok('gun device is connected on the console after arming', armState.consoleArmed === true,
     `state=${JSON.stringify(armState)}`);

  // --- Step 3: fire the gun through the REAL per-frame call chain ---
  // __testApi.gun.fire() injects a fake XR controller and runs ONE real
  // LightGunMgr.tick(), which calls client.sendLightgun(...) exactly like the
  // production render loop does (scene.addTickCallback in main.js).
  const fireOnScreen = await page.evaluate(async () => {
    try {
      const r = await window.__testApi.gun.fire({ pos: { x: 0, y: 1.2, z: -1 }, look: { x: 0, y: 1.2, z: -2 }, trigger: true });
      return { ok: true, result: r };
    } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ok('on-screen gun fire (trigger held) does not throw', fireOnScreen.ok, fireOnScreen.reason || `result=${JSON.stringify(fireOnScreen.result)}`);

  const fireRelease = await page.evaluate(async () => {
    try {
      const r = await window.__testApi.gun.fire({ pos: { x: 0, y: 1.2, z: -1 }, look: { x: 0, y: 1.2, z: -2 }, trigger: false });
      return { ok: true, result: r };
    } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ok('trigger release does not throw', fireRelease.ok, fireRelease.reason || `result=${JSON.stringify(fireRelease.result)}`);

  const fireOffScreen = await page.evaluate(async () => {
    try {
      // Way outside any TV geometry — the off-screen/reload call site
      // (LightGunMgr.js:132), the OTHER call to client.sendLightgun().
      const r = await window.__testApi.gun.fire({ pos: { x: 500, y: 500, z: 500 }, look: { x: 501, y: 500, z: 500 }, trigger: true });
      return { ok: true, result: r };
    } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ok('off-screen (reload) gun fire does not throw', fireOffScreen.ok, fireOffScreen.reason || `result=${JSON.stringify(fireOffScreen.result)}`);
  await sleep(300);

  // --- Step 4: the actual regression assertions ---
  ok('NO pageerror during boot/arm/fire', pageErrors.length === 0, JSON.stringify(pageErrors));
  // Filter out browser-level resource-load noise (missing box-art thumbnails
  // etc. — real in a dev checkout without every asset, unrelated to the P0-1
  // regression) and core stderr passthrough. What we actually care about is a
  // real JS exception surfacing as a console error (e.g. the P0-1
  // "sendLightgun is not a function" TypeError, if something upstream ever
  // starts swallowing it into a console.error instead of an uncaught throw).
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error during boot/arm/fire', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));

  await page.screenshot({ path: resolve(__dirname, '..', 'tmp', 'probe-lightgun-regression.png') }).catch(() => {});
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
