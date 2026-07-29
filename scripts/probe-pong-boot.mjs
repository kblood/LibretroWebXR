// probe-pong-boot — the rebuilt 2-player LWX Pong boots in the live core, and a
// P2 button injected via the rack input path actually REACHES console0's core
// canvas as a player-2-mapped key event.
//
//   node scripts/probe-pong-boot.mjs [url]     (default http://localhost:5176/)
//
// Exit code is the verdict: 0 = all checks passed, 1 = at least one failed.
//
// WHY THIS SHAPE (2026-07-29 probe audit). The previous version of this file
// printed `{ game, file, live, injectOk }` and exited 0 unconditionally. Worse,
// it "tested" the injection with
//     window.__gameInput?.setRemoteButton({ player: 2, btn: 'Down', down: true });
//     window.__gameInput?.setRemoteButton({ player: 2, btn: 'Down', down: false });
//     ... catch (e) { injectOk = String(e); }
// which proved nothing three times over:
//   1. nothing was asserted — exit 0 always;
//   2. the `?.` meant a MISSING __gameInput recorded injectOk === true, i.e. the
//      whole input path being absent was indistinguishable from success;
//   3. down+up in the SAME JS turn set then cleared `_remoteDesired` before the
//      next tick() sweep ever ran, so on a perfectly healthy build ZERO key
//      events reached console0. Measured: the old sequence delivers [] on the
//      real repo. The claim it was cited for was never true.
//
// The replacement is a WITHIN-RUN RELATIVE comparison: two arms at the same
// instant, on the same booted console, differing in exactly ONE field of the
// same setRemoteButton() call, each counted over its own freshly-cleared window
// of frames. Events are counted where the app hands off to the core — a capture
// listener on console0's own emulator canvas, the element EmulatorClient
// .sendInput() dispatches the synthetic KeyboardEvent to.
//
//   ARM ON-TARGET   consoleId: 'console0'            -> must be >= 1 down + 1 up
//   ARM CONTROL     consoleId: '__no-such-console__' -> must be EXACTLY 0
//   ARM P1-ISOLATION  during ON-TARGET, P1's own Down code (ArrowDown) must be
//                     EXACTLY 0 — proves it is player-2 routing, not "any key".
//
// VALIDATED BOTH WAYS on 2026-07-29 against a scratch checkout (junctioned
// node_modules and public, real tree untouched):
//   * real repo                                 -> 5/5 PASS, exit 0 (on-target down=1 up=1, control 0)
//   * GameInputMgr.setRemoteButton made a no-op -> 4/5 FAIL, exit 1 (on-target down=0 up=0)
//   * main.js `dispatch:` made a no-op          -> 4/5 FAIL, exit 1 (on-target down=0 up=0)
//   * `window.__gameInput = gameInput` removed  -> 0/1 FAIL, exit 1
// The OLD version of this probe printed byte-identical green output under all
// three of those breaks — that is why it was replaced.
// A green run here means the P2 remote-button path reaches console0's core
// canvas. It does NOT claim the core acted on the key (that is inside rwebinput);
// it claims the app-side chain setRemoteButton -> tick() sweep -> rackMgr
// dispatch -> ConsoleRuntime.sendInput -> canvas KeyboardEvent is intact.
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
  await sleep(2500);

  const live = window.__rackMgr.runtimes().map((r) => ({ id: r.id, core: r.coreName, live: r.isLive() }));
  const rt = window.__rackMgr.get('console0');
  const canvas = rt?.canvas || rt?.client?.emuCanvas || null;
  if (!canvas) return { game: pong.title, file: pong.file, live, err: 'console0 has no core canvas to observe' };

  // Count key events exactly where the app hands off to the core.
  //  P2 Down -> 'Digit2'  (ControllerMaps.EXTRA_PLAYER_KEYS[2].Down)
  //  P1 Down -> 'ArrowDown' (ControllerMaps.RETROPAD_KEYS.Down)
  let seen = [];
  const rec = (e) => seen.push(`${e.type}:${e.code}`);
  canvas.addEventListener('keydown', rec, true);
  canvas.addEventListener('keyup', rec, true);
  const count = (arr, s) => arr.filter((x) => x === s).length;

  // No optional chaining: the input path being ABSENT must be a failure, not a
  // silent pass. That `?.` was the exact hazard this rewrite removes.
  const gi = window.__gameInput;
  const giOk = !!gi && typeof gi.setRemoteButton === 'function';
  if (!giOk) return { game: pong.title, file: pong.file, live, giOk, err: 'window.__gameInput.setRemoteButton missing' };

  // Hold across frames, then release: setRemoteButton only stages the press —
  // the keydown/keyup are emitted by the next tick() sweep.
  const arm = async (consoleId) => {
    seen = [];
    gi.setRemoteButton({ player: 2, btn: 'Down', down: true, consoleId });
    await sleep(600);
    gi.setRemoteButton({ player: 2, btn: 'Down', down: false, consoleId });
    await sleep(600);
    return seen.slice();
  };

  const onTarget = await arm('console0');
  const control = await arm('__no-such-console__');   // one variable changed
  return {
    game: pong.title,
    file: pong.file,
    live,
    giOk,
    onTarget: { down: count(onTarget, 'keydown:Digit2'), up: count(onTarget, 'keyup:Digit2'), p1Leak: count(onTarget, 'keydown:ArrowDown'), raw: onTarget },
    control:  { total: control.length, raw: control },
  };
});

const checks = [];
const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };
if (out.err) {
  ck('probe ran', false, out.err);
} else {
  const live0 = (out.live || []).find((r) => r.id === 'console0');
  ck('console0 booted live with a core', !!live0 && live0.live && !!live0.core, JSON.stringify(out.live));
  ck('window.__gameInput.setRemoteButton exists', out.giOk === true, `giOk=${out.giOk}`);
  ck('ON-TARGET arm: P2 Down reached console0 canvas', out.onTarget.down >= 1 && out.onTarget.up >= 1,
     `down=${out.onTarget.down} up=${out.onTarget.up} raw=${JSON.stringify(out.onTarget.raw)}`);
  ck('CONTROL arm (bogus consoleId): EXACTLY 0 on console0', out.control.total === 0,
     `total=${out.control.total} raw=${JSON.stringify(out.control.raw)}`);
  ck('P1-ISOLATION: no player-1 ArrowDown leaked', out.onTarget.p1Leak === 0, `p1Leak=${out.onTarget.p1Leak}`);
}
console.log(JSON.stringify({ game: out.game, file: out.file, live: out.live, onTarget: out.onTarget && { down: out.onTarget.down, up: out.onTarget.up, p1Leak: out.onTarget.p1Leak }, control: out.control && { total: out.control.total } }, null, 2));
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  [${c.detail}]`}`);
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
await b.close();
process.exit(passed === checks.length ? 0 : 1);
