// First REAL (non-authored) PSX commercial-game check (2026-07-27), following
// probe-n64-mario64.mjs's precedent for N64: every prior PSX "it plays games"
// claim in this repo used our own authored CC0 test disc (games/psx-testdisc,
// see docs/PSX_TESTDISC.md) — this probe instead boots a real, user-owned,
// legally-dumped commercial CD image (Time Crisis, Namco 1997, a 33-track
// CUE+BIN redump: 1 MODE2/2352 data track + 32 CD-DA audio tracks,
// public/roms/local/ps1/, gitignored — see public/roms/local/local.collection.json)
// through the REAL app flow.
//
// Why this can't reuse probe-n64-mario64.mjs's window.__insertCartridge /
// window.__rom.cacheRom hook chain: those all funnel through
// wrapWorkerContent()/ContentBundle.fromNamedSources() with exactly ONE named
// source (src/main.js:5239-5241) — fine for a single .z64/.exe/.chd file, but
// a real CUE+BIN disc is 34 files (1 cue + 33 tracks) that must all land in
// the SAME ContentBundle so ContentBundle's validateDependencies() can resolve
// the cue's FILE references (src/ContentBundle.js parseCueReferences). The
// ONLY code path in this app that builds a multi-file ContentBundle is the
// desktop file-picker's `isMultiFile` branch (src/main.js:6046-6048,
// `ContentBundle.fromFiles(files, ...)`), wired to the real `#rom-input`
// <input type=file multiple> element (index.html). So this probe drives that
// exact element via Puppeteer's ElementHandle.uploadFile(...) with all 34 real
// paths — a genuine multi-file OS-level file selection, dispatching the same
// 'change' event a real user's file-picker would, running the UNMODIFIED
// romInput change-handler (src/main.js:5986-6119) end to end. This is a more
// "real app flow" test than the cartridge-insert hook chain: no headless-only
// substitute function is called at all, only the real DOM input element.
//
// `.cue`/`.chd` are claimed by BOTH `mednafen_psx_hw` (PSX) and `play` (PS2)
// in systems.js's CORES registry; AMBIGUOUS_EXT_DEFAULT routes a bare `.cue`
// to `play` (PS2) by default (src/systems.js:639, coreForFile's doc comment).
// `?core=mednafen_psx_hw` (the same `coreOverride` URL param
// scripts/probe-mode-switch.mjs already exercises) forces every file in this
// pick to resolve through the PSX core regardless of extension ambiguity.
// `?experimental=1` is ALSO required: `psx` is `experimental: true` in
// systems.js (hidden from the default shelf/collection UI, not the file
// picker) — see the review doc's P0-2 note; harmless here since the file
// input path never consults SYSTEMS[x].experimental at all, but included for
// parity with every other PSX/N64 probe in this repo.
//
// Real-disc-serial finding (verifies the task's stated assumption rather than
// trusting it): dumping this disc's SYSTEM.CNF shows
// `BOOT = cdrom:\SLUS_004.05;1` — already a Sony-format serial (4-char
// region/publisher prefix `SLUS`, matching CalcDiscSCEx_BySYSTEMCNF()'s
// S+{C,L,I}+{E,U,K,B,P}+digits check documented in docs/PSX_TESTDISC.md's
// "Root cause 1"). No file in this repo was patched to make that true — real
// retail PS1 discs ship a valid serial already, exactly as that doc predicted.
//
// GunCon (PS1 lightgun) status: NOT wired anywhere in this codebase (grepped
// GameInputMgr.js/ControllerMaps.js/systems.js for "guncon", case-insensitive
// — zero hits; PS2's GunCon2 in systems.js's `ps2` entry is a different,
// unrelated peripheral on a different core). Implementing it is out of scope
// for this probe. Time Crisis (1997) is designed around the bundled GunCon —
// this probe is therefore INTENTIONALLY OBSERVATIONAL, exactly like
// probe-n64-mario64.mjs: no controller input is injected anywhere, so it only
// asserts however far the game gets entirely on its own (BIOS/OpenBIOS boot,
// the Namco logo, and whatever attract-mode/demo loop it settles into).
// Whether the original game accepts ANY digital-pad input at all (menus,
// "insert coin") was not established one way or the other by this probe —
// see the report for what was actually observed.
//
// Usage:
//   npm run probe:psx-timecrisis
//   node scripts/probe-psx-timecrisis.js
//
// Exit code: 0 = all PASS assertions passed, 1 = at least one failed / setup
// error.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5203;
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

if (!CHROME) {
  console.error('ERROR: no Chrome/Edge binary found');
  process.exit(1);
}
if (!existsSync(CUE_PATH)) {
  console.error(`ERROR: test disc not found at ${CUE_PATH} (this is a gitignored, user-provided local disc image — copy your own legally-owned Time Crisis CUE+BIN dump to ${DISC_DIR} first)`);
  process.exit(1);
}
const missingCore = [CORE_JS, CORE_WASM].filter((p) => !existsSync(p));
if (missingCore.length) {
  console.error('ERROR: required build artifact(s) missing (public/cores/ is gitignored — fetch/build the mednafen_psx core first):');
  for (const p of missingCore) console.error(`  ${p}`);
  process.exit(2);
}

// All 33 track .bin files alongside the .cue, in Track-NN numeric order (the
// order Puppeteer's uploadFile receives them in — irrelevant to correctness
// since ContentBundle resolves the cue's FILE references by name, not by
// upload order, but keeping it deterministic makes re-runs reproducible).
const trackPaths = readdirSync(DISC_DIR)
  .filter((f) => /^Time Crisis \(Track \d+\)\.bin$/i.test(f))
  .sort((a, b) => {
    const na = Number(a.match(/Track (\d+)/i)[1]);
    const nb = Number(b.match(/Track (\d+)/i)[1]);
    return na - nb;
  })
  .map((f) => resolve(DISC_DIR, f));
if (trackPaths.length !== 33) {
  console.error(`ERROR: expected 33 track .bin files in ${DISC_DIR}, found ${trackPaths.length}`);
  process.exit(2);
}
const uploadPaths = [CUE_PATH, ...trackPaths];

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

// Same in-page canvas readback approach as probe-n64-mario64.mjs: decode
// canvas.toDataURL() through a throwaway <img>/2D-canvas round-trip, returning
// a coarse per-cell-average grid signature (for motion detection) plus a
// full-resolution color histogram bucketed into named regions of the RGB
// cube. Named buckets are intentionally generic (white/near-white text or
// logos, saturated red, near-black) rather than Mario-64-style specific
// hues — this probe was written BEFORE the first real screenshot was
// inspected, so it avoids asserting a specific guessed palette; see the run
// log / committed screenshots for what this disc actually rendered.
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

    const GRID = 8;
    const cellW = Math.max(1, Math.floor(img.width / GRID));
    const cellH = Math.max(1, Math.floor(img.height / GRID));
    const signature = [];
    const colorBuckets = new Set();

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
        const ar = r / n, ag = g / n, ab = b / n;
        signature.push(Math.round(ar), Math.round(ag), Math.round(ab));
        colorBuckets.add(`${ar >> 5},${ag >> 5},${ab >> 5}`);
      }
    }

    let saturatedRed = 0, nearWhite = 0, nearBlack = 0, total = 0;
    for (let y = 0; y < img.height; y += 2) {
      for (let x = 0; x < img.width; x += 2) {
        const i = (y * img.width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        total++;
        if (r < 12 && g < 12 && b < 12) nearBlack++;
        if (r > 140 && r - g > 60 && r - b > 60) saturatedRed++;
        if (r > 200 && g > 200 && b > 200) nearWhite++;
      }
    }

    return { width: img.width, height: img.height, signature, distinctColorBuckets: colorBuckets.size,
      saturatedRed, nearWhite, nearBlack, total, dataUrl };
  });
}

function signatureDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
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
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(BASE, { waitUntil: 'load' });
  const ready = await page.waitForFunction(
    () => !!window.__client && !!document.querySelector('#rom-input'),
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with the real #rom-input element present', ready);
  if (!ready) throw new Error('app never finished initialising');

  // Subscribe to the real 'metrics' event RuntimeEmulatorClient re-dispatches
  // from its delegate (RuntimeEmulatorClient.js:66-68) BEFORE booting, so we
  // capture the worker's own frame-health telemetry across the whole run —
  // RuntimeEmulatorClient has no standing `.metrics` property, only events.
  await page.evaluate(() => {
    window.__psxMetrics = [];
    window.__client.addEventListener('metrics', (e) => window.__psxMetrics.push({ t: performance.now(), ...e.detail }));
  });

  // --- Step 1: real multi-file OS-level upload through the ACTUAL desktop
  //     file-picker element — no headless-only bypass hook. Fires the real
  //     'change' event on #rom-input, running the unmodified romInput
  //     change-handler (src/main.js), which builds a real multi-file
  //     ContentBundle (src/ContentBundle.js) from all 34 real files. ---
  const romInput = await page.$('#rom-input');
  ok('#rom-input element found', !!romInput);
  if (!romInput) throw new Error('#rom-input not found');

  info(`uploading ${uploadPaths.length} real files (1 cue + ${trackPaths.length} tracks) via the real file input`);
  await romInput.uploadFile(...uploadPaths);

  // Give the change-handler time to: read the .cue, hash all 34 files for the
  // ContentBundle's contentId (SHA-256 over ~663 MB), transfer everything
  // into the dedicated PSX worker's own MEMFS, and boot the core.
  const booted = await page.waitForFunction(
    () => window.__client?.mode === 'worker' && window.__client?.ready === true,
    { timeout: 100000 },
  ).then(() => true).catch(() => false);
  const finalState = await page.evaluate(() => ({
    mode: window.__client?.mode ?? null,
    ready: !!window.__client?.ready,
    status: document.querySelector('#status')?.textContent ?? null,
  }));
  ok('real file-picker upload booted the disc into worker mode and ready', booted, `finalState=${JSON.stringify(finalState)}`);
  if (!booted) throw new Error(`PSX core never reported ready — status: ${finalState.status}`);

  function saveShot(dataUrl, name) {
    try { writeFileSync(resolve(SHOT_DIR, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')); }
    catch (_) { /* best-effort evidence artifact */ }
  }

  // Capture timestamps bracketing: BIOS/OpenBIOS boot (~1s), CD-ROM seek/load
  // of the game executable + any Namco splash (~5-10s), and whatever
  // attract-mode/demo loop the game settles into if left completely alone
  // (~15-30s). No controller input is injected anywhere in this probe.
  const captureTimes = [1000, 3000, 5000, 8000, 12000, 15000, 20000, 25000, 30000];
  const shots = [];
  let elapsed = 0;
  for (let i = 0; i < captureTimes.length; i++) {
    const wait = captureTimes[i] - elapsed;
    if (wait > 0) await sleep(wait);
    elapsed = captureTimes[i];
    const shot = await captureCanvas(page);
    ok(`canvas snapshot #${i + 1} captured (~${(captureTimes[i] / 1000).toFixed(0)}s)`, !!shot);
    if (shot) {
      const name = `psx-timecrisis-t${i + 1}.png`;
      saveShot(shot.dataUrl, name);
      info(`snapshot #${i + 1} (${name}): distinctColorBuckets=${shot.distinctColorBuckets}, ` +
        `saturatedRed=${shot.saturatedRed}/${shot.total}, nearWhite=${shot.nearWhite}/${shot.total}, ` +
        `nearBlack=${shot.nearBlack}/${shot.total}`);
    }
    shots.push(shot);
  }

  ok('at least one snapshot is not blank (multiple distinct color regions present)',
     shots.some((s) => s && s.distinctColorBuckets >= 4),
     `distinctColorBuckets per snapshot: ${shots.map((s) => s?.distinctColorBuckets).join(', ')}`);

  ok('at least one snapshot is NOT a solid/near-solid black frame',
     shots.some((s) => s && s.nearBlack < s.total * 0.9),
     `nearBlack fraction per snapshot: ${shots.map((s) => s && s.total ? (s.nearBlack / s.total).toFixed(2) : 'n/a').join(', ')}`);

  ok('[REAL-CONTENT SIGNAL] at least one snapshot shows a saturated-red or near-white region (Namco logo / Time Crisis title-screen palette)',
     shots.some((s) => s && (s.saturatedRed > s.total * 0.002 || s.nearWhite > s.total * 0.002)),
     `saturatedRed/nearWhite fraction per snapshot: ${shots.map((s) => s && s.total ? `${(s.saturatedRed/s.total).toFixed(4)}/${(s.nearWhite/s.total).toFixed(4)}` : 'n/a').join(', ')}`);

  // [Codex review, 2026-07-27] The check above only requires SOME frame
  // anywhere in the whole boot window to show red/white — the transient
  // "Produced by namco" splash card is ALSO red/white, so a regression that
  // got stuck there forever (never reaching the actual title screen) would
  // still pass it. The real title screen is an ATTRACT-MODE state that holds
  // on screen indefinitely waiting for input, unlike the splash which plays
  // once and moves on — so require the strong red-sky signal to hold across
  // BOTH of the last two captures (~25s and ~30s), not just flash once.
  const lastTwo = shots.slice(-2);
  ok('[TITLE-SCREEN SIGNAL] settles onto and HOLDS the title screen (large orange-sky red fraction persists across the last two captures, not a one-frame flash)',
     lastTwo.length === 2 && lastTwo.every((s) => s && s.saturatedRed > s.total * 0.03),
     `last-two saturatedRed fractions: ${lastTwo.map((s) => s && s.total ? (s.saturatedRed / s.total).toFixed(4) : 'n/a').join(', ')}`);

  // Motion: content is animating (CD-audio-driven attract demo / logo
  // assembly), not a single frozen frame.
  let anyMotion = false;
  const diffs = [];
  for (let i = 1; i < shots.length; i++) {
    const d = signatureDiff(shots[i - 1]?.signature, shots[i]?.signature);
    diffs.push(d);
    if (d > 3) anyMotion = true;
  }
  info(`consecutive whole-canvas signature diffs: ${diffs.map((d) => d.toFixed(2)).join(', ')}`);
  ok('content is animating somewhere across the run (frame pump is not frozen on a single static frame)',
     anyMotion, `diffs=${diffs.map((d) => d.toFixed(2)).join(',')}`);

  // --- Try Start (Enter) then Cross ("h", this app's input_player1_a bind —
  // see src/RetroArchConfig.js's DEFAULT_KEYBINDS) via the REAL
  // client.sendInput() primitive (RuntimeEmulatorClient.sendInput ->
  // WorkerEmulatorClient.sendInput -> the worker's real input handler; the
  // same primitive GameInputMgr/Keyboard/DesktopGamepad all use — mirrors
  // scripts/probe-ps2-timecrisis2.mjs's press() helper). This is NOT a
  // GunCon substitute (Time Crisis's actual gameplay input is analog gun
  // position, which sendInput cannot provide) — real gameplay/aiming is not
  // exercised. But the state ADVANCE itself (title screen -> intro cutscene)
  // IS asserted below: a real menu transition produces a signature diff far
  // above the ~0-3 noise floor seen between idle attract-mode frames.
  async function press(code, key) {
    await page.evaluate((code, key) => window.__client.sendInput('keydown', code, key), code, key);
    await sleep(120);
    await page.evaluate((code, key) => window.__client.sendInput('keyup', code, key), code, key);
    await sleep(700);
  }
  const preInputShot = await captureCanvas(page);
  for (let i = 0; i < 4; i++) await press('Enter', 'Enter');
  await sleep(500);
  const afterStartShot = await captureCanvas(page);
  for (let i = 0; i < 6; i++) await press('KeyH', 'h');
  await sleep(1500);
  const afterCrossShot = await captureCanvas(page);
  if (afterCrossShot) saveShot(afterCrossShot.dataUrl, 'psx-timecrisis-after-input.png');
  const inputDiff1 = signatureDiff(preInputShot?.signature, afterStartShot?.signature);
  const inputDiff2 = signatureDiff(afterStartShot?.signature, afterCrossShot?.signature);
  info(`digital-pad Start/Cross press observation (NOT a GunCon substitute — real gameplay/aiming not exercised): ` +
    `signature diff pre->afterStart=${inputDiff1.toFixed(2)}, afterStart->afterCross=${inputDiff2.toFixed(2)}`);
  ok('[CUTSCENE-ADVANCE SIGNAL] digital Start/Cross input genuinely advances disc state (title screen -> intro cutscene), not a frozen/ignored input',
     (inputDiff1 > 10 || inputDiff2 > 10),
     `diffs pre->afterStart=${inputDiff1.toFixed(2)}, afterStart->afterCross=${inputDiff2.toFixed(2)} (idle attract-mode noise floor is ~0-3)`);

  // --- Frame-health metrics (same baseline sanity layer as the N64 real-content probe) ---
  const metricsLog = await page.evaluate(() => window.__psxMetrics || []);
  const last = metricsLog[metricsLog.length - 1] || null;
  info(`metrics samples captured: ${metricsLog.length}`);
  if (last) info(`latest metrics snapshot: ${JSON.stringify(last)}`);
  ok('metrics: at least one sample was actually captured (telemetry pipe is alive)',
     metricsLog.length >= 1, `metricsLog.length=${metricsLog.length}`);
  ok('metrics: core reported at least one frame produced', !!last && (last.framesProduced || 0) > 0,
     last ? `framesProduced=${last.framesProduced}` : 'no metrics captured');
  ok('metrics: no core-reported errors across the run', !!last && last.errors === 0,
     last ? `errors=${last.errors}` : 'no metrics captured');

  ok('NO pageerror across the whole upload/boot/render run', pageErrors.length === 0, JSON.stringify(pageErrors));
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^\[worker-core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error across the whole upload/boot/render run', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));

  console.log(`\nScreenshots saved (real canvas.toDataURL() bytes, not a viewport capture): ${shots.map((_, i) => resolve(SHOT_DIR, `psx-timecrisis-t${i + 1}.png`)).join(', ')}`);

  // --- Step 2 (2026-07-27): the REAL cartridge-insert / collection-entry
  // path — window.__insertCartridge -> handleCartridgeInserted ->
  // loadCartridge -> resolveRom (a plain URL fetch of ONLY the .cue's own
  // bytes) -> wrapWorkerContent(). Before this session's fix, wrapWorkerContent
  // wrapped exactly the one named file it was handed, so ContentBundle's
  // validateDependencies() could never find this disc's 33 companion .bin
  // tracks and this insert would throw MISSING_COMPANIONS — the real gap
  // Step 1 above (the file-picker's separate multi-file ContentBundle.fromFiles
  // branch) could not exercise. wrapWorkerContent now recognizes a .cue/.m3u
  // entry sourced from a fetchable URL and resolves+fetches its companions
  // itself (ContentBundle.fromEntryFetch, src/ContentBundle.js), producing the
  // exact same bundle shape fromFiles does. meta below mirrors the real
  // public/roms/local/local.collection.json "Time Crisis" entry exactly (no
  // rom.source override -> RomResolver defaults to ['url']). A fresh page load
  // is used so this exercises the FIRST-insert boot path (currentCore is
  // still null), not a same-core hot-swap.
  info('Step 2: fresh page load, then window.__insertCartridge with the SAME disc — sourced entirely via URL fetch (.cue + all 33 companion .bin tracks), NOT the file-picker');
  const page2 = await browser.newPage();
  page2.setDefaultTimeout(120000);
  const pageErrors2 = [];
  const consoleErrors2 = [];
  page2.on('pageerror', (e) => pageErrors2.push(e.message));
  page2.on('console', (message) => {
    if (message.type() === 'error') consoleErrors2.push(message.text());
  });

  await page2.goto(BASE, { waitUntil: 'load' });
  const ready2 = await page2.waitForFunction(
    () => !!window.__client && typeof window.__insertCartridge === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('[cartridge-insert] fresh app instance booted with window.__insertCartridge ready', ready2);

  if (ready2) {
    const insertMeta = { file: 'local/ps1/Time Crisis.cue', core: 'mednafen_psx_hw', system: 'psx', title: 'Time Crisis' };
    const insertResult = await page2.evaluate(async (meta) => {
      try { await window.__insertCartridge(meta); return { ok: true }; }
      catch (e) { return { ok: false, reason: String(e?.message || e) }; }
    }, insertMeta);
    ok('[cartridge-insert] window.__insertCartridge resolves without throwing for the URL-fetched multi-track disc (the real gap this fix closes)',
       insertResult.ok, insertResult.reason || '');

    const insertBooted = await page2.waitForFunction(
      () => window.__client?.mode === 'worker' && window.__client?.ready === true,
      { timeout: 100000 },
    ).then(() => true).catch(() => false);
    const insertFinalState = await page2.evaluate(() => ({
      mode: window.__client?.mode ?? null,
      ready: !!window.__client?.ready,
      status: document.querySelector('#status')?.textContent ?? null,
    }));
    ok('[cartridge-insert] real cartridge-insert path booted the URL-fetched disc into worker mode and ready',
       insertBooted, `finalState=${JSON.stringify(insertFinalState)}`);

    if (insertBooted) {
      await sleep(25000); // give it time to reach the same title-screen-ish state Step 1 observed
      const insertShot = await captureCanvas(page2);
      ok('[cartridge-insert] canvas snapshot captured', !!insertShot);
      if (insertShot) {
        saveShot(insertShot.dataUrl, 'psx-timecrisis-cartridge-insert.png');
        info(`cartridge-insert snapshot: distinctColorBuckets=${insertShot.distinctColorBuckets}, ` +
          `saturatedRed=${insertShot.saturatedRed}/${insertShot.total}, nearWhite=${insertShot.nearWhite}/${insertShot.total}, ` +
          `nearBlack=${insertShot.nearBlack}/${insertShot.total}`);
      }
      ok('[REAL-CONTENT SIGNAL via cartridge-insert] canvas shows real, non-blank rendered content (saturated-red or near-white region, matching Step 1\'s file-picker signal)',
         !!insertShot && (insertShot.saturatedRed > insertShot.total * 0.002 || insertShot.nearWhite > insertShot.total * 0.002),
         insertShot ? `saturatedRed=${insertShot.saturatedRed}/${insertShot.total}, nearWhite=${insertShot.nearWhite}/${insertShot.total}` : 'no shot');
    }

  }

  ok('[cartridge-insert] NO pageerror across the insert/boot/render run', pageErrors2.length === 0, JSON.stringify(pageErrors2));
  const relevantConsoleErrors2 = consoleErrors2.filter((m) =>
    !/^\[core\]/.test(m) && !/^\[worker-core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('[cartridge-insert] NO console error across the insert/boot/render run', relevantConsoleErrors2.length === 0, JSON.stringify(relevantConsoleErrors2));

  await page2.close().catch(() => {});
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  // See probe-n64-mario64.mjs / probe-n64-scene-render.mjs for why this must
  // be an awaited taskkill on win32 rather than vite.kill()/process.kill(-pid)
  // (shell:true means vite.pid is the shell's pid, not the real vite process).
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
