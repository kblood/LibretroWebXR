// Throwaway Phase-5 verification: spawn a console, reload the page, and confirm
// RackPersistence re-spawns it (core re-booted) and replays the video patch.
// Run: node scripts/probe-persist.mjs
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
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('  [page error]', m.text().slice(0, 160)); });
const ready = () => page.waitForFunction(() => Array.isArray(window.__games) && window.__games.length && window.__rack, { timeout: 30000 });

await page.goto(URL, { waitUntil: 'load' });
await ready();

const out = {};
// Clean slate, then spawn one console and capture the saved descriptor.
await page.evaluate(() => window.__rack.clearSaved());
out.spawned = await page.evaluate(async () => {
  const g = window.__games.find((x) => x.system === 'snes') || window.__games[0];
  await window.__loadCartridge(g);
  await new Promise((r) => setTimeout(r, 1500));
  const id = await window.__rack.spawnNext();
  await new Promise((r) => setTimeout(r, 2000));
  return { id, saved: window.__rack.saved(), video: window.__rack.video(), count: window.__rackMgr.count() };
});

// Reload — localStorage persists; restoreRack should re-create the console.
await page.reload({ waitUntil: 'load' });
await ready();
out.afterReload = await page.evaluate(async () => {
  // Give restoreRack time to re-boot the saved core.
  await new Promise((r) => setTimeout(r, 4000));
  return {
    count: window.__rackMgr.count(),
    ids: window.__rackMgr.ids(),
    video: window.__rack.video(),
    runtimes: window.__rackMgr.runtimes().map((r) => ({ id: r.id, core: r.coreName, loaded: r.isLoaded() })),
  };
});

// Cleanup so the next run / real user isn't stuck with a restored console.
await page.evaluate(() => window.__rack.clearSaved());

console.log(JSON.stringify(out, null, 2));
await browser.close();
