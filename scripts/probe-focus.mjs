// Throwaway Phase-5 verification: spawn a second console via the spawn-menu
// path (__rack.spawnNext), then check focus + per-console audio mute follow.
// Run: node scripts/probe-focus.mjs
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
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => Array.isArray(window.__games) && window.__games.length && window.__rack, { timeout: 30000 });

const result = await page.evaluate(async () => {
  const out = {};
  const primary = (window.__games.find((g) => g.system === 'snes')) || window.__games[0];
  await window.__loadCartridge(primary);
  await new Promise((r) => setTimeout(r, 2000));
  out.afterPrimary = { focused: window.__rack.focused(), audio: window.__rack.audio() };

  // Spawn-menu path.
  const id = await window.__rack.spawnNext();
  await new Promise((r) => setTimeout(r, 2500));
  out.spawned = id;
  out.afterSpawn = { focused: window.__rack.focused(), audio: window.__rack.audio() };

  // Focus the spawned console (simulates gazing at its TV): only it audible.
  out.afterFocusSpawned = { focused: window.__rack.focus(id), audio: window.__rack.audio() };
  // Focus back to primary.
  out.afterFocusPrimary = { focused: window.__rack.focus('console0'), audio: window.__rack.audio() };
  out.video = window.__rack.video();
  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
