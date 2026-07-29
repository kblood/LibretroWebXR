// Boots the legal PS-X EXE smoke workload in the real browser core artifact,
// exercising WorkerEmulatorClient + RetroArch + Beetle PSX + the worker video
// and audio paths as one system.
//
// Scope warning, please read before trusting a PASS here: the bare-.exe path
// does not actually execute the smoke payload in this build (Beetle's
// LoadEXE() patches a retail-Sony-BIOS address that means nothing to the
// bundled OpenBIOS, which then just runs its own shell demo), and the
// Lightrec/Wasm JIT is deliberately disabled in RETROARCH_CORE_OPTIONS because
// it segfaults on real content. Both are explained at length in
// test/psx-core-e2e/harness.js's header, src/RetroArchConfig.js and
// docs/PSX_CORE_BUILD.md. A PASS here therefore means "the core artifact loads
// and stays alive end-to-end", not "our PSX content ran" and not "the JIT
// worked". Set PSX_REQUIRE_JIT=1 to re-arm the strict JIT assertion once the
// core is rebuilt and beetle_psx_cpu_dynarec is turned back on.
// Real authored-content coverage is `npm run probe:psx-testdisc`.
//
// Audit, 2026-07-29 — what a PASS here is and is not evidence for, each line
// established by a negative control that was actually run, not by reasoning:
//
//  * IS evidence that the core artifact loads, boots, renders and is STILL
//    emulating when the probe finishes. The last of those is carried solely by
//    the liveness assertion added below; it fails (tailGuestAdvanced 0/8, 30
//    presentations) against a scratch copy whose emulation loop is frozen with
//    Module.pauseMainLoop() after boot, and passes (8/8, 44 presentations) on
//    a healthy run.
//  * Is NOT evidence about the CONTENT. Zeroing the whole body of
//    psx-jit-smoke.exe past its 0x800 header in a scratch checkout changes
//    nothing: the probe still passes (presented 163, video.lit 5, 327 audio
//    events), because OpenBIOS runs its own shell demo either way, exactly as
//    the scope warning above says. Do not cite this probe for "our PS-X EXE
//    smoke payload ran".
//  * Is NOT evidence about the JIT. The JIT assertion is env-gated off by
//    default (PSX_REQUIRE_JIT), and a default run reports jit: null.
//  * `video.lit > 0` on its own is near-vacuous: in a healthy run all five of
//    its sample points read the SAME flat colour (the background clear), and it
//    stayed at 5 under both negative controls above. It is kept only because it
//    still catches a core that never renders at all.

import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CORE_BASENAME = 'mednafen_psx_jit_libretro';
const REQUIRED = [
  `public/cores/${CORE_BASENAME}.js`,
  `public/cores/${CORE_BASENAME}.wasm`,
  'scripts/cores/psx/test-content/psx-jit-smoke.exe',
];
const missing = REQUIRED.filter((path) => !existsSync(resolve(PROJECT_ROOT, path)));
if (missing.length) {
  console.error([
    'PSX real-core browser probe cannot start: required build artifact is absent.',
    ...missing.map((path) => `  missing: ${path}`),
    'Build and install the pinned core first, then rerun this probe.',
    '  wsl bash scripts/cores/psx/core-build/build.sh',
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
  console.error('PSX real-core browser probe cannot start: no system Chrome/Edge found.');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.exe': 'application/octet-stream',
};

function resolveRequest(pathname) {
  if (pathname === '/') return resolve(PROJECT_ROOT, 'test/psx-core-e2e/index.html');
  if (pathname.startsWith('/cores/')) return resolve(PROJECT_ROOT, `public${pathname}`);
  return resolve(PROJECT_ROOT, `.${pathname}`);
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

  const response = await page.goto(`${origin}/test/psx-core-e2e/index.html`, { waitUntil: 'load' });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => typeof globalThis.runPsxCoreE2E === 'function');

  // ---- Liveness instrumentation: a WITHIN-RUN, TWO-ARM comparison ----------
  //
  // Why this exists (audit, 2026-07-29). The assertions below it —
  // `frames.presented >= 3` and `video.lit > 0` — cannot tell a running core
  // from a DEAD one. Both were shown to stay green against a negative control
  // in which the core booted normally and its emulation loop was then frozen
  // (`Module.pauseMainLoop()` once audio was flowing): the worker frame pump
  // keeps calling `OffscreenCanvas.transferToImageBitmap()` on the core's
  // now-frozen canvas, so frames keep being "presented" and the last rendered
  // picture keeps satisfying `lit > 0` forever. `video.lit` is weaker still —
  // in a healthy run all five of its sample points read the SAME flat colour
  // (the OpenBIOS background clear), so it is satisfied by a clear alone.
  //
  // The fix is a relative comparison rather than an absolute one. Over every
  // sampling interval we measure two quantities at the SAME two instants on
  // the SAME canvas, differing only in what drives them:
  //   HOST arm  — canvas presentations (CanvasRenderingContext2D.drawImage
  //               calls from FrameBridge._present). Advances whenever the page
  //               + worker plumbing is alive, whether or not the guest runs.
  //   GUEST arm — the canvas CONTENT signature. Can only change if the core
  //               actually emulated new output between the two instants.
  // Each sample is compared against its own immediately-prior sample, so
  // elapsed time, boot transients and one-off state drift cancel out. An
  // interval where the HOST arm advanced but the GUEST arm did not is a frozen
  // core. The gate looks at the TAIL of the run (see __psxLiveness below):
  // gating on "any interval anywhere" is not enough, and was measured not to be
  // — the frozen negative control still scored 8 healthy pre-freeze intervals
  // and sailed through that weaker form of this very check.
  //
  // The instrumentation lives here rather than in test/psx-core-e2e/harness.js
  // so the harness's own result stays exactly what it always was.
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const nativeDrawImage = proto.drawImage;
    globalThis.__psxPresentCount = 0;
    proto.drawImage = function drawImage(...args) {
      globalThis.__psxPresentCount++;
      return nativeDrawImage.apply(this, args);
    };

    const GRID = 16;
    const intervals = [];
    let previous = null;
    let previousPresented = 0;

    const signature = () => {
      const canvas = document.querySelector('#output');
      if (!canvas || !canvas.width || !canvas.height) return null;
      // Same context attributes FrameBridge uses, so that if this ever wins the
      // race to create the 2D context the core's presentation path is unchanged.
      const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (!context) return null;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const cells = new Uint8Array(GRID * GRID * 3);
      for (let gy = 0; gy < GRID; gy++) {
        for (let gx = 0; gx < GRID; gx++) {
          const x = Math.min(canvas.width - 1, Math.floor((gx + 0.5) * canvas.width / GRID));
          const y = Math.min(canvas.height - 1, Math.floor((gy + 0.5) * canvas.height / GRID));
          const offset = (y * canvas.width + x) * 4;
          const cell = (gy * GRID + gx) * 3;
          cells[cell] = data[offset];
          cells[cell + 1] = data[offset + 1];
          cells[cell + 2] = data[offset + 2];
        }
      }
      return cells;
    };

    const timer = setInterval(() => {
      try {
        const presented = globalThis.__psxPresentCount;
        const current = signature();
        if (!current) return;
        if (previous) {
          let changedCells = 0;
          for (let index = 0; index < current.length; index += 3) {
            if (current[index] !== previous[index]
              || current[index + 1] !== previous[index + 1]
              || current[index + 2] !== previous[index + 2]) changedCells++;
          }
          intervals.push({ host: presented - previousPresented, guest: changedCells });
        }
        previous = current;
        previousPresented = presented;
      } catch (_) { /* a sampling miss must never fail the run on its own */ }
    }, 120);

    globalThis.__psxLiveness = () => {
      clearInterval(timer);
      proto.drawImage = nativeDrawImage;
      const live = intervals.filter((interval) => interval.host > 0);
      // The TAIL is what carries "stays alive". A core that boots, renders and
      // then dies still racks up plenty of healthy early intervals — the frozen
      // negative control scored 8 of them — so the gate has to ask whether the
      // guest was still advancing at the END of the observed window. Intervals
      // after the harness tears the client down have host === 0 and are
      // excluded here, so the tail is the last real presentation activity.
      const TAIL = 8;
      const tail = live.slice(-TAIL);
      return {
        intervals: intervals.length,
        // Control arm: intervals in which the presentation path demonstrably ran.
        hostLiveIntervals: live.length,
        // Test arm, measured over exactly those same intervals.
        guestAdvancedIntervals: live.filter((interval) => interval.guest > 0).length,
        frozenIntervals: live.filter((interval) => interval.guest === 0).length,
        tailLiveIntervals: tail.length,
        tailGuestAdvanced: tail.filter((interval) => interval.guest > 0).length,
        tailPresentations: tail.reduce((total, interval) => total + interval.host, 0),
        maxChangedCells: live.reduce((best, interval) => Math.max(best, interval.guest), 0),
        totalPresentations: globalThis.__psxPresentCount,
      };
    };
  });

  const result = await page.evaluate((options) => globalThis.runPsxCoreE2E(options), {
    coreUrl: `${origin}/cores/${CORE_BASENAME}.js`,
    contentUrl: `${origin}/scripts/cores/psx/test-content/psx-jit-smoke.exe`,
    bootTimeoutMs: Number(process.env.PSX_CORE_BOOT_TIMEOUT_MS || 30000),
    requireJit: process.env.PSX_REQUIRE_JIT === '1',
  });

  const liveness = await page.evaluate(() => globalThis.__psxLiveness());
  result.liveness = liveness;

  assert.equal(result.crossOriginIsolated, true);
  // Weak on their own — kept because they still catch a core that never loads
  // or never renders at all. Neither can fail for a core that dies after boot;
  // see the liveness comment above and the assertion below.
  assert.ok(result.frames.presented >= 3, 'real PSX core did not present three frames');
  assert.ok(result.video.lit > 0, 'real PSX core output remained blank');
  // Control arm first: if the presentation path never advanced, a flat guest
  // arm would be meaningless and this run cannot decide anything either way.
  assert.ok(liveness.tailLiveIntervals > 0 && liveness.tailPresentations > 0,
    'liveness instrumentation never observed a canvas presentation, so the guest-progress arm has no control to compare against');
  // Test arm, over exactly those same intervals: the picture must still be
  // changing while the presentation path is still running.
  assert.ok(liveness.tailGuestAdvanced > 0,
    `real PSX core stopped emulating: over the last ${liveness.tailLiveIntervals} interval(s) the presentation path delivered ${liveness.tailPresentations} frame(s) to the canvas but its content never changed (a frozen core keeps "presenting" its last frame forever)`);
  if (process.env.PSX_REQUIRE_JIT === '1') {
    assert.ok(result.jit, 'real PSX core produced no JIT evidence');
    assert.ok(result.jit.psxJitCompiledBlocks > 0 || result.jit.bridge?.compiled > 0, 'real PSX core produced no JIT evidence');
  }
  assert.equal(result.errorLogCount, 0);
  assert.deepEqual(result.workerErrors, []);
  assert.deepEqual(browserErrors, []);

  console.log(JSON.stringify(result, null, 2));
  console.log(process.env.PSX_REQUIRE_JIT === '1'
    ? 'Real PSX worker-core browser probe PASSED (including the strict JIT assertion)'
    : 'Real PSX worker-core browser probe PASSED (core loads/stays alive; JIT assertion parked, see this file header)');
} catch (error) {
  console.error('Real PSX worker-core browser probe FAILED');
  if (browserErrors.length) console.error(browserErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

