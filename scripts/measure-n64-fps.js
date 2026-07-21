// Measures interpreter-baseline N64 fps against a real 3D scene (rotating
// cube, not the flat-fill smoke ROM) on desktop Chrome, via the same
// worker-core path the app itself uses. This is Phase N0 item 3 of
// docs/research/n64-wasm-jit-plan.md's exit gate: no commercial N64 ROM is
// available or sourced for this repo, so games/n64-scene (an authored CC0
// scene) stands in for "a representative commercial 3D title".
//
// Quest 3 fps is NOT measured here - this only runs a real browser
// (headless Chrome/swiftshader software GL), which is not representative
// of Quest's GPU. Quest measurement requires the physical headset; see
// docs/N64_CORE_BUILD.md for how to read back Quest-side numbers once this
// build is deployed.

import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CORE_BASENAME = 'mupen64plus_next_libretro';
const ROM_FILENAME = 'lwx-n64-scene.z64';
const REQUIRED = [
  `public/cores/${CORE_BASENAME}.js`,
  `public/cores/${CORE_BASENAME}.wasm`,
  `public/roms/freeware/${ROM_FILENAME}`,
];
const missing = REQUIRED.filter((path) => !existsSync(resolve(PROJECT_ROOT, path)));
if (missing.length) {
  console.error([
    'N64 fps measurement cannot start: required build artifact is absent.',
    ...missing.map((path) => `  missing: ${path}`),
    '  see docs/N64_CORE_BUILD.md, and: node scripts/make-n64-scene.mjs',
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
  console.error('N64 fps measurement cannot start: no system Chrome/Edge found.');
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
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));

  const response = await page.goto(`${origin}/test/n64-core-e2e/index.html`, { waitUntil: 'load' });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => typeof globalThis.measureN64Fps === 'function');
  const measureMs = Number(process.env.N64_FPS_MEASURE_MS || 12000);
  const result = await page.evaluate((options) => globalThis.measureN64Fps(options), {
    coreUrl: `${origin}/cores/${CORE_BASENAME}.js`,
    contentUrl: `${origin}/public/roms/freeware/${ROM_FILENAME}`,
    romFilename: ROM_FILENAME,
    bootTimeoutMs: Number(process.env.N64_CORE_BOOT_TIMEOUT_MS || 30000),
    measureMs,
  });

  assert.deepEqual(browserErrors, []);
  assert.ok(result.video && result.video.lit > 0, 'N64 scene output remained blank during measurement');

  console.log(JSON.stringify(result, null, 2));
  console.log(`Desktop (headless swiftshader) interpreter-baseline N64 fps: ${result.fps.toFixed(2)}`);
  console.log('Phase N0 item 3 (desktop half): measured. Quest 3 fps still requires the physical headset.');
} catch (error) {
  console.error('N64 fps measurement FAILED');
  if (browserErrors.length) console.error(browserErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
