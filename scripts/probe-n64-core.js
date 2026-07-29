// Boots the legal libdragon smoke ROM in the real browser core artifact.
// Unlike the adapter/unit probes, this must exercise WorkerEmulatorClient,
// RetroArch, and mupen64plus_next as one system. Phase N0 is
// interpreter-only (see docs/N64_CORE_BUILD.md) — no native-JIT evidence
// is expected here, unlike scripts/probe-psx-core.js.
//
// ── 2026-07-29 check audit ────────────────────────────────────────────────
// This probe used to end at `result.video.lit > 0` (test/n64-core-e2e/
// harness.js: "at least one of 5 sampled points has r+g+b > 30"), and that
// number was cited in docs/N64_CORE_BUILD.md as "non-blank video" evidence
// that a GLideN64 rendering fix worked. It does not support that claim.
// Two negative controls were built (scratch checkout, junctioned to the real
// public/ and node_modules/) and run against this probe:
//
//   1. VIDEO FROZEN AT BOOT — the worker frame pump keeps presenting, but
//      re-presents the 1st (then the 4th) produced frame forever, i.e. the
//      core boots and then stops executing the ROM. Result: probe went RED
//      ("timed out waiting for non-blank N64 smoke-test video") both times.
//      So `lit > 0` is not vacuous: it does catch a total video blackout.
//      Move the same freeze 2.5s later, though — a core that boots, runs
//      briefly and then hangs — and `lit > 0` went GREEN again.
//
//   2. WRONG ROM DELIVERED — hydrateLaunch() silently writes a DIFFERENT
//      ROM (lwx-n64-scene.z64) under the requested entry path, so the smoke
//      ROM never runs. Result: probe stayed GREEN with byte-identical
//      evidence — frames.presented 6, video.lit 5, every sample [8,8,16].
//      That (8,8,16) is the scene ROM's own dark-navy background, and it is
//      the exact case scripts/probe-n64-scene-render.mjs's header warns
//      about: the background alone sums to 32, two units over the > 30
//      threshold, so a cleared background with nothing drawn on it reads as
//      "lit". The repo's own history has the matching real case — the
//      GLideN64 fill-mode LLE-triangle bug (docs/N64_CORE_BUILD.md) kept
//      this probe green while every cube triangle rendered black.
//
// So `lit > 0` is kept, but ONLY as an artifact-loads / not-blacked-out
// smoke check, and its message now says so. The rendering claim is carried
// by the render-evidence stage below, which is a WITHIN-RUN RELATIVE
// comparison and was validated in both directions against those same two
// negative controls (see RENDER EVIDENCE below for the numbers).

import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CORE_BASENAME = 'mupen64plus_next_libretro';
const ROM_FILENAME = 'lwx-n64-smoke.z64';
const REQUIRED = [
  `public/cores/${CORE_BASENAME}.js`,
  `public/cores/${CORE_BASENAME}.wasm`,
  `public/roms/freeware/${ROM_FILENAME}`,
];
const missing = REQUIRED.filter((path) => !existsSync(resolve(PROJECT_ROOT, path)));
if (missing.length) {
  console.error([
    'N64 real-core browser probe cannot start: required build artifact is absent.',
    ...missing.map((path) => `  missing: ${path}`),
    'Build the pinned core and the smoke ROM first, then rerun this probe.',
    '  see docs/N64_CORE_BUILD.md, and: node scripts/make-n64-smoke.mjs',
  ].join('\n'));
  process.exit(2);
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const executablePath = CHROME_CANDIDATES.find(existsSync);
if (!executablePath) {
  console.error('N64 real-core browser probe cannot start: no system Chrome/Edge found.');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.z64': 'application/octet-stream',
};

function resolveRequest(pathname) {
  if (pathname === '/') return resolve(PROJECT_ROOT, 'test/n64-core-e2e/index.html');
  if (pathname.startsWith('/cores/')) return resolve(PROJECT_ROOT, `public${pathname}`);
  return resolve(PROJECT_ROOT, `.${pathname}`);
}

// ── RENDER EVIDENCE ───────────────────────────────────────────────────────
// games/n64-smoke/main.c repaints the WHOLE 320x240 screen every emulated
// frame with graphics_make_color((f*3)&255, (f*5)&255, (f*7)&255), f being
// its own frame counter, via rdp_draw_filled_rectangle — i.e. real RDP draw
// commands GLideN64 has to translate, not CPU framebuffer writes. The 16bpp
// framebuffer quantises each channel to 5 bits and GLideN64 expands them back
// with bit replication ((v << 3) | (v >> 2)). Those two facts give this ROM a
// signature that elapsed time, animation drift or other content cannot
// imitate.
//
// The check samples the SAME five canvas points repeatedly while the core
// free-runs, and gates on two arms taken from the same captures:
//
//   CONTROL arm (must be EXACTLY 0): on each individual capture, the four
//     corner points minus the centre point. This ROM paints one uniform
//     full-screen fill, so anything else on screen — another ROM's content,
//     a menu, a partially-drawn frame — makes this non-zero. Measured at the
//     same instant as the signal, so elapsed time cannot contaminate it.
//   SIGNAL arm (must be repeatedly non-zero): each capture's centre pixel
//     against its OWN immediately-prior capture. Zero for every pair means
//     the picture is frozen, i.e. the ROM is not executing.
//
// plus an identity gate: every observed colour must decode to a single
// consistent f under this ROM's own generator. An arbitrary colour satisfies
// all three channels with roughly 1/1024 probability.
//
// Validated in BOTH directions on 2026-07-29 against the real core artifact
// (headless Chrome, swiftshader), same three builds as the audit header:
//
//   real repo               captures 70/69  nonUniform 0   offRamp 0  staticRun 3   distinct 64/63  PASS
//   wrong-ROM control       captures 70     nonUniform 67  (fails CONTROL arm)                      FAIL
//   frozen-2.5s-in control  captures 68     nonUniform 0   offRamp 0  staticRun 49  distinct 17     FAIL
//   frozen-at-boot control  never reaches this stage — dies at the smoke check above FAIL
//
// If you weaken any threshold here, re-run those controls. A check that has
// not been seen going RED is not evidence.
const SAMPLE_POINTS = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
const RENDER_MEASURE_MS = Number(process.env.N64_RENDER_MEASURE_MS || 9000);
const MIN_RENDER_CAPTURES = 20;
const MIN_DISTINCT_COLOURS = 8;
// Longest tolerated run of consecutive captures showing the SAME fill colour.
// Captures are ~130ms apart, so 8 is about 1 second of the screen not being
// repainted. Measured: a healthy run's longest static run is 1-2 even at
// ~25 fps; a core that hangs part-way through the window runs to ~50. An
// aggregate "how many pairs changed" count is NOT enough here — a core frozen
// 2.5s into the window still cleared a 10-changed-pairs bar (16/67), which is
// exactly the sort of partial credit this audit exists to remove.
const MAX_STATIC_RUN = 8;

// Per-channel slack when matching an observed colour against the ROM's own
// generator, in 8-bit units. Measured, not guessed: on a real run every
// observed fill colour lands within 1 (the 5-bit framebuffer's rounding), while
// the wrong-ROM control's cube face colours land 17..49 off. 2 sits in that gap
// with an order of magnitude of margin either side.
const RAMP_TOLERANCE = 2;
const expand5 = (value) => ((value << 3) | (value >> 2)) & 0xFF;
const SMOKE_RAMP = [];
for (let frame = 0; frame < 256; frame++) {
  SMOKE_RAMP.push([3, 5, 7].map((k) => expand5(((k * frame) & 0xFF) >> 3)));
}

// Smallest per-channel error between `colour` and any frame of the smoke ROM's
// colour sequence. <= RAMP_TOLERANCE means this pixel provably came from THIS
// ROM's program.
function rampError(colour) {
  let best = 255;
  for (const candidate of SMOKE_RAMP) {
    const error = Math.max(
      Math.abs(candidate[0] - colour[0]),
      Math.abs(candidate[1] - colour[1]),
      Math.abs(candidate[2] - colour[2]),
    );
    if (error < best) best = error;
    if (best === 0) break;
  }
  return best;
}

function analyseCaptures(captures) {
  let spatialNonUniform = 0;
  let offRamp = 0;
  let changedPairs = 0;
  let staticRun = 0;
  let longestStaticRun = 0;
  const distinct = new Set();
  const offRampSamples = [];
  let previous = null;
  for (const points of captures) {
    const [centre, ...corners] = points;
    const centreKey = centre.join(',');
    if (corners.some((corner) => corner.join(',') !== centreKey)) spatialNonUniform++;
    const error = rampError(centre);
    if (error > RAMP_TOLERANCE) {
      offRamp++;
      if (offRampSamples.length < 5) offRampSamples.push(`(${centreKey}) off by ${error}`);
    }
    distinct.add(centreKey);
    if (previous === null) {
      staticRun = 1;
    } else if (previous === centreKey) {
      staticRun++;
    } else {
      changedPairs++;
      staticRun = 1;
    }
    if (staticRun > longestStaticRun) longestStaticRun = staticRun;
    previous = centreKey;
  }
  return {
    captures: captures.length,
    spatialNonUniform,
    offRamp,
    offRampSamples,
    changedPairs,
    longestStaticRun,
    distinctColours: distinct.size,
  };
}

async function sampleCanvas(page) {
  return page.evaluate((points) => {
    const canvas = document.querySelector('#output');
    if (!canvas?.width || !canvas?.height) return null;
    const context = canvas.getContext('2d', { alpha: false });
    return points.map(([x, y]) => {
      const pixel = context.getImageData(
        Math.min(canvas.width - 1, Math.floor(canvas.width * x)),
        Math.min(canvas.height - 1, Math.floor(canvas.height * y)),
        1,
        1,
      ).data;
      return [pixel[0], pixel[1], pixel[2]];
    });
  }, SAMPLE_POINTS);
}

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  const absolute = resolveRequest(pathname);
  const insideRoot = absolute === PROJECT_ROOT || absolute.startsWith(`${PROJECT_ROOT}${sep}`);
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:");
  response.setHeader('Cache-Control', 'no-store');
  if (!insideRoot || !existsSync(absolute) || !statSync(absolute).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': MIME[extname(absolute)] || 'application/octet-stream' });
  createReadStream(absolute).pipe(response);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const browserErrors = [];

try {
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') browserErrors.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));

  const response = await page.goto(`${origin}/test/n64-core-e2e/index.html`, { waitUntil: 'load' });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => typeof globalThis.runN64CoreE2E === 'function');
  const result = await page.evaluate((options) => globalThis.runN64CoreE2E(options), {
    coreUrl: `${origin}/cores/${CORE_BASENAME}.js`,
    contentUrl: `${origin}/public/roms/freeware/${ROM_FILENAME}`,
    bootTimeoutMs: Number(process.env.N64_CORE_BOOT_TIMEOUT_MS || 30000),
  });

  assert.equal(result.crossOriginIsolated, true);
  assert.ok(result.frames.presented >= 3, 'real N64 core did not present three frames');
  // NOT rendering evidence. This only establishes that the core artifact
  // loaded and the canvas was not left entirely blacked out; it stays green
  // when a completely different ROM is running (see the check-audit header).
  // The rendering claim is the render-evidence stage below.
  assert.ok(result.video.lit > 0, 'real N64 core output was blacked out (artifact-loads smoke check — NOT proof the smoke ROM rendered)');
  assert.equal(result.errorLogCount, 0);
  assert.deepEqual(result.workerErrors, []);

  // ── render-evidence stage ───────────────────────────────────────────────
  await page.waitForFunction(() => typeof globalThis.measureN64Fps === 'function');
  let measureDone = false;
  const measurePromise = page.evaluate((options) => globalThis.measureN64Fps(options), {
    coreUrl: `${origin}/cores/${CORE_BASENAME}.js`,
    contentUrl: `${origin}/public/roms/freeware/${ROM_FILENAME}`,
    romFilename: ROM_FILENAME,
    bootTimeoutMs: Number(process.env.N64_CORE_BOOT_TIMEOUT_MS || 30000),
    measureMs: RENDER_MEASURE_MS,
  }).then(
    (value) => { measureDone = true; return value; },
    (error) => { measureDone = true; throw error; },
  );
  measurePromise.catch(() => {});

  const captures = [];
  while (!measureDone) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 120));
    if (measureDone) break;
    const sample = await sampleCanvas(page).catch(() => null);
    if (sample) captures.push(sample);
  }
  const measured = await measurePromise;
  const render = analyseCaptures(captures);

  assert.ok(
    render.captures >= MIN_RENDER_CAPTURES,
    `render evidence collected only ${render.captures} canvas captures (need ${MIN_RENDER_CAPTURES})`,
  );
  // CONTROL arm — same frame, corners vs centre. Must be exactly 0.
  assert.equal(
    render.spatialNonUniform,
    0,
    `CONTROL arm: ${render.spatialNonUniform}/${render.captures} captures were not a uniform full-screen fill — what is on screen is not this ROM`,
  );
  // Identity — every colour must come from this ROM's own (3f,5f,7f) generator.
  assert.equal(
    render.offRamp,
    0,
    `IDENTITY: ${render.offRamp}/${render.captures} captures are not on the smoke ROM's colour ramp (e.g. ${render.offRampSamples.join(' ')})`,
  );
  // SIGNAL arm — each capture against its own immediately-prior capture.
  assert.ok(
    render.longestStaticRun <= MAX_STATIC_RUN,
    `SIGNAL arm: the fill colour went unchanged for ${render.longestStaticRun} consecutive captures (max ${MAX_STATIC_RUN}) — the ROM stopped repainting part-way through the window`,
  );
  assert.ok(
    render.distinctColours >= MIN_DISTINCT_COLOURS,
    `SIGNAL arm: only ${render.distinctColours} distinct fill colours observed (need ${MIN_DISTINCT_COLOURS})`,
  );

  assert.deepEqual(browserErrors, []);

  console.log(JSON.stringify({ ...result, render, fps: measured.fps }, null, 2));
  console.log('Real N64 worker-core browser probe PASSED');
} catch (error) {
  console.error('Real N64 worker-core browser probe FAILED');
  if (browserErrors.length) console.error(browserErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
