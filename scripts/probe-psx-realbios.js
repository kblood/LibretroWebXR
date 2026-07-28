// PSX real-BIOS commercial-game probe (2026-07-28).
//
// WHY THIS EXISTS: every prior PSX verification in this repo booted on the
// core's BUILT-IN OpenBIOS. Nothing was ever staged in public/ and the probes
// launch Chrome with a fresh profile (no userDataDir), so FirmwareStore's
// IndexedDB was always empty and buildStartOptions' `options.firmware` was
// always undefined. OpenBIOS is a homebrew BIOS replacement with known
// commercial-game compatibility limits, so "the core plays real games" had
// never actually been tested in the configuration a real user would run.
//
// This probe imports a REAL Sony BIOS through the app's own #firmware-input
// handler (FirmwareStore.import -> IndexedDB, exactly the user-facing "Import
// BIOS" flow) and then boots real commercial discs through the real
// window.__insertCartridge path, so the whole chain is exercised:
//   #firmware-input -> FirmwareStore.import -> getPreferred(profile, region)
//   -> buildStartOptions.firmware -> worker runtime -> core
//
// It deliberately runs an OpenBIOS baseline FIRST (before any import) on the
// same disc, so a difference between the two is attributable to the BIOS
// rather than to the disc or to boot timing.
//
// All discs are single-file CHDs. That matters: the collection/cartridge-insert
// path historically could not resolve a multi-track CUE's companion .bin files
// (see the "Time Crisis" entry in local.collection.json), which is why the
// existing CUE+BIN probes drive the multi-file #rom-input picker instead. A CHD
// is one file, so these boot through the ordinary cartridge path unmodified.
//
// Usage:
//   npm run probe:psx-realbios
//   node scripts/probe-psx-realbios.js
//   PSX_DISCS="Point Blank (USA).chd" node scripts/probe-psx-realbios.js   # subset
//
// Exit code: 0 = all PASS assertions passed, 1 = at least one failed.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5206;
const BASE = `http://localhost:${PORT}/?core=mednafen_psx_hw&experimental=1`;
const DISC_DIR = resolve(ROOT, 'public', 'roms', 'local', 'ps1');
const BIOS_DIR = resolve(ROOT, 'tmp', 'psx-bios', 'canonical');
const CORE_JS = resolve(ROOT, 'public', 'cores', 'mednafen_psx_jit_libretro.js');
const CORE_WASM = resolve(ROOT, 'public', 'cores', 'mednafen_psx_jit_libretro.wasm');
const SHOT_DIR = resolve(ROOT, 'tmp');

// Region tag in the filename drives regionHintFromMeta -> getPreferred, so the
// BIOS that gets mounted is region-matched per disc. Keep the (USA)/(Japan)
// tags intact when renaming dumps.
const ALL_DISCS = [
  { file: 'Point Blank (USA).chd',            title: 'Point Blank (USA)',            lightgun: true,  bios: 'scph5501.bin' },
  { file: 'Lethal Enforcers I & II (USA).chd', title: 'Lethal Enforcers I & II (USA)', lightgun: true, bios: 'scph5501.bin' },
  { file: 'Time Crisis (USA).chd',            title: 'Time Crisis (USA)',            lightgun: true,  bios: 'scph5501.bin' },
  { file: 'Policenauts (Japan) (Disc 1).chd', title: 'Policenauts (Japan) (Disc 1)', lightgun: true,  bios: 'scph5500.bin' },
];

const only = process.env.PSX_DISCS ? process.env.PSX_DISCS.split('|').map((s) => s.trim()) : null;
const DISCS = only ? ALL_DISCS.filter((d) => only.includes(d.file)) : ALL_DISCS;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) { console.error('ERROR: no Chrome/Edge binary found'); process.exit(2); }

const missingCore = [CORE_JS, CORE_WASM].filter((p) => !existsSync(p));
if (missingCore.length) {
  console.error('ERROR: required build artifact(s) missing (public/cores/ is gitignored):');
  for (const p of missingCore) console.error(`  ${p}`);
  process.exit(2);
}
const missingDiscs = DISCS.filter((d) => !existsSync(resolve(DISC_DIR, d.file)));
if (missingDiscs.length) {
  console.error('ERROR: test disc(s) missing (gitignored, user-provided):');
  for (const d of missingDiscs) console.error(`  ${resolve(DISC_DIR, d.file)}`);
  process.exit(2);
}
const neededBios = [...new Set(DISCS.map((d) => d.bios))];
const missingBios = neededBios.filter((b) => !existsSync(resolve(BIOS_DIR, b)));
if (missingBios.length) {
  console.error(`ERROR: BIOS missing from ${BIOS_DIR} (gitignored, user-provided):`);
  for (const b of missingBios) console.error(`  ${b}`);
  console.error('Identify dumps by MD5 (src/FirmwareStore.js:7-9), not by filename.');
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

// Grid-average canvas signature (same approach as probe-psx-guncon.js) plus
// the spread across cells, which is what separates a real rendered frame from
// a flat single-colour fill — the specific failure mode the N64 colour-fill
// regression and the PSX presentation bug both produced.
async function captureCanvas(page) {
  return page.evaluate(async () => {
    const canvas = document.getElementById('canvas');
    if (!canvas) return null;
    const dataUrl = canvas.toDataURL('image/png');
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('canvas snapshot failed to decode'));
      im.src = dataUrl;
    });
    const off = document.createElement('canvas');
    off.width = img.width; off.height = img.height;
    off.getContext('2d').drawImage(img, 0, 0);
    const { data } = off.getContext('2d').getImageData(0, 0, img.width, img.height);
    // Grid the INNER region only. The core letterboxes its output with black
    // bars, and those bars alone produce enough cell-to-cell variance to pass
    // a naive "not a flat fill" check — an earlier version of this probe was
    // fooled exactly that way by a blank grey BIOS screen with black bars.
    const x0 = Math.floor(img.width * 0.10), x1 = Math.ceil(img.width * 0.90);
    const y0 = Math.floor(img.height * 0.14), y1 = Math.ceil(img.height * 0.86);
    const GRID = 12;
    const cellW = Math.max(1, Math.floor((x1 - x0) / GRID));
    const cellH = Math.max(1, Math.floor((y1 - y0) / GRID));
    const signature = [];
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0 + gy * cellH; y < Math.min(y1, y0 + (gy + 1) * cellH); y += 2) {
          for (let x = x0 + gx * cellW; x < Math.min(x1, x0 + (gx + 1) * cellW); x += 2) {
            const i = (y * img.width + x) * 4;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
        }
        if (n === 0) n = 1;
        signature.push(Math.round(r / n), Math.round(g / n), Math.round(b / n));
      }
    }
    // Luma spread across cells: ~0 means a flat fill (or a blank screen).
    const lumas = [];
    for (let i = 0; i < signature.length; i += 3) {
      lumas.push(0.2126 * signature[i] + 0.7152 * signature[i + 1] + 0.0722 * signature[i + 2]);
    }
    const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
    const spread = Math.sqrt(lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length);
    return { width: img.width, height: img.height, grid: GRID, signature, dataUrl, meanLuma: mean, lumaSpread: spread };
  });
}

function totalDiff(a, b) {
  if (!a || !b || a.signature.length !== b.signature.length) return null;
  let sum = 0;
  for (let i = 0; i < a.signature.length; i++) sum += Math.abs(a.signature[i] - b.signature[i]);
  return sum;
}

function saveShot(dataUrl, name) {
  try { writeFileSync(resolve(SHOT_DIR, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')); }
  catch (_) {}
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Boots one disc in a fresh page and reports what the core actually did.
// `label` distinguishes the OpenBIOS baseline from the real-BIOS runs in both
// the assertion names and the screenshot filenames.
async function bootDisc(browser, disc, label) {
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  const appReady = await page.waitForFunction(
    () => !!window.__client && typeof window.__insertCartridge === 'function',
    { timeout: 60000 },
  ).then(() => true).catch(() => false);
  if (!appReady) { await page.close(); return { fatal: 'app never initialised' }; }

  await page.evaluate(() => {
    window.__psxMetrics = [];
    window.__client.addEventListener('metrics', (e) => window.__psxMetrics.push({ t: performance.now(), ...e.detail }));
  });

  const meta = {
    file: `local/ps1/${disc.file}`,
    core: 'mednafen_psx_hw',
    system: 'psx',
    title: disc.title,
    ...(disc.lightgun ? { lightgun: true, gunDevice: 'guncon' } : {}),
  };
  const insert = await page.evaluate(async (m) => {
    try { await window.__insertCartridge(m); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, meta);

  const booted = await page.waitForFunction(
    () => window.__client?.mode === 'worker' && window.__client?.ready === true,
    { timeout: 150000 },
  ).then(() => true).catch(() => false);

  const status = await page.evaluate(() => document.querySelector('#status')?.textContent ?? null);

  let first = null, second = null, metrics = null, timeToPicture = null;
  if (booted) {
    // Poll rather than sleep a fixed amount. A real Sony BIOS plays its logo
    // sequence and then goes BLACK for ~10s before the game appears, so any
    // fixed settle time is a coin flip — an earlier version of this probe used
    // 20s, landed in that dark gap, and reported a false "black screen with
    // real BIOS" while the core was in fact fine (it renders from ~30s).
    // OpenBIOS skips all of that and paints almost immediately, so the two
    // configurations genuinely need different budgets.
    // A real BIOS paints its own logo screen within ~3s, so polling from t=0
    // captures the SPLASH, not the game — every disc then looks identical
    // because it IS identical. Sit out the whole BIOS sequence first
    // (logo ~0-12s, black gap ~15-25s, game from ~30s per the timeline in
    // tmp/psx-bios-timeline.mjs) before looking for a picture.
    const MIN_SETTLE_MS = 45000;
    await sleep(MIN_SETTLE_MS);
    const deadline = Date.now() + 75000;
    const started = Date.now();
    while (Date.now() < deadline) {
      const shot = await captureCanvas(page);
      if (shot && shot.meanLuma > 2 && shot.lumaSpread > 6) {
        first = shot;
        timeToPicture = Math.round((Date.now() - started) / 1000);
        break;
      }
      first = shot;                     // keep the last one for diagnostics on failure
      await sleep(3000);
    }
    await sleep(6000);                  // long enough for an attract loop to visibly move
    second = await captureCanvas(page);
    metrics = await page.evaluate(() => {
      const m = window.__psxMetrics || [];
      const last = m[m.length - 1] || {};
      return {
        count: m.length,
        framesProduced: last.framesProduced ?? null,
        framesSkipped: last.framesSkipped ?? null,
        audioForwarded: last.psxAudioFramesForwarded ?? null,
        coreErrors: last.errors ?? null,
        uptimeMs: last.uptimeMs ?? null,
        jitCompiled: last.jit?.compiled ?? null,
      };
    });
    if (first) saveShot(first.dataUrl, `psx-realbios-${slug(label)}-${slug(disc.title)}-a.png`);
    if (second) saveShot(second.dataUrl, `psx-realbios-${slug(label)}-${slug(disc.title)}-b.png`);
  }

  await page.close();
  return { insert, booted, status, first, second, metrics, timeToPicture, pageErrors, consoleErrors };
}

function reportDisc(disc, label, r) {
  const tag = `[${label}] ${disc.title}`;
  if (r.fatal) { ok(`${tag}: app initialised`, false, r.fatal); return null; }
  ok(`${tag}: __insertCartridge resolved`, r.insert.ok, r.insert.reason || '');
  ok(`${tag}: booted into worker mode + ready`, r.booted, `status=${JSON.stringify(r.status)}`);
  if (!r.booted) return null;

  const advanced = (r.metrics?.framesProduced ?? 0) > 0;
  ok(`${tag}: core advanced frames`, advanced, `framesProduced=${r.metrics?.framesProduced} skipped=${r.metrics?.framesSkipped}`);

  const nonBlank = !!r.first && r.first.meanLuma > 2;
  ok(`${tag}: renders a non-blank frame`, nonBlank, `meanLuma=${r.first?.meanLuma?.toFixed(1)} afterFirstPicture=${r.timeToPicture}s`);

  // A flat fill has near-zero spread across the 12x12 grid; real rendered
  // content (title art, menus, 3D) does not.
  const structured = !!r.first && r.first.lumaSpread > 6;
  ok(`${tag}: frame has real structure (not a flat fill)`, structured, `lumaSpread=${r.first?.lumaSpread?.toFixed(1)}`);

  // Informational, NOT an assertion: whether the picture moves is a property
  // of the game, not of the core. Time Crisis boots to its GunCon calibration
  // screen ("Aim and shoot at the center of the screen"), which is static by
  // design and legitimately reports gridDiff=0. Liveness is already proven by
  // framesProduced climbing and by the cross-disc distinctness check below.
  const diff = totalDiff(r.first, r.second);
  info(`${tag}: picture delta over 6s — gridDiff=${diff}${diff === 0 ? ' (static screen — expected for a calibration/menu screen)' : ''}`);

  ok(`${tag}: core reported no internal errors`, (r.metrics?.coreErrors ?? 0) === 0, `errors=${r.metrics?.coreErrors}`);
  ok(`${tag}: audio is being forwarded`, (r.metrics?.audioForwarded ?? 0) > 0, `audioFrames=${r.metrics?.audioForwarded}`);
  ok(`${tag}: no page errors`, r.pageErrors.length === 0, r.pageErrors.slice(0, 2).join(' | '));

  // NOT an assertion: the Lightrec Wasm-JIT is known-inert on this build (see
  // memory psx-lightrec-gl-investigation). Recorded so a future fix shows up
  // here as a number going non-zero rather than needing a bespoke probe.
  info(`${tag}: jit.compiled=${r.metrics?.jitCompiled} timeToPicture=${r.timeToPicture}s consoleErrors=${r.consoleErrors.length}`);
  return {
    meanLuma: Number(r.first?.meanLuma?.toFixed(1)), lumaSpread: Number(r.first?.lumaSpread?.toFixed(1)),
    diff, framesProduced: r.metrics?.framesProduced, jitCompiled: r.metrics?.jitCompiled, timeToPicture: r.timeToPicture,
  };
}

let browser;
try {
  if (!(await waitForServer(`http://localhost:${PORT}/`))) throw new Error('vite dev server never came up');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
  });

  // --- Step 1: OpenBIOS baseline, BEFORE importing anything. Establishes what
  //     this disc does in the configuration every prior probe actually ran. ---
  const baselineDisc = DISCS[0];
  info(`OpenBIOS baseline on "${baselineDisc.title}" (no BIOS imported yet)`);
  const baseline = await bootDisc(browser, baselineDisc, 'openbios');
  const baselineSummary = reportDisc(baselineDisc, 'openbios', baseline);

  // --- Step 2: import the real BIOS through the app's own handler. IndexedDB
  //     is shared across pages in this browser, so one import covers every
  //     later boot; getPreferred picks per-disc by region hint. ---
  const importPage = await browser.newPage();
  importPage.setDefaultTimeout(60000);
  await importPage.goto(BASE, { waitUntil: 'load' });
  await importPage.waitForFunction(() => !!document.querySelector('#firmware-input'), { timeout: 30000 });
  for (const bios of neededBios) {
    const input = await importPage.$('#firmware-input');
    await input.uploadFile(resolve(BIOS_DIR, bios));
    await importPage.waitForFunction(
      () => /imported BIOS|import rejected|import failed/i.test(document.querySelector('#status')?.textContent || ''),
      { timeout: 30000 },
    ).catch(() => {});
    const status = await importPage.evaluate(() => document.querySelector('#status')?.textContent || '');
    ok(`BIOS import: ${bios} recognized by FirmwareStore`, /imported BIOS/i.test(status) && !/unrecognized/i.test(status), status);
    await importPage.evaluate(() => { const s = document.querySelector('#status'); if (s) s.textContent = ''; });
  }
  const stored = await importPage.evaluate(async () => {
    try {
      const { FirmwareStore } = await import('/src/FirmwareStore.js');
      const list = await new FirmwareStore().list('psx');
      return list.map((r) => ({ name: r.name, region: r.region, recognized: !!r.recognized }));
    } catch (e) { return { error: String(e?.message || e) }; }
  });
  info(`FirmwareStore.list('psx') = ${JSON.stringify(stored)}`);
  ok('BIOS persisted in FirmwareStore (IndexedDB)', Array.isArray(stored) && stored.length === neededBios.length,
    Array.isArray(stored) ? `${stored.length} record(s)` : JSON.stringify(stored));
  await importPage.close();

  // --- Step 3: boot every disc with the real BIOS mounted. ---
  const summaries = {};
  const shots = {};
  for (const disc of DISCS) {
    info(`real-BIOS boot: "${disc.title}" (expects ${disc.bios})`);
    const r = await bootDisc(browser, disc, 'realbios');
    summaries[disc.title] = reportDisc(disc, 'realbios', r);
    if (r.first) shots[disc.title] = r.first;
  }

  // --- Cross-disc distinctness. The single most useful check here: if the
  //     probe is accidentally sampling a shared screen (BIOS splash, blank
  //     grey, a stuck canvas) every disc yields the SAME signature, and every
  //     per-disc assertion above still passes. Two different games must not
  //     look identical. This is what caught the splash-screen false pass. ---
  const titles = Object.keys(shots);
  if (titles.length > 1) {
    let identicalPairs = 0;
    for (let i = 0; i < titles.length; i++) {
      for (let j = i + 1; j < titles.length; j++) {
        const d = totalDiff(shots[titles[i]], shots[titles[j]]);
        if (d !== null && d < 500) {
          identicalPairs++;
          info(`near-identical picture: "${titles[i]}" vs "${titles[j]}" (diff=${d})`);
        }
      }
    }
    ok('each disc renders a DISTINCT picture (not a shared BIOS/blank screen)', identicalPairs === 0,
      `${identicalPairs} near-identical pair(s) of ${(titles.length * (titles.length - 1)) / 2}`);
  }

  // --- Step 4: contrast. Not an assertion — OpenBIOS may well boot these
  //     fine; the point is to record the delta rather than assume it. ---
  const rb = summaries[baselineDisc.title];
  if (baselineSummary && rb) {
    info(`BIOS delta on "${baselineDisc.title}": openbios=${JSON.stringify(baselineSummary)} realbios=${JSON.stringify(rb)}`);
  }

  console.log(`\nScreenshots: ${SHOT_DIR}\\psx-realbios-*.png`);
} catch (err) {
  console.error(`FATAL: ${err?.message || err}`);
  results.push(false);
} finally {
  if (browser) await browser.close().catch(() => {});
  try { vite.kill(); } catch (_) {}
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} assertions passed`);
process.exit(failed === 0 ? 0 : 1);
