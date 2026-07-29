// PSX TWO-GUN (2x GunCon) probe (2026-07-29) — the verification that lifted
// SYSTEMS.psx.lightgun2's `broken: true` gate, and the regression guard that
// now keeps it lifted.
//
// WHY THIS EXISTS
// ---------------
// The gate was originally raised (commit f98e549) because the SHIPPED core
// artifact lacked the per-port export rwebinput_set_lightgun(port,x,y,buttons);
// without it two guns would silently share ONE DOM-mouse aim point and read as
// an app bug. That export is present again since the 2026-07-29 core restore
// (`grep -c rwebinput_set_lightgun public/cores/mednafen_psx_jit_libretro.js`
// = 1). But the core was only HALF the blocker, and the other half was never
// written down: PSX is the app's ONLY worker-execution gun system
// (CORES.mednafen_psx_hw.execution = 'worker'), and the worker's
// EmulatorWorkerRuntime.forwardLightgun() had NO multiport branch at all — it
// used `port` purely as a gunDownByPort trigger-edge key and pushed every aim
// through the shared canvas mousemove. The main-thread EmulatorClient's
// _resolveWebgun/_webgunSet path (which the SNES Justifier rides) simply does
// not run for PSX. So the gate's own stated failure mode — two guns, one aim —
// was real on the app side too, independent of the artifact.
// That worker-side multiport path was added alongside this probe; this script
// is what proves it, on a REAL commercial disc against the REAL core.
//
// WHAT THIS PROVES, PRECISELY (read this before quoting the result)
// -----------------------------------------------------------------
// CORE-LEVEL, not two-player-gameplay-verified. Specifically it establishes:
//   (a) SEATING     — the worker really wrote device 260 on BOTH libretro ports
//                     (players 1 and 2) into the RetroArch cfg + remap.
//   (b) ROUTING     — each port's aim went through the per-port export
//                     (path='multiport'), NOT the shared DOM pointer, and the
//                     two ports hold DIFFERENT coordinates at the same instant.
//   (c) RENDERING   — Beetle PSX draws a SECOND, independently-positioned
//                     GunCon crosshair for port 1 (gun_cursor='cross'), i.e.
//                     the core itself is tracking two distinct gun positions.
//                     This is the core reading back distinct per-port state.
//   (d) ISOLATION   — the same aim + trigger differing ONLY in `port` produces
//                     DIFFERENT game outcomes: firing port 1 at the Time Crisis
//                     calibration target does nothing (that 1P screen polls
//                     port 0), while firing port 0 at the identical point
//                     registers the shot. Under the shared-pointer failure mode
//                     the port-1 shot would ALSO have registered — so this is a
//                     direct falsification test of the exact bug the gate
//                     guarded, at the emulated-game level.
// It does NOT prove two humans playing a real 2P co-op session (Point Blank /
// Lethal Enforcers 2P mode requires menu navigation this probe doesn't drive).
// Label any claim accordingly.
//
// Disc: the same real "Time Crisis" .cue scripts/probe-psx-guncon.js uses —
// deliberately, so the single-gun 14/14 result is the control this is read
// against. Gitignored / user-supplied (see CLAUDE.md).
//
// Usage:
//   npm run probe:psx-twogun
//   node scripts/probe-psx-twogun.js
//
// Exit code: 0 = all PASS assertions passed, 1 = at least one failed.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { twoGunForSystem, lightgunLoadConfig, isTwoGunCapable } from '../src/systems.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5207;
const BASE = `http://localhost:${PORT}/?core=mednafen_psx_hw&experimental=1`;
const DISC_DIR = resolve(ROOT, 'public', 'roms', 'local', 'ps1');
const CUE_PATH = resolve(DISC_DIR, 'Time Crisis.cue');
const CORE_JS = resolve(ROOT, 'public', 'cores', 'mednafen_psx_jit_libretro.js');
const CORE_WASM = resolve(ROOT, 'public', 'cores', 'mednafen_psx_jit_libretro.wasm');
const SHOT_DIR = resolve(ROOT, 'tmp');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) { console.error('ERROR: no Chrome/Edge binary found'); process.exit(1); }
if (!existsSync(CUE_PATH)) {
  console.error(`ERROR: test disc not found at ${CUE_PATH} (gitignored, user-provided — see CLAUDE.md)`);
  process.exit(1);
}
const missingCore = [CORE_JS, CORE_WASM].filter((p) => !existsSync(p));
if (missingCore.length) {
  console.error('ERROR: required build artifact(s) missing (public/cores/ is gitignored):');
  for (const p of missingCore) console.error(`  ${p}`);
  process.exit(2);
}
const trackCount = readdirSync(DISC_DIR).filter((f) => /^Time Crisis \(Track \d+\)\.bin$/i.test(f)).length;
if (trackCount !== 33) {
  console.error(`ERROR: expected 33 track .bin files in ${DISC_DIR}, found ${trackCount}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
const info = (name, extra = '') => console.log(`INFO  ${name}${extra ? '  — ' + extra : ''}`);

mkdirSync(SHOT_DIR, { recursive: true });

// --- Registry preconditions (pure, no browser) -------------------------------
// The two-gun descriptor must exist and describe two DISTINCT libretro ports; a
// registry that seated both guns on one port would make everything below
// meaningless regardless of what the core does.
const tg = twoGunForSystem('psx');
ok('registry: SYSTEMS.psx.lightgun2 exists', !!tg);
ok('registry: two-gun seats GunCon (260) on TWO DISTINCT ports',
   !!tg && tg.devices?.length === 2 && tg.devices.every((d) => d === 260)
   && tg.ports?.length === 2 && tg.ports[0] !== tg.ports[1],
   tg ? `devices=${JSON.stringify(tg.devices)} ports=${JSON.stringify(tg.ports)}` : '');
// The un-gating guard. This whole probe runs WITHOUT window.__allowBrokenLightgun
// (see the boot step below), and every gate downstream — main.js's
// _twoGunActiveFor and lightgunLoadConfig's own `broken` check — consults
// isTwoGunCapable/`broken`. So if lightgun2 were ever re-gated, this assertion
// fails here and the browser half below fails with it, instead of the probe
// quietly passing through an override.
ok('registry: two-gun is offered UN-GATED (isTwoGunCapable(psx) === true, no allowBroken override)',
   isTwoGunCapable('psx') === true);
const cfgTwo = lightgunLoadConfig('psx', { twoGun: true });
ok('registry: lightgunLoadConfig(twoGun) yields per-port inputDevices for both guns',
   !!cfgTwo && Object.keys(cfgTwo.inputDevices || {}).length === 2 && cfgTwo.guns?.length === 2,
   cfgTwo ? `inputDevices=${JSON.stringify(cfgTwo.inputDevices)}` : 'null');
const GUN_PORTS = tg?.ports ?? [0, 1];

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true });

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

// Same canvas-readback approach as probe-psx-guncon.js: a per-cell-average grid
// signature, so a change can be localised to a screen region.
async function captureCanvas(page) {
  return page.evaluate(async () => {
    const canvas = document.getElementById('canvas');
    if (!canvas) return null;
    const dataUrl = canvas.toDataURL('image/png');
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('canvas snapshot image failed to decode'));
      im.src = dataUrl;
    });
    const off = document.createElement('canvas');
    off.width = img.width; off.height = img.height;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0);
    const { data } = octx.getImageData(0, 0, img.width, img.height);
    const GRID = 12;
    const cellW = Math.max(1, Math.floor(img.width / GRID));
    const cellH = Math.max(1, Math.floor(img.height / GRID));
    const signature = [];
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = gy * cellH; y < Math.min(img.height, (gy + 1) * cellH); y += 2) {
          for (let x = gx * cellW; x < Math.min(img.width, (gx + 1) * cellW); x += 2) {
            const i = (y * img.width + x) * 4;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
        }
        if (n === 0) n = 1;
        signature.push(Math.round(r / n), Math.round(g / n), Math.round(b / n));
      }
    }
    return { width: img.width, height: img.height, grid: GRID, signature, dataUrl };
  });
}

function cellDiffs(a, b) {
  if (!a || !b || a.grid !== b.grid || a.signature.length !== b.signature.length) return null;
  const n = a.grid * a.grid;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    out[i] = Math.abs(a.signature[o] - b.signature[o])
           + Math.abs(a.signature[o + 1] - b.signature[o + 1])
           + Math.abs(a.signature[o + 2] - b.signature[o + 2]);
  }
  return out;
}
function cellIndex(grid, u, v) {
  const gx = Math.max(0, Math.min(grid - 1, Math.floor(u * grid)));
  const gy = Math.max(0, Math.min(grid - 1, Math.floor(v * grid)));
  return gy * grid + gx;
}
const maxOf = (arr) => (arr && arr.length ? Math.max(...arr) : null);
const rgbDist = (a, b) => (a && b)
  ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) : 0;

// Look for a drawn CURSOR near (u,v): read a small box of live canvas pixels,
// take the box's most common colour as the local background, and return the
// pixel that deviates furthest from it. A GunCon crosshair is a thin bright
// cross on a flat background, so `dist` is large when one is present and ~0 on
// empty screen — and `rgb` is that crosshair's own colour, which Beetle PSX
// picks PER PORT (visible in tmp/psx-twogun-cursors-apart.png: port 0 red,
// port 1 blue). Comparing the two ports' cursor colours is therefore a direct
// read-back of two independent per-port gun states from the core's own output.
async function sampleCursor(page, u, v, box = 14) {
  return page.evaluate(async (uu, vv, bb) => {
    const canvas = document.getElementById('canvas');
    if (!canvas) return null;
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = () => rej(new Error('decode failed'));
      im.src = canvas.toDataURL('image/png');
    });
    const off = document.createElement('canvas');
    off.width = img.width; off.height = img.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const cx = Math.round(uu * img.width), cy = Math.round(vv * img.height);
    const x0 = Math.max(0, cx - bb), y0 = Math.max(0, cy - bb);
    const w = Math.min(img.width - x0, bb * 2), h = Math.min(img.height - y0, bb * 2);
    if (w <= 0 || h <= 0) return null;
    const { data } = ctx.getImageData(x0, y0, w, h);
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const k = `${data[i]},${data[i + 1]},${data[i + 2]}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let bgKey = null, bgN = -1;
    for (const [k, n] of counts) if (n > bgN) { bgN = n; bgKey = k; }
    const bg = bgKey.split(',').map(Number);
    let best = bg, bestD = 0;
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > bestD) { bestD = d; best = [data[i], data[i + 1], data[i + 2]]; }
    }
    return { rgb: best, bg, dist: bestD };
  }, u, v, box);
}

let browser;
try {
  if (!(await waitForServer(`http://localhost:${PORT}/`))) throw new Error('vite dev server never came up');

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  const appReady = await page.waitForFunction(
    () => !!window.__client && typeof window.__insertCartridge === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with __client + window.__insertCartridge present', appReady);
  if (!appReady) throw new Error('app never finished initialising');

  await page.evaluate(() => {
    window.__psxMetrics = [];
    window.__client.addEventListener('metrics', (e) => window.__psxMetrics.push({ t: performance.now(), ...e.detail }));
  });

  // NOTE: `window.__allowBrokenLightgun` is deliberately NOT set. While
  // SYSTEMS.psx.lightgun2 was still gated this probe opted back in through that
  // de-risk hook (as probe-psx-guncon.js does), but with the flag set the run
  // was bit-identical whether the gate was up or down — it threads into BOTH
  // main.js's _twoGunActiveFor and lightgunLoadConfig's allowBroken, so a
  // re-gating could not have turned this probe red. Now that the gate is down,
  // the run below takes the same flag-free path a real boot takes, which is what
  // makes it a regression guard rather than a demo.

  // --- Step 1: boot the real disc through the REAL cartridge-insert path with
  //     twoGun:true, so loadCartridge's own gun branch (_twoGunActiveFor ->
  //     lightgunLoadConfig({twoGun}) -> inputDevices/coreOptions/remapName ->
  //     wrapWorkerContent + client.start()) seats BOTH GunCons at boot. ---
  const insertMeta = {
    file: 'local/ps1/Time Crisis.cue', core: 'mednafen_psx_hw', system: 'psx',
    title: 'Time Crisis', lightgun: true, twoGun: true,
  };
  info(`window.__insertCartridge(${JSON.stringify(insertMeta)})`);
  const insertResult = await page.evaluate(async (meta) => {
    try { await window.__insertCartridge(meta); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, insertMeta);
  ok('window.__insertCartridge resolved with lightgun:true + twoGun:true', insertResult.ok, insertResult.reason || '');

  const booted = await page.waitForFunction(
    () => window.__client?.mode === 'worker' && window.__client?.ready === true,
    { timeout: 100000 },
  ).then(() => true).catch(() => false);
  const finalState = await page.evaluate(() => ({
    mode: window.__client?.mode ?? null, ready: !!window.__client?.ready,
    status: document.querySelector('#status')?.textContent ?? null,
  }));
  ok('two-GunCon disc booted into worker mode and ready', booted, `finalState=${JSON.stringify(finalState)}`);
  if (!booted) throw new Error(`PSX core never reported ready — status: ${finalState.status}`);

  function saveShot(dataUrl, name) {
    try { writeFileSync(resolve(SHOT_DIR, name), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')); }
    catch (_) {}
  }
  // Latest worker metrics sample carrying a `gun` block.
  const latestGun = async () => page.evaluate(() => {
    const log = window.__psxMetrics || [];
    for (let i = log.length - 1; i >= 0; i--) if (log[i].gun) return log[i].gun;
    return null;
  });

  await sleep(20000);   // same boot-settle budget probe-psx-guncon.js uses

  // --- Step 2 (SEATING): did the worker actually write device 260 on BOTH
  //     libretro ports? Read from the worker's own echo of what writeConfig()
  //     put into the RetroArch cfg + remap, not inferred from the page side. ---
  await page.waitForFunction(() => (window.__psxMetrics || []).some((s) => s.gun), { timeout: 4000 }).catch(() => {});
  const seating = await latestGun();
  info(`worker gun telemetry (post-boot): ${JSON.stringify(seating)}`);
  const seatedDevs = seating?.devices || null;
  const expectPlayers = GUN_PORTS.map((p) => String(p + 1));
  ok('[SEATING] worker seated GunCon (260) on BOTH libretro ports at boot',
     !!seatedDevs && expectPlayers.every((pl) => Number(seatedDevs[pl]) === 260)
     && Object.keys(seatedDevs).length === 2,
     `inputDevices=${JSON.stringify(seatedDevs)} (expected players ${expectPlayers.join(',')} = 260)`);

  const baseline = await captureCanvas(page);
  ok('baseline canvas snapshot captured', !!baseline);
  if (baseline) saveShot(baseline.dataUrl, 'psx-twogun-baseline.png');

  // --- Step 3 (ROUTING): drive the two guns to DIFFERENT points and confirm
  //     each went through the per-port export rather than the shared pointer. ---
  // Aim points deliberately placed in the CLEAR yellow field on Time Crisis's
  // calibration screen — left and right of the centre target circle, above the
  // "Aim and shoot" text box and below the "GunCon Calibration" banner. Corners
  // would put a crosshair on top of that scenery, and the per-pixel cursor
  // sample below (which reports the pixel furthest from its local background)
  // would then be reading the banner/text box rather than the crosshair.
  const AIM_A = { u: 0.15, v: 0.55 };   // port GUN_PORTS[0]
  const AIM_B = { u: 0.85, v: 0.55 };   // port GUN_PORTS[1]
  const aim = async (port, u, v, trigger = false) =>
    page.evaluate((p, uu, vv, t) => window.__client.sendLightgun(uu, vv, t, p), port, u, v, trigger);

  await aim(GUN_PORTS[0], AIM_A.u, AIM_A.v);
  await aim(GUN_PORTS[1], AIM_B.u, AIM_B.v);
  await sleep(1600);   // let a metrics tick carry the recorded aims back
  const routed = await latestGun();
  info(`worker gun telemetry (after distinct aims): ${JSON.stringify(routed)}`);
  const p0 = routed?.ports?.[String(GUN_PORTS[0])] || null;
  const p1 = routed?.ports?.[String(GUN_PORTS[1])] || null;

  ok('[ROUTING] worker resolved the multiport per-port setter (rwebinput_set_lightgun), not the DOM fallback',
     routed?.multiport === true, `gun.multiport=${JSON.stringify(routed?.multiport)}`);
  ok('[ROUTING] BOTH gun ports were carried by the multiport path (neither fell back to the shared DOM pointer)',
     p0?.path === 'multiport' && p1?.path === 'multiport',
     `port${GUN_PORTS[0]}.path=${p0?.path ?? 'none'} port${GUN_PORTS[1]}.path=${p1?.path ?? 'none'}`);
  // Distinctness is on the coordinate PAIR, not on both axes independently —
  // AIM_A/AIM_B deliberately share a v (see their comment), so y is equal by
  // construction and only x separates them.
  ok('[ROUTING] the two ports hold DIFFERENT aim coordinates at the same instant',
     !!p0 && !!p1 && (p0.x !== p1.x || p0.y !== p1.y) && Math.abs(p0.x - p1.x) > 100,
     `port${GUN_PORTS[0]}=(${p0?.x},${p0?.y}) port${GUN_PORTS[1]}=(${p1?.x},${p1?.y})`);

  // --- Step 4 (RENDERING): does the CORE itself hold two distinct positions?
  //     beetle_psx_gun_cursor='cross' makes Beetle PSX draw a crosshair per
  //     connected GunCon port, in a PER-PORT COLOUR. Three frames:
  //       T1  both guns at A          -> the two crosses overlap
  //       T2  gun 1 at A, gun 2 at B  -> one cross at each corner
  //       T3  both guns at B          -> nothing left at A
  //     The discriminating fact a shared pointer cannot produce is T2 vs T3 at
  //     cell A: something is still drawn at A in T2 and gone in T3, i.e. gun
  //     1's cursor STAYED at A while gun 2 was at B. (Naive "did A change when
  //     gun 2 moved" is NOT a valid test — A legitimately changes when the
  //     overlapping second cross leaves it.) The per-pixel cursor sample on T2
  //     then reads the two crosshairs' own COLOURS straight out of the core's
  //     framebuffer and requires them to differ, which is the core reporting
  //     two independent gun states rather than one drawn twice. ---
  await aim(GUN_PORTS[0], AIM_A.u, AIM_A.v);
  await aim(GUN_PORTS[1], AIM_A.u, AIM_A.v);
  await sleep(1200);
  const together = await captureCanvas(page);
  if (together) saveShot(together.dataUrl, 'psx-twogun-cursors-together.png');

  await aim(GUN_PORTS[1], AIM_B.u, AIM_B.v);      // move ONLY gun 2
  await sleep(1200);
  const apart = await captureCanvas(page);
  if (apart) saveShot(apart.dataUrl, 'psx-twogun-cursors-apart.png');
  const cursorAtA = await sampleCursor(page, AIM_A.u, AIM_A.v);
  const cursorAtB = await sampleCursor(page, AIM_B.u, AIM_B.v);

  await aim(GUN_PORTS[0], AIM_B.u, AIM_B.v);      // now move gun 1 to B as well
  await sleep(1200);
  const bothAtB = await captureCanvas(page);
  if (bothAtB) saveShot(bothAtB.dataUrl, 'psx-twogun-cursors-both-b.png');

  const grid = together?.grid ?? 12;
  const cellA = cellIndex(grid, AIM_A.u, AIM_A.v);
  const cellB = cellIndex(grid, AIM_B.u, AIM_B.v);
  const dArrive = cellDiffs(together, apart);      // gun 2 moved A -> B
  const dVacate = cellDiffs(apart, bothAtB);       // gun 1 then moved A -> B
  info(`[cursor analysis] gun2 A->B: cell@A=${dArrive?.[cellA]}, cell@B=${dArrive?.[cellB]}  |  `
     + `gun1 A->B: cell@A=${dVacate?.[cellA]}, cell@B=${dVacate?.[cellB]}`);
  info(`[cursor pixels @T2] cursor near A: rgb=${JSON.stringify(cursorAtA?.rgb)} dist=${cursorAtA?.dist} (bg=${JSON.stringify(cursorAtA?.bg)})  |  `
     + `near B: rgb=${JSON.stringify(cursorAtB?.rgb)} dist=${cursorAtB?.dist} (bg=${JSON.stringify(cursorAtB?.bg)})`);

  ok('[RENDERING] gun 2\'s crosshair moved to its OWN new position (cell at B changed when only gun 2 moved)',
     !!dArrive && dArrive[cellB] > 0, `cell@B diff=${dArrive?.[cellB]}`);
  ok('[RENDERING] gun 1\'s crosshair STAYED at A while gun 2 was at B — it only left A when gun 1 ITSELF was moved (a shared pointer cannot do this)',
     !!dVacate && dVacate[cellA] > 0, `cell@A diff when gun 1 later moved away=${dVacate?.[cellA]}`);
  ok('[RENDERING] two crosshairs are simultaneously drawn, in DIFFERENT per-port colours, at the two guns\' own positions',
     !!cursorAtA && !!cursorAtB && cursorAtA.dist > 60 && cursorAtB.dist > 60
     && rgbDist(cursorAtA.rgb, cursorAtB.rgb) > 60,
     `A=${JSON.stringify(cursorAtA?.rgb)} B=${JSON.stringify(cursorAtB?.rgb)} colourDist=${rgbDist(cursorAtA?.rgb, cursorAtB?.rgb)}`);

  // --- Step 5 (ISOLATION, the falsification test): fire the SAME shot at the
  //     SAME point on each port in turn and show the outcome depends on WHICH
  //     port fired. Time Crisis's GunCon calibration screen is 1-player: it
  //     polls port 0 only. Each arm parks the gun on the target FIRST and only
  //     then captures its own pre-shot baseline, so the crosshair's movement is
  //     already in the baseline and the measured delta is the GAME reacting,
  //     not the cursor sliding across the screen.
  //       5a  gun 2 fires at the target -> expect nothing (under the
  //           shared-pointer bug this WOULD register: that is the falsification)
  //       5b  gun 1 fires at the identical point -> expect the shot to register,
  //           the same signal probe:psx-guncon's 14/14 control produces. ---
  await aim(GUN_PORTS[0], AIM_A.u, AIM_A.v);    // park gun 1 away from the target
  await aim(GUN_PORTS[1], 0.5, 0.5);            // gun 2 onto the target, no trigger
  await sleep(2000);
  const preGun2 = await captureCanvas(page);
  if (preGun2) saveShot(preGun2.dataUrl, 'psx-twogun-pre-gun2-shot.png');
  await aim(GUN_PORTS[1], 0.5, 0.5, true);
  await sleep(700);
  await aim(GUN_PORTS[1], 0.5, 0.5, false);
  await sleep(2500);
  const afterGun2 = await captureCanvas(page);
  if (afterGun2) saveShot(afterGun2.dataUrl, 'psx-twogun-after-gun2-shot.png');
  const gun2Diffs = cellDiffs(preGun2, afterGun2);
  info(`[isolation 5a] gun 2 (port ${GUN_PORTS[1]}) pulled the trigger on-target: max cell diff=${maxOf(gun2Diffs)}`);

  await aim(GUN_PORTS[0], 0.5, 0.5);            // gun 1 onto the same point, no trigger
  await sleep(2000);
  const preGun1 = await captureCanvas(page);
  if (preGun1) saveShot(preGun1.dataUrl, 'psx-twogun-pre-gun1-shot.png');
  await aim(GUN_PORTS[0], 0.5, 0.5, true);
  await sleep(700);
  await aim(GUN_PORTS[0], 0.5, 0.5, false);
  await sleep(2500);
  const afterGun1 = await captureCanvas(page);
  if (afterGun1) saveShot(afterGun1.dataUrl, 'psx-twogun-after-gun1-shot.png');
  const gun1Diffs = cellDiffs(preGun1, afterGun1);
  info(`[isolation 5b] gun 1 (port ${GUN_PORTS[0]}) pulled the trigger at the SAME point: max cell diff=${maxOf(gun1Diffs)}`);

  ok('[ISOLATION] gun 2 firing at the target did NOT advance the 1-player calibration (port 2 is genuinely its own port, not the shared pointer)',
     gun2Diffs !== null && maxOf(gun2Diffs) === 0,
     `maxDiff=${maxOf(gun2Diffs)} — any game-state change here is what the shared-pointer bug looks like`);
  ok('[ISOLATION] gun 1 firing at the IDENTICAL point DID register with the game (per-port aim reaches Beetle PSX correctly)',
     gun1Diffs !== null && maxOf(gun1Diffs) > 0,
     `maxDiff=${maxOf(gun1Diffs)}`);
  ok('[ISOLATION] the two identical shots produced clearly different outcomes (the ONLY difference between them was the port)',
     gun1Diffs !== null && gun2Diffs !== null && maxOf(gun1Diffs) > maxOf(gun2Diffs) * 4 + 10,
     `gun1 maxDiff=${maxOf(gun1Diffs)} vs gun2 maxDiff=${maxOf(gun2Diffs)}`);

  // --- Frame-health metrics (same sanity layer as every worker-execution probe) ---
  const metricsLog = await page.evaluate(() => window.__psxMetrics || []);
  const last = metricsLog[metricsLog.length - 1] || null;
  info(`metrics samples captured: ${metricsLog.length}`);
  if (last) info(`latest metrics: framesProduced=${last.framesProduced} framesSkipped=${last.framesSkipped} errors=${last.errors} inputs=${last.inputs} gun=${JSON.stringify(last.gun)}`);
  ok('metrics: core reported frames produced', !!last && (last.framesProduced || 0) > 0,
     last ? `framesProduced=${last.framesProduced}` : 'no metrics captured');
  ok('metrics: no core-reported errors across the run', !!last && last.errors === 0,
     last ? `errors=${last.errors}` : 'no metrics captured');
  const maxInputs = metricsLog.reduce((m, s) => Math.max(m, s.inputs || 0), 0);
  ok('metrics: worker recorded every sendLightgun call (forwardLightgun ran per call)',
     maxInputs >= 10, `maxInputs=${maxInputs} (expected >= 10)`);

  ok('NO pageerror across the whole two-gun run', pageErrors.length === 0, JSON.stringify(pageErrors));
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^\[worker-core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error across the whole two-gun run', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));

  console.log(`\nScreenshots saved under: ${SHOT_DIR}`);
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
