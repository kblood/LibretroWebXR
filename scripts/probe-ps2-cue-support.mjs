// Verifies REAL .cue support for the PS2 (`play`) core — the fix that
// replaces the same-inode NTFS hardlink-alias workaround
// probe-ps2-timecrisis2.mjs relied on (see that script's header comment).
//
// Background: Play!'s Emscripten build routes every optical-disc-image open
// through a JS discImageDevice bridge with ONE global slot (see
// EmulatorClient.js's DISC_IMAGE_EXTS comment) — handing it a raw .cue
// directly would make Play!'s own cue-sheet parser open a SECOND stream (for
// the referenced .bin) that collides with the first on that same slot. The
// fix (src/main.js's resolvePs2DiscCue, wired into loadCartridge) resolves
// the .cue ourselves — parses it with ContentBundle.js's parseCueReferences
// (the same FILE-line parser PSX's multi-track handling already uses),
// fetches just the primary data track's real bytes, and boots them through
// the bridge exactly like an .iso. Play! never sees a .cue file at all.
//
// This probe boots the REAL .cue (not the .iso hardlink) through the REAL
// app flow — window.__insertCartridge(meta) === handleCartridgeInserted(meta)
// === the exact function GrabMgr.js's onCartridgeInserted callback invokes
// when a physical cartridge snaps into a console's slot in VR — with NO
// hardlink alias anywhere in the picture. Content, assertions, and rigor
// mirror probe-ps2-timecrisis2.mjs (same TV_RECT palette checks, same
// pinned-to-final-frame cutscene-advance check per that script's own
// Codex-review history of catching "any frame in the whole run" weaknesses).
//
// Content: the user's own legally-owned Time Crisis II (Japan, With GunCon2)
// dump, staged at public/roms/local/ps2/ (gitignored, NOT in git) — the SAME
// .bin this probe's sibling (probe-ps2-timecrisis2.mjs) already verified via
// the .iso hardlink, but here loaded via its real .cue sidecar directly.
//
// Usage:
//   npm run probe:ps2-cue-support
//   node scripts/probe-ps2-cue-support.mjs
//
// Exit code: 0 = all PASS assertions passed, 1 = at least one failed / setup error.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5210;
const BASE = `http://localhost:${PORT}/`;
const PS2_DIR = resolve(ROOT, 'public', 'roms', 'local', 'ps2');
const CUE = resolve(PS2_DIR, 'Time Crisis II (Japan) (With GunCon2).cue');
const BIN = resolve(PS2_DIR, 'Time Crisis II (Japan) (With GunCon2).bin');
const CORE_JS = resolve(ROOT, 'public', 'cores', 'play_libretro.js');
const CORE_WASM = resolve(ROOT, 'public', 'cores', 'play_libretro.wasm');
const SHOT_DIR = resolve(ROOT, 'tmp');
// The REAL .cue path, not the .iso hardlink alias — the whole point of this probe.
const META = { file: 'local/ps2/Time Crisis II (Japan) (With GunCon2).cue', system: 'ps2', core: 'play', title: 'Time Crisis II (cue)', lightgun: true };

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) {
  console.error('ERROR: no Chrome/Edge binary found');
  process.exit(1);
}
const missing = [CUE, BIN, CORE_JS, CORE_WASM].filter((p) => !existsSync(p));
if (missing.length) {
  console.error('ERROR: required artifact(s) missing:');
  for (const p of missing) console.error(`  ${p}`);
  console.error('(the CUE+BIN is a gitignored, user-owned local ROM — see public/roms/local/local.collection.json\'s Time Crisis II entry; public/cores/ is gitignored build output — fetch/build the play core first)');
  process.exit(2);
}
mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
const info = (name, extra = '') => console.log(`INFO  ${name}${extra ? '  — ' + extra : ''}`);
// Race a promise against a hard deadline (see probe-ps2-timecrisis2.mjs's
// comment — a stuck CDP call otherwise eats the whole protocolTimeout with
// zero diagnosable information).
const withTimeout = (p, ms, label) => {
  const guarded = p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, error: String(e?.message || e), label }));
  return Promise.race([
    guarded,
    new Promise((res) => setTimeout(() => res({ ok: false, timeout: true, label }), ms)),
  ]);
};

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

// Region-tag a screenshot — identical technique/rect to probe-ps2-timecrisis2.mjs
// (same fixed default-camera 1024x768 view, same TV-screen rect).
async function analyzeShot(page, dataUrl) {
  const TV_RECT = { x: 365, y: 390, w: 295, h: 190 };
  return page.evaluate((dataUrl, rect) => new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      try {
        const full = document.createElement('canvas');
        full.width = img.width; full.height = img.height;
        const fctx = full.getContext('2d');
        fctx.drawImage(img, 0, 0);
        const fd = fctx.getImageData(0, 0, full.width, full.height).data;
        let fullNonBlack = 0, fullTotal = 0;
        for (let i = 0; i < fd.length; i += 4) {
          fullTotal++;
          if (fd[i] > 8 || fd[i + 1] > 8 || fd[i + 2] > 8) fullNonBlack++;
        }

        const tv = document.createElement('canvas');
        tv.width = rect.w; tv.height = rect.h;
        const tctx = tv.getContext('2d');
        tctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        const td = tctx.getImageData(0, 0, rect.w, rect.h).data;
        let tvNonBlack = 0, tvTotal = 0;
        let grayPanel = 0, darkBanner = 0, violetHighlight = 0, nightSky = 0, whiteBeam = 0;
        for (let i = 0; i < td.length; i += 4) {
          const r = td[i], g = td[i + 1], b = td[i + 2];
          tvTotal++;
          if (r > 8 || g > 8 || b > 8) tvNonBlack++;
          if (r > 100 && r < 200 && Math.abs(r - g) < 15 && Math.abs(g - b) < 15) grayPanel++;
          if (r < 40 && g < 40 && b < 40) darkBanner++;
          if (r > 80 && b > 80 && r - g > 30 && b - g > 20) violetHighlight++;
          if (b > 25 && g > 20 && b >= r && (b - r) < 90 && r < 90 && g < 110) nightSky++;
          if (r > 200 && g > 200 && b > 200) whiteBeam++;
        }
        res({
          fullNonBlack, fullTotal, tvNonBlack, tvTotal,
          grayPanel, darkBanner, violetHighlight, nightSky, whiteBeam,
        });
      } catch (e) {
        res({ error: String(e && e.message || e) });
      }
    };
    img.onerror = () => res(null);
    img.src = dataUrl;
  }), dataUrl, TV_RECT);
}

let browser;
try {
  if (!(await waitForServer(BASE))) throw new Error('vite dev server never came up');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 60000,
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 1024, height: 768 });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(BASE, { waitUntil: 'load' });

  const ready = await page.waitForFunction(
    () => !!window.__client && typeof window.__insertCartridge === 'function'
       && typeof window.__armGun === 'function' && typeof window.__gunArmedState === 'function'
       && typeof window.__gunFire === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with cartridge-insert/gun-test hooks ready', ready);
  if (!ready) throw new Error('app never finished initialising');

  // --- Step 1: boot the REAL .cue via the REAL cartridge-insert path ---
  const t0 = Date.now();
  const insert = await page.evaluate(async (meta) => {
    try { await window.__insertCartridge(meta); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, META);
  ok('real cartridge-insert path (handleCartridgeInserted) resolves without throwing for the REAL .cue (no .iso hardlink involved)', insert.ok, insert.reason || '');
  if (!insert.ok) throw new Error(insert.reason);

  // window.__lastPs2CueResolve is set by main.js's loadCartridge right after
  // resolvePs2DiscCue succeeds — proves this booted via the REAL parsed-cue
  // fix (not some other fallback), and lets us check exactly what it resolved.
  // Resolving it (parsing the cue + fetching the real ~700MB primary track)
  // takes real wall time, same order as the .iso probe's own disc fetch — wait
  // for it explicitly rather than sampling once immediately, which would
  // race the async resolution and false-FAIL every time.
  const cueResolveOk = await page.waitForFunction(
    () => !!window.__lastPs2CueResolve,
    { timeout: 60000 },
  ).then(() => true).catch(() => false);
  const cueResolve = await page.evaluate(() => window.__lastPs2CueResolve || null);
  ok('[ROOT-FIX SIGNAL] the .cue-resolution path actually ran (window.__lastPs2CueResolve set) — proves this booted via the real parsed-cue fix, not some other fallback',
     cueResolveOk && !!cueResolve, JSON.stringify(cueResolve));
  ok('resolved track is the real primary data track (the .bin the .cue references)',
     cueResolve?.track === 'Time Crisis II (Japan) (With GunCon2).bin',
     `track=${cueResolve?.track}`);
  ok('resolved byte count matches a real, multi-hundred-MB disc image (not the tiny cue-sheet text)',
     (cueResolve?.bytes ?? 0) > 100_000_000,
     `bytes=${cueResolve?.bytes}`);

  const bootedReady = await page.waitForFunction(
    () => window.__client?.ready === true,
    { timeout: 120000 },
  ).then(() => true).catch(() => false);
  const finalState = await page.evaluate(() => ({
    mode: window.__client?.mode ?? null,
    ready: !!window.__client?.ready,
  }));
  info(`time to ready: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  ok('client ended up ready', bootedReady, `finalState=${JSON.stringify(finalState)}`);
  ok('client stayed on the main-thread delegate (PS2 has no execution:"worker")', finalState.mode === 'main',
     `mode=${finalState.mode}`);
  if (!bootedReady) throw new Error('play core never reported ready booting the real .cue');

  function saveShot(buf, name) {
    writeFileSync(resolve(SHOT_DIR, name), buf);
  }

  async function captureNamed(name, waitMs) {
    if (waitMs > 0) await sleep(waitMs);
    const s0 = Date.now();
    const shotRes = await withTimeout(page.screenshot(), 30000, 'page.screenshot');
    info(`${name}: page.screenshot() ${shotRes.ok ? 'OK' : 'TIMED OUT'} in ${((Date.now() - s0) / 1000).toFixed(1)}s`);
    if (!shotRes.ok) return { name, stats: null, timedOutAt: 'screenshot' };
    const buf = shotRes.v;
    saveShot(buf, name);
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    const a0 = Date.now();
    const analyzeRes = await withTimeout(analyzeShot(page, dataUrl), 30000, 'analyzeShot');
    info(`${name}: analyzeShot() ${analyzeRes.ok ? 'OK' : 'TIMED OUT'} in ${((Date.now() - a0) / 1000).toFixed(1)}s`);
    const stats = analyzeRes.ok ? analyzeRes.v : null;
    info(`${name}: ${stats ? JSON.stringify(stats) : 'analysis failed/timed out'}`);
    return { name, stats, timedOutAt: analyzeRes.ok ? null : 'analyzeShot' };
  }

  // --- Step 2: capture the boot-settle sequence (no input yet) ---
  const shot1 = await captureNamed('probe-ps2-cue-support-01-boot.png', 4000);
  const shot2 = await captureNamed('probe-ps2-cue-support-02-settled.png', 6000);

  ok('screenshots captured to tmp/probe-ps2-cue-support-*.png', existsSync(resolve(SHOT_DIR, 'probe-ps2-cue-support-01-boot.png')));
  ok('[REAL-CONTENT] TV region shows real non-black, non-uniform content after boot (not stuck on a black/frozen screen)',
     [shot1, shot2].some((s) => s.stats && s.stats.tvNonBlack > 0 && s.stats.tvNonBlack < s.stats.tvTotal * 0.995),
     [shot1, shot2].map((s) => `${s.name}: tvNonBlack=${s.stats?.tvNonBlack}/${s.stats?.tvTotal}`).join('; '));

  // --- Step 3: advance past the memory-card prompt via the REAL
  // client.sendInput() path, mirroring probe-ps2-timecrisis2.mjs ---
  async function press(code, key) {
    const down = await withTimeout(page.evaluate((code, key) => window.__client.sendInput('keydown', code, key), code, key), 15000, 'sendInput-down');
    await sleep(120);
    const up = await withTimeout(page.evaluate((code, key) => window.__client.sendInput('keyup', code, key), code, key), 15000, 'sendInput-up');
    await sleep(700);
    return down.ok && up.ok;
  }
  let allPressesOk = true;
  for (let i = 0; i < 4; i++) allPressesOk = (await press('Enter', 'Enter')) && allPressesOk;
  const shot3 = await captureNamed('probe-ps2-cue-support-03-afterstart.png', 500);
  for (let i = 0; i < 6; i++) allPressesOk = (await press('KeyH', 'h')) && allPressesOk;
  const shot4 = await captureNamed('probe-ps2-cue-support-04-aftercross.png', 500);
  const shot5 = await captureNamed('probe-ps2-cue-support-05-final.png', 5000);

  ok('all synthetic Start/Cross sendInput() calls resolved without throwing/timing out',
     allPressesOk, `allPressesOk=${allPressesOk}`);

  const allShots = [shot1, shot2, shot3, shot4, shot5];
  const cutsceneSignature = (s) => s.stats && (
    (s.stats.grayPanel > s.stats.tvTotal * 0.05 && s.stats.darkBanner > s.stats.tvTotal * 0.02) ||
    (s.stats.nightSky > s.stats.tvTotal * 0.05 && s.stats.whiteBeam > 0)
  );
  ok('[REAL-CONTENT] at least one post-input frame shows recognizable memory-card-screen OR cutscene palette '
     + '(gray panel / dark banner / violet highlight box, OR night-sky / white spotlight-beam colors)',
     allShots.some(cutsceneSignature),
     allShots.map((s) => `${s.name}: gray=${s.stats?.grayPanel} dark=${s.stats?.darkBanner} violet=${s.stats?.violetHighlight} sky=${s.stats?.nightSky} beam=${s.stats?.whiteBeam}`).join(' | '));

  // Pinned to the FINAL post-input capture specifically (not "any frame in
  // the whole run" — see probe-ps2-timecrisis2.mjs's own 2026-07-27 Codex
  // review finding about that exact weakness).
  ok('[CUTSCENE-ADVANCE SIGNAL] the FINAL post-input capture (well after both Start and Cross) specifically shows the cutscene/menu palette, not just some earlier frame',
     cutsceneSignature(shot5),
     `${shot5.name}: gray=${shot5.stats?.grayPanel} dark=${shot5.stats?.darkBanner} sky=${shot5.stats?.nightSky} beam=${shot5.stats?.whiteBeam}`);

  ok('[REAL-CONTENT] frame content changed across the run (not a single frozen frame — boot animation / menu / input response)',
     (() => {
       const sigs = allShots.map((s) => s.stats && `${s.stats.tvNonBlack}:${s.stats.grayPanel}:${s.stats.nightSky}:${s.stats.whiteBeam}:${s.stats.violetHighlight}`);
       return new Set(sigs.filter(Boolean)).size > 1;
     })(),
     allShots.map((s) => s.name).join(', '));

  // --- Step 4: GunCon2 arm/fire against this REAL game booted via .cue ---
  const armRes = await withTimeout(page.evaluate(async () => {
    try { await window.__armGun(); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }), 45000, 'armGun');
  ok('__armGun() (the real gun-grab handler) resolves without throwing against the .cue-booted disc',
     armRes.ok && armRes.v?.ok, armRes.ok ? (armRes.v?.reason || '') : `TIMED OUT (${armRes.label})`);
  await sleep(3000); // PS2 live-reboot is slower than 8/16-bit cores

  const armStateRes = await withTimeout(page.evaluate(() => window.__gunArmedState()), 15000, 'gunArmedState');
  const armState = armStateRes.ok ? armStateRes.v : {};
  ok('GunCon2 device is connected on the console after arming', armState.consoleArmed === true,
     `state=${JSON.stringify(armState)}`);
  ok('armed system is ps2', armState.system === 'ps2', `system=${armState.system}`);

  const fireOnScreen = await withTimeout(page.evaluate(() => {
    try { const r = window.__gunFire({ x: 0, y: 1.2, z: -1 }, { x: 0, y: 1.2, z: -2 }, true); return { ok: true, result: r }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }), 15000, 'gunFire-on');
  ok('on-screen gun fire (trigger held) does not throw against the .cue-booted disc',
     fireOnScreen.ok && fireOnScreen.v?.ok, fireOnScreen.ok ? (fireOnScreen.v?.reason || `result=${fireOnScreen.v?.result}`) : `TIMED OUT (${fireOnScreen.label})`);

  const fireRelease = await withTimeout(page.evaluate(() => {
    try { const r = window.__gunFire({ x: 0, y: 1.2, z: -1 }, { x: 0, y: 1.2, z: -2 }, false); return { ok: true, result: r }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }), 15000, 'gunFire-release');
  ok('trigger release does not throw',
     fireRelease.ok && fireRelease.v?.ok, fireRelease.ok ? (fireRelease.v?.reason || `result=${fireRelease.v?.result}`) : `TIMED OUT (${fireRelease.label})`);

  const fireOffScreen = await withTimeout(page.evaluate(() => {
    try { const r = window.__gunFire({ x: 500, y: 500, z: 500 }, { x: 501, y: 500, z: 500 }, true); return { ok: true, result: r }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }), 15000, 'gunFire-offscreen');
  ok('off-screen gun fire does not throw',
     fireOffScreen.ok && fireOffScreen.v?.ok, fireOffScreen.ok ? (fireOffScreen.v?.reason || `result=${fireOffScreen.v?.result}`) : `TIMED OUT (${fireOffScreen.label})`);
  await sleep(300);

  await captureNamed('probe-ps2-cue-support-06-after-gun.png', 0);

  // --- Step 5: SECONDARY-console .cue resolution (the real gap Codex found
  //     in the first version of this fix — resolvePs2DiscCue was only wired
  //     into the PRIMARY console's loadCartridge; a .cue dropped on a
  //     secondary console went through loadCartridgeIntoConsole/
  //     swapConsoleCore instead, which silently handed Play! raw cue-sheet
  //     text with no resolution at all). Spawn a cheap secondary console on
  //     a different core, then insert the SAME real .cue targeted at it via
  //     meta.consoleId — since its current core differs from 'play', this
  //     exercises swapConsoleCore specifically. ---
  const spawnRes = await withTimeout(page.evaluate(async () => {
    try { const id = await window.__rack.spawn('nes'); return { ok: true, id }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }), 30000, 'rack.spawn');
  ok('spawned a secondary console (window.__rack.spawn) to target for the .cue insert',
     spawnRes.ok && !!spawnRes.v?.id, spawnRes.ok ? JSON.stringify(spawnRes.v) : `TIMED OUT (${spawnRes.label})`);
  const secondaryId = spawnRes.ok ? spawnRes.v.id : null;

  if (secondaryId) {
    const secondaryInsert = await withTimeout(page.evaluate(async (meta, consoleId) => {
      try { await window.__insertCartridge({ ...meta, consoleId }); return { ok: true }; }
      catch (e) { return { ok: false, reason: String(e?.message || e) }; }
    }, META, secondaryId), 120000, 'insertCartridge-secondary');
    ok('[SECONDARY-CONSOLE SIGNAL] real cartridge-insert path targeting a SECONDARY console (meta.consoleId, exercises swapConsoleCore since its prior core != play) resolves without throwing for the REAL .cue',
       secondaryInsert.ok && secondaryInsert.v?.ok, secondaryInsert.ok ? (secondaryInsert.v?.reason || '') : `TIMED OUT (${secondaryInsert.label})`);

    const secondaryCueResolveOk = await page.waitForFunction(
      (id) => window.__lastPs2CueResolve?.consoleId === id,
      { timeout: 60000 }, secondaryId,
    ).then(() => true).catch(() => false);
    const secondaryCueResolve = await page.evaluate(() => window.__lastPs2CueResolve || null);
    ok('[SECONDARY-CONSOLE SIGNAL] .cue resolution ran again for the secondary console specifically (window.__lastPs2CueResolve.consoleId matches), not silently skipped',
       secondaryCueResolveOk, JSON.stringify(secondaryCueResolve));
    ok('[SECONDARY-CONSOLE SIGNAL] resolved the same real primary data track (not raw cue-sheet text)',
       (secondaryCueResolve?.bytes ?? 0) > 100_000_000 && secondaryCueResolve?.track === 'Time Crisis II (Japan) (With GunCon2).bin',
       `track=${secondaryCueResolve?.track} bytes=${secondaryCueResolve?.bytes}`);

    // NOTE: NOT asserting `live` here — RackMgr.applyBudget()'s maxLive cap
    // can legitimately leave a just-swapped, unfocused secondary console
    // paused (budget/focus scheduling, unrelated to whether the swap itself
    // succeeded) — see RackMgr.js's planLive. The swap succeeding is already
    // proven above (cue resolved for THIS consoleId with the real track's
    // byte count); this only additionally confirms the runtime's core
    // actually flipped to 'play'.
    const secondaryReady = await page.waitForFunction(
      (id) => (window.__rack?.live() || []).some((r) => r.id === id && r.core === 'play'),
      { timeout: 60000 }, secondaryId,
    ).then(() => true).catch(() => false);
    const liveState = await page.evaluate(() => window.__rack.live());
    ok('[SECONDARY-CONSOLE SIGNAL] secondary console runtime ended up running the play core (swapConsoleCore actually swapped it)',
       secondaryReady, JSON.stringify(liveState));
  }

  // --- Step 6: the actual regression assertions ---
  ok('NO pageerror during boot/input/arm/fire', pageErrors.length === 0, JSON.stringify(pageErrors));
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error during boot/input/arm/fire', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));

  console.log(`\nScreenshots saved under ${SHOT_DIR}\\probe-ps2-cue-support-*.png`);
} catch (e) {
  console.error('ERROR', e);
  results.push(false);
} finally {
  if (browser) await browser.close();
  if (process.platform === 'win32') {
    await new Promise((res) => {
      const tk = spawn('taskkill', ['/pid', String(vite.pid), '/t', '/f'], { stdio: 'ignore' });
      tk.on('exit', res);
      tk.on('error', res);
    });
  } else {
    vite.kill();
    try { process.kill(-vite.pid); } catch (_) {}
  }
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length && results.length ? 0 : 1);
