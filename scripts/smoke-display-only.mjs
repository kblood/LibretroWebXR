// Headless TWO-CLIENT smoke for the OTHER half of M1.4's "one room, one game"
// invariant (M1.4a): not "may a client boot?" — smoke-shared-game.mjs covers that
// — but **may a client that was ALREADY PLAYING keep running?**
//
// It exists because that gap shipped once: every boot route was gated on
// amRoomHost(), yet `RackMgr.applyBudget()` knew nothing about the netplay role and
// happily resumed whatever it found paused. So a peer that had booted a game before
// joining was paused correctly at join time and then silently RESUMED by the next
// perf-budget pass — the in-world "Auto-pause" toggle, or just gazing at a second
// TV — and emulated its own divergent copy of the game behind the host's video
// feed. That is the user's original "each computer runs its own game" report,
// re-entered through a performance path. Related: only the PRIMARY console was
// paused, so a pre-existing multi-console rack kept its secondary cores running;
// and the watcher's header kept naming a core, which made the manual check in
// docs/MULTIPLAYER.md cry wolf on a healthy client.
//
// Peer B therefore boots solo AND spawns a second console BEFORE joining — the
// state no other committed smoke sets up, which is why `liveCores(client)===0`
// used to pass vacuously.
//
// GROUND TRUTH for "is this core emulating?" is distinct frame signatures off each
// ConsoleRuntime's OWN canvas (r.canvas) — NOT the TV texture (it switches to the
// host's <video> and then reports "no local canvas", i.e. "frozen" for the wrong
// reason) and NOT the client's `paused` flag alone. The host is the positive
// control: it must be stepping frames throughout.
//
// The whole run is NEGATIVE-CONTROLLED in-place: one phase removes the gate from
// the page (window.__rackMgr.setAllowRun(null)) and REQUIRES the watcher's cores to
// come back to life. If that phase ever reports no resume, this smoke has gone
// vacuous and its green result means nothing.
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8797; node server/room-server.mjs         # terminal 1
//   npm run dev -- --port 5199                           # terminal 2
//   node scripts/smoke-display-only.mjs --app=http://localhost:5199/ --ws=ws://localhost:8797/
//
// Flags: --app=<url> --ws=<url> --headed --shots=<dir>

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5199/';
const WS = args.ws || 'ws://localhost:8797/';
const SHOTS = typeof args.shots === 'string' ? args.shots : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAUNCH = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
  '--enable-features=SharedArrayBuffer', '--disable-features=WebRtcHideLocalIpsWithMdns'];

const browsers = [];
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.error(`  FAIL ${m}`); } };

async function open(nick, room) {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH });
  browsers.push(b);
  const p = await b.newPage();
  p._browser = b;
  await p.setViewport({ width: 1000, height: 700 });
  const q = room ? `?session=${room}&server=${encodeURIComponent(WS)}&nick=${nick}` : `?server=${encodeURIComponent(WS)}`;
  await p.goto(APP + q, { waitUntil: 'load' });
  await p.waitForFunction(() => Array.isArray(window.__games) && window.__games.length > 0
    && typeof window.__insertCartridge === 'function' && window.__rack, { timeout: 90000 });
  if (room) await p.waitForFunction(() => window.__net?.connected(), { timeout: 30000 });
  return p;
}

// Per-runtime frame-motion sampling off each ConsoleRuntime's own canvas.
async function stepping(page, samples = 8, gap = 320) {
  const rows = [];
  for (let i = 0; i < samples; i++) {
    rows.push(await page.evaluate(() => (window.__rackMgr?.runtimes?.() || []).map((r) => {
      const cv = r.canvas; let sig = null;
      if (cv?.width) {
        const c = document.createElement('canvas'); c.width = 16; c.height = 16;
        const cx = c.getContext('2d', { willReadFrequently: true });
        try {
          cx.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, 16, 16);
          const d = cx.getImageData(0, 0, 16, 16).data;
          let s = 0; for (let k = 0; k < d.length; k++) s = (s * 31 + d[k]) >>> 0;
          sig = s;
        } catch {}
      }
      return { id: r.id, core: r.coreName, paused: r.client?.paused ?? null, sig };
    })));
    await sleep(gap);
  }
  const last = rows.at(-1);
  return last.map((row, i) => {
    const sigs = rows.map((r) => r[i]?.sig).filter((s) => s != null);
    return { id: row.id, core: row.core, paused: row.paused, distinct: new Set(sigs).size, of: sigs.length };
  });
}
const anyStepping = (m) => m.some((r) => r.core && r.distinct > 1);
const state = (page) => page.evaluate(() => ({
  isHost: window.__net?.isHost() ?? null,
  hostId: window.__net?.hostId() ?? null,
  mayRun: window.__rack.mayRun(),
  live: window.__rack.live(),
  tvs: window.__rack.tvs().map((t) => ({ id: t.id, video: t.video, source: t.source })),
  header: document.querySelector('header h1')?.textContent || '',
  status: document.getElementById('status')?.textContent || '',
}));

// The full display-only invariant, re-asserted after every trigger.
async function assertWatching(page, label) {
  const s = await state(page);
  const frames = await stepping(page);
  ok(s.isHost === false, `${label}: still a display-only client`);
  ok(s.mayRun === false, `${label}: mayRunLocalCore() === false`);
  ok(s.live.length > 0 && s.live.every((r) => r.live === false),
    `${label}: EVERY console paused ${JSON.stringify(s.live)}`);
  ok(!anyStepping(frames), `${label}: no runtime steps frames ${JSON.stringify(frames)}`);
  ok(s.tvs.some((t) => t.video), `${label}: the TV still paints the host's feed`);
  return s;
}

try {
  const room = `dsp${Date.now().toString(36)}`;
  console.log(`\n=== room ${room} · app ${APP} · ws ${WS} ===`);

  // ── A: the host, playing a real game ──────────────────────────────────────
  const A = await open('Alice', room);
  const g = await A.evaluate(() => {
    const x = window.__games.find((q) => q.system === 'nes' && /pong/i.test(q.title || q.file))
           || window.__games.find((q) => q.system === 'nes');
    return { file: x.file, core: x.core, system: x.system, title: x.title };
  });
  await A.evaluate((m) => window.__insertCartridge(m), g);
  await sleep(14000);
  ok((await A.evaluate(() => window.__net.isHost())) === true, 'A is the elected host');
  ok(anyStepping(await stepping(A, 6)), 'POSITIVE CONTROL: A (host) is stepping frames');

  // ── B: boots solo AND builds a two-console rack, THEN joins ───────────────
  // The rack is what made the secondary-console leak reachable: no committed
  // smoke had one up before joining, so `liveCores(client)===0` passed vacuously.
  console.log('\n--- B: solo play + a second console, then join ---');
  const B = await open('Bob', null);
  await B.evaluate((m) => window.__insertCartridge(m), g);
  await sleep(14000);
  const spawned = await B.evaluate(async () => {
    try { return await window.__rack.spawn('nes'); } catch (e) { return `ERR ${e.message}`; }
  });
  console.log(`  B spawned secondary console: ${spawned}`);
  await sleep(12000);
  const soloLive = await B.evaluate(() => window.__rack.live());
  ok(soloLive.length >= 2, `B has a ${soloLive.length}-console rack while solo ${JSON.stringify(soloLive)}`);
  ok(soloLive.every((r) => r.live), 'B: both consoles LIVE while solo (legitimate)');
  ok((await B.evaluate(() => window.__rack.mayRun())) === true, 'B: mayRun() true while solo');
  if (SHOTS) await B.screenshot({ path: `${SHOTS}/b-solo-rack.png` });

  await B.evaluate((r) => {
    document.getElementById('mp-room-input').value = r;
    document.getElementById('mp-nick-input').value = 'Bob';
    document.getElementById('mp-join-btn').click();
  }, room);
  await B.waitForFunction(() => window.__net?.connected(), { timeout: 30000 });
  await sleep(18000);

  const joined = await assertWatching(B, 'after joining');
  ok(!/fceumm|nes \(|snes|genesis/i.test(joined.header),
    `after joining: the header does not name a core (${JSON.stringify(joined.header)})`);
  ok(/watching/i.test(joined.status), `after joining: status says we're watching (${JSON.stringify(joined.status)})`);
  if (SHOTS) await B.screenshot({ path: `${SHOTS}/b-watching.png` });

  // ── the reachable triggers that used to undo the watcher pause ────────────
  console.log('\n--- trigger 1: the in-world "Auto-pause" toggle ---');
  console.log('  autoPause ->', await B.evaluate(() => window.__rack.autoPause(!window.__rack.autoPause())));
  await sleep(2500);
  await assertWatching(B, 'after Auto-pause OFF');
  console.log('  autoPause ->', await B.evaluate(() => window.__rack.autoPause(!window.__rack.autoPause())));
  await sleep(2000);
  await assertWatching(B, 'after Auto-pause back ON');

  console.log('\n--- trigger 2: gaze shift (updateFocus → setFocus + applyBudget) ---');
  console.log('  focus ->', await B.evaluate(() => window.__rack.focus('console1')));
  await sleep(2500);
  await assertWatching(B, 'after gazing at the 2nd TV');
  await B.evaluate(() => window.__rack.focus('console0'));
  await sleep(1500);

  console.log('\n--- trigger 3: the console POWER switch (direct runtime.resume) ---');
  console.log('  power console1 off ->', await B.evaluate(() => window.__rack.powerConsole('console1', false)));
  await sleep(1200);
  console.log('  power console1 on  ->', await B.evaluate(() => window.__rack.powerConsole('console1', true)));
  await sleep(2500);
  await assertWatching(B, 'after power-cycling console1');

  console.log('\n--- trigger 4: a bare applyBudget() pass ---');
  console.log('  budget ->', JSON.stringify(await B.evaluate(() => window.__rack.budget())));
  await sleep(2000);
  await assertWatching(B, 'after a bare budget pass');

  // ── NEGATIVE CONTROL: defeat the gate, the bug must come back ─────────────
  // Without this the green run above proves nothing: it could be green because
  // the cores were dead for some unrelated reason.
  console.log('\n--- NEGATIVE CONTROL: remove the gate from the page ---');
  await B.evaluate(() => { window.__rackMgr.setAllowRun(null); window.__rack.budget(); });
  await sleep(3000);
  const ungated = await stepping(B);
  const ungatedLive = await B.evaluate(() => window.__rack.live());
  ok(anyStepping(ungated), `gate removed ⇒ the watcher's core RESUMES (this is the old bug) ${JSON.stringify(ungated)}`);
  ok(ungatedLive.some((r) => r.live), `gate removed ⇒ live consoles reappear ${JSON.stringify(ungatedLive)}`);
  ok((await B.evaluate(() => window.__net.isHost())) === false, 'gate removed: B is STILL not the host (so this was a real double-run)');
  if (SHOTS) await B.screenshot({ path: `${SHOTS}/b-negative-control.png` });
  // Put the gate back (approximating mayRunLocalCore: B is a connected non-host).
  await B.evaluate(() => { window.__rackMgr.setAllowRun(() => false); window.__rack.budget(); });
  await sleep(2500);
  await assertWatching(B, 'gate restored');

  // ── promotion: the host leaves, B is the senior remaining peer ────────────
  console.log('\n--- promotion: A leaves (past the 15s host-reclaim window) ---');
  await A._browser.close();
  browsers.splice(browsers.indexOf(A._browser), 1);
  // Restore the REAL predicate before promotion so we test the app, not the stub.
  await B.evaluate(() => { window.__rackMgr.setAllowRun(null); });
  await B.waitForFunction(() => window.__net?.isHost() === true, { timeout: 60000, polling: 1000 });
  await sleep(20000);
  const promoted = await state(B);
  const promotedFrames = await stepping(B);
  ok(promoted.isHost === true, 'B was promoted (seniority migration)');
  ok(promoted.mayRun === true, 'promoted: mayRunLocalCore() true again');
  ok(anyStepping(promotedFrames), `promoted: B now really emulates ${JSON.stringify(promotedFrames)}`);
  ok(promoted.live.some((r) => r.live), `promoted: the rack came back off suspension ${JSON.stringify(promoted.live)}`);
  ok(!promoted.tvs.some((t) => t.video), 'promoted: the TV is back on our own canvas, not a dead feed');
  if (SHOTS) await B.screenshot({ path: `${SHOTS}/b-promoted.png` });

  // ── leaving the room ─────────────────────────────────────────────────────
  console.log('\n--- leaving the room ---');
  await B.evaluate(() => document.getElementById('mp-leave-btn').click());
  await sleep(4000);
  const left = await state(B);
  ok(left.hostId === null && left.isHost === null, `left: no session ${JSON.stringify({ h: left.hostId, i: left.isHost })}`);
  ok(left.mayRun === true, 'left: our machine is ours again');
  ok(anyStepping(await stepping(B)), 'left: still emulating our own game');
} catch (e) { fail++; console.error('EXCEPTION', e); }
finally {
  for (const b of browsers) { try { await b.close(); } catch {} }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
