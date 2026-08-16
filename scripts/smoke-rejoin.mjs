// smoke-rejoin — COR-2 end to end: leaving a room and rejoining it must not
// leave this peer holding the previous session.
//
// Two real browsers against a real relay. The other peer picks up OUR gamepad
// and never lets go, while we leave and come back:
//
//   held        → our local pad is hidden, a ghost appears in their hand
//   LEAVE       → our pad must come back (the session scope's cleanup runs)
//   REJOIN      → the ghost must be rebuilt against the NEW session's avatars
//   they release→ our pad unhides again, proving the rebuilt wiring is live
//
// Before COR-2 was fixed, both middle steps failed silently: the unhide sweep
// lives in GhostGamepadMgr.sync(), which stops being called the moment Leave
// detaches the session ticks, and the ghost managers held `net.avatars` BY VALUE
// from the first join, so after a rejoin they asked a dead AvatarMgr where the
// new session's peers were.
//
// VALIDATED BOTH WAYS on 2026-08-16 (each mutation applied to the real tree, run,
// reverted):
//   * as shipped                                  → 13/13, exit 0
//   * disconnectFromRoom without _runSessionCleanups()
//                                                 → 2 FAIL (pad stays hidden
//                                                   after Leave, ghost survives)
//   * createLiveAvatars memoising its first resolve (i.e. the old by-value
//     capture)                                    → 1 FAIL (no ghost after the
//                                                   rejoin, though the hold is
//                                                   known and the pad is hidden)
//
// NOT in CI (needs real Chrome). Run it directly:
//   node scripts/smoke-rejoin.mjs
//   node scripts/smoke-rejoin.mjs --app=http://localhost:5173/ --ws=ws://localhost:8787/
//
// With no --app/--ws it spawns its OWN vite (:5241) and room-server (:8803) and
// kills only those two children — never anything else on this machine (CLAUDE.md).
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const ROOT = process.cwd();
const VITE_PORT = 5241;
const WS_PORT = 8803;
const APP = args.app || `http://localhost:${VITE_PORT}/`;
const WS = args.ws || `ws://localhost:${WS_PORT}/`;
const ROOM = args.room || `rejoin-${process.pid}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else { failed++; console.error(`  FAIL ${msg} ${extra}`); }
};

// --- servers (only the ones we were not handed) ----------------------------
const children = [];
if (!args.ws) {
  children.push(spawn(process.execPath, [`${ROOT}/server/room-server.mjs`],
    { cwd: ROOT, env: { ...process.env, PORT: String(WS_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] }));
}
if (!args.app) {
  children.push(spawn(process.execPath, [`${ROOT}/node_modules/vite/bin/vite.js`, '--port', String(VITE_PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }));
}
for (let i = 0; i < 80; i++) { try { const r = await fetch(APP); if (r.ok) break; } catch (_) {} await sleep(500); }

// One browser PER PEER. Two pages in ONE browser looks like a broken app: the
// background page is throttled, so its rAF stops, so its ticks stop — no poses,
// no avatars, no ghost sync. (This cost an hour; the sibling smokes do the same.)
const browsers = [];
const urlFor = (nick) => `${APP}${APP.includes('?') ? '&' : '?'}session=${ROOM}&server=${encodeURIComponent(WS)}&nick=${nick}`;
const open = async (nick) => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !args.headed,
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--use-gl=swiftshader'],
  });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`  [pageerror ${nick}]`, e.message));
  await page.goto(urlFor(nick), { waitUntil: 'load', timeout: 40000 });
  await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 25000 });
  return page;
};
const waitFor = async (page, fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await sleep(200); }
  return false;
};

const me = await open('mine');       // the peer that leaves and comes back
const other = await open('other');   // the peer that holds our gamepad throughout

ok(await waitFor(me, () => window.__net.peerCount() >= 1, 15000), 'both peers see each other');
for (const [page, nick] of [[me, 'mine'], [other, 'other']]) {
  ok(await waitFor(page, () => typeof window.__rack?.grabGamepad === 'function', 30000), `${nick}: the world is built`);
}

// --- they take our gamepad -------------------------------------------------
const grabbed = await other.evaluate(() => window.__rack.grabGamepad('gp-1'));
ok(!!grabbed, 'the other peer grabbed gp-1', JSON.stringify(grabbed));
ok(await waitFor(me, () => window.__ghostGp?.isHidden('gp-1') === true), 'our local gp-1 is hidden while they hold it');
ok(await waitFor(me, () => window.__ghostGp?.count() === 1), 'and a ghost gamepad is in their hand');

// --- we leave, with the hold still standing --------------------------------
await me.evaluate(() => window.__testApi.session.leave());
await sleep(600);
const afterLeave = await me.evaluate(() => ({
  isHidden: window.__ghostGp?.isHidden('gp-1'),
  ghosts: window.__ghostGp?.count(),
  connected: !!window.__net?.connected?.(),
}));
ok(afterLeave.connected === false, 'we really left', JSON.stringify(afterLeave));
ok(afterLeave.isHidden === false, 'Leave gives our gamepad back', JSON.stringify(afterLeave));
ok(afterLeave.ghosts === 0, 'and removes the ghost', JSON.stringify(afterLeave));

// --- we rejoin; they never let go ------------------------------------------
await me.evaluate((room) => window.__testApi.session.join({ room, nick: 'mine-again' }), ROOM);
ok(await waitFor(me, () => !!window.__net?.connected?.()), 'we are back in the room');
ok(await waitFor(me, () => window.__net.peerCount() >= 1, 15000), 'and can see the peer again');
const reGhost = await waitFor(me, () => window.__ghostGp?.count() === 1, 15000);
const after = await me.evaluate(() => ({
  ghosts: window.__ghostGp?.count(),
  isHidden: window.__ghostGp?.isHidden('gp-1'),
  heldBy: window.__ghostGp?.heldBy('gp-1'),
}));
ok(reGhost, 'after the rejoin the ghost is rebuilt against the NEW session', JSON.stringify(after));
ok(after.isHidden === true, 'and our own pad is hidden again, correctly', JSON.stringify(after));

// --- and the rebuilt wiring is live, not just present ----------------------
await other.evaluate(() => window.__rack.releaseGamepad?.('gp-1') ?? window.__net.setObjectState('hold:gp:gp-1', null));
ok(await waitFor(me, () => window.__ghostGp?.isHidden('gp-1') === false, 15000), 'their release unhides our pad again');

console.log(`\n${passed} passed, ${failed} failed`);
for (const b of browsers) { try { await b.close(); } catch (_) {} }
for (const c of children) { try { c.kill(); } catch (_) {} }
process.exit(failed ? 1 : 0);
