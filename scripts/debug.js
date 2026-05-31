// Headless Chrome debug harness for LibretroWebXR.
//
// Drives the deployed (or local) site with puppeteer-core, captures every
// console message, page error, request failure, and (if --rom is passed) a
// synthesised "Load ROM" click so we can see worker boot logs end-to-end
// without asking the user to copy/paste devtools.
//
// Usage:
//   node scripts/debug.js                            # production URL, idle scrape
//   node scripts/debug.js --url=http://localhost:5173/
//   node scripts/debug.js --rom=path/to/file.smc     # also exercises worker startup
//   node scripts/debug.js --screenshot=out.png       # save a render of the scene
//   node scripts/debug.js --headed                   # see the browser window
//   node scripts/debug.js --timeout=20000            # idle wait (ms) after load

import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || true] : [a, true];
  }),
);

let URL = args.url || 'https://dionysus.dk/webxr/libretrowebxr/';
// --core=<name> appends ?core=<name> so the page picks a specific libretro
// core regardless of ROM-extension auto-detection.
if (args.core) {
  const sep = URL.includes('?') ? '&' : '?';
  URL = `${URL}${sep}core=${encodeURIComponent(args.core)}`;
}
const TIMEOUT = parseInt(args.timeout || '8000', 10);
const HEADED = !!args.headed;
const SCREENSHOT = args.screenshot;
const ROM_PATH = args.rom;

// System-Chrome paths we'll try in order.
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
  console.error('No system Chrome/Edge found. Install one or extend CHROME_CANDIDATES.');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: !HEADED,
  args: [
    // SharedArrayBuffer requires either secure context + isolation OR this flag.
    // The site sets COOP/COEP correctly, but the flag is a useful fallback for
    // local file:// or http://localhost smoke tests.
    '--enable-features=SharedArrayBuffer',
    '--no-sandbox',
  ],
});
const page = await browser.newPage();
page.setDefaultTimeout(TIMEOUT);

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);
const events = { console: [], pageerror: [], requestfailed: [], response: [] };

page.on('console', (m) => {
  const text = m.text();
  events.console.push({ type: m.type(), text });
  log(`console:${m.type()}`, text);
});
page.on('pageerror', (e) => {
  events.pageerror.push(e.message);
  log('pageerror', e.message);
});
page.on('requestfailed', (r) => {
  const f = `${r.method()} ${r.url()} — ${r.failure()?.errorText}`;
  events.requestfailed.push(f);
  log('requestfailed', f);
});
page.on('response', (r) => {
  // Only flag non-2xx — 2xx noise drowns out real problems.
  if (r.status() >= 400) {
    const f = `${r.status()} ${r.url()}`;
    events.response.push(f);
    log('response:err', f);
  }
});

console.log(`# loading ${URL}`);
const navResp = await page.goto(URL, { waitUntil: 'load' });
console.log(`# nav status: ${navResp?.status()}`);

// Confirm cross-origin isolation actually took effect (the libretro pthread
// pool will silently refuse to start without it).
const isolated = await page.evaluate(() => self.crossOriginIsolated);
console.log(`# crossOriginIsolated: ${isolated}`);

// Snapshot scene + DOM sanity checks before the wait.
const sceneInfo = await page.evaluate(() => {
  const c = document.querySelector('#stage canvas');
  const placeholder = document.querySelector('#placeholder-canvas');
  const emu = document.querySelector('#canvas');
  return {
    hasThreeCanvas: !!c,
    threeCanvasSize: c ? `${c.width}x${c.height}` : null,
    placeholderSize: placeholder ? `${placeholder.width}x${placeholder.height}` : null,
    emuCanvasSize: emu ? `${emu.width}x${emu.height}` : null,
    sceneChildren: window.__scene?.scene?.children?.length ?? null,
    rendererPresenting: window.__scene?.renderer?.xr?.isPresenting ?? null,
    emulatorReady: window.__client?.ready ?? null,
  };
});
console.log('# scene:', sceneInfo);

if (ROM_PATH) {
  const romBasename = ROM_PATH.split(/[\\/]/).pop();
  console.log(`# injecting ROM: ${ROM_PATH} (basename ${romBasename})`);
  const romBytes = readFileSync(resolve(ROM_PATH));
  // Hand the bytes into the page and trigger the same code path the file
  // picker uses, with the real filename so the page's ROM-extension →
  // core auto-detection picks the right libretro core.
  await page.evaluate(async (b64, filename) => {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const file = new File([buf], filename, { type: 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('#rom-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, romBytes.toString('base64'), romBasename);
}

console.log(`# idling ${TIMEOUT}ms to collect logs…`);
await new Promise((r) => setTimeout(r, TIMEOUT));

if (SCREENSHOT) {
  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  console.log(`# screenshot saved: ${SCREENSHOT}`);
}

await browser.close();

// Exit code carries the verdict so this is CI-friendly: 0 = healthy idle,
// 1 = errors observed, 2 = setup failure.
const hadErrors =
  events.pageerror.length > 0 ||
  events.requestfailed.length > 0 ||
  events.console.some((c) => c.type === 'error') ||
  isolated !== true;

console.log('\n# summary');
console.log(`  console msgs:    ${events.console.length}`);
console.log(`  console errors:  ${events.console.filter((c) => c.type === 'error').length}`);
console.log(`  page errors:     ${events.pageerror.length}`);
console.log(`  request failures:${events.requestfailed.length}`);
console.log(`  4xx/5xx:         ${events.response.length}`);
console.log(`  verdict:         ${hadErrors ? 'FAIL' : 'OK'}`);

process.exit(hadErrors ? 1 : 0);
