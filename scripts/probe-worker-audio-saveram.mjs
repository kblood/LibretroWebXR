// Opportunistic B3 (worker audio) + B4 (SaveRAM persistence) verification for
// the Phase B worker-cores review (2026-07-25). Not one of the task's
// required T-X4/T-X5 regression gates, but cheap to run with existing
// content, so it's wired in as a permanent probe.
//
// Uses public/roms/freeware/lwx-n64-scene.z64 (CC0, already shipped — see
// public/roms/manifest.json) via the REAL cartridge-insert path
// (window.__insertCartridge, same as scripts/probe-worker-cartridge-insert.mjs).
// Per its manifest credits, this content drives "a persistent EEPROM boot
// counter, and a continuous generated tone through the audio HLE path" — the
// two things B4 and B3 respectively need real evidence for.
//
// ===========================================================================
// WHAT A GREEN RUN OF THIS PROBE DOES AND DOES NOT PROVE
// (negative-control audit, 2026-07-29 — read this before citing it anywhere)
//
//   PROVES: worker-core audio reaches the PRIMARY console's SpatialAudio
//           branch. Validated by breaking it, twice, and watching it go red.
//   DOES NOT PROVE: that SaveRAM persists. Nothing in this probe's exit code
//           can distinguish working SaveRAM persistence from broken. Validated
//           by breaking it and watching it stay green. See B4 below.
//
// Despite the script's name, the SaveRAM half is NOT a regression gate.
// ===========================================================================
//
// B3 (audio) — SOUND, this is the assertion that carries the claim: asserts
// the PRIMARY console's SpatialAudio branch (window.__rack.audio(), console0)
// actually received at least one pushed buffer (nextAudioTime advances off 0)
// — i.e. WorkerEmulatorClient's 'audio' events are reaching ConsoleRuntime ->
// SpatialAudio.pushSamples for the primary console specifically. This is the
// exact case that was still broken until bootOnPrimary gained its own
// ensureBranch() call (see main.js) — the primary's very first worker-core
// boot doesn't go through ConsoleRuntime.load() (the only other ensureBranch
// call site), so this probe would have failed without that fix.
//
// That last sentence is not a guess — it was measured (2026-07-29) in a
// scratch checkout with junctioned node_modules/public:
//   • negative control A — delete the `audioRouter?.ensureBranch?.(CONSOLE_ID)`
//     line from bootOnPrimary (i.e. revert the B3 fix): 6/8, BOTH B3
//     assertions RED (window.__rack.audio() returns [], nextAudioTime
//     undefined). A stack trace confirmed bootOnPrimary:5934 is the ONLY
//     ensureBranch call that fires on this probe's path, so the header claim
//     above is exactly right.
//   • negative control B — leave the branch in place but stop forwarding the
//     client's 'audio' events (`if (false && this._audio ...)` in
//     ConsoleRuntime's constructor): 7/8, branch-exists PASSES and
//     nextAudioTime STAYS 0 (RED). So the nextAudioTime assertion is
//     independently structural, not a proxy for "a branch object exists".
// Known limitation: nextAudioTime is a one-way latch that never resets, so
// this cannot detect audio that starts and then stops mid-session.
//
// B4 (SaveRAM) — NOT A GATE, PROVES NOTHING, deliberately so: waits past
// RetroArchConfig's autosave_interval (10s), then calls client.flushSaveRam()
// (the same call flushCurrentSaveRam() in main.js makes on its periodic timer
// / pagehide). The two checks that would actually be evidence — "returned a
// non-empty buffer" and "buffer is not all-zero" — are declared with info(),
// which prints WITHOUT pushing to `results`, so they cannot affect the exit
// code. On a healthy repo both already report INFO(unmet). The only B4 check
// wired to the exit code is "the call did not throw", which is a liveness
// check on the JS binding and nothing more.
//
// Measured (2026-07-29), negative control C: reverting the P0-5 fix itself —
// autosave_interval "10" -> "0" in RetroArchConfig.js, the precise change that
// made native SaveRAM never persist for worker cores — leaves this probe at a
// full 8/8 with byte-identical output to the healthy repo. So a green run here
// must NEVER be cited as evidence that SaveRAM persistence works or that P0-5
// is effective.
//
// Why it can't currently be made falsifiable: verified by hand (2026-07-25)
// that even a 40s wait — 4x autosave_interval — never produces a .srm file for
// THIS specific ROM. mupen64plus_next's save-type (EEPROM/SRAM/FlashRAM/none)
// is detected from a CRC/game-database lookup keyed off the ROM header; this
// is a from-scratch libdragon homebrew ROM with no database entry, so it most
// likely resolves to "no save" — meaning
// retro_get_memory_size(RETRO_MEMORY_SAVE_RAM) is 0 and RetroArch's autosave
// thread correctly has nothing to write. With zero SaveRAM signal available
// there is no pair of arms to compare within a run, so no honest gate can be
// built from this content. A real SaveRAM gate needs a ROM with a recognized
// save type (or a forced core-option override) plus a two-arm, within-run
// comparison: same session, one arm that writes save data and one that does
// not, each read back against its own immediately-prior bytes. Until that
// exists, the B4 half stays informational and the claim stays unmade.
//
// Usage:
//   npm run probe:worker-audio-saveram
//   node scripts/probe-worker-audio-saveram.mjs
//
// Exit code: 0 = all assertions passed, 1 = at least one failed / setup error.

import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5196;
const BASE = `http://localhost:${PORT}/?experimental=1`;
const ROM = resolve(ROOT, 'public', 'roms', 'freeware', 'lwx-n64-scene.z64');
const META = { file: 'lwx-n64-scene.z64', core: 'mupen64plus_next', system: 'n64', title: 'N64 Audio/SaveRAM Probe' };

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
// Reports a check WITHOUT affecting the exit code — for B4's saveram check,
// which is currently inconclusive with this specific ROM (see the B4 doc
// comment above) rather than a pass/fail regression signal. NOTE: anything
// reported through info() is NOT a regression gate and must not be cited as
// evidence; a green exit code says nothing about it either way.
const info = (name, cond, extra = '') => {
  console.log(`${cond ? 'INFO(ok)' : 'INFO(unmet)'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const romB64 = readFileSync(ROM).toString('base64');

// STALE-SERVER GUARD (added 2026-07-29 during the negative-control audit).
// vite is spawned with --strictPort, so if anything is ALREADY bound to PORT
// our vite exits immediately, waitForServer() below happily connects to the
// FOREIGN server, and every assertion in this file silently measures a
// different source tree than the one under test. This is not hypothetical: a
// leaked vite from a previous run of this very script made a deliberately
// broken checkout report a clean 8/8. Refuse to run instead of lying.
if (await fetch(`http://localhost:${PORT}/`).then(() => true).catch(() => false)) {
  console.error(`ERROR: something is already listening on http://localhost:${PORT}/ — refusing to run.`);
  console.error('       This probe would end up measuring THAT server\'s source tree, not this one.');
  console.error('       Stop the stale server (by PID / port — never blanket-kill node) and re-run.');
  process.exit(1);
}

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

// Targeted teardown: find whatever is LISTENING on `port` and kill that
// process tree. Kills by PORT, never by image name — a blanket `taskkill /IM
// node.exe` would take down unrelated tooling (and the agent harness itself).
// Needed because vite.kill() alone does not reach through the `shell: true`
// wrapper: the npx/vite processes underneath get orphaned (their parent shell
// exits first, so even `taskkill /T` on the shell pid can no longer see them)
// and keep PORT bound for the next run. Measured 2026-07-29.
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
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  const ready = await page.waitForFunction(
    () => !!window.__client && typeof window.__rom?.cacheRom === 'function'
       && typeof window.__addLocalRom === 'function' && typeof window.__insertCartridge === 'function'
       && typeof window.__rack?.audio === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with required test hooks ready', ready);
  if (!ready) throw new Error('app never finished initialising');

  await page.evaluate(() => {
    window.__diagLogs = [];
    window.__client.addEventListener('log', (e) => window.__diagLogs.push(e.detail));
  });

  // --- Mint + insert via the real path (same pattern as probe-worker-cartridge-insert.mjs) ---
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

  const insert = await page.evaluate(async (meta, sha1) => {
    try { await window.__insertCartridge({ ...meta, rom: { sha1, sources: ['opfs'] } }); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, META, mint.sha1);
  ok('real cartridge-insert path (handleCartridgeInserted) resolves without throwing', insert.ok, insert.reason || '');

  const booted = await page.waitForFunction(
    () => window.__client?.mode === 'worker' && window.__client?.ready === true,
    { timeout: 45000 },
  ).then(() => true).catch(() => false);
  ok('client booted into worker mode and ready', booted);
  if (!booted) throw new Error('N64 core never reported ready');

  // Give the core >1 autosave_interval (10s, RetroArchConfig.js) so its
  // background autosave thread rewrites the MEMFS .srm file at least once,
  // and enough continuous-tone frames to guarantee several audio buffers.
  await sleep(15000);

  // --- B3: primary console's audio branch actually received pushed buffers ---
  const audioState = await page.evaluate(() => window.__rack.audio());
  const primaryBranch = audioState.find((b) => b.console === 'console0');
  ok('B3: primary console (console0) has a SpatialAudio branch', !!primaryBranch, JSON.stringify(audioState));
  ok('B3: that branch actually received pushed audio (nextAudioTime advanced)', (primaryBranch?.nextAudioTime || 0) > 0,
     `nextAudioTime=${primaryBranch?.nextAudioTime}`);

  // --- B4: flushSaveRam() reads real, non-blank bytes after autosave_interval ---
  const flush = await page.evaluate(async () => {
    try {
      const data = await window.__client.flushSaveRam();
      if (!data) return { ok: true, present: false, byteLength: 0, allZero: true };
      const bytes = new Uint8Array(data);
      const allZero = bytes.every((b) => b === 0);
      return { ok: true, present: true, byteLength: bytes.byteLength, allZero };
    } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  // Liveness of the JS binding ONLY — this is deliberately not a persistence
  // gate and must not be read as one. Measured 2026-07-29: reverting P0-5
  // (autosave_interval "10" -> "0" in RetroArchConfig.js) keeps this PASSing
  // and the whole probe at 8/8, identical to a healthy repo.
  ok('B4: flushSaveRam() is callable and does not throw — NOT evidence that SaveRAM persists (see header)', flush.ok, flush.reason || '');
  info('B4: flushSaveRam() returned a non-empty SaveRAM buffer (autosave_interval fired)', flush.present && flush.byteLength > 0,
     JSON.stringify(flush));
  info('B4: SaveRAM buffer is not all-zero (real EEPROM content, not a blank stub)', flush.present && !flush.allZero,
     JSON.stringify(flush));

  if (!flush.present) {
    // Verbose per-block JIT-shadow logging (see EmulatorWorkerRuntime.js) is
    // expected noise here and not diagnostic for saveram — just confirm no
    // save/eeprom-related warning or error was logged, without dumping the
    // full (potentially huge) per-block trace.
    const logs = await page.evaluate(() => window.__diagLogs || []);
    const relevant = logs.filter((l) => /save|eeprom|sram|flash/i.test(l.text || ''));
    console.log(`DIAG: ${logs.length} core log lines captured, ${relevant.length} mention save/eeprom/sram/flash:`);
    for (const l of relevant) console.log(`  [${l.level}] ${l.text}`);
  }

  ok('NO pageerror across the whole audio/saveram probe', pageErrors.length === 0, JSON.stringify(pageErrors));
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  vite.kill();
  try { process.kill(-vite.pid); } catch (_) {}
  // ...and then the process that is actually holding the port, which the two
  // calls above provably do not reach on Windows (see killPort's comment).
  // Without this the NEXT run silently measures this run's source tree.
  killPort(PORT);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length && results.length ? 0 : 1);
