// Boots the real DOSBox Pure core artifact headlessly. This is a BOOT SMOKE
// TEST, not a rendering-correctness probe (see test/dos-core-e2e/harness.js
// header) — the real open question, per the 2026-07-29 build commit
// ("Build a working DOSBox Pure core for DOS"), is whether DBP_ThreadControl's
// real pthread_create() runs at all from inside this app's OWN dedicated
// execution Worker (a worker-in-worker topology no other core here has
// exercised), not whether any particular content renders correctly.

import assert from 'node:assert/strict';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CORE_BASENAME = 'dosbox_pure_libretro';
const REQUIRED = [
  `public/cores/${CORE_BASENAME}.js`,
  `public/cores/${CORE_BASENAME}.wasm`,
  `public/cores/${CORE_BASENAME}.worker.js`,
];
const missing = REQUIRED.filter((path) => !existsSync(resolve(PROJECT_ROOT, path)));
if (missing.length) {
  console.error([
    'DOS real-core browser probe cannot start: required build artifact is absent.',
    ...missing.map((path) => `  missing: ${path}`),
    'Build the core first: see scripts/cores/dos/build.sh and docs/DOS_CORE_BUILD.md.',
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
  console.error('DOS real-core browser probe cannot start: no system Chrome/Edge found.');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

function resolveRequest(pathname) {
  if (pathname === '/') return resolve(PROJECT_ROOT, 'test/dos-core-e2e/index.html');
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

  const response = await page.goto(`${origin}/test/dos-core-e2e/index.html`, { waitUntil: 'load' });
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => typeof globalThis.runDosCoreE2E === 'function');
  const bootTimeoutMs = Number(process.env.DOS_CORE_BOOT_TIMEOUT_MS || 30000);
  const result = await page.evaluate((options) => globalThis.runDosCoreE2E(options), {
    coreUrl: `${origin}/cores/${CORE_BASENAME}.js`,
    bootTimeoutMs,
  });

  assert.equal(result.crossOriginIsolated, true);
  assert.ok(result.frames.presented >= 3, 'real DOS core did not present three frames');
  assert.ok(result.video.lit > 0, 'real DOS core output was blacked out');
  assert.equal(result.errorLogCount, 0, `core emitted error log output: ${JSON.stringify(result.allLogs)}`);
  assert.deepEqual(result.workerErrors, []);
  assert.deepEqual(browserErrors, []);

  console.log(JSON.stringify(result, null, 2));
  console.log('Real DOS (DOSBox Pure) worker-core browser probe PASSED');
} catch (error) {
  console.error('Real DOS (DOSBox Pure) worker-core browser probe FAILED');
  if (browserErrors.length) console.error(browserErrors.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
