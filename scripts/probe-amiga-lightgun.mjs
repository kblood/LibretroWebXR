// Amiga (PUAE) light-gun probe — the verification behind SYSTEMS.amiga.lightgun
// (the Trojan Phazer, device 260 on port 0). Opt-in: needs real Chrome and the
// gitignored public/cores/puae_libretro.{js,wasm} build. Never runs in CI.
//
//   npm run probe:amiga-lightgun          (or: node scripts/probe-amiga-lightgun.mjs)
//   exit 0 = every assertion passed, 1 = at least one failed, 2 = precondition missing
//
// WHY THIS CORE NEEDED ANYTHING AT ALL
// ------------------------------------
// libretro-uae was never the problem: retro_ui_get_pointer_state()
// (libretro/libretro-mapper.c) has always read the standard
// input_state_cb(port, RETRO_DEVICE_LIGHTGUN, …) SCREEN_X / SCREEN_Y /
// IS_OFFSCREEN ids, and retro_set_controller_port_device() maps device 260 onto
// UAE jport mode 8 (lightpen). What was missing was the FRONTEND half: the
// shipped puae build (2026-06-14) predates all gun work and was linked against a
// stock rwebinput, which has NO RETRO_DEVICE_LIGHTGUN case whatsoever — so aim
// and trigger read 0 forever, silently. The fix was a relink against the patched
// RetroArch tree (docs/patches/rwebinput-lightgun*.diff, recipe in
// docs/AMIGA_CORE_BUILD.md). No app-side gun code changed; this probe exists to
// prove that claim rather than assert it.
//
// WHAT IS MEASURED, AND WHY IT IS GROUND TRUTH
// --------------------------------------------
// PUAE draws its own crosshair for a gun port straight INTO the emulated
// framebuffer (retro_ui_get_pointer_state again, colour from
// puae_joyport_pointer_color), so the crosshair's position in the captured frame
// is the core's own opinion of where the gun points — not the app's. This probe
// locates it by hue and checks it lands where sendLightgun() aimed.
//
// The TRIGGER is a separate path and is measured separately: PUAE ignores
// RETRO_DEVICE_ID_LIGHTGUN_TRIGGER (retro_lightpen_update in libretro-glue.c
// reads position only and discards the button byte) and takes the fire button
// from RETRO_DEVICE_MOUSE's left button, gated on puae_physicalmouse. With the
// statusbar on, a lightgun port renders mflag[port] through
// joystick_value_human(…, 3), which prints an inverted 'L' glyph exactly while
// that button is held — a pixel band that appears on press and clears on
// release. The statusbar is enabled HERE ONLY (it is a probe instrument, not
// part of SYSTEMS.amiga.lightgun's coreOptions).
//
// NEGATIVE CONTROL — the reason a green run means anything. Every measurement
// above is repeated in a second boot that is byte-identical except that NO gun
// device is seated (no inputDevices, no remapName). If the crosshair or the
// trigger band showed up there too, they would be ambient AROS animation rather
// than gun state, and the positive half would prove nothing. The control boot
// must show zero crosshair pixels at every aim and zero trigger response.
//
// Content is a BLANK double-density floppy and puae_kickstart 'aros' (PUAE's
// built-in AROS replacement ROM), so this probe needs nothing from the private,
// gitignored public/roms/local tree and runs on a clean clone that has fetched
// cores. There is no Amiga light-gun game on hand to shoot at — when one turns
// up, an in-game hit test belongs here as a further step, the way
// scripts/probe-psx-guncon.js asserts a real calibration screen advancing.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isLightgunCapable, lightgunLoadConfig } from '../src/systems.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 5208;
const BASE = `http://localhost:${PORT}/`;
const CORE_JS = resolve(ROOT, 'public', 'cores', 'puae_libretro.js');
const CORE_WASM = resolve(ROOT, 'public', 'cores', 'puae_libretro.wasm');
const SHOT_DIR = resolve(ROOT, 'tmp');
const BOOT_MS = Number(process.env.BOOT_MS ?? 20000);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
const info = (name, extra = '') => console.log(`INFO  ${name}${extra ? '  — ' + extra : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CHROME) { console.error('ERROR: no Chrome/Edge binary found'); process.exit(2); }
const missing = [CORE_JS, CORE_WASM].filter((p) => !existsSync(p));
if (missing.length) {
  console.error('ERROR: puae core artifact(s) missing (public/cores/ is gitignored — run npm run fetch-cores / rebuild):');
  for (const p of missing) console.error(`  ${p}`);
  process.exit(2);
}

// --- Registry + artifact preconditions (pure, no browser) --------------------
// The gate guard: if SYSTEMS.amiga.lightgun is ever removed or flagged
// `broken`, the app stops offering the gun and this probe must go red rather
// than quietly measuring nothing.
ok('registry: the Amiga gun is offered UN-GATED (isLightgunCapable("amiga"))',
   isLightgunCapable('amiga') === true);
const cfg = lightgunLoadConfig('amiga');
ok('registry: config seats device 260 on port 0 (inputDevices {1:260})',
   JSON.stringify(cfg?.inputDevices) === JSON.stringify({ 1: 260 }), JSON.stringify(cfg?.inputDevices));
ok('registry: the gun core is puae with remapName "PUAE" (a port device only connects through the .rmp)',
   cfg?.core === 'puae' && cfg?.remapName === 'PUAE', `${cfg?.core} / ${cfg?.remapName}`);
// The artifact tell. The base gun patch cannot be string-searched (it adds a
// switch case, not a symbol), but the multiport patch exports a symbol, and both
// were applied by the same relink — so its presence is the static proof that the
// shipped .js is the relinked build and not the pre-gun 2026-06-14 one or a
// buildbot refresh. Mirrors scripts/test-patched-cores.mjs, which enforces the
// same thing against public/cores/PATCHED.json on every `npm test`.
const glue = readFileSync(CORE_JS, 'utf8');
ok('artifact: public/cores/puae_libretro.js is the gun-patched relink (exports rwebinput_set_lightgun)',
   glue.includes('rwebinput_set_lightgun'));

mkdirSync(SHOT_DIR, { recursive: true });
// Spawned WITHOUT a shell and by direct script path, so vite.pid is the real
// node process and vite.kill() below actually stops it — an npx/shell wrapper
// leaves the dev server orphaned on this port, and this project must never be
// cleaned up by killing node by name (see CLAUDE.md).
const vite = spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverUp = false;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(BASE); if (r.ok) { serverUp = true; break; } } catch (_) {}
  await sleep(500);
}
if (!serverUp) { console.error(`ERROR: vite did not come up on ${BASE}`); vite.kill(); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--enable-features=SharedArrayBuffer', '--no-sandbox', '--use-gl=swiftshader'],
});

// One boot of PUAE + the aim/trigger sweep. `seatGun` false = the negative
// control: identical in every other respect, including the crosshair colour and
// the statusbar, so any difference between the two runs is the seated gun.
async function run(seatGun) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });

  const started = await page.evaluate(async (seatGun, gunCfg) => {
    const { EmulatorClient } = await import('/src/EmulatorClient.js');
    const canvas = document.createElement('canvas');
    canvas.id = 'amiga'; canvas.width = 720; canvas.height = 540;
    canvas.style.position = 'fixed'; canvas.style.left = '0'; canvas.style.top = '0'; canvas.style.zIndex = '99999';
    document.body.appendChild(canvas);
    const client = new EmulatorClient({ coreUrl: 'cores/puae_libretro.js', coreName: 'puae', moduleStyle: 'module' });
    window.__amiga = client;
    const blank = new Uint8Array(901120); // blank DD Amiga floppy: AROS, no private ROM needed
    const opts = {
      contentExt: 'adf',
      coreOptions: {
        puae_kickstart: 'aros',
        ...gunCfg.coreOptions,
        // Probe instrument only (see header): the statusbar is where the
        // trigger becomes visible.
        puae_statusbar: 'bottom',
        puae_statusbar_startup: 'enabled',
      },
    };
    if (seatGun) { opts.inputDevices = gunCfg.inputDevices; opts.remapName = gunCfg.remapName; }
    return await new Promise((res) => {
      client.addEventListener('ready', () => res('ready'), { once: true });
      client.addEventListener('error', (e) => res('error:' + (e.detail || '')), { once: true });
      client.start(canvas, blank.buffer, opts).catch((e) => res('throw:' + e.message));
      setTimeout(() => res('timeout-start'), 25000);
    });
  }, seatGun, cfg);

  await sleep(BOOT_MS);

  // Hold one aim for ~1 s of wall clock (PUAE under swiftshader is slow), then
  // read the frame back through a real screenshot. NOT drawImage(canvas): the
  // core's WebGL context has no preserveDrawingBuffer, so an in-page copy comes
  // back empty — measured, it reported zero crosshair pixels on a frame whose
  // screenshot plainly showed one.
  async function aim(u, v, trigger) {
    await page.evaluate(async (u, v, trigger) => {
      for (let i = 0; i < 40; i++) { window.__amiga.sendLightgun(u, v, trigger); await new Promise((r) => setTimeout(r, 25)); }
    }, u, v, trigger);
    const el = await page.$('#amiga');
    const b64 = await el.screenshot({ encoding: 'base64' });
    return await page.evaluate(async (b64) => {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im); im.onerror = () => rej(new Error('decode'));
        im.src = 'data:image/png;base64,' + b64;
      });
      const W = img.width, H = img.height, BAR = 40; // statusbar strip height
      const t = document.createElement('canvas'); t.width = W; t.height = H;
      const ctx = t.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, W, H);
      // Crosshair: red pixels ABOVE the statusbar (the bar has red LEDs of its own).
      let n = 0, sx = 0, sy = 0;
      for (let y = 0; y < H - BAR; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) { n++; sx += x; sy += y; }
        }
      }
      // Statusbar: per-column count of lit pixels, so a glyph appearing shows up
      // as a change confined to a few columns.
      const cols = new Array(W).fill(0);
      for (let y = H - BAR; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) cols[x]++;
        }
      }
      return { n, cx: n ? sx / n / W : null, cy: n ? sy / n / H : null, cols, W, H };
    }, b64);
  }
  const shot = async (name) => { const el = await page.$('#amiga'); if (el) await el.screenshot({ path: resolve(SHOT_DIR, `amiga-gun-${name}.png`) }); };

  const tag = seatGun ? 'gun' : 'nogun';
  const out = { started, errs };
  out.center = await aim(0.5, 0.5, false); await shot(`${tag}-center`);
  out.topLeft = await aim(0.25, 0.25, false); await shot(`${tag}-topleft`);
  out.botRight = await aim(0.75, 0.75, false); await shot(`${tag}-botright`);
  out.offscreen = await aim(-0.5, -0.5, false); await shot(`${tag}-offscreen`);
  out.preFire = await aim(0.5, 0.5, false);
  out.fire = await aim(0.5, 0.5, true); await shot(`${tag}-fire`);
  out.postFire = await aim(0.5, 0.5, false);
  await page.close();
  return out;
}

// Columns whose statusbar lit-pixel count differs between two captures, as
// [start,end] runs, optionally restricted to a column window.
//
// The windows below are MEASURED, not guessed (2026-08-15, 720x540 canvas). The
// statusbar's left end reads "L1 <flags>  J2 <flags>  J3  J4":
//   x <  20  the port-1 MODE label — 'L1' for a light gun, 'J1' for a joypad
//   x 20..40 the port-1 flags slot — where the gun's trigger glyph appears (27-32)
//   x 40..80 the port-2 slot       — where a plain mouse button shows up (42-66)
//   x > 200  clock / LEDs / drive activity, which tick on their own: EXCLUDED
//            from every trigger comparison, since a free-running clock would
//            otherwise make "something changed" true no matter what.
const changedCols = (a, b, min = 0, max = Infinity) => {
  const runs = [];
  for (let x = min; x < Math.min(a.cols.length, max); x++) {
    if (a.cols[x] !== b.cols[x]) {
      if (runs.length && runs[runs.length - 1][1] === x - 1) runs[runs.length - 1][1] = x;
      else runs.push([x, x]);
    }
  }
  return runs;
};
const near = (got, want, tol = 0.03) => got != null && Math.abs(got - want) <= tol;

const gun = await run(true);
ok('boot: PUAE comes up with the gun seated', gun.started === 'ready', gun.started);
ok('boot: no page errors', gun.errs.length === 0, gun.errs.join(' | '));

// Aim. The crosshair is drawn by the CORE, so its position is the core's own
// reading of the gun — the app cannot fake it into the framebuffer.
ok('aim: the core draws its crosshair when the gun aims at screen centre',
   gun.center.n > 0, `${gun.center.n} px`);
ok('aim: (0.25,0.25) puts the crosshair at the top-left quadrant',
   near(gun.topLeft.cx, 0.25) && near(gun.topLeft.cy, 0.25),
   `centroid ${gun.topLeft.cx?.toFixed(3)},${gun.topLeft.cy?.toFixed(3)}`);
ok('aim: (0.75,0.75) tracks it to the bottom-right quadrant',
   near(gun.botRight.cx, 0.75) && near(gun.botRight.cy, 0.75),
   `centroid ${gun.botRight.cx?.toFixed(3)},${gun.botRight.cy?.toFixed(3)}`);
ok('aim: the crosshair actually MOVED between the two aims (not a static overlay)',
   gun.topLeft.cx != null && gun.botRight.cx != null && gun.botRight.cx - gun.topLeft.cx > 0.4);
ok('aim: an off-screen aim removes the crosshair (IS_OFFSCREEN reaches the core)',
   gun.offscreen.n === 0, `${gun.offscreen.n} px`);

// Trigger. Separate path from aim (mouse left button, not the LIGHTGUN trigger
// id), so it needs its own evidence: a statusbar glyph that appears while held.
const fireRuns = changedCols(gun.preFire, gun.fire, 0, 200);
const releaseRuns = changedCols(gun.preFire, gun.postFire, 0, 200);
ok('trigger: holding it lights a glyph in port 1\'s own statusbar slot',
   fireRuns.length > 0 && fireRuns[0][0] >= 20 && fireRuns[fireRuns.length - 1][1] < 40,
   JSON.stringify(fireRuns));
ok('trigger: releasing it restores the bar exactly (edge-triggered, no latch)',
   releaseRuns.length === 0, JSON.stringify(releaseRuns));

// --- Negative control --------------------------------------------------------
const nogun = await run(false);
ok('control: the same boot WITHOUT a gun device still comes up',
   nogun.started === 'ready', nogun.started);
ok('control: no crosshair anywhere with no gun seated (centre aim)',
   nogun.center.n === 0, `${nogun.center.n} px`);
ok('control: no crosshair for either off-centre aim either',
   nogun.topLeft.n === 0 && nogun.botRight.n === 0,
   `${nogun.topLeft.n} / ${nogun.botRight.n} px`);
// The trigger control is deliberately NARROW, because the broad version is
// false and measuring it was what showed that: sendLightgun's mouse-button press
// reaches the core whether or not a gun is seated, and PUAE renders it — as
// MOUSE flags, in the port-2 slot (measured: columns 42-66 change here). What
// only happens with a gun seated is port 1's OWN slot responding, which is the
// slot the gun's trigger drives. So the control asserts that slot stays dead,
// and records the mouse-flag response rather than pretending it isn't there.
const ctlGunSlot = changedCols(nogun.preFire, nogun.fire, 20, 40);
const ctlAll = changedCols(nogun.preFire, nogun.fire, 0, 200);
ok('control: with no gun seated, port 1\'s slot does NOT respond to the trigger',
   ctlGunSlot.length === 0, JSON.stringify(ctlGunSlot));
info('control: what DOES respond there is the shared mouse button, in the port-2 slot',
     `changed columns ${JSON.stringify(ctlAll)}`);
// Third, independent tell that the core accepted the device: PUAE labels a
// lightgun port 'L1' instead of 'J1' (libretro-glue.c's JOYMODE1). Same content,
// same options, so a difference in the label columns is the device and nothing else.
const labelCols = changedCols(nogun.center, gun.center, 0, 20);
ok('device: the core labels port 1 as a light gun ("L1"), not a joypad ("J1")',
   labelCols.length > 0, `changed label columns ${JSON.stringify(labelCols)}`);

// --- The real app path -------------------------------------------------------
// Everything above drives EmulatorClient directly, which proves the CORE works
// but says nothing about whether a cartridge inserted in the app ever reaches it
// with a gun attached. This section boots the shipping CC0 Amiga demo through
// the real window.__insertCartridge path with `lightgun: true` and reads the
// files the core actually booted with out of its own emscripten FS — the same
// ground-truth trick scripts/probe-hotswap-config.mjs uses.
{
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  const appReady = await page.waitForFunction(
    () => typeof window.__insertCartridge === 'function' && !!window.__client, { timeout: 40000 },
  ).then(() => true).catch(() => false);
  ok('app path: the app initialises with __insertCartridge/__client', appReady);

  if (appReady) {
    await page.evaluate(() => window.__insertCartridge({
      file: 'freeware/lwx-amiga-demo.adf', system: 'amiga', core: 'puae',
      title: 'LWX Amiga Demo', lightgun: true,
    }));
    await page.waitForFunction(() => !!(window.__client?.ready), { timeout: 90000 }).catch(() => {});
    await sleep(4000);
    const files = await page.evaluate(() => {
      const c = window.__client?.delegate || window.__client;
      const M = c?._getModule?.();
      if (!M?.FS) return { cfg: null, rmp: null, opts: null, why: 'no live main-thread module' };
      const read = (p) => { try { return M.FS.readFile(p, { encoding: 'utf8' }); } catch (e) { return `ERR:${e?.message || e}`; } };
      const D = '/home/web_user/retroarch/userdata';
      return {
        cfg: read(`${D}/retroarch.cfg`),
        rmp: read(`${D}/config/remaps/PUAE/PUAE.rmp`),
        opts: read(`${D}/retroarch-core-options.cfg`),
      };
    });
    ok('app path: a gun-flagged Amiga cartridge boots with the gun device declared to the core',
       typeof files.cfg === 'string' && files.cfg.includes('input_libretro_device_p1 = "260"'),
       typeof files.cfg === 'string'
         ? (files.cfg.split('\n').filter((l) => /input_libretro_device|gun_trigger/.test(l)).join(' | ') || 'no device lines at all')
         : String(files.cfg));
    ok('app path: the trigger is bound to the mouse button PUAE reads it from',
       typeof files.cfg === 'string' && files.cfg.includes('input_player1_gun_trigger_mbtn = "1"'));
    // The .rmp is what actually CONNECTS the device at boot (the main cfg's
    // device line is ignored there) — see EmulatorClient's REMAP_DIR comment.
    ok('app path: the per-core remap that connects the device at boot was written',
       typeof files.rmp === 'string' && files.rmp.includes('input_libretro_device_p1 = "260"'),
       files.rmp ? files.rmp.trim() : String(files.rmp));
    // The merge, which is easy to get wrong in the other direction: the gun's
    // coreOptions must be layered ON TOP of CORES.puae's, not replace them — drop
    // puae_kickstart/puae_model_fd and a gun boot would stop finding a real
    // Kickstart and boot a different machine than the same game without a gun.
    ok('app path: the gun options are merged with the core\'s, not substituted for them',
       typeof files.opts === 'string'
         && files.opts.includes('puae_joyport_pointer_color = "red"')
         && files.opts.includes('puae_kickstart =')
         && files.opts.includes('puae_model_fd ='),
       files.opts ? files.opts.replace(/\n/g, ' | ').slice(0, 300) : String(files.opts));
    ok('app path: no page errors', errs.length === 0, errs.join(' | '));
  }
  await page.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
console.log(`screenshots: tmp/amiga-gun-{gun,nogun}-*.png`);
await browser.close();
vite.kill();
process.exit(failed ? 1 : 0);
