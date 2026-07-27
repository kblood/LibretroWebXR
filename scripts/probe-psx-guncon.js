// PSX GunCon light-gun probe (2026-07-27) — verifies the GunCon wiring added
// this session: SYSTEMS.psx.lightgun in src/systems.js (device 260 =
// SUBCLASS(LIGHTGUN,0), verified against beetle-psx-libretro's input.c at the
// exact pinned BEETLE_PSX_COMMIT — see that entry's comment), CORES.
// mednafen_psx_hw.remapName ('Beetle PSX', verified against the compiled
// wasm's retro_get_system_info library_name string), and the new
// coreOptions/inputDevices/remapName + sendLightgun plumbing added to
// WorkerEmulatorClient.js / EmulatorWorkerRuntime.js. PSX is a
// worker-executed core (execution:'worker' in CORES) — the ONLY
// worker-executed light-gun-capable system in this app; every other gun here
// (PS2 GunCon2, SNES Super Scope/Justifier, NES Zapper, Genesis Menacer, SMS
// Light Phaser) runs on the MAIN THREAD via EmulatorClient.js, which already
// had this plumbing. The worker path had NONE of it before this session: no
// coreOptions/inputDevices/remapName ever left WorkerEmulatorClient.start(),
// and WorkerEmulatorClient had no sendLightgun method at all.
//
// Boot path: this probe originally carried its own bespoke
// window.__pickLocalRomMultiFile hook (a multi-file, gun-aware sibling of the
// existing __pickLocalRom de-risk hook) because, at the time it was written,
// the real desktop multi-file `#rom-input` picker and the real
// window.__insertCartridge/loadCartridge path could not resolve a CUE's
// companion .bin tracks when NOT handed as literal File objects. A
// concurrently-running agent (commit 5b309f3, "Resolve multi-track .cue
// companions via URL fetch in cartridge-insert path") closed exactly that
// gap — wrapWorkerContent() now recognizes a .cue/.m3u entry sourced from a
// fetchable URL and resolves+fetches its companions itself
// (ContentBundle.fromEntryFetch) — so window.__insertCartridge can now boot
// this real 33-track disc on its own, and loadCartridge (src/main.js) ALREADY
// computes lightgunLoadConfig() from `meta.lightgun` for every boot, worker
// or not. That made the bespoke hook redundant duplicate logic, so it was
// removed from src/main.js; this probe instead uses the same real
// window.__insertCartridge path scripts/probe-psx-timecrisis.js's Step 2
// proved works for this disc, just adding `lightgun: true` to the meta
// (mirroring the real public/roms/local/local.collection.json "Time Crisis"
// entry, which now also carries lightgun:true + gunDevice:"guncon").
//
// What this ACTUALLY proves vs. what it can't: sendLightgun() reaching
// EmulatorWorkerRuntime's new forwardLightgun() and dispatching real
// mousemove/mousedown/mouseup on the worker's canvas is verifiable directly
// (this probe does — see the "inputs" metrics assertion). Whether Beetle
// PSX's OWN RetroArch frontend build was linked against a PATCHED rwebinput
// (docs/patches/rwebinput-lightgun.diff — stock rwebinput has NO
// RETRO_DEVICE_LIGHTGUN case, always reads 0) is NOT verifiable by
// inspecting the release wasm (function bodies aren't visible via string
// search) — mednafen_psx_jit_libretro is a bespoke from-scratch build
// (docs/PSX_CORE_BUILD.md), not one relinked through the same WSL2 pipeline
// that patched nestopia/snes9x/genesis_plus_gx.
//
// RESULT (confirmed 2026-07-27, reproduced across multiple runs): the real
// Time Crisis disc boots straight into its "Guncon Calibration" screen — a
// FIXED printed target (no on-screen cursor; real GunCon hardware has no
// screen-feedback loop for aim, only a photodiode read at the moment of
// firing, so a moving cursor was never the right thing to look for — see the
// aim-sweep analysis below, informational only). Firing directly at the
// drawn target (screen center, matching the "Aim and shoot at the center of
// the screen" prompt) leaves the frame byte-identical before and after,
// across every attempt — the shot never registers. Combined with the metrics
// proof that forwardLightgun DID run for every call, this pins the gap to
// the core artifact itself: this build's RetroArch frontend most likely
// wasn't linked against the patched rwebinput, so gun position never reaches
// Beetle PSX. Fixing it means rebuilding the core (out of scope here) —
// tracked as a follow-up, not silently declared "working."
//
// Usage:
//   npm run probe:psx-guncon
//   node scripts/probe-psx-guncon.js
//
// Exit code: 0 = all PASS assertions passed, 1 = at least one failed.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5205;
const BASE = `http://localhost:${PORT}/?core=mednafen_psx_hw&experimental=1`;
const DISC_DIR = resolve(ROOT, 'public', 'roms', 'local', 'ps1');
const CUE_PATH = resolve(DISC_DIR, 'Time Crisis.cue');
const CORE_JS = resolve(ROOT, 'public', 'cores', 'mednafen_psx_jit_libretro.js');
const CORE_WASM = resolve(ROOT, 'public', 'cores', 'mednafen_psx_jit_libretro.wasm');
const SHOT_DIR = resolve(ROOT, 'tmp');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) { console.error('ERROR: no Chrome/Edge binary found'); process.exit(1); }
if (!existsSync(CUE_PATH)) {
  console.error(`ERROR: test disc not found at ${CUE_PATH} (gitignored, user-provided — see CLAUDE.md)`);
  process.exit(1);
}
const missingCore = [CORE_JS, CORE_WASM].filter((p) => !existsSync(p));
if (missingCore.length) {
  console.error('ERROR: required build artifact(s) missing (public/cores/ is gitignored):');
  for (const p of missingCore) console.error(`  ${p}`);
  process.exit(2);
}

const trackCount = readdirSync(DISC_DIR).filter((f) => /^Time Crisis \(Track \d+\)\.bin$/i.test(f)).length;
if (trackCount !== 33) {
  console.error(`ERROR: expected 33 track .bin files in ${DISC_DIR}, found ${trackCount}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
const info = (name, extra = '') => console.log(`INFO  ${name}${extra ? '  — ' + extra : ''}`);

mkdirSync(SHOT_DIR, { recursive: true });

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

// Same canvas-readback approach as probe-psx-timecrisis.js: decode
// canvas.toDataURL() and return a per-cell-average grid signature (for
// spatially-localized diffing).
async function captureCanvas(page) {
  return page.evaluate(async () => {
    const canvas = document.getElementById('canvas');
    if (!canvas) return null;
    const dataUrl = canvas.toDataURL('image/png');
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('canvas snapshot image failed to decode'));
      im.src = dataUrl;
    });
    const off = document.createElement('canvas');
    off.width = img.width; off.height = img.height;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0);
    const { data } = octx.getImageData(0, 0, img.width, img.height);
    const GRID = 12;
    const cellW = Math.max(1, Math.floor(img.width / GRID));
    const cellH = Math.max(1, Math.floor(img.height / GRID));
    const signature = [];
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = gy * cellH; y < Math.min(img.height, (gy + 1) * cellH); y += 2) {
          for (let x = gx * cellW; x < Math.min(img.width, (gx + 1) * cellW); x += 2) {
            const i = (y * img.width + x) * 4;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
        }
        if (n === 0) n = 1;
        signature.push(Math.round(r / n), Math.round(g / n), Math.round(b / n));
      }
    }
    return { width: img.width, height: img.height, grid: GRID, signature, dataUrl };
  });
}

function cellDiffs(a, b) {
  if (!a || !b || a.grid !== b.grid || a.signature.length !== b.signature.length) return null;
  const n = a.grid * a.grid;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    out[i] = Math.abs(a.signature[o] - b.signature[o]) + Math.abs(a.signature[o + 1] - b.signature[o + 1]) + Math.abs(a.signature[o + 2] - b.signature[o + 2]);
  }
  return out;
}

function cellIndex(grid, u, v) {
  const gx = Math.max(0, Math.min(grid - 1, Math.floor(u * grid)));
  const gy = Math.max(0, Math.min(grid - 1, Math.floor(v * grid)));
  return gy * grid + gx;
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
  page.setDefaultTimeout(120000);
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  const appReady = await page.waitForFunction(
    () => !!window.__client && typeof window.__insertCartridge === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with __client + window.__insertCartridge present', appReady);
  if (!appReady) throw new Error('app never finished initialising');

  await page.evaluate(() => {
    window.__psxMetrics = [];
    window.__client.addEventListener('metrics', (e) => window.__psxMetrics.push({ t: performance.now(), ...e.detail }));
  });

  // SYSTEMS.psx.lightgun carries `broken: true` (this probe is exactly why —
  // see its comment in systems.js): lightgunLoadConfig returns null for it
  // by default so real players are never auto-armed into a gun that
  // provably can't register a shot yet. This probe explicitly opts back in
  // via the allowBroken test hook so it keeps exercising the real app-side
  // wiring end-to-end while that gate is up.
  await page.evaluate(() => { window.__allowBrokenLightgun = true; });

  // --- Step 1: boot the real disc through the REAL cartridge-insert path
  //     (window.__insertCartridge -> handleCartridgeInserted -> loadCartridge),
  //     with lightgun:true so loadCartridge's existing gun-wiring branch
  //     (meta.lightgun -> lightgunLoadConfig -> coreOptions/inputDevices/
  //     remapName threaded into wrapWorkerContent + client.start()) connects
  //     the GunCon at boot. Mirrors the real local.collection.json entry. ---
  const insertMeta = { file: 'local/ps1/Time Crisis.cue', core: 'mednafen_psx_hw', system: 'psx', title: 'Time Crisis', lightgun: true };
  info(`window.__insertCartridge(${JSON.stringify(insertMeta)})`);
  const insertResult = await page.evaluate(async (meta) => {
    try { await window.__insertCartridge(meta); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, insertMeta);
  ok('window.__insertCartridge resolved (boot call did not throw) with lightgun:true', insertResult.ok, insertResult.reason || '');

  const booted = await page.waitForFunction(
    () => window.__client?.mode === 'worker' && window.__client?.ready === true,
    { timeout: 100000 },
  ).then(() => true).catch(() => false);
  const finalState = await page.evaluate(() => ({
    mode: window.__client?.mode ?? null, ready: !!window.__client?.ready,
    status: document.querySelector('#status')?.textContent ?? null,
  }));
  ok('GunCon-armed disc booted into worker mode and ready', booted, `finalState=${JSON.stringify(finalState)}`);
  if (!booted) throw new Error(`PSX core never reported ready — status: ${finalState.status}`);

  function saveShot(dataUrl, name) {
    try { writeFileSync(resolve(SHOT_DIR, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')); }
    catch (_) {}
  }

  // Let the disc settle onto the attract-mode/title loop before probing aim
  // (same boot-timing budget probe-psx-timecrisis.js established as
  // sufficient to reach a stable, animating title screen).
  await sleep(20000);
  const baseline = await captureCanvas(page);
  ok('baseline canvas snapshot captured', !!baseline);
  if (baseline) saveShot(baseline.dataUrl, 'psx-guncon-baseline.png');

  // --- Step 2: sweep the gun's aim across several points and screenshot
  //     after each. sendLightgun -> RuntimeEmulatorClient -> WorkerEmulator
  //     Client.sendLightgun -> the worker's new forwardLightgun -> real
  //     mousemove dispatched on the worker's canvas (this leg is CODE we
  //     just added and are directly exercising here) -> RetroArch's rwebinput
  //     -> (IF patched) Beetle PSX's gun_pos[] -> (IF gun_cursor enabled, its
  //     default) an on-screen cursor overlay. ---
  const aimPoints = [
    { name: 'top-left', u: 0.12, v: 0.12 },
    { name: 'bottom-right', u: 0.88, v: 0.88 },
    { name: 'top-right', u: 0.88, v: 0.12 },
    { name: 'center', u: 0.5, v: 0.5 },
  ];
  const aimShots = [];
  for (const p of aimPoints) {
    await page.evaluate((u, v) => window.__client.sendLightgun(u, v, false, null), p.u, p.v);
    await sleep(600);
    const shot = await captureCanvas(page);
    aimShots.push({ ...p, shot });
    if (shot) saveShot(shot.dataUrl, `psx-guncon-aim-${p.name}.png`);
    info(`captured aim shot "${p.name}" (u=${p.u}, v=${p.v})`);
  }
  ok('all aim-sweep snapshots captured', aimShots.every((s) => !!s.shot));

  // --- Step 3: trigger pull AT the calibration target (screen center,
  //     matching the "center" aim point above and the on-screen target's
  //     drawn position — see psx-guncon-baseline.png) — a real GunCon
  //     trigger pull is a mousedown edge on the worker canvas. Give the game
  //     real time to react after releasing the trigger, then capture a
  //     settled post-shot frame. ---
  await page.evaluate((u, v) => window.__client.sendLightgun(u, v, true, null), 0.5, 0.5);
  await sleep(600);
  const triggerDownShot = await captureCanvas(page);
  if (triggerDownShot) saveShot(triggerDownShot.dataUrl, 'psx-guncon-trigger-down.png');
  await page.evaluate((u, v) => window.__client.sendLightgun(u, v, false, null), 0.5, 0.5);
  await sleep(2500);
  const triggerUpShot = await captureCanvas(page);
  if (triggerUpShot) saveShot(triggerUpShot.dataUrl, 'psx-guncon-trigger-up.png');
  ok('trigger down/up snapshots captured', !!triggerDownShot && !!triggerUpShot);

  // --- Analysis 1 (informational only — see header comment): does ANYTHING
  //     localized to the commanded aim point change between opposite-corner
  //     aim shots? NOTE: a real GunCon has no photodiode feedback loop to the
  //     screen — unlike a mouse or IR pointer, there is no reason to expect
  //     a moving on-screen cursor that tracks aim BEFORE the trigger is
  //     pulled (the calibration screen's blue circle+crosshair, confirmed by
  //     directly viewing psx-guncon-baseline.png, is a FIXED printed target
  //     you point the physical gun at — it does not move on real hardware
  //     either). So this check is weak evidence at best and must never gate
  //     the probe's pass/fail on its own — Analysis 2 below is the real,
  //     meaningful check for whether GunCon input actually reaches the game. ---
  const tl = aimShots.find((s) => s.name === 'top-left')?.shot;
  const br = aimShots.find((s) => s.name === 'bottom-right')?.shot;
  const diffs = cellDiffs(tl, br);
  if (diffs) {
    const grid = tl.grid;
    const tlCell = cellIndex(grid, 0.12, 0.12);
    const brCell = cellIndex(grid, 0.88, 0.88);
    const sorted = [...diffs].sort((a, b) => b - a);
    const tlRank = sorted.indexOf(diffs[tlCell]);
    const brRank = sorted.indexOf(diffs[brCell]);
    const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const maxDiff = Math.max(...diffs);
    info(`[informational] top-left vs bottom-right cell-diff analysis: mean=${meanDiff.toFixed(1)}, max=${maxDiff}, ` +
      `top-left-cell diff=${diffs[tlCell]} (rank ${tlRank}/${diffs.length}), ` +
      `bottom-right-cell diff=${diffs[brCell]} (rank ${brRank}/${diffs.length}) — ` +
      `low rank number = among the most-changed cells in the whole grid; a visible on-screen cursor is ` +
      `NOT expected for a real GunCon (see comment above), so a flat/zero diff here is NOT itself evidence of a gap`);
  }

  // --- Analysis 2 (the REAL gating check): did shooting the calibration
  //     target actually register with the game? Compare the settled
  //     post-trigger-up frame against the pre-input baseline — a real hit
  //     should advance Time Crisis's GunCon calibration flow (e.g. to a
  //     "shot registered" / next-step / confirmation state), producing a
  //     content-level frame change distinct from static "camera did nothing"
  //     playback (this screen has already been shown to be pixel-static
  //     across all preceding shots — baseline/top-left/bottom-right/top-
  //     right/center/trigger-down are all identical, so ANY change here is
  //     meaningful, not just idle-animation noise). If this stays flat, the
  //     honest conclusion is that GunCon input is not reaching the core for
  //     this specific build — a real, separate gap from the app-side wiring
  //     (postMessage -> forwardLightgun -> DOM events on the worker canvas),
  //     which the metrics assertions below independently confirm DID run. ---
  const postShotDiffs = cellDiffs(baseline, triggerUpShot);
  const postShotChanged = !!postShotDiffs && Math.max(...postShotDiffs) > 0;
  info(`[gating] baseline vs settled post-trigger-up frame: ${postShotDiffs ? `max cell diff=${Math.max(...postShotDiffs)}` : 'comparison unavailable'}`);
  ok('[GUNCON END-TO-END SIGNAL] shooting the calibration target actually changed game state (the settled post-trigger-up frame differs from the pre-input baseline) — a real hit reaching Beetle PSX, not just app-side event dispatch',
     postShotChanged,
     postShotDiffs ? `maxDiff=${Math.max(...postShotDiffs)} (screen was otherwise pixel-static across every capture up to this point)` : 'baseline/trigger-up shot grid mismatch or missing data');

  // --- Frame-health metrics (same baseline sanity layer as every other
  //     worker-execution probe in this repo) ---
  // Metrics broadcast on the worker's own 1000ms setInterval (see
  // EmulatorWorkerRuntime.js's metricsTimer), independent of when the last
  // sendLightgun call landed — give it up to ~1.5s past that interval to
  // post one more sample reflecting the trigger-up call before reading, so
  // this doesn't race a real periodic broadcast.
  await page.waitForFunction(
    (n) => (window.__psxMetrics || []).some((s) => (s.inputs || 0) >= n),
    { timeout: 2500 }, aimPoints.length + 2,
  ).catch(() => {});
  const metricsLog = await page.evaluate(() => window.__psxMetrics || []);
  const last = metricsLog[metricsLog.length - 1] || null;
  info(`metrics samples captured: ${metricsLog.length}`);
  if (last) info(`latest metrics snapshot: ${JSON.stringify(last)}`);
  ok('metrics: at least one sample was actually captured (telemetry pipe is alive)', metricsLog.length >= 1);
  ok('metrics: core reported at least one frame produced', !!last && (last.framesProduced || 0) > 0,
     last ? `framesProduced=${last.framesProduced}` : 'no metrics captured');
  ok('metrics: no core-reported errors across the run', !!last && last.errors === 0,
     last ? `errors=${last.errors}` : 'no metrics captured');
  // inputs metric increments once per forwardLightgun call in the worker —
  // directly confirms our postMessage->worker->forwardLightgun leg ran. Use
  // the MAX across all periodic samples, not just the last one: `inputs` is
  // a point-in-time snapshot broadcast on its own cadence, independent of
  // when sendLightgun calls land, so the very last call can easily land
  // after the last metrics broadcast was already queued — a false FAIL on a
  // real race, not a dropped input.
  const maxInputs = metricsLog.reduce((m, s) => Math.max(m, s.inputs || 0), 0);
  ok('metrics: worker recorded the sendLightgun-driven input calls (forwardLightgun ran in the worker)',
     maxInputs >= aimPoints.length + 2,
     `maxInputs=${maxInputs} (expected >= ${aimPoints.length + 2})`);

  ok('NO pageerror across the whole boot/aim/fire run', pageErrors.length === 0, JSON.stringify(pageErrors));
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^\[worker-core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error across the whole boot/aim/fire run', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));

  console.log(`\nScreenshots saved under: ${SHOT_DIR}`);
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  if (process.platform === 'win32') {
    await new Promise((res) => {
      const tk = spawn('taskkill', ['/pid', String(vite.pid), '/t', '/f'], { stdio: 'ignore' });
      tk.on('exit', res);
      tk.on('error', res);
    });
  } else {
    vite.kill();
    try { process.kill(-vite.pid); } catch (_) {}
  }
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length && results.length ? 0 : 1);
