// Throwaway Phase-3 verification: boot the primary console, spawn a SECOND
// console+TV via window.__rack.spawn, and confirm each TV samples a distinct
// console canvas through the patch graph. Run: node scripts/probe-multitv.mjs
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

// Wait for the games registry + rack hooks to exist.
await page.waitForFunction(() => Array.isArray(window.__games) && window.__games.length && window.__rack, { timeout: 30000 });

const result = await page.evaluate(async () => {
  const out = { steps: [] };
  // 1) Boot the primary console (first SNES game, else first game).
  const games = window.__games;
  const primary = games.find((g) => g.system === 'snes') || games[0];
  await window.__loadCartridge(primary);
  await new Promise((r) => setTimeout(r, 2500));
  out.primary = { system: primary.system, core: primary.core, title: primary.title };
  out.beforeSpawn = { tvs: window.__rack.tvs(), video: window.__rack.video() };

  // 2) Spawn a second console with a LIGHT core so the budget keeps both live.
  const second = games.find((g) => ['nes', 'gb', 'sms'].includes(g.system)) || games.find((g) => g.system !== primary.system);
  try {
    const id = await window.__rack.spawn(second.system, { game: second });
    out.spawned = { id, system: second.system, core: second.core, title: second.title };
  } catch (e) { out.spawnError = String(e?.message || e); }
  await new Promise((r) => setTimeout(r, 2500));

  // 3) Read the resulting routing + budget.
  out.afterSpawn = { tvs: window.__rack.tvs(), video: window.__rack.video() };
  out.rack = {
    count: window.__rackMgr.count(),
    ids: window.__rackMgr.ids(),
    focus: window.__rackMgr.focusedId(),
    live: window.__rackMgr.runtimes().map((r) => ({ id: r.id, core: r.coreName, weight: r.weight, loaded: r.isLoaded(), live: r.isLive() })),
  };
  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
