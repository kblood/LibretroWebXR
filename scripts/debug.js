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
const events = { console: [], pageerror: [], requestfailed: [], response: [], expected: [] };

// Box-art is resolved by probing libretro-thumbnails with an ordered list of
// candidate URLs (filename → title → tag-stripped, see src/ArtResolver.js) and
// using the first that loads. Misses are EXPECTED — homebrew/region variants
// often have no thumbnail — and the cartridge falls back to a text label. So
// these 404s (and the matching "Failed to load resource" console errors the
// browser emits for them) are health noise, not failures.
const isBoxartProbe = (url) =>
  /raw\.githubusercontent\.com\/libretro-thumbnails\//.test(url || '');

page.on('console', (m) => {
  const text = m.text();
  // Chrome logs a generic "Failed to load resource: …404" error for each
  // image probe miss, with the URL on the message's args/location. Treat any
  // resource-load error as expected (image probes are the only sub-resources
  // the page fetches cross-origin that can 404 by design).
  const loc = m.location?.()?.url || '';
  if (m.type() === 'error' && /Failed to load resource/.test(text) && isBoxartProbe(loc)) {
    events.expected.push(text);
    log('console:error(expected boxart)', text);
    return;
  }
  events.console.push({ type: m.type(), text });
  log(`console:${m.type()}`, text);
});
page.on('pageerror', (e) => {
  events.pageerror.push(e.message);
  log('pageerror', e.message);
});
page.on('requestfailed', (r) => {
  const err = r.failure()?.errorText || '';
  const f = `${r.method()} ${r.url()} — ${err}`;
  // The remote logger (src/Logger.js) POSTs batches to /log; an in-flight flush
  // is routinely aborted when the headless page tears down — not a real failure.
  if (r.method() === 'POST' && /\/log(\?|$)/.test(r.url()) && err === 'net::ERR_ABORTED') {
    events.expected.push(f);
    log('requestfailed(expected logger flush)', f);
    return;
  }
  events.requestfailed.push(f);
  log('requestfailed', f);
});
page.on('response', (r) => {
  // Only flag non-2xx — 2xx noise drowns out real problems.
  if (r.status() >= 400) {
    const f = `${r.status()} ${r.url()}`;
    if (isBoxartProbe(r.url())) { events.expected.push(f); log('response:expected boxart', f); return; }
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

// --boot[=<system>] boots a game from the loaded collection through the real
// RomResolver/loadCartridge path (url source by default), so we exercise
// in-app ROM resolution + core start, not just the file-picker shortcut.
if (args.boot) {
  const wantSystem = typeof args.boot === 'string' ? args.boot : null;
  const booted = await page.evaluate(async (sys) => {
    const games = window.__games || [];
    const meta = sys ? games.find((g) => g.system === sys) : games[0];
    if (!meta) return { ok: false, reason: sys ? `no game for system ${sys}` : 'no games' };
    await window.__loadCartridge(meta);
    return { ok: true, title: meta.title, system: meta.system, core: meta.core };
  }, wantSystem);
  console.log('# boot:', booted);
}

// --probe-file=<path> evaluates a JS file as a function body in the page and
// logs its JSON return. Runs before the screenshot so any visual changes it
// makes are captured. Useful for poking window.__* debug hooks (e.g. driving
// the E.2 env edits and reading window.__editor.serialize() back).
if (args['probe-file']) {
  const code = readFileSync(resolve(args['probe-file']), 'utf8');
  try {
    const result = await page.evaluate((src) => {
      const fn = new Function(src);
      return JSON.stringify(fn());
    }, code);
    console.log('# probe:', result);
  } catch (e) {
    console.log('# probe error:', e.message);
  }
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
console.log(`  expected probes: ${events.expected.length} (boxart misses → text label; not a failure)`);
console.log(`  verdict:         ${hadErrors ? 'FAIL' : 'OK'}`);

process.exit(hadErrors ? 1 : 0);
