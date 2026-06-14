// Throwaway: confirm the rebuilt 2-player LWX Pong still boots in the live core
// and that a P2 button injected via the rack input path reaches console0 without
// throwing.  node scripts/probe-pong-boot.mjs [url]
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const URL = process.argv[2] || 'http://localhost:5176/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await p.goto(URL, { waitUntil: 'load' });
await p.waitForFunction(() => window.__rack && Array.isArray(window.__games) && window.__games.length, { timeout: 45000 });
const out = await p.evaluate(async () => {
  const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
  const pong = window.__games.find((g) => /pong/i.test(g.title) && g.system === 'nes');
  if (!pong) return { err: 'pong cartridge not in manifest' };
  await window.__loadCartridge(pong);
  await sleep(2000);
  const live = window.__rackMgr.runtimes().map((r) => ({ id: r.id, core: r.coreName, live: r.isLive() }));
  // Inject a P2 "Down" then release via the host-side remote-button path.
  let injectOk = true;
  try {
    window.__gameInput?.setRemoteButton({ player: 2, btn: 'Down', down: true });
    window.__gameInput?.setRemoteButton({ player: 2, btn: 'Down', down: false });
  } catch (e) { injectOk = String(e); }
  return { game: pong.title, file: pong.file, live, injectOk };
});
console.log(JSON.stringify(out, null, 2));
await b.close();
