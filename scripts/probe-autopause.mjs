// Throwaway: verify the rack auto-pause toggle. With 3 over-budget consoles,
// auto-pause ON pauses the non-focused excess; OFF keeps them all live.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const URL = process.argv[2] || 'https://dionysus.dk/webxr/libretrowebxr2/';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'] });
const p = await b.newPage();
await p.goto(URL, { waitUntil: 'load' });
await p.waitForFunction(() => window.__rack && Array.isArray(window.__games) && window.__games.length, { timeout: 30000 });
const out = await p.evaluate(async () => {
  const r = {};
  r.defaultAutoPause = window.__rack.autoPause();
  const g = window.__games.find((x) => x.system === 'snes') || window.__games[0];
  await window.__loadCartridge(g); await new Promise((s) => setTimeout(s, 1200));
  await window.__rack.spawn('genesis').catch(() => {});
  await window.__rack.spawn('gba').catch(() => {});
  await new Promise((s) => setTimeout(s, 2500));
  r.withAutoPauseOn = { auto: window.__rack.autoPause(), live: window.__rack.live() };
  window.__rack.autoPause(false);
  r.afterDisable = { auto: window.__rack.autoPause(), live: window.__rack.live() };
  window.__rack.autoPause(true);
  r.afterReEnable = { auto: window.__rack.autoPause(), live: window.__rack.live() };
  return r;
});
console.log(JSON.stringify(out, null, 2));
await b.close();
