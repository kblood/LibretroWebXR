// PERF-2 (CODEX_REVIEW): repeated core swaps must not accumulate resources —
// including swaps that FAIL. This is the soak test that finding asks for, and it
// only became meaningful once COR-5 gave a retired console a real release path.
//
// Two sections, both against the real app:
//
//   A — SUCCESSFUL SWAPS. Boot a worker-execution core (N64, 256 MiB initial
//       Wasm memory) on a rack console, then swap that console back and forth
//       with a main-thread core, N times. After every swap the page-level
//       counters (canvases, audio branches, live runtimes, TVs) must equal what
//       they were after the FIRST one — they may track how many consoles exist,
//       never how many boots the session has done. Every retired runtime is kept
//       reachable and re-checked at the end: each must have a terminated worker.
//
//   B — FAILED SWAPS. The same console, with the worker client's start() patched
//       to reject. Each attempt builds a fresh runtime (canvas, client, audio
//       branch) and then throws mid-boot. The counters must come back to where
//       they started, and the console must still be running what it was running
//       before — a failed boot may not half-swap the rack.
//
// WHAT THIS PROBE PROVES / DOES NOT PROVE
//   PROVES: no unbounded growth in the resources a page can actually count, and
//           that every retired worker was terminated.
//   DOES NOT PROVE: how much memory the browser gave back. Wasm heaps of
//           terminated workers are not observable from the page; usedJSHeapSize
//           is reported as INFO only (it is main-thread-only and GC-timing
//           dependent, so gating on it would be a flake, not a measurement).
//   DELIBERATELY AVOIDED: a 20-swap soak between two MAIN-THREAD cores. Those
//           cannot be unloaded at all (they pin a WebGL context past callMain —
//           see ConsoleRuntime's header), so such a run would measure a known,
//           documented platform limitation rather than this fix. Section A does
//           one main-thread core per cycle, which is the shipped usage pattern.
//
// WHAT IT FOUND. Section B failed on its first run against the then-current
// tree, twice over, and both were real:
//   • a swap whose boot FAILED left the still-running console permanently
//     silent — its audio branch had been handed to the replacement before the
//     replacement existed (1 → 0 branches over four failed boots);
//   • every failed boot ended in an uncaught "execution worker is not running",
//     from dispose() pausing a client whose worker it had just torn down.
// Fixed in SpatialAudio (detach/reattach + token-exact removal), ConsoleRuntime
// (record the branch token on the boot ATTEMPT; settle pause/resume) and
// WorkerEmulatorClient (pausing a stopped client resolves).
//
// VALIDATED BOTH WAYS on 2026-08-16 (mutation applied to the real tree, run,
// reverted):
//   * as shipped                                        → 22/22, exit 0
//   * MA, the whole COR-5 release path reverted (dispose = bare pause + canvas
//     detach, nothing touching branches)                → 19/22: audio branches
//     climb one per main-thread boot (2 → 4), the drift check names the cycle
//     it first grew in, and no retired worker is terminated.
//   * MB, only the PERF-2 failed-boot half reverted (incumbent's branch removed
//     rather than detached, never handed back; dispose passing a null token;
//     pause() rejecting on a dead worker) → 20/22: exactly the two failures
//     above, reproduced verbatim.
//
// Usage: node scripts/probe-swap-soak.mjs [--cycles=2]
// Exit code: 0 = all assertions passed. Needs real Chrome + a fetched N64 core;
// never part of `npm test`.

import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const PORT = 5199;
const BASE = `http://localhost:${PORT}/?experimental=1`;
const CYCLES = Number(args.cycles || 2);          // each cycle = 2 swaps (worker → main → worker)
const FAILED_ATTEMPTS = 4;
const ROM = resolve(ROOT, 'public', 'roms', 'freeware', 'lwx-n64-scene.z64');
const META = { file: 'lwx-n64-scene.z64', core: 'mupen64plus_next', system: 'n64', title: 'Swap Soak Probe' };

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
const info = (name, extra = '') => console.log(`INFO  ${name}${extra ? '  — ' + extra : ''}`);

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
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox', '--use-gl=swiftshader', '--js-flags=--expose-gc'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  const ready = await page.waitForFunction(
    () => typeof window.__rack?.spawn === 'function' && typeof window.__rack?.resources === 'function'
       && typeof window.__rom?.cacheRom === 'function' && Array.isArray(window.__games),
    { timeout: 40000 },
  ).then(() => true).catch(() => false);
  ok('app booted with the rack + resource hooks ready', ready);
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
  const workerGame = { ...META, rom: { sha1: mint.sha1, sources: ['opfs'] } };

  const mainGame = await page.evaluate(() => {
    const g = (window.__games || []).find((x) => x.system === 'nes');
    return g ? { ...g } : null;
  });
  ok('a main-thread cartridge is available to alternate with', !!mainGame, JSON.stringify(mainGame?.file));
  if (!mainGame) throw new Error('no NES game registered');

  const spawned = await page.evaluate(async (meta) => {
    try { return { ok: true, id: await window.__rack.spawn('n64', { game: meta }) }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, workerGame);
  ok('spawned the rack console under test', spawned.ok, spawned.reason || '');
  if (!spawned.ok) throw new Error(spawned.reason);
  const id = spawned.id;

  // Every runtime this console has ever had, kept reachable so each can be
  // re-examined after the soak.
  await page.evaluate((consoleId) => {
    window.__soakRetired = [];
    window.__soakCurrent = window.__rack.runtime(consoleId);
  }, id);

  const swapTo = async (meta) => {
    await page.evaluate((m, consoleId) => {
      window.__soakCurrent = window.__rack.runtime(consoleId);
      try { window.__insertCartridge({ ...m, consoleId }); } catch (_) {}
    }, meta, id);
    const done = await page.waitForFunction(
      (consoleId) => {
        const now = window.__rack.runtime(consoleId);
        return now && now !== window.__soakCurrent && now.isLoaded?.();
      },
      { timeout: 120000 }, id,
    ).then(() => true).catch(() => false);
    if (done) await page.evaluate(() => { window.__soakRetired.push(window.__soakCurrent); });
    await sleep(1200);                     // let the async stop settle
    return done;
  };

  // --- A. successful swaps ---------------------------------------------------
  ok(`swap 1 (worker → main-thread) completed`, await swapTo(mainGame, 'main'));
  const baseline = await page.evaluate(() => window.__rack.resources());
  info('resources after the first swap', JSON.stringify(baseline));

  let drift = null;
  let swaps = 1;
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    if (!(await swapTo(workerGame, 'worker'))) { ok(`swap ${++swaps} (→ worker) completed`, false); break; }
    ok(`swap ${++swaps} (→ worker) completed`, true);
    if (!(await swapTo(mainGame, 'main'))) { ok(`swap ${++swaps} (→ main-thread) completed`, false); break; }
    ok(`swap ${++swaps} (→ main-thread) completed`, true);
    const now = await page.evaluate(() => window.__rack.resources());
    const grew = ['runtimes', 'canvases', 'audioBranches', 'tvs'].filter((k) => now[k] > baseline[k]);
    if (grew.length && !drift) drift = { cycle, now, grew };
  }

  const final = await page.evaluate(() => window.__rack.resources());
  ok('live runtimes did not grow across the swaps', final.runtimes === baseline.runtimes,
    `${baseline.runtimes} → ${final.runtimes}`);
  ok('canvases did not grow across the swaps', final.canvases === baseline.canvases,
    `${baseline.canvases} → ${final.canvases}`);
  ok('audio branches did not grow across the swaps', final.audioBranches === baseline.audioBranches,
    `${baseline.audioBranches} → ${final.audioBranches} (append-only branches were the shipped leak)`);
  ok('no counter drifted at any point during the soak', drift === null, JSON.stringify(drift));
  info('heap after the soak (NOT a gate — main-thread only, GC-timing dependent)',
    `${baseline.heapBytes} → ${final.heapBytes}`);

  const retired = await page.evaluate(() => window.__soakRetired.map((rt, i) => ({
    i,
    core: rt?.coreName,
    disposed: rt?._disposed === true,
    workerAlive: !!rt?.client?.delegate?.worker,
    mode: rt?.client?.mode,
  })));
  info(`retired runtimes kept for inspection: ${retired.length}`, JSON.stringify(retired));
  ok('every retired runtime was disposed', retired.length > 0 && retired.every((r) => r.disposed), JSON.stringify(retired));
  const workers = retired.filter((r) => r.mode === 'worker');
  ok('every retired WORKER runtime had its worker terminated',
    workers.length > 0 && workers.every((r) => !r.workerAlive), JSON.stringify(workers));

  // --- B. failed swaps -------------------------------------------------------
  // Patch the worker client's start() to reject, through the class of a runtime
  // we already have. Each attempt still builds a fresh runtime first, which is
  // exactly the resource that used to be stranded.
  const before = await page.evaluate(() => {
    const anyWorker = window.__soakRetired.find((rt) => rt?.client?.mode === 'worker');
    const Cls = anyWorker?.client?.delegate?.constructor;
    if (!Cls) return null;
    window.__soakStarts = 0;
    window.__soakRealStart = Cls.prototype.start;
    Cls.prototype.start = function patched() {
      window.__soakStarts++;
      return Promise.reject(new Error('soak: injected boot failure'));
    };
    window.__soakPatchedClass = Cls;
    return window.__rack.resources();
  });
  ok('the worker client start() could be patched to fail', !!before, JSON.stringify(before));
  if (!before) throw new Error('no worker client class reachable from a retired runtime');

  const runningBefore = await page.evaluate((consoleId) => window.__rack.runtime(consoleId)?.coreName, id);
  let failures = 0;
  for (let i = 0; i < FAILED_ATTEMPTS; i++) {
    const target = i + 1;
    await page.evaluate((m, consoleId) => {
      try { window.__insertCartridge({ ...m, consoleId }); } catch (_) {}
    }, workerGame, id);
    // A boot that FAILS is still a boot: wait until the fresh runtime actually
    // reached start() before measuring, or the counters would be read before
    // the resource it is supposed to strand was even created.
    const reached = await page.waitForFunction((n) => window.__soakStarts >= n, { timeout: 60000 }, target)
      .then(() => true).catch(() => false);
    if (reached) failures++;
    await sleep(1500);                    // let the failure path's teardown run
  }
  const after = await page.evaluate(() => window.__rack.resources());
  const runningAfter = await page.evaluate((consoleId) => window.__rack.runtime(consoleId)?.coreName, id);

  ok(`all ${FAILED_ATTEMPTS} failed boots reached the core's start()`, failures === FAILED_ATTEMPTS, `${failures}`);
  ok('a failed boot leaves the console running what it was running',
    runningAfter === runningBefore, `${runningBefore} → ${runningAfter}`);
  ok('failed boots did not strand canvases', after.canvases === before.canvases,
    `${before.canvases} → ${after.canvases}`);
  ok('failed boots did not strand audio branches', after.audioBranches === before.audioBranches,
    `${before.audioBranches} → ${after.audioBranches}`);
  ok('failed boots did not strand runtimes in the rack', after.runtimes === before.runtimes,
    `${before.runtimes} → ${after.runtimes}`);

  await page.evaluate(() => { window.__soakPatchedClass.prototype.start = window.__soakRealStart; });

  // pageerrors: a rejected boot is REPORTED through the app's own error path, so
  // an uncaught one here would mean the failure escaped that path.
  ok('NO uncaught page exceptions across the whole soak', pageErrors.length === 0, JSON.stringify(pageErrors));
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
