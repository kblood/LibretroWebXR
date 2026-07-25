// T-X4 regression guard (Phase B, 2026-07-25 review): "mode-switch guard" —
// before Phase B, RuntimeEmulatorClient.start() permanently dead-ended the
// instant a second core with a different execution topology (main-thread vs.
// dedicated worker) was booted on the same facade: it threw a generic Error
// with no recovery, and nothing in the app ever caught it, so switching from
// a main-thread core (e.g. any classic system) to a worker core (PSX/N64) —
// or back — left the page stuck (P0-3).
//
// The chosen fix (see RuntimeModeSwitchError's doc comment in
// src/RuntimeEmulatorClient.js and bootOnPrimary in src/main.js) reuses the
// pre-existing bootFreshRuntime/rebindPrimaryClient live-reboot mechanism
// (already proven for light-gun/mouse arm-reboots and secondary-console core
// swaps): a cross-core load builds a FRESH canvas + FRESH RuntimeEmulatorClient
// instead of ever asking the old one to switch modes in place, so the
// mode-mismatch throw is architecturally avoided on every real call site
// rather than merely caught after the fact.
//
// This probe drives that exact real sequence through the real app (real
// pick path, no bypass harness):
//   1. Boot a main-thread core (NES / lwx-nes-pong.nes).
//   2. Boot a worker core (PSX / psx-jit-smoke.exe) on the SAME page —
//      this is the cross-core swap that used to dead-end.
//   3. Boot the main-thread core again — switching back.
// At each step it asserts: no pageerror/console error, the client actually
// reflects the new core's mode (RuntimeEmulatorClient facade persists across
// swaps — main.js's `client` binding is repointed via rebindPrimaryClient,
// but window.__client always tracks the CURRENT live client), and ready
// becomes true. This is the direct regression guard for P0-3 / B2.
//
// Usage:
//   npm run probe:mode-switch
//   node scripts/probe-mode-switch.mjs
//
// Exit code: 0 = all assertions passed, 1 = at least one failed / setup error.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5195;
const BASE = `http://localhost:${PORT}/?experimental=1`;

const NES_ROM = resolve(ROOT, 'public', 'roms', 'freeware', 'lwx-nes-pong.nes');
const PSX_ROM = resolve(ROOT, 'scripts', 'cores', 'psx', 'test-content', 'psx-jit-smoke.exe');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) {
  console.error('ERROR: no Chrome/Edge binary found');
  process.exit(1);
}
for (const p of [NES_ROM, PSX_ROM]) {
  if (!existsSync(p)) {
    console.error(`ERROR: required test content missing: ${p}`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const nesB64 = readFileSync(NES_ROM).toString('base64');
const psxB64 = readFileSync(PSX_ROM).toString('base64');

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

// Drives window.__pickLocalRom (the real ROM-boot logic shared with the
// desktop file-picker — see main.js's romInput change handler, which calls
// the exact same buildStartOptions/bootOnPrimary chain) for one ROM with an
// EXPLICIT core, and waits for the client to report the expected execution
// mode + ready.
//
// Uses { core, system } opts to bypass filename-based auto-detection:
// `.exe` is claimed by TWO registered cores (DOS's virtualxt AND PSX's
// mednafen_psx_hw) and AMBIGUOUS_EXT_DEFAULT (systems.js) resolves that
// collision to virtualxt by default — correct for real DOS .exe files, but
// wrong for this probe's PSX smoke content, which is a raw PS-EXE that only
// carries a `.exe` name because that's what mednafen_psx_hw's own exts list
// (and the existing probe:psx-core harness) already uses it as.
//
// Deliberately stays on __pickLocalRom (not window.__insertCartridge /
// handleCartridgeInserted, used by scripts/probe-worker-cartridge-insert.mjs's
// T-X5 probe) for THIS probe's cross-core steps: handleCartridgeInserted's
// cross-core branch does a full page reload (pre-existing, untouched
// behaviour — see PENDING_KEY in main.js), which is a real and working
// recovery path but not what T-X4 is targeting here. This probe instead
// targets bootOnPrimary's live fresh-canvas swap (B2's actual fix for the
// mode-switch dead end) by staying on one page across all three steps,
// mirroring how __pickLocalRom (and the real romInput file-picker handler)
// already behave.
//
// Returns diagnostic state so callers can assert on it, rather than
// throwing, so one failed step doesn't abort the remaining steps in this
// probe (we want to see the FULL sequence, e.g. confirm switching back also
// survives even if the forward switch broke).
async function pickAndWait(page, meta, b64, expectedMode, timeoutMs = 45000) {
  const pick = await page.evaluate(async (m, b) => {
    const bin = atob(b);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    try { await window.__pickLocalRom(m.file, buf.buffer, { core: m.core, system: m.system }); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e), name: e?.name || null }; }
  }, meta, b64);
  if (!pick.ok) return { pickOk: false, pick, mode: null, ready: false };

  const settled = await page.waitForFunction(
    (mode) => window.__client?.mode === mode && window.__client?.ready === true,
    { timeout: timeoutMs },
    expectedMode,
  ).then(() => true).catch(() => false);
  const state = await page.evaluate(() => ({ mode: window.__client?.mode ?? null, ready: !!window.__client?.ready }));
  return { pickOk: true, pick, settled, mode: state.mode, ready: state.ready };
}

let browser;
try {
  if (!(await waitForServer(`http://localhost:${PORT}/`))) throw new Error('vite dev server never came up');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(BASE, { waitUntil: 'load' });
  const readyHooks = await page.waitForFunction(
    () => !!window.__client && typeof window.__pickLocalRom === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with pick-test hooks ready', readyHooks);
  if (!readyHooks) throw new Error('app never finished initialising');

  const nesMeta = { file: 'lwx-nes-pong.nes', core: 'nestopia', system: 'nes', title: 'NES Mode-Switch Guard' };
  const psxMeta = { file: 'psx-jit-smoke.exe', core: 'mednafen_psx_hw', system: 'psx', title: 'PSX Mode-Switch Guard' };

  // --- Step 1: boot a main-thread core (NES) ---
  const step1 = await pickAndWait(page, nesMeta, nesB64, 'main');
  ok('step 1: NES (main-thread) insert does not throw', step1.pickOk, step1.pick?.reason || '');
  ok('step 1: client ends up mode=main, ready=true', step1.settled,
     `mode=${step1.mode} ready=${step1.ready}`);
  const clientAfterStep1 = await page.evaluate(() => !!window.__client);

  // --- Step 2: switch to a worker core (PSX) on the same page ---
  // This is the exact sequence that pre-Phase-B threw RuntimeModeSwitchError's
  // predecessor (a bare unrecoverable Error) with no caller ever handling it.
  const step2 = await pickAndWait(page, psxMeta, psxB64, 'worker');
  ok('step 2: PSX (worker) insert does not throw (no dead end switching main->worker)', step2.pickOk, step2.pick?.reason || '');
  ok('step 2: client ends up mode=worker, ready=true', step2.settled,
     `mode=${step2.mode} ready=${step2.ready}`);
  // MODE_SWITCH_REQUIRED escaping to here (uncaught by any real call site)
  // would be exactly the P0-3 regression signature — explicit named check so
  // a future regression fails loudly instead of just timing out above.
  ok('step 2: no RuntimeModeSwitchError (MODE_SWITCH_REQUIRED) surfaced', step2.pick?.name !== 'RuntimeModeSwitchError');

  // --- Step 3: switch back to the main-thread core ---
  const step3 = await pickAndWait(page, nesMeta, nesB64, 'main');
  ok('step 3: switching back to NES (main-thread) does not throw', step3.pickOk, step3.pick?.reason || '');
  ok('step 3: client ends up mode=main, ready=true again', step3.settled,
     `mode=${step3.mode} ready=${step3.ready}`);
  ok('step 3: no RuntimeModeSwitchError (MODE_SWITCH_REQUIRED) surfaced', step3.pick?.name !== 'RuntimeModeSwitchError');

  await sleep(300);
  ok('NO pageerror across the whole main->worker->main sequence', pageErrors.length === 0, JSON.stringify(pageErrors));
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error across the whole main->worker->main sequence', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));

  console.log(`\ndiagnostic: window.__client present after step 1 = ${clientAfterStep1}`);
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
