// T-X5 regression guard (Phase B, 2026-07-25 review): "cartridge-insert
// parity" — every core registered with execution:'worker' in systems.js
// (currently PSX/mednafen_psx_hw and N64/mupen64plus_next) must be reachable
// through the REAL VR cartridge-insert path, not just the desktop file-picker
// or a bypass test harness (P0-2). Before Phase B, loadCartridge() called
// client.start() directly with no worker-mode support at all, so a worker
// core inserted through handleCartridgeInserted (the exact function GrabMgr
// invokes when a physical cartridge snaps into a console slot) would throw
// or silently boot in the wrong mode.
//
// What this probe does, for EACH execution:'worker' core in systems.js:
//   1. Boots the real app against a real vite dev server (no bypass harness).
//   2. Caches known-good test content into OPFS via the same cacheRom() path
//      real local-ROM picks use (window.__rom.cacheRom).
//   3. Mints a REAL shelf cartridge for it via addLocalRomToShelf
//      (window.__addLocalRom) — this does NOT boot anything, it only places
//      the cartridge object, mirroring what happens when a cart is dropped
//      onto a shelf prop in-VR.
//   4. Inserts that shelf cartridge via window.__insertCartridge, which is a
//      thin passthrough to handleCartridgeInserted(meta) — the literal
//      onCartridgeInserted callback GrabMgr.js fires on a real physical
//      cart-slot interaction (src/GrabMgr.js:750, wired at main.js:2205).
//      Only the 3D grab/slot gesture is skipped (nothing headless can drive
//      real XR hand tracking); the boot logic executed is identical.
//   5. Asserts the primary RuntimeEmulatorClient (window.__client) ended up
//      with .mode === 'worker' and .ready === true, with no pageerror/worker
//      error along the way.
//
// Test content (both legally redistributable, already used by the existing
// probe:psx-core / probe:n64-core probes, no BIOS/firmware required by
// either):
//   PSX  scripts/cores/psx/test-content/psx-jit-smoke.exe  (raw PS-EXE, HLE-
//        boots without a BIOS — see test/psx-core-e2e/harness.js)
//   N64  public/roms/freeware/lwx-n64-smoke.z64             (CC0 libdragon ROM)
//
// Usage:
//   npm run probe:worker-cartridge-insert
//   node scripts/probe-worker-cartridge-insert.mjs
//
// Exit code: 0 = all assertions passed, 1 = at least one failed / setup error.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5194;
const BASE = `http://localhost:${PORT}/?experimental=1`;

const CASES = [
  {
    core: 'mednafen_psx_hw',
    system: 'psx',
    file: 'psx-jit-smoke.exe',
    title: 'PSX Worker Smoke',
    romPath: resolve(ROOT, 'scripts', 'cores', 'psx', 'test-content', 'psx-jit-smoke.exe'),
  },
  {
    core: 'mupen64plus_next',
    system: 'n64',
    file: 'lwx-n64-smoke.z64',
    title: 'N64 Worker Smoke',
    romPath: resolve(ROOT, 'public', 'roms', 'freeware', 'lwx-n64-smoke.z64'),
  },
];

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) {
  console.error('ERROR: no Chrome/Edge binary found');
  process.exit(1);
}

const missing = CASES.filter((c) => !existsSync(c.romPath));
if (missing.length) {
  console.error('ERROR: required test content missing:');
  for (const c of missing) console.error(`  ${c.romPath}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

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
  if (!(await waitForServer(`http://localhost:${PORT}/`))) throw new Error('vite dev server never came up');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
  });

  for (const testCase of CASES) {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    try {
      await page.goto(BASE, { waitUntil: 'load' });

      const ready = await page.waitForFunction(
        () => !!window.__client && typeof window.__rom?.cacheRom === 'function'
           && typeof window.__addLocalRom === 'function' && typeof window.__insertCartridge === 'function',
        { timeout: 30000 },
      ).then(() => true).catch(() => false);
      ok(`[${testCase.core}] app booted with cartridge-insert test hooks ready`, ready);
      if (!ready) throw new Error('app never finished initialising');

      const romB64 = readFileSync(testCase.romPath).toString('base64');

      // Step 1+2: cache the bytes (real OPFS path) and mint a REAL shelf
      // cartridge — no boot happens yet.
      const mint = await page.evaluate(async (b64, meta) => {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        try {
          const sha1 = await window.__rom.cacheRom(buf.buffer);
          if (!sha1) return { ok: false, reason: 'cacheRom returned no sha1 (OPFS unsupported?)' };
          const cart = await window.__addLocalRom({ ...meta, rom: { sha1, sources: ['opfs'] } });
          return { ok: true, sha1, hasCart: !!cart };
        } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
      }, romB64, { file: testCase.file, core: testCase.core, system: testCase.system, title: testCase.title });
      ok(`[${testCase.core}] shelf cartridge minted (addLocalRomToShelf, no boot)`, mint.ok && mint.hasCart, mint.reason || JSON.stringify(mint));
      if (!mint.ok) throw new Error(mint.reason || 'mint failed');

      // Step 3: insert it through the REAL insert path — the exact function
      // GrabMgr.js's onCartridgeInserted callback invokes on a real slot.
      const insert = await page.evaluate(async (meta, sha1) => {
        try {
          await window.__insertCartridge({ ...meta, rom: { sha1, sources: ['opfs'] } });
          return { ok: true };
        } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
      }, { file: testCase.file, core: testCase.core, system: testCase.system, title: testCase.title }, mint.sha1);
      ok(`[${testCase.core}] handleCartridgeInserted (real insert path) resolves without throwing`, insert.ok, insert.reason || '');

      // Give the worker time to actually boot the core (module fetch,
      // WASM instantiate, retro_load_game, first frames).
      const bootedToWorker = await page.waitForFunction(
        () => window.__client?.mode === 'worker' && window.__client?.ready === true,
        { timeout: 45000 },
      ).then(() => true).catch(() => false);
      const finalState = await page.evaluate(() => ({
        mode: window.__client?.mode ?? null,
        ready: !!window.__client?.ready,
      }));
      ok(`[${testCase.core}] client ended up in worker mode and ready`, bootedToWorker,
         `finalState=${JSON.stringify(finalState)}`);

      ok(`[${testCase.core}] NO pageerror during mint/insert/boot`, pageErrors.length === 0, JSON.stringify(pageErrors));
      const relevantConsoleErrors = consoleErrors.filter((m) =>
        !/^\[core\]/.test(m) && !/^Failed to load resource/.test(m));
      ok(`[${testCase.core}] NO console error during mint/insert/boot`, relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));
    } catch (e) {
      ok(`[${testCase.core}] case completed without a fatal harness error`, false, String(e?.message || e));
    } finally {
      await page.close().catch(() => {});
    }
  }
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
