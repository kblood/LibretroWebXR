// N64 real-content rendering + frame-health verification (2026-07-26 review
// follow-up). Boots the authored CC0 3D scene ROM (public/roms/freeware/
// lwx-n64-scene.z64 — a rotating flat-shaded cube, EEPROM boot counter, and a
// continuous audio tone, see games/n64-scene/main.c) through the REAL app
// flow: window.__insertCartridge, the exact passthrough to
// handleCartridgeInserted(meta) that GrabMgr.js's onCartridgeInserted callback
// invokes on a real physical cart-slot interaction (same pattern as
// scripts/probe-worker-cartridge-insert.mjs / probe-worker-audio-saveram.mjs).
//
// Why this probe exists: probe:worker-cartridge-insert and probe:mode-switch
// only assert `client.mode === 'worker' && client.ready === true` — "boots
// clean" — which the concurrent PSX-testdisc investigation (2026-07-26, see
// docs/research/psx-ps2-n64-review-2026-07-24.md) found is NOT the same as
// "the real content is what's actually on screen" for PSX, and the existing
// N64 harness's own "lit" check (test/n64-core-e2e/harness.js: r+g+b > 30)
// is too weak to catch the same class of gap — the scene's own dark-navy
// background color (8,8,16) already sums to 32, so ANY frame with just the
// background cleared, cube or no cube, colored or black, would read as "lit".
//
// ORIGINAL FINDING from this probe (2026-07-26, verified via both the coarse
// 8x8-grid signature below AND a direct pixel-histogram scan of the cube's
// screen-space bounding box across three captures 2s/5.5s/9s into a real
// boot): the cube's GEOMETRY rendered correctly — right silhouette shape,
// right screen position, and its projected area visibly changed over the
// three captures (silhouette pixel count 29911 -> 32613 -> 32454 in one
// concrete run), proving the transform/rotation/depth-sort pipeline was alive
// and the frame pump was NOT stalled (261 frames produced over 9.3s, 0 stale
// FRAME_ACKs, 0 core errors). But the cube's SIX ASSIGNED FLAT FACE COLORS
// (red/green/blue/yellow/magenta/cyan via rdp_set_primitive_color +
// rdp_draw_filled_triangle in games/n64-scene/main.c) never appeared anywhere
// in its bounding box: the fill was solid (0,0,0) black, with only
// antialiased gray ramps between black and the (8,8,16) background at the
// silhouette edge. Screenshots are saved to tmp/ as direct visual evidence
// (n64-scene-t1/2/3.png), decoded straight from canvas.toDataURL() rather
// than a Puppeteer elementHandle.screenshot() — the latter was tried first
// and produced a MISLEADING full-viewport capture instead of #canvas's own
// backing store, because #canvas is deliberately positioned off-page
// (index.html: `position:absolute;left:-99999px`, a WebGL/2D texture source
// for the TV mesh, not the visible viewport — see SceneMgr.js).
//
// RESOLVED 2026-07-26 — real core bug, fixed in GLideN64 and rebuilt.
// It was indeed a GFX-plugin gap and NOT anything the Phase A/B facade
// changes caused (none of those touch color/pixel output — they're JS-side
// plumbing: sendLightgun/sendMouse forwarding, buildStartOptions, audio
// wiring, autosave_interval, pause handling, the frame-ack watchdog). The
// R4300 CPU side was independently confirmed correct too: this build's
// N64_JIT_SHADOW harness logs checked=31/matched=31/mismatched=0 for this
// exact boot, and the core log confirms the "Cached Interpreter" (not any
// JIT) is the one actually executing.
//
// Root cause (GLideN64/src/gDP.cpp, LLETriangle::draw): a NON-SHADED
// low-level RDP triangle — command 0x08/0x09, i.e. gDPTriFill/gDPTriFillZ,
// which is exactly what libdragon's pre-rdpq rdp_draw_filled_triangle()
// emits — carries no per-vertex color, and the function's updateVtx() lambda
// only ever assigned vtx->r/g/b/a inside an `if (_shade)` branch. The
// vertices therefore reached the drawer with their color fields never
// written at all (undefined behaviour; deterministically zero => black under
// wasm). That is invisible in normal 1/2-cycle content, but fatal in
// G_CYC_FILL: CombinerInfo::update() replaces the color combiner with a
// pure "shade only" program for FILL cycle type, so the fragment color IS
// that never-written vertex shade. Real RDP hardware ignores the combiner
// entirely in FILL mode and writes SET_FILL_COLOR — which gDPFillRectangle()
// already reproduced for rectangles (via gDP.rectColor <- gDPGetFillColor),
// but LLE triangles were simply missing the equivalent. That asymmetry is
// exactly what this ROM's output showed: its background rect (also drawn
// with rdp_set_primitive_color + rdp_draw_filled_rectangle) came out at the
// correct (8,8,16), while all 12 cube triangles came out black.
// Fix: seed non-shaded LLE-triangle vertices from gDPGetFillColor() when
// cycleType == G_CYC_FILL (white otherwise, matching the function's own
// `int r = 0xff, g = 0xff, ...` initialisation intent), and value-initialise
// the local SPVertex array. See docs/N64_CORE_BUILD.md.
//
// Also collects the worker's periodic 'metrics' events (framesProduced,
// framesSkipped, staleFrameAcks, errors — see EmulatorWorkerRuntime.js's
// postMetrics, emitted every 1s) across the run as an INFO-only frame-rate /
// stall-behavior report (not asserted pass/fail — no established fps
// baseline for a headless-swiftshader run exists to regress against; see
// scripts/measure-n64-fps.js for the dedicated fps baseline measurement).
//
// SaveRAM/autosave (B4): calls flushSaveRam() same as
// probe-worker-audio-saveram.mjs and reports INFO only — this ROM is already
// documented (see that probe's header comment) to most likely report a
// zero-size SAVE_RAM because mupen64plus_next's CRC/database-driven
// save-type detection doesn't recognize a from-scratch homebrew ROM. Not
// re-litigated here.
//
// EVIDENCE AUDIT 2026-07-29 — what this probe does and does NOT establish.
// Every gating assertion here was re-tested by breaking the capability it
// claims to prove in a scratch checkout (junctioned to the real node_modules
// and public/) and confirming it goes RED:
//   * The bbox colour check ("REGRESSION SIGNAL") is SOUND: with every
//     non-background pixel forced to black in FrameBridge._present() (a faithful
//     replay of the historical GLideN64 fill-mode LLE-triangle bug's output) it
//     fails at brightCount=0 vs ~33000 on a working build.
//   * The two motion assertions did NOT survive. They compared silhouetteCount
//     at t against t+3.5s and gated on a bare `!==`, so ANY pixel-count change
//     satisfied them. With the presented frame shredded into ten horizontally
//     displaced bands — no coherent cube anywhere on screen — the probe still
//     reported 18/18. They are replaced below by a within-run, two-arm,
//     same-instant relative comparison (see sampleMotion), validated to fail
//     both a frozen picture and the shredded-geometry control.
//   * The probe also had no way to tell it was even measuring THIS tree: with
//     --strictPort its own vite exits when the port is taken, and waitForServer
//     accepted any 200. A concurrent session's checkout on 5198 produced a
//     clean, entirely meaningless 18/18. Guarded now at the pre-flight check.
//
// Usage:
//   npm run probe:n64-scene-render
//   node scripts/probe-n64-scene-render.mjs
//   PROBE_PORT=5698 node scripts/probe-n64-scene-render.mjs   (concurrent runs)
//
// Exit code: 0 = all PASS assertions passed, 1 = at least one failed / setup
// error. Since the GLideN64 fix above landed this probe is expected to pass
// in full; the color-fill assertions are now a live regression guard against
// the fill-mode LLE-triangle path breaking again (e.g. after a core rebuild
// from a fresh mupen64plus-libretro-nx clone that doesn't carry the patch).

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.PROBE_PORT || 5198);
const BASE = `http://localhost:${PORT}/?experimental=1`;
const ROM = resolve(ROOT, 'public', 'roms', 'freeware', 'lwx-n64-scene.z64');
const META = { file: 'lwx-n64-scene.z64', core: 'mupen64plus_next', system: 'n64', title: 'N64 Scene Render Probe' };
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
const info = (name, extra = '') => console.log(`INFO  ${name}${extra ? '  — ' + extra : ''}`);

mkdirSync(SHOT_DIR, { recursive: true });
const romB64 = readFileSync(ROM).toString('base64');

// EVIDENCE-INTEGRITY PRE-FLIGHT (2026-07-29 audit). --strictPort makes OUR
// vite exit if PORT is already bound, but waitForServer() below accepts ANY
// HTTP 200 — so the whole probe would then run against WHOEVER already owns
// the port. That is not hypothetical: during this audit a concurrent session's
// scratch checkout was serving 5198, and this probe reported a clean 18/18
// while measuring a completely different codebase's canvas. Refuse to run
// rather than produce meaningless green. Set PROBE_PORT to run concurrently.
if (await fetch(`http://localhost:${PORT}/`).then(() => true).catch(() => false)) {
  console.error(`ERROR: port ${PORT} is already served by another process. This probe would `
    + 'silently measure THAT tree instead of this one. Stop it, or re-run with '
    + `PROBE_PORT=<free port> (e.g. PROBE_PORT=${PORT + 500}).`);
  process.exit(1);
}

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
// Second half of the same guard: if our vite dies (bind failure, crash), never
// fall through to some other server that happens to answer on PORT.
let viteExited = false;
vite.on('exit', () => { viteExited = true; });

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (viteExited) throw new Error('our vite process exited before serving — refusing to run '
      + `against whatever else may answer on port ${PORT}`);
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

// In-page pixel analysis: decodes the canvas's own toDataURL() output back
// through an <img> into a fresh, throwaway 2D canvas (works regardless of
// whether #canvas itself is a WebGL or 2D-context canvas) and returns coarse
// stats + a low-res per-cell-average "signature" cheap enough to ship back
// over the CDP channel, so two captures can be diffed in Node without a PNG
// decoder dependency.
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
    let maxChannel = 0;

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
        maxChannel = Math.max(maxChannel, ar, ag, ab);
      }
    }
    return { width: img.width, height: img.height, signature, distinctColorBuckets: colorBuckets.size, maxChannel, dataUrl };
  });
}

function signatureDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// Targeted scan of the cube's approximate screen-space bounding box (in this
// 512x448-canvas coordinate space) — cheaper and far more sensitive than the
// coarse whole-canvas grid above for two specific questions: (1) does ANY
// pixel in the region the cube actually occupies show one of its six bright
// assigned face colors, and (2) does the region's silhouette (non-background)
// pixel count change over time, which is a rotation signal independent of what
// color the faces come out as, since the projected area of a rotating cube
// changes regardless of its fill color.
//
// `silhouetteCount` deliberately keys off "differs from the scene's own
// (8,8,16) background", NOT off "is near-black": an earlier revision of this
// probe used a near-black `darkCount` because at the time the GLideN64
// fill-mode LLE-triangle bug (see header) made every face render solid black,
// so black WAS the silhouette. Once that core bug was fixed the faces became
// correctly colored and `darkCount` went to a constant 0, making the motion
// assertions fail for the wrong reason. The background-difference form works
// in both regimes.
async function scanCubeBBox(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const x0 = 100, x1 = Math.min(360, width), y0 = 130, y1 = Math.min(380, height);
    // games/n64-scene/main.c clears with graphics_make_color(8, 10, 18, 255),
    // which quantizes through RGBA5551 to exactly (8, 8, 16) on output.
    const BG = [8, 8, 16];
    let brightCount = 0, darkCount = 0, silhouetteCount = 0, maxSum = 0;
    let maxPixel = null;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const sum = r + g + b;
        if (sum > maxSum) { maxSum = sum; maxPixel = [x, y, r, g, b]; }
        // A face color (red/green/blue/yellow/magenta/cyan at ~255,51,51 etc.)
        // always has at least one channel near-saturated far above the
        // (8,8,16) background/black-fill range.
        if (r > 100 || g > 100 || b > 60) brightCount++;
        // Retained for diagnostics only: distinguishes "black fill" (the old
        // core bug's signature) from "colored fill".
        if (sum < 20) darkCount++;
        if (Math.abs(r - BG[0]) > 6 || Math.abs(g - BG[1]) > 6 || Math.abs(b - BG[2]) > 6)
          silhouetteCount++;
      }
    }
    return { maxSum, maxPixel, brightCount, darkCount, silhouetteCount, area: (x1 - x0) * (y1 - y0) };
  });
}

// --- WITHIN-RUN RELATIVE MOTION MEASUREMENT (2026-07-29 evidence audit) ------
//
// Replaces the previous motion assertions, which compared `silhouetteCount` at
// t against `silhouetteCount` at t+3.5s and gated on a bare `!==`. That form
// was shown to prove nothing about the scene: with the presented frame shredded
// into ten horizontally displaced bands (a stand-in for a broken
// geometry/transform stage — no coherent cube anywhere on screen, see the
// negative-control note below) the probe still passed 18/18, because ANY change
// in an integer pixel count over 3.5s satisfies `!==`. It also could not tell
// real rotation from framebuffer jitter, and could false-FAIL whenever a
// rotating cube happened to project to the same area twice.
//
// The replacement is a two-arm, same-instant, relative comparison, each arm
// measured against its own immediately-prior frame ~300ms earlier:
//   SIGNAL arm  — pixels inside the cube's own bbox must change.
//   CONTROL arm — pixels OUTSIDE the cube's whole rotation envelope must change
//                 in EXACTLY 0 pixels over that same frame pair.
// Only the region differs between the arms; the frames, the instant and the
// comparison are identical. A frozen picture fails the SIGNAL arm; anything
// that moves pixels around the screen at large (jitter, a resize, shredded /
// mis-projected geometry, whole-frame noise, different content) fails the
// CONTROL arm. Both directions were validated — see the negative controls
// documented at the assertions themselves.
const CUBE_BOX = { x0: 100, x1: 360, y0: 130, y1: 380 };
// Outer bound of everywhere the cube can ever project to over a full yaw lap at
// this ROM's fixed pitch (0.3 rad; headless has no analog input to change it).
// Derived from games/n64-scene/main.c's projection: half-diagonal 50*sqrt(3)
// world units, FOCAL/zc scale in [0.65, 1.35], canvas scale 512/320 x 448/240,
// centred at (256, 224). Everything outside this rect is scene background and
// static black overscan, and must therefore be pixel-identical frame to frame.
const CUBE_ENVELOPE = { x0: 95, x1: 415, y0: 45, y1: 400 };

async function sampleMotion(page, cube, envelope) {
  return page.evaluate((box, env) => {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const prev = window.__lwxPrevFrame;
    window.__lwxPrevFrame = new Uint8ClampedArray(data);
    if (!prev || prev.length !== data.length) return null; // priming capture
    let cubeChanged = 0, marginChanged = 0, totalChanged = 0;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] === prev[i] && data[i + 1] === prev[i + 1] && data[i + 2] === prev[i + 2]) continue;
        totalChanged++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) cubeChanged++;
        if (x < env.x0 || x >= env.x1 || y < env.y0 || y >= env.y1) marginChanged++;
      }
    }
    return {
      cubeChanged, marginChanged, totalChanged,
      changedBBox: maxX < 0 ? null : [minX, minY, maxX, maxY],
    };
  }, cube, envelope);
}

// Takes the priming capture, waits, then returns the real measurement — so the
// two arms below always describe ONE frame pair a known short interval apart.
async function measureMotionWindow(page, ms = 300) {
  await sampleMotion(page, CUBE_BOX, CUBE_ENVELOPE);
  await sleep(ms);
  return sampleMotion(page, CUBE_BOX, CUBE_ENVELOPE);
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
  const ready = await page.waitForFunction(
    () => !!window.__client && typeof window.__rom?.cacheRom === 'function'
       && typeof window.__addLocalRom === 'function' && typeof window.__insertCartridge === 'function'
       && typeof window.__rack?.audio === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with required test hooks ready', ready);
  if (!ready) throw new Error('app never finished initialising');

  await page.evaluate(() => {
    window.__n64Metrics = [];
    window.__client.addEventListener('metrics', (e) => window.__n64Metrics.push({ t: performance.now(), ...e.detail }));
  });

  // --- Mint + insert via the REAL cartridge-insert path ---
  const mint = await page.evaluate(async (b64, meta) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const sha1 = await window.__rom.cacheRom(buf.buffer);
    if (!sha1) return { ok: false, reason: 'cacheRom returned no sha1' };
    await window.__addLocalRom({ ...meta, rom: { sha1, sources: ['opfs'] } });
    return { ok: true, sha1 };
  }, romB64, META);
  ok('shelf cartridge minted (real addLocalRomToShelf path)', mint.ok, mint.reason || '');
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

  // Writes canvas.toDataURL()'s own base64 PNG bytes straight to disk — this
  // reads the SAME backing store captureCanvas()/scanCubeBBox() analyze, so
  // the saved file is guaranteed to be actual evidence of what was measured
  // (unlike a Puppeteer elementHandle.screenshot() on this off-page canvas,
  // which was tried first and returned an unrelated full-viewport capture).
  function saveShot(dataUrl, name) {
    try { writeFileSync(resolve(SHOT_DIR, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')); }
    catch (_) { /* best-effort evidence artifact */ }
  }

  // Let the core run past its initial boot frames before the first capture.
  await sleep(2000);
  const shot1 = await captureCanvas(page);
  const bbox1 = await scanCubeBBox(page);
  ok('canvas snapshot #1 captured', !!shot1);
  if (shot1) saveShot(shot1.dataUrl, 'n64-scene-t1.png');

  ok('snapshot #1: canvas is not blank (multiple distinct color regions present)',
     !!shot1 && shot1.distinctColorBuckets >= 4,
     `distinctColorBuckets=${shot1?.distinctColorBuckets}`);
  ok('snapshot #1 [REGRESSION SIGNAL]: a real cube-face color (bright/saturated pixel) appears in the cube\'s own bounding box, not just an all-black fill',
     bbox1.brightCount > 0,
     `brightCount=${bbox1.brightCount}/${bbox1.area}, brightest pixel in bbox=${JSON.stringify(bbox1.maxPixel)} (sum=${bbox1.maxSum})`);

  // Wait well past the FRAME_ACK stall-watchdog timeout (500ms) and long
  // enough for visible cube rotation (~0.012 rad/frame -> a full lap in a
  // few hundred frames), then capture again.
  await sleep(3500);
  const shot2 = await captureCanvas(page);
  const bbox2 = await scanCubeBBox(page);
  ok('canvas snapshot #2 captured', !!shot2);
  if (shot2) saveShot(shot2.dataUrl, 'n64-scene-t2.png');

  const diff12 = signatureDiff(shot1?.signature, shot2?.signature);
  info(`snapshot #1->#2 whole-canvas color-average diff: meanAbsChannelDiff=${diff12.toFixed(2)}`);
  info(`snapshot #1->#2 cube-bbox silhouette AREA (diagnostic only — a bare !== on this number was the pre-2026-07-29 motion assertion and proves nothing; see the two-arm checks): silhouetteCount ${bbox1.silhouetteCount} -> ${bbox2.silhouetteCount} (darkCount ${bbox1.darkCount} -> ${bbox2.darkCount})`);

  // Two-arm relative motion check, EARLY in the run. Validated in both
  // directions on 2026-07-29 against scratch-checkout negative controls:
  //   SIGNAL arm goes RED when FrameBridge._present() stops updating the canvas
  //     after 60 frames (frozen picture, telemetry still perfectly healthy) —
  //     cubeChanged 0 vs ~14k on a working build.
  //   CONTROL arm goes RED when the presented frame is shredded into ten
  //     horizontally displaced bands (broken geometry/transform stand-in) —
  //     the old `!==` assertions passed that break 18/18.
  const motionEarly = await measureMotionWindow(page);
  ok('[MOTION SIGNAL ARM] within ONE ~300ms window, pixels inside the cube bbox change (the cube is being redrawn — not a frozen/stalled picture)',
     !!motionEarly && motionEarly.cubeChanged > 200,
     motionEarly ? `cubeChanged=${motionEarly.cubeChanged} (bbox ${CUBE_BOX.x0},${CUBE_BOX.y0}-${CUBE_BOX.x1},${CUBE_BOX.y1})` : 'no motion sample');
  ok('[MOTION CONTROL ARM] over that SAME frame pair, pixels OUTSIDE the cube\'s whole rotation envelope change in EXACTLY 0 pixels (the change is the cube moving, not global jitter / a resize / shredded or mis-projected geometry / different content)',
     !!motionEarly && motionEarly.marginChanged === 0,
     motionEarly ? `marginChanged=${motionEarly.marginChanged}, totalChanged=${motionEarly.totalChanged}, changedBBox=${JSON.stringify(motionEarly.changedBBox)} vs envelope ${CUBE_ENVELOPE.x0},${CUBE_ENVELOPE.y0}-${CUBE_ENVELOPE.x1},${CUBE_ENVELOPE.y1}` : 'no motion sample');

  await sleep(3500);
  const shot3 = await captureCanvas(page);
  const bbox3 = await scanCubeBBox(page);
  ok('canvas snapshot #3 captured', !!shot3);
  if (shot3) saveShot(shot3.dataUrl, 'n64-scene-t3.png');

  const diff23 = signatureDiff(shot2?.signature, shot3?.signature);
  info(`snapshot #2->#3 whole-canvas color-average diff: meanAbsChannelDiff=${diff23.toFixed(2)}`);
  info(`snapshot #2->#3 cube-bbox silhouette AREA (diagnostic only, see above): silhouetteCount ${bbox2.silhouetteCount} -> ${bbox3.silhouetteCount} (darkCount ${bbox2.darkCount} -> ${bbox3.darkCount})`);

  // Same two-arm check, LATE in the run — this is what covers "no later
  // stall": a pump that dies after the first seconds fails the SIGNAL arm here
  // while the early pair still passed.
  const motionLate = await measureMotionWindow(page);
  ok('[MOTION SIGNAL ARM, late] the same within-window cube-bbox change is still there ~9s in (motion continues across the whole run, no later stall)',
     !!motionLate && motionLate.cubeChanged > 200,
     motionLate ? `cubeChanged=${motionLate.cubeChanged}` : 'no motion sample');
  ok('[MOTION CONTROL ARM, late] and the off-envelope margin is still EXACTLY 0 changed pixels over that same late frame pair',
     !!motionLate && motionLate.marginChanged === 0,
     motionLate ? `marginChanged=${motionLate.marginChanged}, totalChanged=${motionLate.totalChanged}, changedBBox=${JSON.stringify(motionLate.changedBBox)}` : 'no motion sample');
  info(`snapshot #3 bbox color check (restates the #1 assertion above, not a separate pass/fail axis): brightCount=${bbox3.brightCount}/${bbox3.area}, brightest pixel in bbox=${JSON.stringify(bbox3.maxPixel)} (sum=${bbox3.maxSum})`);

  // --- Frame-health metrics (informational — no established headless fps
  // baseline to assert a pass/fail threshold against; see measure-n64-fps.js) ---
  const metricsLog = await page.evaluate(() => window.__n64Metrics || []);
  const last = metricsLog[metricsLog.length - 1] || null;
  const first = metricsLog[0] || null;
  const elapsedS = last && first ? (last.t - first.t) / 1000 : 0;
  const framesDelta = last && first ? (last.framesProduced - first.framesProduced) : 0;
  info(`metrics samples captured: ${metricsLog.length}`);
  if (last) {
    info(`latest metrics snapshot: ${JSON.stringify({
      framesProduced: last.framesProduced, framesSkipped: last.framesSkipped,
      staleFrameAcks: last.staleFrameAcks || 0, errors: last.errors, uptimeMs: last.uptimeMs,
    })}`);
    info(`approx fps over probe window: ${elapsedS > 0 ? (framesDelta / elapsedS).toFixed(1) : 'n/a'} (headless swiftshader, not representative of Quest/native GPU)`);
  }
  // codex exec review (2026-07-26): the two checks below used to short-circuit
  // to PASS via `!last` whenever metrics forwarding was broken/misattached —
  // i.e. "no telemetry received" read as "telemetry looks healthy". Require
  // real samples first so a metrics-pipe regression fails loudly instead.
  ok('metrics: at least one sample was actually captured (telemetry pipe is alive)',
     metricsLog.length >= 1, `metricsLog.length=${metricsLog.length}`);
  ok('metrics: no core-reported errors across the run', !!last && last.errors === 0, last ? `errors=${last.errors}` : 'no metrics captured');
  ok('metrics: stale FRAME_ACK count is not runaway (frame pump is not silently stalling)',
     !!last && (last.staleFrameAcks || 0) < Math.max(5, framesDelta * 0.1),
     last ? `staleFrameAcks=${last.staleFrameAcks || 0} framesDelta=${framesDelta}` : 'no metrics captured');

  // --- B3 quick check: primary console's audio branch actually advanced ---
  const audioState = await page.evaluate(() => window.__rack.audio());
  const primaryBranch = audioState.find((b) => b.console === 'console0');
  ok('audio: primary console (console0) SpatialAudio branch received pushed buffers',
     (primaryBranch?.nextAudioTime || 0) > 0, `nextAudioTime=${primaryBranch?.nextAudioTime}`);

  // --- B4 SaveRAM/autosave: informational only (known content/detection gap) ---
  const flush = await page.evaluate(async () => {
    try {
      const data = await window.__client.flushSaveRam();
      if (!data) return { ok: true, present: false };
      const bytes = new Uint8Array(data);
      return { ok: true, present: true, byteLength: bytes.byteLength, allZero: bytes.every((b) => b === 0) };
    } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  });
  ok('saveram: flushSaveRam() does not throw', flush.ok, flush.reason || '');
  info('saveram: flushSaveRam() result (see B4 note — this ROM likely has no recognized save type)', JSON.stringify(flush));

  ok('NO pageerror across the whole boot/render/metrics run', pageErrors.length === 0, JSON.stringify(pageErrors));
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error across the whole boot/render/metrics run', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));

  console.log(`\nScreenshots saved (real canvas.toDataURL() bytes, not a viewport capture): ${resolve(SHOT_DIR, 'n64-scene-t1.png')}, n64-scene-t2.png, n64-scene-t3.png`);
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  // codex exec review (2026-07-26): with shell:true, vite.pid is the shell's
  // pid, not the actual node/vite process — vite.kill() only kills the shell,
  // and process.kill(-vite.pid) is a POSIX process-group idiom that throws
  // (silently swallowed) on Windows, so the real vite process can survive and
  // keep PORT bound for the next run. On win32, kill the whole process tree
  // via taskkill instead; POSIX keeps the existing process-group kill.
  if (process.platform === 'win32') {
    // Must be awaited: spawn() alone races the script's own exit below, so the
    // taskkill child can itself get cut off before it finishes reaping the
    // vite process tree (observed: port stayed bound after a prior version of
    // this fix that didn't wait).
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
