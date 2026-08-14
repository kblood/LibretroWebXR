// Permanent regression guard for the app-core correctness bugs found in the
// 2026-08 reviews (CLAUDE_REVIEW.md §5.1/§5.3/§5.4, CODEX_REVIEW.md COR-2/COR-4)
// and in the skeptic pass over the first round of fixes for them.
// Both are driven through the REAL app (real vite dev server, real index.html,
// real main.js — no bypass harness), because both are bugs about what the app
// does BETWEEN two real user actions, which no unit test can observe.
//
// ── Section A — same-core cartridge swaps must attach the NEW peripheral ──────
// (§5.4 "high, verified" / COR-4)
//
// Inserting a cartridge whose core is already running takes the hot-swap path:
// EmulatorClient.start() rewrites rom.bin, resets and RETURNS — before
// _writeRetroArchConfig(), the only consumer of `inputDevices`. So booting a
// SNES Super Scope game while a plain snes9x game is running left the core with
// the OLD game's devices (no gun) while the UI reported the gun armed. This
// section boots plain snes9x content, then a Super Scope title on the SAME core,
// and reads the RetroArch config out of the LIVE core's emscripten FS: the gun's
// device line (input_libretro_device_p2 = "260") must be there. It also asserts
// the reverse (gun game -> plain game must not inherit the gun) and that an
// unchanged boot config still takes the cheap in-place hot swap.
//
// ── Section C — the SAME must hold on a SECONDARY (rack) console ─────────────
// (skeptic finding on the round-1 fix for §5.4 / COR-4)
//
// Round 1 fixed only the primary console, from OUTSIDE EmulatorClient. The rack
// path (loadCartridgeIntoConsole → ConsoleRuntime.load) passed no
// inputDevices/coreOptions/remapName at all and hit the very same hot-swap early
// return, so on a secondary console a same-core swap kept the previous game's
// devices AND a gun game dropped there never got a device in the first place —
// with light guns on secondary consoles a shipped feature
// (docs/LIGHTGUN_SUPPORT.md). This section spawns a rack console running a plain
// snes9x game, drops a Super Scope title on THAT console, and reads the
// RetroArch config out of THAT console's live core. It also asserts the primary
// console is undisturbed by the secondary's reboot.
//
// ── Section B — leaving a room must stop its per-frame callbacks ──────────────
// (§5.1 "medium, real" + §5.3 / COR-2)
//
// Four tick callbacks registered for a room session dereference the module-level
// `net`. Leave sets `net = null` and SceneMgr had no deregistration API, so all
// four threw once per frame forever after — caught by SceneMgr._render's
// try/catch, which logged `[SceneMgr tick]` every time (~288 thrown-and-caught
// exceptions/sec on a Quest, each shipped to the remote logger). This section
// joins a real room server, leaves, and asserts ZERO such warnings afterwards
// plus a real drop in SceneMgr's registered-callback count.
//
// ── Section D — SceneMgr's tick loop vs. mid-frame deregistration ────────────
//
// Giving SceneMgr a removeTickCallback (Section B's fix) made the render loop
// re-entrant: a callback can now deregister callbacks while the loop is walking
// them. The first cut guarded that by copying the array EVERY frame, in the
// hottest loop in the app. This section pins the behaviour the copy provided —
// an immediate removal, no skipped neighbours, no throw — so the copy can be
// removed (and stay removed) without anyone having to take that on faith.
//
// Usage:
//   node scripts/probe-hotswap-config.mjs [--headed] [--port=5199] [--ws-port=8796]
// Exit code: 0 = every assertion passed, 1 = at least one failed / setup error.

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = Number(args.port || 5199);
const WS_PORT = Number(args['ws-port'] || 8796);
const LOG_PORT = Number(args['log-port'] || 8795);
const BASE = `http://localhost:${PORT}/`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('ERROR: no Chrome/Edge binary found'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// The two shipping CC0 snes9x cartridges: one plain, one Super Scope.
const PLAIN = { file: 'freeware/lwx-snes-demo.sfc', system: 'snes', core: 'snes9x', title: 'LWX SNES Demo' };
const GUN   = { file: 'freeware/lwx-snes-scope.sfc', system: 'snes', core: 'snes9x', title: 'LWX Scope Range', lightgun: true };
// systems.js: snes.lightgun = { device: 260, port: 1 } -> inputDevices { 2: 260 }.
const GUN_CFG_LINE = 'input_libretro_device_p2 = "260"';

// Spawned WITHOUT a shell and by direct script path, so vite.pid is the real
// node process — a shell/npx wrapper leaves the server orphaned on this port
// when the probe exits, and this project must never be cleaned up by killing
// node by name (see CLAUDE.md).
const vite = spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
vite.stderr.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stdout.write(`  [vite] ${s}`); });

const roomServer = spawn(process.execPath, ['server/room-server.mjs'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(WS_PORT), LOG_PORT: String(LOG_PORT) },
});
roomServer.stdout.on('data', (d) => process.stdout.write(`  [room-server] ${d}`));
roomServer.stderr.on('data', (d) => process.stdout.write(`  [room-server!] ${d}`));

async function waitForServer(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

// Read the RetroArch config out of the LIVE primary core's emscripten FS. This
// is the file the core actually booted with, so it is the ground truth for
// "did this boot declare a light gun", independent of any app-side bookkeeping.
const READ_CFG = () => {
  const c = window.__client?.delegate || window.__client;
  const M = c?._getModule?.();
  if (!M?.FS) return null;
  try { return M.FS.readFile('/home/web_user/retroarch/userdata/retroarch.cfg', { encoding: 'utf8' }); }
  catch (e) { return `ERR:${e?.message || e}`; }
};

// Same ground truth as READ_CFG, but for a SECONDARY (rack) console: read the
// RetroArch config out of the core running under `rackMgr.get(id)`. A rack
// console's client is a RuntimeEmulatorClient facade, so unwrap its delegate the
// same way. Returns null when that console has no live main-thread core.
const READ_CONSOLE_CFG = (id) => {
  const rt = window.__rackMgr?.get(id);
  const c = rt?.client?.delegate || rt?.client;
  const M = c?._getModule?.();
  if (!M?.FS) return null;
  try { return M.FS.readFile('/home/web_user/retroarch/userdata/retroarch.cfg', { encoding: 'utf8' }); }
  catch (e) { return `ERR:${e?.message || e}`; }
};
const deviceLines = (cfg) => (typeof cfg === 'string'
  ? (cfg.split('\n').filter((l) => /input_libretro_device|gun_trigger/.test(l)).join(' | ') || 'no device lines at all')
  : String(cfg));

let browser;
try {
  if (!(await waitForServer(BASE))) throw new Error(`vite dev server never came up on :${PORT}`);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !args.headed,
    args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
  });

  // =========================================================================
  // Section A — same-core swap must apply the new game's boot configuration
  // =========================================================================
  console.log('\n--- Section A: same-core cartridge swap re-applies boot config (§5.4 / COR-4)');
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('  [page]', m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  const ready = await page.waitForFunction(
    () => typeof window.__insertCartridge === 'function' && !!window.__client,
    { timeout: 40000 },
  ).then(() => true).catch(() => false);
  ok('app booted with __insertCartridge/__client ready', ready);
  if (!ready) throw new Error('app never finished initialising');

  const insert = async (meta) => {
    await page.evaluate((m) => window.__insertCartridge(m), meta);
    // Wait for the core to be up (a fresh runtime swaps window.__client).
    await page.waitForFunction(() => !!(window.__client?.ready), { timeout: 60000 }).catch(() => {});
    await sleep(2500);
  };

  // A1: plain snes9x game boots and declares NO gun device.
  await insert(PLAIN);
  const cfgPlain = await page.evaluate(READ_CFG);
  ok('plain snes9x game booted (RetroArch cfg readable from the live core)',
     typeof cfgPlain === 'string' && cfgPlain.includes('system_directory'),
     cfgPlain ? `${cfgPlain.length} bytes` : String(cfgPlain));
  ok('plain boot declares no light gun', typeof cfgPlain === 'string' && !cfgPlain.includes(GUN_CFG_LINE));

  // A2: an UNCHANGED boot config must still take the cheap in-place hot swap —
  // this is the performance win the same-core path exists for. Tag the live
  // client object; if the app rebuilt the runtime the tag is gone.
  await page.evaluate(() => { window.__client.__probeTag = 'hotswap-A'; });
  await insert(PLAIN);
  const tagAfterSameConfig = await page.evaluate(() => window.__client?.__probeTag ?? null);
  ok('same core + same boot config still hot-swaps in place (no runtime rebuild)',
     tagAfterSameConfig === 'hotswap-A', `tag=${tagAfterSameConfig}`);

  // A3: THE BUG — a Super Scope title on the SAME core must reach the emulator
  // with the gun device declared.
  await insert(GUN);
  const cfgGun = await page.evaluate(READ_CFG);
  ok('same-core swap into a Super Scope game declares the gun device to the core',
     typeof cfgGun === 'string' && cfgGun.includes(GUN_CFG_LINE),
     typeof cfgGun === 'string'
       ? (cfgGun.split('\n').filter((l) => /input_libretro_device|gun_trigger/.test(l)).join(' | ') || 'no device lines at all')
       : String(cfgGun));
  const tagAfterGun = await page.evaluate(() => window.__client?.__probeTag ?? null);
  ok('the gun swap rebuilt the runtime (fresh client, nothing stale can survive)',
     tagAfterGun === null, `tag=${tagAfterGun}`);

  // A4: the other direction — a plain game after a gun game must NOT inherit it.
  await insert(PLAIN);
  const cfgBack = await page.evaluate(READ_CFG);
  ok('swapping back to a plain game drops the gun device (no sticky config)',
     typeof cfgBack === 'string' && !cfgBack.includes(GUN_CFG_LINE),
     typeof cfgBack === 'string'
       ? (cfgBack.split('\n').filter((l) => /input_libretro_device/.test(l)).join(' | ') || 'no device lines')
       : String(cfgBack));

  ok('no uncaught page exceptions during the swap sequence', pageErrors.length === 0, pageErrors.join(' / '));

  // =========================================================================
  // Section C — the SAME rule on a SECONDARY (rack) console
  // =========================================================================
  console.log('\n--- Section C: same-core swap on a RACK console re-applies boot config (skeptic finding)');

  const rackReady = await page.waitForFunction(
    () => !!window.__rack && !!window.__rackMgr && Array.isArray(window.__games) && window.__games.length,
    { timeout: 40000 },
  ).then(() => true).catch(() => false);
  ok('rack hooks available (__rack / __rackMgr / __games)', rackReady);
  if (!rackReady) throw new Error('rack hooks never appeared');

  // C1 — spawn a SECOND console running the PLAIN snes9x game. Its own core, its
  // own canvas, its own TV; console0 keeps whatever Section A left on it.
  const consoleId = await page.evaluate(async (plain) => {
    return await window.__rack.spawn(plain.system, { game: plain });
  }, PLAIN);
  ok('spawned a secondary rack console for the plain snes9x game', typeof consoleId === 'string' && consoleId !== 'console0', `id=${consoleId}`);
  if (typeof consoleId !== 'string') throw new Error('spawn did not return a console id');
  await sleep(3000);

  const cfgRack0 = await page.evaluate(READ_CONSOLE_CFG, consoleId);
  ok('the secondary console booted (RetroArch cfg readable from ITS live core)',
     typeof cfgRack0 === 'string' && cfgRack0.includes('system_directory'),
     typeof cfgRack0 === 'string' ? `${cfgRack0.length} bytes` : String(cfgRack0));
  ok('secondary plain boot declares no light gun',
     typeof cfgRack0 === 'string' && !cfgRack0.includes(GUN_CFG_LINE), deviceLines(cfgRack0));

  // Drive the REAL insert path (what dropping a cart into that console does).
  const insertInto = async (meta, id) => {
    await page.evaluate((m) => window.__insertCartridge(m), { ...meta, consoleId: id });
    await sleep(4000);
  };

  // C2 — an UNCHANGED boot config must still hot-swap in place on a rack console
  // too. Without this the "fix" could just be "always rebuild", which would trade
  // the bug for a leaked Wasm heap on every single cartridge swap (COR-5).
  await page.evaluate((id) => { window.__rackMgr.get(id).client.__probeTag = 'rack-C'; }, consoleId);
  await insertInto(PLAIN, consoleId);
  const rackTagSame = await page.evaluate((id) => window.__rackMgr.get(id)?.client?.__probeTag ?? null, consoleId);
  ok('secondary: same core + same boot config still hot-swaps in place (no runtime rebuild)',
     rackTagSame === 'rack-C', `tag=${rackTagSame}`);

  // C3 — THE BUG. A Super Scope title on the SAME core, dropped on the SECONDARY
  // console, must reach THAT console's emulator with the gun device declared.
  await insertInto(GUN, consoleId);
  const cfgRackGun = await page.evaluate(READ_CONSOLE_CFG, consoleId);
  ok('SECONDARY console: same-core swap into a Super Scope game declares the gun device to ITS core',
     typeof cfgRackGun === 'string' && cfgRackGun.includes(GUN_CFG_LINE), deviceLines(cfgRackGun));
  const rackTagGun = await page.evaluate((id) => window.__rackMgr.get(id)?.client?.__probeTag ?? null, consoleId);
  ok('secondary: the gun swap rebuilt that console\'s runtime (fresh client)',
     rackTagGun === null, `tag=${rackTagGun}`);

  // C4 — and the reverse: a plain game after a gun game must not inherit the gun.
  await insertInto(PLAIN, consoleId);
  const cfgRackBack = await page.evaluate(READ_CONSOLE_CFG, consoleId);
  ok('secondary: swapping back to a plain game drops the gun device (no sticky config)',
     typeof cfgRackBack === 'string' && !cfgRackBack.includes(GUN_CFG_LINE), deviceLines(cfgRackBack));

  // C5 — the whole point of the rack: rebooting console1 must not disturb
  // console0. Its core is still there, still ready, still without a gun.
  const primaryIntact = await page.evaluate(() => ({
    ready: !!window.__client?.ready,
    core: window.__rackMgr?.get('console0')?.coreName ?? null,
    live: !!window.__rackMgr?.get('console0')?.isLive?.(),
  }));
  ok('the primary console survived the secondary reboots (still booted + live)',
     primaryIntact.ready && !!primaryIntact.core, JSON.stringify(primaryIntact));

  ok('no uncaught page exceptions during the rack swap sequence', pageErrors.length === 0, pageErrors.join(' / '));

  // =========================================================================
  // Section D — SceneMgr's tick loop survives mid-frame deregistration
  // =========================================================================
  // The loop must be safe against a callback that removes callbacks while it is
  // running (the in-VR Leave button does exactly that from menuMgr.tick()) WITHOUT
  // copying the callback array every frame — this is the hottest loop in the app
  // (72-90 Hz on a Quest, ~26 callbacks). Four markers W,X,Y,Z are registered in
  // order; X removes W the first time it runs. Then:
  //   • W must not run again (a removal must take effect immediately),
  //   • Y and Z must BOTH still run, in order, in that same frame — this is the
  //     assertion that fails if removal splices the live array while it is being
  //     iterated (every element after the removed one shifts down one index and
  //     the walk skips one),
  //   • nothing may throw (a tombstoned slot must be skipped, not called),
  //   • and the registration count must return to its baseline afterwards, which
  //     is what proves the tombstones are actually compacted away rather than
  //     accumulating for the life of the page.
  console.log('\n--- Section D: SceneMgr tick loop vs. mid-frame deregistration (no per-frame copy)');
  const tickWarns = [];
  const tickWarnListener = (m) => { if (/\[SceneMgr tick\]/.test(m.text())) tickWarns.push(m.text()); };
  page.on('console', tickWarnListener);

  const baselineTicks = await page.evaluate(() => window.__scene.tickCallbackCount());
  await page.evaluate(() => {
    const scene = window.__scene;
    const seq = [];
    const probe = { seq, mark: -1, counts: { W: 0, X: 0, Y: 0, Z: 0 }, fns: {} };
    const mk = (name) => () => { probe.counts[name]++; seq.push(name); };
    probe.fns.W = mk('W');
    probe.fns.Y = mk('Y');
    probe.fns.Z = mk('Z');
    probe.fns.X = () => {
      probe.counts.X++; seq.push('X');
      if (probe.counts.X === 1) { probe.mark = seq.length; scene.removeTickCallback(probe.fns.W); }
    };
    for (const n of ['W', 'X', 'Y', 'Z']) scene.addTickCallback(probe.fns[n]);
    window.__tickProbe = probe;
  });
  await sleep(600);   // ~40+ frames
  const tick = await page.evaluate(() => {
    const p = window.__tickProbe;
    return { mark: p.mark, counts: { ...p.counts }, afterMark: p.seq.slice(p.mark, p.mark + 2), total: p.seq.length };
  });
  ok('the four markers ran (the real render loop is driving them)',
     tick.counts.X > 5 && tick.counts.Z > 5, JSON.stringify(tick.counts));
  ok('a callback removed from INSIDE the tick loop stops immediately (ran exactly once)',
     tick.counts.W === 1, `W ran ${tick.counts.W}x`);
  ok('the callbacks AFTER the removed one are not skipped in that same frame',
     tick.afterMark[0] === 'Y' && tick.afterMark[1] === 'Z',
     `after the removal the loop ran [${tick.afterMark.join(',')}] (want [Y,Z]; [Z,…] means the walk skipped one)`);
  ok('no exceptions thrown by the tick loop during the removal',
     tickWarns.length === 0, tickWarns.slice(0, 2).join(' / '));

  await page.evaluate(() => {
    const p = window.__tickProbe;
    for (const n of ['X', 'Y', 'Z']) window.__scene.removeTickCallback(p.fns[n]);
  });
  await sleep(400);
  const afterTicks = await page.evaluate(() => window.__scene.tickCallbackCount());
  ok('tombstones are compacted away (registration count back to baseline)',
     afterTicks === baselineTicks, `baseline=${baselineTicks} after=${afterTicks}`);
  page.off('console', tickWarnListener);

  await page.close();

  // =========================================================================
  // Section B — leaving a room stops its per-frame callbacks
  // =========================================================================
  console.log('\n--- Section B: leave a room -> zero per-frame exceptions (§5.1 / §5.3 / COR-2)');
  const mp = await browser.newPage();
  mp.setDefaultTimeout(60000);
  const tickWarnings = [];
  mp.on('console', (m) => { if (/\[SceneMgr tick\]/.test(m.text())) tickWarnings.push(m.text()); });

  const room = `probe-leave-${Date.now().toString(36)}`;
  await mp.goto(`${BASE}?session=${room}&server=${encodeURIComponent(`ws://localhost:${WS_PORT}/`)}&nick=Probe`, { waitUntil: 'load' });
  const joined = await mp.waitForFunction(() => !!window.__net?.connected?.() && !!window.__ghost, { timeout: 40000 })
    .then(() => true).catch(() => false);
  ok('joined a real room server and the session tick callbacks are wired', joined);
  if (!joined) throw new Error('never joined the room / session never wired');

  await sleep(1500);
  const warnsWhileConnected = tickWarnings.length;
  ok('no [SceneMgr tick] warnings while still in the room', warnsWhileConnected === 0, `${warnsWhileConnected} seen`);

  const before = await mp.evaluate(() => window.__netTicks?.() ?? null);
  await mp.evaluate(() => document.getElementById('mp-leave-btn').click());
  await sleep(500);
  const leftClean = await mp.evaluate(() => !window.__net);
  ok('Leave tore the session down (window.__net cleared)', leftClean);

  tickWarnings.length = 0;   // count only what happens AFTER the leave
  await sleep(3000);
  ok('ZERO [SceneMgr tick] exceptions in the 3s after leaving',
     tickWarnings.length === 0, `${tickWarnings.length} warnings: ${tickWarnings.slice(0, 2).join(' / ')}`);

  const after = await mp.evaluate(() => window.__netTicks?.() ?? null);
  ok('SceneMgr.removeTickCallback actually deregistered the session ticks',
     !!before && !!after && after.attached === false && before.attached === true
       && before.registered >= 4 && (before.sceneTicks - after.sceneTicks) === before.registered,
     `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

  // Rejoin: the ticks must come back (deregistration must not be a one-way door).
  // The widget re-uses the module-level server URL the ?server= param installed.
  await mp.evaluate((r) => {
    document.getElementById('mp-room-input').value = r;
    document.getElementById('mp-join-btn').click();
  }, room);
  await sleep(2500);
  const rejoined = await mp.evaluate(() => window.__netTicks?.() ?? null);
  ok('rejoining re-attaches the session ticks',
     !!rejoined && rejoined.attached === true && rejoined.sceneTicks === (after?.sceneTicks + rejoined.registered),
     `rejoined=${JSON.stringify(rejoined)}`);

} catch (e) {
  console.error('\nPROBE ERROR:', e?.message || e);
  results.push(false);
} finally {
  if (browser) await browser.close().catch(() => {});
  // Kill ONLY the two child processes this probe started (never by name).
  try { roomServer.kill('SIGTERM'); } catch (_) {}
  try { process.kill(vite.pid); } catch (_) {}
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    try { spawn('taskkill', ['/pid', String(roomServer.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
  }
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
