// First REAL (non-authored) N64 commercial-game check (2026-07-27), following
// probe-n64-scene-render.mjs's now-fixed GLideN64 fill-mode-color core bug.
// Every prior N64 "it plays games" claim in this repo used our own authored
// libdragon test scene (games/n64-scene — a rotating flat-shaded cube); this
// probe instead boots a real, user-owned, legally-dumped cartridge ROM
// (Super Mario 64 (USA), 8388608 bytes, public/roms/local/n64/mario64.z64,
// gitignored — see public/roms/local/local.collection.json) through the exact
// same REAL app flow probe-n64-scene-render.mjs established:
// window.__rom.cacheRom -> window.__addLocalRom -> window.__insertCartridge
// (the same passthrough handleCartridgeInserted(meta) that GrabMgr.js's
// onCartridgeInserted callback invokes on a real physical cart-slot
// interaction). No bypass harness, no direct WorkerEmulatorClient import.
//
// This is intentionally an OBSERVATIONAL probe, not a scripted-input
// playthrough: no controller presses are injected, so it only exercises
// however far the game gets on its own. Empirically (2026-07-27 run, see
// tmp/n64-mario64-t*.png): ~2s is still pre-boot black; ~4s catches the
// tumbling "SUPER MARIO 64" 3D logo assembling itself (mid-tumble, so some
// lettering is transiently upside-down — that is the real animation, not a
// capture bug) over a "(c)1996 Nintendo" copyright card; ~6-8s is a black
// transition gap; from ~12s onward it settles on the actual, unmistakable
// title screen: the famous rotatable/stretchable 3D "Mario face" logo over
// a tiled blue "SUPER MARIO 64" wallpaper background, with idle sparkle
// effects animating around the face and (by ~20s) a "PRESS START" prompt
// fading in — all without a single controller input. It never reaches the
// castle courtyard / file-select / gameplay, because that requires an
// actual Start-button press this probe intentionally does not inject.
// The assertions below are evidence-based on what THIS run actually showed,
// not aspirational — do not weaken them to force a pass, and do not tighten
// them past what a real run actually demonstrated either.
//
// One honest anomaly worth flagging (not asserted on, just noted): the 2D
// title-screen text overlays (the tumbling logo lettering, the "PRESS START"
// prompt, the copyright card) render upside-down/mirrored, while the 3D
// Mario face model in the same frames renders right-side-up — i.e. this is
// NOT a whole-frame flip (probe-n64-scene-render.mjs's cube renders
// correctly oriented), it looks specific to whatever 2D-overlay/textured-quad
// path the game uses for its title-screen text layer. Not investigated
// further here; flagging for whoever picks up N64 rendering fidelity next.
//
// Usage:
//   npm run probe:n64-mario64
//   node scripts/probe-n64-mario64.mjs
//
// Exit code: 0 = all PASS assertions passed, 1 = at least one failed / setup
// error.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5199;
const BASE = `http://localhost:${PORT}/?experimental=1`;
const ROM = resolve(ROOT, 'public', 'roms', 'local', 'n64', 'mario64.z64');
const META = { file: 'local/n64/mario64.z64', core: 'mupen64plus_next', system: 'n64', title: 'Super Mario 64 (real-cart probe)' };
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
  console.error(`ERROR: test ROM not found at ${ROM} (this is a gitignored, user-provided local ROM — copy your own legally-owned dump there first)`);
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

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

// Same in-page canvas readback approach as probe-n64-scene-render.mjs: decode
// canvas.toDataURL() through a throwaway <img>/2D-canvas round-trip (works
// regardless of whether #canvas is WebGL or 2D backed), returning a coarse
// per-cell-average grid signature plus a full-resolution color histogram
// bucketed into named regions of the RGB cube so specific hues (saturated
// red, sky blue, grass green, etc.) can be asserted on directly instead of
// just "not blank".
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

    // Named-hue pixel counts across the WHOLE frame (full res, step 2 for
    // speed) — these thresholds describe specific N64/Mario-64-plausible
    // palette regions, not generic "bright pixel" thresholds:
    //   saturatedRed: strong red channel, green/blue both clearly lower
    //     (the swirling N64 boot logo's red lobe, and/or the "SUPER MARIO 64"
    //     logo lettering, and/or Mario's red cap/shirt).
    //   skyBlue: light, blue-dominant with green not far behind (the
    //     intro flyover's sky and the castle-grounds daytime sky).
    //   grassGreen: green-dominant, moderate brightness (castle-grounds
    //     grass / hedges).
    //   nearBlack: nothing rendered / letterbox / pre-boot black.
    let saturatedRed = 0, skyBlue = 0, grassGreen = 0, nearBlack = 0, total = 0;
    for (let y = 0; y < img.height; y += 2) {
      for (let x = 0; x < img.width; x += 2) {
        const i = (y * img.width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        total++;
        if (r < 12 && g < 12 && b < 12) nearBlack++;
        if (r > 140 && r - g > 60 && r - b > 60) saturatedRed++;
        if (b > 140 && b - r > 10 && g > 80 && (b - r) < 140) skyBlue++;
        if (g > 90 && g - r > 20 && g - b > 20) grassGreen++;
      }
    }

    return {
      width: img.width, height: img.height, signature, distinctColorBuckets: colorBuckets.size, maxChannel,
      saturatedRed, skyBlue, grassGreen, nearBlack, total, dataUrl,
    };
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

  function saveShot(dataUrl, name) {
    try { writeFileSync(resolve(SHOT_DIR, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')); }
    catch (_) { /* best-effort evidence artifact */ }
  }

  // Capture timestamps chosen to bracket: N64 boot-code logo (~2s), the
  // game's own intro cinematic/logo (~6s, ~12s), and whichever idle/title/
  // attract state it settles into if left completely alone (~20s). No
  // controller input is injected anywhere in this probe.
  const captureTimes = [2000, 4000, 6000, 8000, 12000, 16000, 20000, 26000];
  const shots = [];
  let elapsed = 0;
  for (let i = 0; i < captureTimes.length; i++) {
    const wait = captureTimes[i] - elapsed;
    if (wait > 0) await sleep(wait);
    elapsed = captureTimes[i];
    const shot = await captureCanvas(page);
    ok(`canvas snapshot #${i + 1} captured (~${(captureTimes[i] / 1000).toFixed(0)}s)`, !!shot);
    if (shot) {
      const name = `n64-mario64-t${i + 1}.png`;
      saveShot(shot.dataUrl, name);
      info(`snapshot #${i + 1} (${name}): distinctColorBuckets=${shot.distinctColorBuckets}, ` +
        `saturatedRed=${shot.saturatedRed}/${shot.total}, skyBlue=${shot.skyBlue}/${shot.total}, ` +
        `grassGreen=${shot.grassGreen}/${shot.total}, nearBlack=${shot.nearBlack}/${shot.total}`);
    }
    shots.push(shot);
  }

  ok('at least one snapshot is not blank (multiple distinct color regions present)',
     shots.some((s) => s && s.distinctColorBuckets >= 4),
     `distinctColorBuckets per snapshot: ${shots.map((s) => s?.distinctColorBuckets).join(', ')}`);

  ok('at least one snapshot is NOT a solid/near-solid black frame',
     shots.some((s) => s && s.nearBlack < s.total * 0.9),
     `nearBlack fraction per snapshot: ${shots.map((s) => s && s.total ? (s.nearBlack / s.total).toFixed(2) : 'n/a').join(', ')}`);

  ok('[REAL-CONTENT SIGNAL] at least one snapshot shows a saturated-red region (matches Mario\'s red cap/face on the title screen, and/or the tumbling logo lettering)',
     shots.some((s) => s && s.saturatedRed > s.total * 0.002),
     `saturatedRed fraction per snapshot: ${shots.map((s) => s && s.total ? (s.saturatedRed / s.total).toFixed(4) : 'n/a').join(', ')}`);

  ok('[REAL-CONTENT SIGNAL] at least one snapshot shows a distinctive blue/green hue region (matches the tiled blue title-screen wallpaper background)',
     shots.some((s) => s && (s.skyBlue > s.total * 0.01 || s.grassGreen > s.total * 0.01)),
     `skyBlue/grassGreen fraction per snapshot: ${shots.map((s) => s && s.total ? `${(s.skyBlue/s.total).toFixed(3)}/${(s.grassGreen/s.total).toFixed(3)}` : 'n/a').join(', ')}`);

  // [Codex review, 2026-07-27] The four checks above only require SOME
  // snapshot anywhere in the whole run to show red/blue — a regression that
  // stalls forever on the tumbling intro logo (or anything else colorful)
  // would still satisfy them. Pin the actual claim from the header comment:
  // from ~12s onward the run settles onto, and STAYS on, the title screen
  // specifically (red Mario-face + blue tiled wallpaper simultaneously in
  // EVERY late capture, not just once). This is the discriminator that
  // actually distinguishes "reached and held the title screen" from
  // "flashed something colorful once" — e.g. the ~4s tumbling-logo capture
  // (skyBlue fraction 0.011) would fail this threshold even though it passes
  // the looser checks above.
  const lateShots = shots.slice(4);
  ok('[TITLE-SCREEN SIGNAL] settles onto and STAYS ON a title-screen-consistent frame from ~12s onward (red Mario-face + blue wallpaper together, in every late capture)',
     lateShots.length > 0 && lateShots.every((s) => s && s.saturatedRed > s.total * 0.02 && s.skyBlue > s.total * 0.02),
     `late (>=12s) saturatedRed/skyBlue fractions: ${lateShots.map((s) => s && s.total ? `${(s.saturatedRed / s.total).toFixed(3)}/${(s.skyBlue / s.total).toFixed(3)}` : 'n/a').join(', ')}`);

  // Coarse whole-run motion, reported as INFO only. This USED to be an
  // assertion ("content is animating somewhere across the run", any
  // consecutive signatureDiff > 3). A 2026-07-29 negative-control audit
  // proved it was worthless as evidence: with the presentation path
  // deliberately frozen at 14s (FrameBridge._present() stops calling
  // drawImage, everything else stays healthy) the canvas was byte-identical
  // for the whole last 12s of the run — the very window the title-screen
  // claim is about — and that assertion still PASSED, because the boot-era
  // transitions (black -> logo -> black -> title, diffs 23.78/23.39/55.04)
  // alone satisfy "somewhere across the run". A whole-run "any motion"
  // gate can never fail once a game has booted at all, so it is not a check.
  const diffs = [];
  for (let i = 1; i < shots.length; i++) diffs.push(signatureDiff(shots[i - 1]?.signature, shots[i]?.signature));
  info(`consecutive whole-canvas signature diffs (informational, NOT asserted — see above): ${diffs.map((d) => d.toFixed(2)).join(', ')}`);

  // [LIVENESS] Within-run relative liveness burst — the real replacement for
  // the assertion above. Instead of one absolute before/after diff spanning
  // seconds (which silently measures boot progression, state drift and
  // elapsed time alongside any actual animation), take a burst of closely
  // spaced captures INSIDE the title-screen window the claim is about, and
  // measure each capture against its OWN immediately-prior capture.
  //
  // The discriminator is exact, not a drift threshold: a stalled presentation
  // path reproduces the previous frame bit-for-bit, so changedPixels is
  // EXACTLY 0 for every pair. A live title screen (idle sparkle effects, the
  // "PRESS START" prompt fading, the face's idle animation) cannot produce a
  // byte-identical canvas 300ms later. Over ~300ms nothing else in the run
  // is changing — same screen, same game state — so a nonzero delta can only
  // come from the emulator still pushing new frames.
  const LIVENESS_SAMPLES = 8;
  const LIVENESS_GAP_MS = 300;
  const deltas = [];
  await page.evaluate(() => { delete window.__probePrevPixels; });
  for (let i = 0; i < LIVENESS_SAMPLES; i++) {
    const d = await page.evaluate(async () => {
      const canvas = document.getElementById('canvas');
      if (!canvas) return null;
      const dataUrl = canvas.toDataURL('image/png');
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('liveness snapshot failed to decode'));
        im.src = dataUrl;
      });
      const off = document.createElement('canvas');
      off.width = img.width; off.height = img.height;
      const octx = off.getContext('2d');
      octx.drawImage(img, 0, 0);
      const { data } = octx.getImageData(0, 0, img.width, img.height);
      const prev = window.__probePrevPixels;
      let changed = 0;
      if (prev && prev.length === data.length) {
        for (let p = 0; p < data.length; p += 4) {
          if (data[p] !== prev[p] || data[p + 1] !== prev[p + 1] || data[p + 2] !== prev[p + 2]) changed++;
        }
      }
      window.__probePrevPixels = new Uint8ClampedArray(data);
      return { changed, total: (data.length / 4) | 0, hadPrev: !!prev };
    });
    if (d?.hadPrev) deltas.push(d.changed);
    if (i < LIVENESS_SAMPLES - 1) await sleep(LIVENESS_GAP_MS);
  }
  const liveDeltas = deltas.filter((d) => d > 0).length;
  info(`[LIVENESS] changed-pixel counts vs immediately-prior capture, ${LIVENESS_GAP_MS}ms apart: ${deltas.join(', ')}`);
  ok('[LIVENESS] the title-screen window is LIVE, not a frozen last frame (each capture differs from its own immediately-prior capture ~300ms earlier)',
     deltas.length >= 4 && liveDeltas >= Math.ceil(deltas.length / 2),
     `nonzero pairs ${liveDeltas}/${deltas.length}, counts=[${deltas.join(',')}]`);

  // --- Frame-health metrics (same baseline sanity layer as probe-n64-scene-render.mjs) ---
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
  ok('metrics: at least one sample was actually captured (telemetry pipe is alive)',
     metricsLog.length >= 1, `metricsLog.length=${metricsLog.length}`);
  ok('metrics: no core-reported errors across the run', !!last && last.errors === 0, last ? `errors=${last.errors}` : 'no metrics captured');
  ok('metrics: stale FRAME_ACK count is not runaway (frame pump is not silently stalling)',
     !!last && (last.staleFrameAcks || 0) < Math.max(5, framesDelta * 0.1),
     last ? `staleFrameAcks=${last.staleFrameAcks || 0} framesDelta=${framesDelta}` : 'no metrics captured');

  // --- Audio: primary console's SpatialAudio branch actually advanced ---
  const audioState = await page.evaluate(() => window.__rack.audio());
  const primaryBranch = audioState.find((b) => b.console === 'console0');
  ok('audio: primary console (console0) SpatialAudio branch received pushed buffers',
     (primaryBranch?.nextAudioTime || 0) > 0, `nextAudioTime=${primaryBranch?.nextAudioTime}`);

  ok('NO pageerror across the whole boot/render/metrics run', pageErrors.length === 0, JSON.stringify(pageErrors));
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error across the whole boot/render/metrics run', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));

  console.log(`\nScreenshots saved (real canvas.toDataURL() bytes, not a viewport capture): ${shots.map((_, i) => resolve(SHOT_DIR, `n64-mario64-t${i + 1}.png`)).join(', ')}`);
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  // See probe-n64-scene-render.mjs for why this must be awaited taskkill on
  // win32 rather than vite.kill()/process.kill(-pid) (shell:true means
  // vite.pid is the shell's pid, not the real vite process).
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
