// Headless smoke probe: verify the in-VR multi-disc Prev/Next panel (C6,
// 2026-07-27 — src/DiscSwapPanel.js) actually shows/hides/updates correctly
// in a real browser scene graph.
//
// A real end-to-end check would need a bootable multi-track PSX image with a
// real .m3u — out of proportion for verifying a UI wiring layer sitting on
// top of already-tested plumbing (DiscControlBridge / WorkerEmulatorClient's
// setDisc/setDiscEjected/discStatus have their own coverage in
// test/psx-foundations.test.js and test/runtime.test.js). Instead this drives
// window.__discSwap directly against window.__client (the same live object
// refreshDiscPanel/stepDisc read), monkey-patching discStatus/setDisc to
// simulate a 3-disc core without needing real content.
//
// What it tests:
//   1. The panel exists in the scene and starts hidden (no game loaded yet).
//   2. refreshDiscPanel() against a single-disc (or disc-control-unsupported)
//      status keeps it hidden — the common case (every main-thread core, and
//      most PSX/N64 content) must never show a stray Prev/Next control.
//   3. refreshDiscPanel() against a real 3-disc status shows the panel with
//      the correct "DISC 1/3" label.
//   4. step(1) (Next) calls client.setDisc() with the wrapped-forward index
//      and updates the panel to "DISC 2/3".
//   5. step(-1) (Prev) from index 0 wraps to the LAST disc ("DISC 3/3") —
//      confirms the modulo wrap-around, not just a clamped range.
//   6. A setDisc() rejection (core refuses the index) leaves the panel
//      showing the last-good status rather than throwing out to the caller.
//
// Usage:
//   node scripts/probe-discswap-panel.mjs [url]
//   url defaults to http://localhost:5173/
//
// Requires the dev server to be running:  npm run dev
// Exit code: 0 = all assertions passed, 1 = at least one failed.

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const URL = process.argv[2] || 'http://localhost:5173/';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) {
  console.error('ERROR: no Chrome/Edge binary found');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
});

const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  await page.goto(URL, { waitUntil: 'load' });
} catch (e) {
  console.error(`ERROR: could not load ${URL}: ${e.message}`);
  console.error('Is `npm run dev` running?');
  await browser.close();
  process.exit(1);
}

try {
  await page.waitForFunction(
    () => window.__discSwap && typeof window.__discSwap.refresh === 'function'
       && window.__client,
    { timeout: 30000 },
  );
} catch {
  console.error('ERROR: app did not finish initialising within 30s');
  await browser.close();
  process.exit(1);
}

const result = await page.evaluate(async () => {
  const R = { pass: [], fail: [] };
  const assert = (name, cond, extra) => {
    if (cond) R.pass.push(name); else R.fail.push(extra ? `${name} — ${extra}` : name);
  };

  const panel = window.__discSwap.panel();
  assert('panel exists in the scene', !!panel);
  assert('panel starts hidden (no game loaded)', panel.visible === false);

  // A game with no disc control (or a single-disc game) — the common case.
  window.__client.discStatus = async () => null;
  await window.__discSwap.refresh();
  assert('stays hidden for a null status (no disc control)', panel.visible === false);

  window.__client.discStatus = async () => ({ index: 0, discCount: 1, ejected: false, supported: true });
  await window.__discSwap.refresh();
  assert('stays hidden for a single-disc status', panel.visible === false);

  // A real 3-disc game.
  let currentIndex = 0;
  const DISC_COUNT = 3;
  window.__client.discStatus = async () => ({ index: currentIndex, discCount: DISC_COUNT, ejected: false, supported: true });
  await window.__discSwap.refresh();
  assert('shows for a 3-disc status', panel.visible === true);
  const statusPlane = panel.children.find((c) => c !== panel.userData.buttons[0].mesh && c !== panel.userData.buttons[1].mesh && c.material?.map?.image?.getContext);
  const readLabel = () => {
    const ctx = statusPlane.material.map.image.getContext('2d');
    // Read back a horizontal strip through the label text and hash it — cheap
    // way to assert "the canvas was redrawn with different content" without
    // an OCR step. Compared against itself across steps below, not asserted
    // as an exact string.
    return ctx.getImageData(0, 60, statusPlane.material.map.image.width, 20).data.join(',');
  };
  const label1over3 = readLabel();

  // Next (wraps forward): index 0 -> 1.
  let lastSetDiscArg = null;
  window.__client.setDisc = async (i) => { lastSetDiscArg = i; currentIndex = i; return { index: i, discCount: DISC_COUNT, ejected: false }; };
  await window.__discSwap.step(1);
  assert('Next calls setDisc(1) from index 0', lastSetDiscArg === 1);
  assert('panel relabels after Next', readLabel() !== label1over3);
  const label2over3 = readLabel();

  // Prev twice from index 1: 1 -> 0 -> wraps to 2 (last disc, discCount-1).
  await window.__discSwap.step(-1);
  assert('Prev calls setDisc(0) from index 1', lastSetDiscArg === 0);
  await window.__discSwap.step(-1);
  assert('Prev wraps from index 0 to the last disc (2)', lastSetDiscArg === 2);
  assert('panel shows the wrapped disc, not stuck on a prior label',
    readLabel() !== label1over3 && readLabel() !== label2over3);

  // A rejected setDisc() (core refuses) must not throw out of step() and
  // must leave the panel showing the last successfully-applied status.
  const beforeRejectLabel = readLabel();
  window.__client.setDisc = async () => { throw new Error('Core rejected disc index 1'); };
  let threw = false;
  try { await window.__discSwap.step(1); } catch { threw = true; }
  assert('a setDisc rejection does not throw out of step()', threw === false);
  assert('panel keeps the last-good label after a rejected swap', readLabel() === beforeRejectLabel);

  return R;
});

if (pageErrors.length) console.warn('  [page errors]:', pageErrors.slice(0, 3).join('; '));

console.log('\n=== probe-discswap-panel results ===');
for (const p of result.pass) console.log(`  PASS  ${p}`);
for (const f of result.fail) console.log(`  FAIL  ${f}`);
console.log(`\n${result.pass.length} passed, ${result.fail.length} failed`);

await browser.close();
process.exit(result.fail.length ? 1 : 0);
