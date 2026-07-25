// Boots the authored CC0 PSX test disc (games/psx-testdisc, a real CUE+BIN
// built with PSn00bSDK — see scripts/make-psx-testdisc.mjs) through the real
// browser core artifact via WorkerEmulatorClient, exercising the actual
// CD-ROM/BIOS disc-boot path (not a bare .exe like scripts/probe-psx-core.js
// exercises). This proves the disc loads through the real content pipeline
// with no track/file/fatal errors and produces continuous audio + JIT
// execution + a non-blank frame. It does NOT prove our authored content's
// own draw calls are what's on screen — see docs/PSX_TESTDISC.md "Known
// gap" for the isolation testing behind that distinction, and
// test/psx-core-e2e/harness-disc.js's header comment for specifics. The
// memory-card round-trip fields are captured for completeness but are
// expected to read back null in this environment (P0-5 SaveRAM-flush
// plumbing, being addressed by a separate, concurrent effort).

import assert from 'node:assert/strict';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CORE_BASENAME = 'mednafen_psx_jit_libretro';
const REQUIRED = [
  `public/cores/${CORE_BASENAME}.js`,
  `public/cores/${CORE_BASENAME}.wasm`,
  'public/roms/freeware/lwx-psx-testdisc.cue',
  'public/roms/freeware/lwx-psx-testdisc.bin',
];
const missing = REQUIRED.filter((path) => !existsSync(resolve(PROJECT_ROOT, path)));
if (missing.length) {
  console.error([
    'PSX disc-boot probe cannot start: required artifact is absent.',
    ...missing.map((path) => `  missing: ${path}`),
    'Build the test disc first:',
    '  node scripts/make-psx-testdisc.mjs',
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
  console.error('PSX disc-boot probe cannot start: no system Chrome/Edge found.');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.cue': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
};

function resolveRequest(pathname) {
  if (pathname === '/') return resolve(PROJECT_ROOT, 'test/psx-core-e2e/index-disc.html');
  if (pathname.startsWith('/cores/')) return resolve(PROJECT_ROOT, `public${pathname}`);
  if (pathname.startsWith('/disc/')) return resolve(PROJECT_ROOT, `public/roms/freeware/${pathname.slice('/disc/'.length)}`);
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
  await page.setViewport({ width: 660, height: 520 });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') browserErrors.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));

  const response = await page.goto(`${origin}/test/psx-core-e2e/index-disc.html`, { waitUntil: 'load' });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => typeof globalThis.runPsxDiscE2E === 'function');

  const bootTimeoutMs = Number(process.env.PSX_DISC_BOOT_TIMEOUT_MS || 30000);
  const resultPromise = page.evaluate((options) => globalThis.runPsxDiscE2E(options), {
    coreUrl: `${origin}/cores/${CORE_BASENAME}.js`,
    cueUrl: `${origin}/disc/lwx-psx-testdisc.cue`,
    binUrl: `${origin}/disc/lwx-psx-testdisc.bin`,
    bootTimeoutMs,
    autoSaveFrame: 180,
  });

  // Grab a mid-run screenshot once video is non-blank as separate proof of
  // real rendered output (independent of the pixel-sampling assertions
  // inside the harness itself).
  const shotDir = resolve(PROJECT_ROOT, 'tmp');
  mkdirSync(shotDir, { recursive: true });
  await new Promise((r) => setTimeout(r, Math.min(6000, bootTimeoutMs / 2)));
  try {
    const canvas = await page.$('#output');
    if (canvas) await canvas.screenshot({ path: resolve(shotDir, 'psx-testdisc-boot.png') });
  } catch (_) { /* best-effort mid-run shot; final result still asserted below */ }

  const result = await resultPromise;

  assert.equal(result.crossOriginIsolated, true);
  assert.ok(result.frames.presented >= 3, 'real PSX disc boot did not present frames');
  assert.ok(result.videoAtBoot.lit > 0, 'real PSX disc-boot output remained blank');
  assert.ok(result.videoAfterSave.lit > 0, 'real PSX disc video went blank after the save trigger');
  assert.ok(result.videoAfterReset.lit > 0, 'real PSX disc video went blank after soft reset');
  assert.equal(result.errorLogCount, 0);
  assert.deepEqual(result.workerErrors, []);
  assert.deepEqual(browserErrors, []);

  // Final screenshot for a clean end-state proof.
  try {
    const canvas = await page.$('#output');
    if (canvas) await canvas.screenshot({ path: resolve(shotDir, 'psx-testdisc-final.png') });
  } catch (_) { /* best-effort */ }

  writeFileSync(resolve(shotDir, 'psx-testdisc-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log('Real PSX disc-boot browser probe PASSED (disc-boot pipeline verified; see docs/PSX_TESTDISC.md for what this does/does not prove about on-screen content)');
} catch (error) {
  console.error('Real PSX disc-boot browser probe FAILED');
  if (browserErrors.length) console.error(browserErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
