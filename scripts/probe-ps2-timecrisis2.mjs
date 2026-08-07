// Re-verification of the 2026-07-18 "Time Crisis II boots" confirmation
// AGAINST CURRENT CODE (2026-07-27), following this session's PS2 Phase A/B
// facade rewrite (RuntimeEmulatorClient replacing EmulatorClient app-wide) and
// sort_save* config fix. That prior confirmation predates both changes and is
// stale evidence — see docs/PS2_CORE_BUILD.md's "Verified: real commercial
// game boot" section, commit a9cbe75. It was also never driven through the
// REAL app: tmp/diag-ps2-realgame.mjs and tmp/diag-ps2-realgame-play.mjs (both
// gitignored, never committed) directly `import EmulatorClient` and call
// `client.start()` on a resized/repositioned #canvas overlay — completely
// bypassing loadCartridge/handleCartridgeInserted/the collection system.
//
// This probe instead boots through the REAL app flow, same bar as
// probe-n64-mario64.mjs and probe-ps2-guncon-regression.mjs:
//   window.__insertCartridge(meta) === handleCartridgeInserted(meta) ===
//   the exact function GrabMgr.js's onCartridgeInserted callback invokes when
//   a physical cartridge snaps into a console's slot in VR. `meta` here is
//   the same shape as the new local.collection.json entry (see that file) —
//   this probe doubles as the entry's own verification.
//
// Content: the user's own legally-owned Time Crisis II (Japan, With GunCon2)
// dump, staged at public/roms/local/ps2/ (gitignored, NOT in git). The game
// disc is a raw MODE2/2352 .bin with a .cue sidecar; Play!'s Emscripten build
// routes ALL optical-disc opens through a JS discImageDevice bridge that only
// auto-activates for core:play + extension in {iso,cso,isz,chd} (deliberately
// excluding .cue — a cue sheet parses into TWO CreateImageStream() calls that
// collide on the bridge's single global slot; see EmulatorClient.js's
// DISC_IMAGE_EXTS comment). `local/ps2/time-crisis-2.iso` is a same-inode NTFS
// hardlink to the .bin (zero extra disk space) so the REAL pick/collection
// path's extension-derived contentExt auto-detects discImage=true, exactly
// the workaround the original 2026-07-18 verification used manually via an
// explicit opts.discImage override.
//
// What this checks, all through the real app (real vite dev server, real
// index.html, real main.js):
//   1. Real cartridge-insert boot reaches RuntimeEmulatorClient 'main' mode + ready.
//   2. Multiple timestamped screenshots (both a real page.screenshot() and an
//      in-page pixel-region analysis, mirroring probe-ps2-guncon-regression.mjs's
//      TV_RECT scoping) across a boot/settle window, asserting specific
//      Time-Crisis-II-plausible content signatures (the memory-card-select
//      screen's dark text banner + purple/violet slot-1 highlight box; the oil-
//      rig intro cutscene's dark night sky + white spotlight beams), not just
//      "non-blank".
//   3. Synthetic Start(Enter)/Cross(h) presses via the real client.sendInput()
//      path (same primitive GameInputMgr/Keyboard/DesktopGamepad all use) to
//      try advancing past the memory-card prompt, matching the prior
//      confirmation's proven navigation.
//   4. GunCon2 arm/fire via window.__armGun/__gunArmedState/__testApi.gun.fire() (the
//      exact in-VR gun-grab/trigger call chain) against this REAL game, not
//      just the homebrew games/ps2-guncon-range target every prior PS2 gun
//      regression check used.
//   5. No pageerror / no console error across the whole run.
//
// AUDIT 2026-07-29 — what this probe does and does NOT establish.
// It was audited by breaking the capability it claimed to prove: with
// EmulatorClient.sendInput() made a no-op (presses accepted and resolved
// app-side, nothing dispatched to the core) the probe still passed 18/18. The
// old "[CUTSCENE-ADVANCE SIGNAL]" was an absolute one-frame palette test with
// no no-input arm and could not tell input-driven advance from a title that
// boots into the same state on its own. Pixel evidence cannot carry that claim
// on this title at all: the TV rect churns ~8-12k of 56050 pixels every 2s with
// zero input and never quiesces, so input-caused motion is unmeasurable here.
// The causal claim is now carried by [INPUT-REACHES-CORE], a two-arm same-
// instant comparison that is red under that same negative control; the palette
// checks are renamed to [FRAME-SHAPE, NOT CAUSAL] / [LIVENESS, NOT CAUSAL] and
// state only what they establish. A green run means: the game boots through the
// real cartridge-insert path and renders plausible content, synthetic RetroPad
// keys are delivered to and consumed by this core's input driver, and the
// GunCon2 seats and fires without throwing. It does NOT mean "the game visibly
// advanced because of the synthetic input" — nothing in this probe shows that.
//
// Usage:
//   npm run probe:ps2-timecrisis2
//   node scripts/probe-ps2-timecrisis2.mjs
//
// Exit code: 0 = all PASS assertions passed, 1 = at least one failed / setup error.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5201;
const BASE = `http://localhost:${PORT}/`;
const ISO = resolve(ROOT, 'public', 'roms', 'local', 'ps2', 'time-crisis-2.iso');
const CORE_JS = resolve(ROOT, 'public', 'cores', 'play_libretro.js');
const CORE_WASM = resolve(ROOT, 'public', 'cores', 'play_libretro.wasm');
const SHOT_DIR = resolve(ROOT, 'tmp');
const META = { file: 'local/ps2/time-crisis-2.iso', system: 'ps2', core: 'play', title: 'Time Crisis II', lightgun: true };

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

if (!CHROME) {
  console.error('ERROR: no Chrome/Edge binary found');
  process.exit(1);
}
const missing = [ISO, CORE_JS, CORE_WASM].filter((p) => !existsSync(p));
if (missing.length) {
  console.error('ERROR: required artifact(s) missing:');
  for (const p of missing) console.error(`  ${p}`);
  console.error('(the ISO is a gitignored, user-owned local ROM — see public/roms/local/local.collection.json\'s Time Crisis II entry; public/cores/ is gitignored build output — fetch/build the play core first)');
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
// Race a promise against a hard deadline so a stuck CDP call (e.g. a
// Runtime.callFunctionOn that never settles) reports as a diagnosable timeout
// instead of silently eating the whole protocolTimeout with no information —
// this cost real debugging time once already (2026-07-27 investigation), so
// every heavier in-page evaluate() in this probe goes through it.
// `guarded` never rejects (it catches internally) so if `p` settles AFTER the
// timeout branch already won the race (e.g. a CDP call that eventually times
// out on its own protocolTimeout), there's no orphaned unhandledRejection.
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

// Region-tag a screenshot: real page.screenshot() PNG, decoded through an
// in-page <img>/2D-canvas round-trip (works regardless of what backs #canvas),
// scoped to the same TV-screen rect probe-ps2-guncon-regression.mjs measured
// for this scene's fixed default-camera 1024x768 view (excludes room/bezel/UI
// chrome). Returns whole-frame AND TV-rect-scoped named-color pixel counts.
const TV_RECT = { x: 365, y: 390, w: 295, h: 190 };

async function analyzeShot(page, dataUrl) {
  return page.evaluate((dataUrl, rect) => new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      // A thrown exception in here (e.g. a bad rect argument) would otherwise
      // leave this Promise permanently unresolved (img.onload runs OUTSIDE the
      // executor's own try/catch scope) -- Puppeteer then reports it as an
      // opaque "Runtime.callFunctionOn timed out" with zero information about
      // why. Cost real debugging time once already (2026-07-27); always wrap.
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
        // Named-hue counts scoped to the TV rect, matching the two states the
        // prior confirmation actually documented:
        //   grayPanel: the memory-card screen's mid-gray slot/background boxes.
        //   darkBanner: the memory-card screen's near-black instruction banner.
        //   violetHighlight: the purple/magenta "slot 1 selected" border.
        //   nightSky: the oil-rig cutscene's dark blue-green night sky.
        //   whiteBeam: the cutscene's bright white spotlight beams.
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

// Count TV-rect pixels that MOVED between two captures.
//
// This exists only to be used as a WITHIN-RUN RELATIVE measurement: two equal-
// length windows captured back-to-back on the same screen, each measured
// against its own immediately-prior frame, differing only in which keys were
// dispatched. An absolute before/after diff (or an absolute palette bucket)
// silently measures elapsed time, boot animation and state drift alongside the
// effect — that is exactly the failure mode this probe was audited for on
// 2026-07-29, so never compare a frame to the boot baseline here.
async function diffShots(page, aUrl, bUrl, rect = TV_RECT) {
  return page.evaluate((aUrl, bUrl, rect) => new Promise((res) => {
    const load = (src) => new Promise((ok2, no2) => {
      const i = new Image();
      i.onload = () => ok2(i);
      i.onerror = () => no2(new Error('image decode failed'));
      i.src = src;
    });
    Promise.all([load(aUrl), load(bUrl)]).then(([ia, ib]) => {
      // As in analyzeShot: a throw inside this async continuation would leave
      // the Promise forever pending and surface as an opaque CDP timeout.
      try {
        const grab = (img) => {
          const c = document.createElement('canvas');
          c.width = rect.w; c.height = rect.h;
          const x = c.getContext('2d');
          x.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
          return x.getImageData(0, 0, rect.w, rect.h).data;
        };
        const da = grab(ia), db = grab(ib);
        let changed = 0, total = 0;
        for (let i = 0; i < da.length; i += 4) {
          total++;
          if (Math.abs(da[i] - db[i]) > 16
           || Math.abs(da[i + 1] - db[i + 1]) > 16
           || Math.abs(da[i + 2] - db[i + 2]) > 16) changed++;
        }
        res({ changed, total });
      } catch (e) { res({ error: String(e && e.message || e) }); }
    }).catch((e) => res({ error: String(e && e.message || e) }));
  }), aUrl, bUrl, rect);
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
    if (message.text().includes('[analyzeShot]')) console.log('  BROWSER: ' + message.text());
  });

  await page.goto(BASE, { waitUntil: 'load' });

  const ready = await page.waitForFunction(
    () => !!window.__client && typeof window.__insertCartridge === 'function'
       && typeof window.__armGun === 'function' && typeof window.__gunArmedState === 'function'
       && typeof window.__testApi?.gun?.fire === 'function',
    { timeout: 30000 },
  ).then(() => true).catch(() => false);
  ok('app booted with cartridge-insert/gun-test hooks ready', ready);
  if (!ready) throw new Error('app never finished initialising');

  // --- Step 1: boot via the REAL cartridge-insert path ---
  const t0 = Date.now();
  const insert = await page.evaluate(async (meta) => {
    try { await window.__insertCartridge(meta); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }, META);
  ok('real cartridge-insert path (handleCartridgeInserted) resolves without throwing', insert.ok, insert.reason || '');
  if (!insert.ok) throw new Error(insert.reason);

  // A real 700MB+ disc image (fetched by the browser itself from the local
  // dev server, then handed through Play!'s discImageDevice bridge) + a full
  // PS2 BIOS boot legitimately takes much longer than an 8/16-bit cartridge
  // or the tiny homebrew guncon-range ELF — give it real room before failing.
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
  if (!bootedReady) throw new Error('play core never reported ready');

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
    return { name, stats, dataUrl, timedOutAt: analyzeRes.ok ? null : 'analyzeShot' };
  }

  // Bare capture (no palette analysis) for the frame-to-frame windows below.
  async function grab(name) {
    const shotRes = await withTimeout(page.screenshot(), 30000, 'page.screenshot');
    if (!shotRes.ok) return null;
    saveShot(shotRes.v, name);
    return 'data:image/png;base64,' + shotRes.v.toString('base64');
  }

  // --- Step 2: capture the boot-settle sequence (no input yet) ---
  const shot1 = await captureNamed('probe-ps2-timecrisis2-01-boot.png', 4000);
  const shot2 = await captureNamed('probe-ps2-timecrisis2-02-settled.png', 6000);

  ok('screenshots captured to tmp/probe-ps2-timecrisis2-*.png', existsSync(resolve(SHOT_DIR, 'probe-ps2-timecrisis2-01-boot.png')));
  ok('[REAL-CONTENT] TV region shows real non-black, non-uniform content after boot (not stuck on a black/frozen screen)',
     [shot1, shot2].some((s) => s.stats && s.stats.tvNonBlack > 0 && s.stats.tvNonBlack < s.stats.tvTotal * 0.995),
     [shot1, shot2].map((s) => `${s.name}: tvNonBlack=${s.stats?.tvNonBlack}/${s.stats?.tvTotal}`).join('; '));

  async function press(code, key) {
    const down = await withTimeout(page.evaluate((code, key) => window.__client.sendInput('keydown', code, key), code, key), 15000, 'sendInput-down');
    await sleep(120);
    const up = await withTimeout(page.evaluate((code, key) => window.__client.sendInput('keyup', code, key), code, key), 15000, 'sendInput-up');
    await sleep(700);
    return down.ok && up.ok;
  }
  let allPressesOk = true;

  // --- Step 2b: [TV-RECT-AIM] is TV_RECT still pointed at the live screen? ----
  //
  // TV_RECT is a hardcoded rect for the fixed default-camera 1024x768 pose. A
  // camera/layout change would silently retarget every pixel measurement in
  // this probe onto static room geometry, and the palette buckets below would
  // go on reporting numbers for the wrong pixels. Guard it relatively: over the
  // SAME interval, the TV rect must move far more than an equal-area rect of
  // room chrome. If TV_RECT ever drifts off the screen this goes red.
  const ROOM_RECT = { x: 40, y: 40, w: TV_RECT.w, h: TV_RECT.h };
  const tvPixels = TV_RECT.w * TV_RECT.h;
  const aimA = await grab('probe-ps2-timecrisis2-aim-a.png');
  await sleep(1500);
  const aimB = await grab('probe-ps2-timecrisis2-aim-b.png');
  let aimTv = null, aimRoom = null;
  if (aimA && aimB) {
    const t = await withTimeout(diffShots(page, aimA, aimB, TV_RECT), 30000, 'diffShots-tv');
    const r = await withTimeout(diffShots(page, aimA, aimB, ROOM_RECT), 30000, 'diffShots-room');
    aimTv = t.ok && typeof t.v?.changed === 'number' ? t.v.changed : null;
    aimRoom = r.ok && typeof r.v?.changed === 'number' ? r.v.changed : null;
  }
  ok('[TV-RECT-AIM] the hardcoded TV_RECT is still aimed at the live emulator screen '
     + '(over one interval it moves far more than an equal-area rect of static room chrome)',
     aimTv !== null && aimRoom !== null && aimTv >= Math.max(aimRoom * 4, tvPixels * 0.01),
     `tvChanged=${aimTv} roomChanged=${aimRoom} of ${tvPixels}`);

  // --- Step 2c: [INPUT-REACHES-CORE] two-arm, one-variable, same instant -----
  //
  // AUDIT 2026-07-29. The check that used to carry this claim
  // ("[CUTSCENE-ADVANCE SIGNAL] the FINAL post-input capture ... shows the
  // cutscene/menu palette") named the synthetic input as the cause but only
  // ever asked "does the last frame fall in a palette bucket". It was run
  // against a negative control in which EmulatorClient.sendInput() was made a
  // no-op — every synthetic press still accepted and resolved app-side, nothing
  // dispatched to the core — and it passed IDENTICALLY, 18/18, satisfying its
  // bucket (nightSky=28146) more strongly than the working run (10544). Same
  // class of defect as probe:psx-guncon's old boot-baseline maxDiff check.
  //
  // Pixel evidence cannot carry this claim on this title at all: measured with
  // zero input for 135s straight, the TV rect churns a steady ~8-12k of 56050
  // pixels every 2s (scripts/_measure-quiesce.mjs during the audit) and never
  // quiesces, so any input-caused motion is buried in the attract loop. An
  // earlier rewrite that compared a Start/Cross window against an identically
  // timed unbound-key window measured control=[36486,5242,8382] vs
  // input=[13718,13670,8634] — pure noise. It was NOT shipped.
  //
  // What IS measurable, and is a genuine two-arm relative comparison:
  //   ARM A (path under test) — call the real window.__client.sendInput(), the
  //     same primitive GameInputMgr/Keyboard/DesktopGamepad use, and observe the
  //     event from a bubble-phase listener on the core's own canvas. The
  //     listener is added AFTER the core registered its own, so it runs second
  //     and can read defaultPrevented: emscripten's HTML5 keyboard shim calls
  //     preventDefault() exactly when the core's registered callback consumed
  //     the key. Firing at all proves the event was delivered to THIS console's
  //     canvas; defaultPrevented proves the core's input handler actually ran.
  //   ARM B (control) — at the same instant, an identical KeyboardEvent
  //     dispatched to a sibling element outside the core. Everything is the
  //     same but the dispatch target, so if `defaultPrevented` were coming from
  //     some app-wide or browser-wide handler rather than from the core, arm B
  //     would show it too. Measured during the audit: canvas=true, sibling=false.
  //
  // This goes red when sendInput() is a no-op (arm A never fires), when it
  // regresses to dispatching at `document` instead of the core canvas (the real
  // 2026-06-02 regression — arm A never fires), when the core fails to install
  // its input handler (arm A dp=false), and when multi-core routing sends the
  // keys to the wrong console's canvas (arm A never fires). Validated: red
  // under the sendInput no-op negative control, green here.
  //
  // Scope, stated honestly: this proves synthetic RetroPad keys reach and are
  // consumed by THIS core's input driver. It does NOT prove the game reacted —
  // see the [FRAME-SHAPE] note below for why nothing here can prove that.
  const reachRes = await withTimeout(page.evaluate(async () => {
    const canvas = window.__client?.delegate?.emuCanvas || window.__client?.emuCanvas || null;
    if (!canvas) return { ok: false, why: 'no emuCanvas on the running client' };
    const seen = [];
    const rec = (ev) => seen.push({ code: ev.code, dp: ev.defaultPrevented, onCore: ev.currentTarget === canvas });
    canvas.addEventListener('keydown', rec, false); // bubble phase → runs after the core's own handler
    const sibling = document.createElement('div');
    document.body.appendChild(sibling);
    const control = [];
    try {
      for (const [code, key] of [['Enter', 'Enter'], ['KeyH', 'h'], ['KeyG', 'g']]) {
        window.__client.sendInput('keydown', code, key);             // ARM A
        const ev = new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true });
        sibling.dispatchEvent(ev);                                   // ARM B, same instant
        control.push({ code, dp: ev.defaultPrevented });
        window.__client.sendInput('keyup', code, key);
        await new Promise((r) => setTimeout(r, 120));
      }
    } finally {
      canvas.removeEventListener('keydown', rec, false);
      sibling.remove();
    }
    return { ok: true, seen, control };
  }), 30000, 'inputReachesCore');
  const reach = reachRes.ok ? reachRes.v : null;
  const coreArm = reach?.seen || [];
  const ctrlArm = reach?.control || [];
  const coreArmOk = coreArm.length === 3 && coreArm.every((e) => e.onCore === true && e.dp === true);
  const ctrlArmOk = ctrlArm.length === 3 && ctrlArm.every((e) => e.dp === false);
  const reachDetail = `coreArm=${JSON.stringify(coreArm)} controlArm=${JSON.stringify(ctrlArm)}`
    + (reach?.why ? ` why=${reach.why}` : '') + (reachRes.ok ? '' : ` TIMED OUT (${reachRes.label})`);
  ok('[INPUT-REACHES-CORE] synthetic RetroPad keys sent through the real client.sendInput() are delivered to '
     + "THIS console's own canvas and consumed by the core's input handler, while an identical KeyboardEvent "
     + 'dispatched at the same instant to a non-core element is NOT consumed (two arms, one variable: the target)',
     coreArmOk && ctrlArmOk, reachDetail);

  // --- Step 3: try to advance past the memory-card prompt via the REAL
  // client.sendInput() path (same primitive GameInputMgr uses), mirroring the
  // prior confirmation's proven Start/Cross navigation ---
  for (let i = 0; i < 4; i++) allPressesOk = (await press('Enter', 'Enter')) && allPressesOk;
  const shot3 = await captureNamed('probe-ps2-timecrisis2-03-afterstart.png', 500);
  for (let i = 0; i < 6; i++) allPressesOk = (await press('KeyH', 'h')) && allPressesOk;
  const shot4 = await captureNamed('probe-ps2-timecrisis2-04-aftercross.png', 500);
  const shot5 = await captureNamed('probe-ps2-timecrisis2-05-final.png', 5000);

  // [Codex review, 2026-07-27] press() previously discarded withTimeout()'s
  // {ok:false} result on a throw/timeout, so a regression that broke the
  // real Start/Cross sendInput() path entirely would go unnoticed — the
  // palette/frame-change checks below can still pass off the pre-input boot
  // animation alone. Assert the synthetic input calls themselves actually
  // succeeded, not just that the game kept rendering something.
  ok('all synthetic Start/Cross sendInput() calls resolved without throwing/timing out',
     allPressesOk, `allPressesOk=${allPressesOk}`);

  const allShots = [shot1, shot2, shot3, shot4, shot5];
  const cutsceneSignature = (s) => s.stats && (
    (s.stats.grayPanel > s.stats.tvTotal * 0.05 && s.stats.darkBanner > s.stats.tvTotal * 0.02) ||
    (s.stats.nightSky > s.stats.tvTotal * 0.05 && s.stats.whiteBeam > 0)
  );
  // [AUDIT 2026-07-29] "post-input" was wrong: allShots includes shot1/shot2,
  // both captured before any press. Wording corrected; this stays a content-
  // plausibility check, not an input-response one.
  ok('[REAL-CONTENT] at least one frame in the run shows recognizable memory-card-screen OR cutscene palette '
     + '(gray panel / dark banner / violet highlight box, OR night-sky / white spotlight-beam colors)',
     allShots.some(cutsceneSignature),
     allShots.map((s) => `${s.name}: gray=${s.stats?.grayPanel} dark=${s.stats?.darkBanner} violet=${s.stats?.violetHighlight} sky=${s.stats?.nightSky} beam=${s.stats?.whiteBeam}`).join(' | '));

  // [Codex review, 2026-07-27] pinned this to the final capture rather than
  // "some frame in the run".
  // [AUDIT 2026-07-29] It was still named "[CUTSCENE-ADVANCE SIGNAL]" and read
  // as "the synthetic input advanced the game into the cutscene". It does not
  // establish that. It is an ABSOLUTE palette-bucket test on one frame with no
  // no-input arm: a title that reaches the same state on its own over ~25s of
  // boot, with every press dropped on the floor, satisfies it identically.
  // MEASURED, not assumed — with EmulatorClient.sendInput() no-op'd it passed
  // at gray=759 dark=19616 sky=28146 beam=49 vs the working run's gray=618
  // dark=45369 sky=10544 beam=11, i.e. it matched its bucket MORE strongly
  // while nothing whatsoever reached the emulated PS2. Renamed to say only
  // what it establishes. The causal claim now lives in [INPUT-REACHES-CORE].
  ok('[FRAME-SHAPE, NOT CAUSAL] the final capture\'s TV palette falls in the memory-card/cutscene bucket '
     + '(descriptive only — this frame is NOT attributed to the synthetic input; it passes unchanged with '
     + 'sendInput() no-op\'d, see the audit note above)',
     cutsceneSignature(shot5),
     `${shot5.name}: gray=${shot5.stats?.grayPanel} dark=${shot5.stats?.darkBanner} sky=${shot5.stats?.nightSky} beam=${shot5.stats?.whiteBeam}`);

  // [AUDIT 2026-07-29] This is an elapsed-time drift check and nothing more:
  // five time-separated signatures, Set size > 1. Time Crisis II's attract loop
  // churns ~8-12k of the 56050 TV pixels every 2s with ZERO input (measured
  // over 135s), so this passes on wall-clock alone. Kept as a liveness/
  // not-frozen check, renamed so nobody reads it as an input-response signal.
  ok('[LIVENESS, NOT CAUSAL] the TV kept rendering new frames across the run (not one frozen frame) — '
     + 'elapsed-time drift only, this title animates on its own with no input at all',
     (() => {
       const sigs = allShots.map((s) => s.stats && `${s.stats.tvNonBlack}:${s.stats.grayPanel}:${s.stats.nightSky}:${s.stats.whiteBeam}:${s.stats.violetHighlight}`);
       return new Set(sigs.filter(Boolean)).size > 1;
     })(),
     allShots.map((s) => s.name).join(', '));

  // --- Step 4: GunCon2 arm/fire against this REAL game (not just the
  // homebrew ps2-guncon-range target) ---
  const armRes = await withTimeout(page.evaluate(async () => {
    try { await window.__armGun(); return { ok: true }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }), 45000, 'armGun');
  ok('__armGun() (the real gun-grab handler) resolves without throwing against Time Crisis II',
     armRes.ok && armRes.v?.ok, armRes.ok ? (armRes.v?.reason || '') : `TIMED OUT (${armRes.label})`);
  await sleep(3000); // PS2 live-reboot is slower than 8/16-bit cores

  const armStateRes = await withTimeout(page.evaluate(() => window.__gunArmedState()), 15000, 'gunArmedState');
  const armState = armStateRes.ok ? armStateRes.v : {};
  ok('GunCon2 device is connected on the console after arming', armState.consoleArmed === true,
     `state=${JSON.stringify(armState)}`);
  ok('armed system is ps2', armState.system === 'ps2', `system=${armState.system}`);

  const fireOnScreen = await withTimeout(page.evaluate(async () => {
    try { const r = await window.__testApi.gun.fire({ pos: { x: 0, y: 1.2, z: -1 }, look: { x: 0, y: 1.2, z: -2 }, trigger: true }); return { ok: true, result: r }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }), 15000, 'gunFire-on');
  ok('on-screen gun fire (trigger held) does not throw against the real game',
     fireOnScreen.ok && fireOnScreen.v?.ok, fireOnScreen.ok ? (fireOnScreen.v?.reason || `result=${JSON.stringify(fireOnScreen.v?.result)}`) : `TIMED OUT (${fireOnScreen.label})`);

  const fireRelease = await withTimeout(page.evaluate(async () => {
    try { const r = await window.__testApi.gun.fire({ pos: { x: 0, y: 1.2, z: -1 }, look: { x: 0, y: 1.2, z: -2 }, trigger: false }); return { ok: true, result: r }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }), 15000, 'gunFire-release');
  ok('trigger release does not throw',
     fireRelease.ok && fireRelease.v?.ok, fireRelease.ok ? (fireRelease.v?.reason || `result=${JSON.stringify(fireRelease.v?.result)}`) : `TIMED OUT (${fireRelease.label})`);

  const fireOffScreen = await withTimeout(page.evaluate(async () => {
    try { const r = await window.__testApi.gun.fire({ pos: { x: 500, y: 500, z: 500 }, look: { x: 501, y: 500, z: 500 }, trigger: true }); return { ok: true, result: r }; }
    catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  }), 15000, 'gunFire-offscreen');
  ok('off-screen gun fire does not throw',
     fireOffScreen.ok && fireOffScreen.v?.ok, fireOffScreen.ok ? (fireOffScreen.v?.reason || `result=${JSON.stringify(fireOffScreen.v?.result)}`) : `TIMED OUT (${fireOffScreen.label})`);
  await sleep(300);

  await captureNamed('probe-ps2-timecrisis2-06-after-gun.png', 0);

  // --- Step 5: the actual regression assertions ---
  ok('NO pageerror during boot/input/arm/fire', pageErrors.length === 0, JSON.stringify(pageErrors));
  const relevantConsoleErrors = consoleErrors.filter((m) =>
    !/^\[core\]/.test(m) && !/^Failed to load resource/.test(m));
  ok('NO console error during boot/input/arm/fire', relevantConsoleErrors.length === 0, JSON.stringify(relevantConsoleErrors));

  console.log(`\nScreenshots saved under ${SHOT_DIR}\\probe-ps2-timecrisis2-*.png`);
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
