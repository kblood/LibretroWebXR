// COR-5 in a real browser: when a console is replaced, is the old one actually
// RELEASED — or does its worker (and its audio branch) live on for the session?
//
// scripts/test-runtime-dispose.mjs pins the logic against fakes. This drives the
// real app: spawn a rack console running a WORKER-execution core (N64, 256 MiB
// initial Wasm memory per public/cores/mupen64plus_next_libretro.build.json),
// then drop a different core's cartridge on it — the real cross-core swap path
// (loadCartridgeIntoConsole → swapConsoleCore → bootFreshRuntime) — and look at
// what became of the runtime that was replaced.
//
// WHAT THIS PROBE PROVES / DOES NOT PROVE
//   PROVES: the retired runtime is disposed, its worker is terminated and its
//           frame bridge released (so the core's Wasm memory is collectable),
//           and the console ends up with exactly ONE audio branch rather than
//           one per boot it has ever done.
//   DOES NOT PROVE: how many bytes the browser actually gave back. There is no
//           API that reports a terminated worker's heap, so "the Worker object
//           is gone and nothing references it" is the strongest observable
//           available from the page.
//
// VALIDATED BOTH WAYS on 2026-08-16 (mutation applied to the real tree, run,
// reverted):
//   * as shipped                                       → 14/14, exit 0
//   * the pre-COR-5 dispose restored (no client.stop(), no branch removal in
//     ConsoleRuntime.dispose, no pre-boot branch handover in bootFreshRuntime —
//     that handover is a detachBranch since PERF-2, see probe-swap-soak.mjs)
//                                                      → 10/14, with the retired
//     runtime reporting `oldWorker: true, oldFrameBridge: true, oldReady: true`
//     while flagged disposed, and the console holding TWO audio branches
//     (["console1","console1"]). That is the shipped leak, measured.
//
// Usage: node scripts/probe-runtime-release.mjs
// Exit code: 0 = all assertions passed. Needs real Chrome + a fetched N64 core;
// never part of `npm test`.

import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5198;
const BASE = `http://localhost:${PORT}/?experimental=1`;
const ROM = resolve(ROOT, 'public', 'roms', 'freeware', 'lwx-n64-scene.z64');
const META = { file: 'lwx-n64-scene.z64', core: 'mupen64plus_next', system: 'n64', title: 'Runtime Release Probe' };

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find(existsSync);

if (!CHROME) { console.error('ERROR: no Chrome binary found'); process.exit(1); }
if (!existsSync(ROM)) { console.error(`ERROR: test ROM not found at ${ROM}`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const romB64 = readFileSync(ROM).toString('base64');

if (await fetch(`http://localhost:${PORT}/`).then(() => true).catch(() => false)) {
  console.error(`ERROR: something is already listening on http://localhost:${PORT}/ — refusing to run.`);
  console.error('       Stop it by PID/port (pwsh scripts/kill-dev.ps1) — never blanket-kill node.');
  process.exit(1);
}

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

function killPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout || '';
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
    for (const pid of pids) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
  } catch (_) {}
}

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
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  const ready = await page.waitForFunction(
    () => typeof window.__rack?.spawn === 'function' && typeof window.__rack?.runtime === 'function'
       && typeof window.__rom?.cacheRom === 'function' && typeof window.__insertCartridge === 'function'
       && Array.isArray(window.__games),
    { timeout: 40000 },
  ).then(() => true).catch(() => false);
  ok('app booted with the rack hooks ready', ready);
  if (!ready) throw new Error('app never finished initialising');

  const mint = await page.evaluate(async (b64, meta) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const sha1 = await window.__rom.cacheRom(buf.buffer);
    if (!sha1) return { ok: false, reason: 'cacheRom returned no sha1' };
    await window.__addLocalRom({ ...meta, rom: { sha1, sources: ['opfs'] } });
    return { ok: true, sha1 };
  }, romB64, META);
  ok('shelf cartridge minted', mint.ok, mint.reason || '');
  if (!mint.ok) throw new Error(mint.reason);
  const gameMeta = { ...META, rom: { sha1: mint.sha1, sources: ['opfs'] } };

  // --- a rack console running a worker core ---------------------------------
  const spawned = await page.evaluate(async (meta) => {
    try { return { ok: true, id: await window.__rack.spawn('n64', { game: meta }) }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, gameMeta);
  ok('spawned a rack console on a worker-execution core', spawned.ok, spawned.reason || '');
  if (!spawned.ok) throw new Error(spawned.reason);
  const id = spawned.id;

  const before = await page.evaluate((consoleId) => {
    const rt = window.__rack.runtime(consoleId);
    window.__probeOldRuntime = rt;                    // keep the retired one reachable
    return {
      core: rt?.coreName,
      mode: rt?.client?.mode,
      hasWorker: !!rt?.client?.delegate?.worker,
      hasFrameBridge: !!rt?.client?.delegate?.frameBridge,
      branches: window.__rack.audio().filter((b) => b.console === consoleId).length,
    };
  }, id);
  ok('it is running a real worker with a frame bridge',
    before.mode === 'worker' && before.hasWorker && before.hasFrameBridge, JSON.stringify(before));
  ok('and has exactly one audio branch', before.branches === 1, JSON.stringify(before));

  // --- drop a DIFFERENT core's cartridge on it ------------------------------
  const nes = await page.evaluate(() => {
    const g = (window.__games || []).find((x) => x.system === 'nes');
    return g ? { ...g } : null;
  });
  ok('a second-core cartridge is available to swap in', !!nes, JSON.stringify(nes?.file));
  if (!nes) throw new Error('no NES game registered to swap with');

  await page.evaluate((meta, consoleId) => window.__insertCartridge({ ...meta, consoleId }), nes, id);
  // The secondary-console load is fire-and-forget (main.js's
  // handleCartridgeInserted does not await it), so wait for the runtime object
  // itself to be REPLACED rather than for the call to return.
  const replaced = await page.waitForFunction(
    (consoleId) => window.__rack.runtime(consoleId) && window.__rack.runtime(consoleId) !== window.__probeOldRuntime,
    { timeout: 90000 }, id,
  ).then(() => true).catch(() => false);
  ok('the cross-core swap built a FRESH runtime for that console', replaced);
  if (!replaced) throw new Error('the console was never rebuilt');
  await sleep(1500);   // let the async stop settle

  const after = await page.evaluate((consoleId) => {
    const old = window.__probeOldRuntime;
    const now = window.__rack.runtime(consoleId);
    return {
      oldDisposed: old?._disposed === true,
      oldWorker: !!old?.client?.delegate?.worker,
      oldFrameBridge: !!old?.client?.delegate?.frameBridge,
      oldReady: old?.client?.delegate?.ready === true,
      newCore: now?.coreName,
      newLive: now?.isLive?.() === true,
      branches: window.__rack.audio().filter((b) => b.console === consoleId).length,
      allBranches: window.__rack.audio().map((b) => b.console),
    };
  }, id);

  ok('the retired runtime is disposed', after.oldDisposed, JSON.stringify(after));
  ok('its Worker is terminated — the 256 MiB core memory can go', after.oldWorker === false, JSON.stringify(after));
  ok('its frame bridge is released', after.oldFrameBridge === false, JSON.stringify(after));
  ok('and it no longer claims to be ready', after.oldReady === false, JSON.stringify(after));
  ok('the console is running the new core', !!after.newCore && after.newCore !== 'mupen64plus_next', JSON.stringify(after.newCore));
  // The leak that was visible from the page: branches were append-only, so the
  // replacement's own branch was added next to the dead one, for ever.
  ok('the console has ONE audio branch, not one per boot', after.branches === 1, JSON.stringify(after.allBranches));

  ok('NO pageerror across the whole probe', pageErrors.length === 0, JSON.stringify(pageErrors));
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  vite.kill();
  try { process.kill(-vite.pid); } catch (_) {}
  killPort(PORT);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length && results.length ? 0 : 1);
