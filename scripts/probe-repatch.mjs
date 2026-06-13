// Throwaway Phase-4 verification: boot primary + spawn a second console, then
// drive the video patch cords (window.__rack.repatch / unpatch) to confirm the
// pure snap + Patchbay rewire actually reroutes which TV shows which console.
// Run: node scripts/probe-repatch.mjs
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const URL = process.argv[2] || 'https://dionysus.dk/webxr/libretrowebxr2/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 160)); });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => Array.isArray(window.__games) && window.__games.length && window.__rack, { timeout: 30000 });

const result = await page.evaluate(async () => {
  const out = {};
  const games = window.__games;
  const primary = games.find((g) => g.system === 'snes') || games[0];
  await window.__loadCartridge(primary);
  await new Promise((r) => setTimeout(r, 2000));

  const second = games.find((g) => ['nes', 'gb', 'sms'].includes(g.system)) || games.find((g) => g.system !== primary.system);
  await window.__rack.spawn(second.system, { game: second });
  await new Promise((r) => setTimeout(r, 2000));

  out.initial = window.__rack.video();              // tv0←console0, tv1←console1
  // Swap: move console0's video cord to tv1, console1's to tv0.
  out.afterMove0to1 = window.__rack.repatch('console0', 'tv1');
  out.afterMove1to0 = window.__rack.repatch('console1', 'tv0');
  out.tvsAfterSwap = window.__rack.tvs();           // which canvas each TV samples
  // Pull console0's cord out (mid-air drop) → tv1 should go idle.
  out.afterUnpatch0 = window.__rack.unpatch('console0');
  out.tvsAfterUnpatch = window.__rack.tvs();
  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
