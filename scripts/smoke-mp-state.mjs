// smoke-mp-state — real two/three-browser checks for three shared-room fixes,
// all driven through window.__testApi + scripts/lib/mp-harness.mjs.
//
//   §1  Spawn seats.        Joining peers take a deterministic per-seat offset
//                           (src/net/SessionUtils.js spawnSeatOffset) so a remote
//                           avatar's head plane no longer materialises at the
//                           watcher's own camera, occluding the shared TV.
//   §2  Honest isLive().    ConsoleRuntime.isLive() requires a core to exist, so a
//                           display-only watcher's never-booted primary console
//                           stops claiming live:true.
//   §3  Disc index in `tv`. The room's `tv` key carries which disc of a multi-disc
//                           (.m3u) game is loaded, so a watcher / late joiner /
//                           promoted host sees the real disc instead of disc 1.
//
// Every section has a NEGATIVE CONTROL that asserts the RED outcome, because a
// green tick in this repo is not evidence until it has been seen to fail — see
// docs/TEST_AUTOMATION.md § Negative controls.
//
// §3's core is SIMULATED, and deliberately so: a genuine end-to-end multi-disc
// check needs a bootable multi-track PSX image plus a real BIOS, which is out of
// proportion for a state-propagation layer whose disc plumbing already has its own
// coverage (test/psx-foundations.test.js, test/runtime.test.js). Following the
// precedent set by scripts/probe-discswap-panel.mjs, the HOST's live
// `window.__client` gets discStatus()/setDisc() monkey-patched to answer like a
// 3-disc core; everything above that — main.js's stepDisc / refreshDiscPanel /
// publishDiscState, NetMgr's STATE broadcast, the watcher's applyRemoteTv and its
// real (unpatched, coreless) DiscSwapPanel — is the production path.
//
// Prereqs (two terminals):
//   $env:PORT=8797; node server/room-server.mjs
//   npm run dev -- --port 5199
//
// Usage:
//   node scripts/smoke-mp-state.mjs [--app=http://localhost:5199/] [--ws=ws://localhost:8797/]
//   …or against production: --app=https://dionysus.dk/webxr/libretrowebxr2/ --ws=wss://dionysus.dk/ws/
//
// Exit code: 0 = every check passed, 1 = at least one failed.

import { MpHarness, parseArgs, sleep } from './lib/mp-harness.mjs';

const args = parseArgs();
const APP = args.app || 'http://localhost:5199/';
const WS = args.ws || 'ws://localhost:8797/';
const ROOM = args.room || `mpstate-${Math.random().toString(36).slice(2, 7)}`;
const PONG = 'roms/freeware/lwx-nes-pong.nes';

let pass = 0;
let fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log(`  ok   ${msg}`); }
  else { fail++; console.error(`  FAIL ${msg}${detail !== undefined ? `\n         ${JSON.stringify(detail)}` : ''}`); }
};
const section = (s) => console.log(`\n=== ${s} ===`);

/** Poll until a peer's nearest remote avatar head is really in the room (eased up
 *  from its below-the-floor parking spot), then return that distance. */
async function settledAvatarDistance(peer, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const avs = await peer.avatars();
    const up = avs.filter((a) => Array.isArray(a.pos) && a.pos[1] > 0.5);
    if (up.length) return { dist: await peer.nearestAvatarDistance(), avatars: avs };
    if (Date.now() > deadline) throw new Error(`[${peer.name}] no remote avatar ever got a pose (${JSON.stringify(avs)})`);
    await sleep(250);
  }
}

const mp = new MpHarness({ app: APP, ws: WS, room: ROOM, chrome: args.chrome });

try {
  console.log(`app=${APP}\nws=${WS}\nroom=${ROOM}`);

  const host = await mp.openHost('Host');
  const watcher = await mp.open('Watcher');
  await watcher.waitUntilWatching();
  await host.waitForPeers(1);

  // ---------------------------------------------------------------------------
  section('§1 spawn seats — a joiner does not stand inside the peer already there');
  // ---------------------------------------------------------------------------
  const hv = await host.viewpoint();
  const wv = await watcher.viewpoint();
  ok(hv.seatIndex === 0, 'the senior peer takes seat 0', hv);
  ok(JSON.stringify(hv.seatOffset) === '[0,0,0]', 'seat 0 keeps the canonical room origin', hv.seatOffset);
  ok(wv.seatIndex === 1, 'the joiner takes seat 1', wv);
  ok(Array.isArray(wv.seatOffset) && Math.hypot(wv.seatOffset[0], wv.seatOffset[2]) > 0.5,
    'seat 1 is a real offset, not [0,0,0]', wv.seatOffset);

  const rigGap = Math.hypot(hv.rig[0] - wv.rig[0], hv.rig[2] - wv.rig[2]);
  ok(rigGap > 0.5, `the two peers' player rigs are ${rigGap.toFixed(2)} m apart`, { host: hv.rig, watcher: wv.rig });

  // The measurement that matters: how far is the OTHER player's head from mine.
  // This is the number that was ~0 before the fix — the head plane at your camera.
  const hSeen = await settledAvatarDistance(host);
  const wSeen = await settledAvatarDistance(watcher);
  ok(hSeen.dist > 0.5, `host sees the watcher's head ${hSeen.dist.toFixed(2)} m away (not in its face)`, hSeen);
  ok(wSeen.dist > 0.5, `watcher sees the host's head ${wSeen.dist.toFixed(2)} m away (not in its face)`, wSeen);

  // NC1 — the same measurement, on a peer deliberately re-seated onto seat 0.
  // Everyone on seat 0 is exactly the pre-fix world, and it must read RED.
  const intruder = await mp.open('Intruder');
  await intruder.waitUntilWatching();
  const iv0 = await intruder.viewpoint();
  ok(iv0.seatIndex === 2, 'third peer takes seat 2', iv0);
  await intruder.page.evaluate(() => window.__net.takeSpawnSeat(0));   // force the old behaviour
  const iv1 = await intruder.viewpoint();
  ok(JSON.stringify(iv1.rig) === JSON.stringify(hv.rig),
    'NC1: the re-seated peer now stands exactly where the host does', { intruder: iv1.rig, host: hv.rig });
  const hostToIntruder = await host.until(async () => {
    const avs = (await host.avatars()).filter((a) => a.pos[1] > 0.5 && a.nick === 'Intruder');
    if (!avs.length) return null;
    const d = Math.hypot(avs[0].pos[0] - hv.head[0], avs[0].pos[2] - hv.head[2]);
    return d < 0.35 ? d : null;
  }, { timeoutMs: 15000, what: 'the seat-0 intruder to occlude the host' });
  ok(hostToIntruder < 0.35,
    `NC1 RED: on seat 0 the intruder's head is only ${hostToIntruder.toFixed(2)} m from the host's camera — the bug`,
    hostToIntruder);
  ok(hSeen.dist > hostToIntruder * 2,
    'NC1: the seated watcher is measurably further away than the seat-0 intruder',
    { seated: hSeen.dist, seat0: hostToIntruder });
  await intruder.close();

  // ---------------------------------------------------------------------------
  section('§2 isLive() — a coreless watcher stops claiming its core runs');
  // ---------------------------------------------------------------------------
  const wConsoles = await watcher.consoles();
  const wPrimary = wConsoles[0];
  ok(!!wPrimary, 'the watcher has a primary console runtime at all', wConsoles);
  ok(wPrimary.loaded === false, 'watcher primary: loaded false (nothing booted)', wPrimary);
  ok(wPrimary.hasCore === false, 'watcher primary: hasCore false', wPrimary);
  ok(wPrimary.live === false, 'watcher primary: live FALSE — the fix', wPrimary);
  ok((await watcher.mayRunLocalCore()) === false, 'watcher may run no local core');

  // NC2 — the pre-fix formula, read off the very same client object. It still
  // says "live", which is precisely why isLive() had to stop being that formula.
  const preFix = await watcher.page.evaluate(() => ({
    paused: window.__client?.paused ?? null,
    ready: window.__client?.ready ?? null,
    preFixIsLive: !window.__client?.paused,
  }));
  ok(preFix.ready === false, 'NC2: the watcher\'s client never became ready', preFix);
  ok(preFix.preFixIsLive === true,
    'NC2 RED: `!client.paused` (the old isLive) still claims the coreless watcher is live', preFix);
  ok(preFix.preFixIsLive !== wPrimary.live,
    'NC2: the fixed isLive() disagrees with the old formula on this exact runtime',
    { old: preFix.preFixIsLive, now: wPrimary.live });

  // …and it is not merely "always false": a host with a real game reads live.
  await host.loadFile({ url: PONG });
  await host.waitForGame('lwx-nes-pong');
  const hPrimary = (await host.consoles()).find((c) => c.core);
  ok(hPrimary?.hasCore === true, 'host primary: hasCore true once a game booted', hPrimary);
  ok(hPrimary?.live === true, 'host primary: live true (so the check can still go green)', hPrimary);
  const hRunning = (await host.runningCores({ ms: 1200 })).filter((r) => r.running);
  ok(hRunning.length === 1, 'exactly one core genuinely running on the host', hRunning);
  const wRunning = await watcher.runningCores({ ms: 1200 });
  ok(wRunning.every((r) => !r.running), 'zero cores running on the watcher', wRunning);

  // ---------------------------------------------------------------------------
  section('§3 the room `tv` state carries the current disc');
  // ---------------------------------------------------------------------------
  // Baseline: a plain cartridge must NOT publish disc fields (that would be wire
  // noise on every insert), and the watcher's disc panel must stay hidden.
  const base = await host.discState();
  ok(base.published?.disc === null && base.published?.discCount === null,
    'a cartridge game publishes no disc fields', base.published);
  ok(base.panel.visible === false, 'host disc panel hidden for single-disc content', base.panel);
  const wBase = await watcher.discState();
  ok(wBase.panel.visible === false, 'watcher disc panel hidden too', wBase.panel);
  ok(wBase.published?.disc === null,
    'NC3 RED: with no disc in `tv`, the watcher cannot know the disc — the bug', wBase.published);

  // Make the host's live client answer like a 3-disc core (see the header note).
  await host.page.evaluate(() => {
    const c = window.__client;
    let index = 0;
    const status = () => ({ index, discCount: 3, ejected: false, supported: true, explicit: true });
    c.discStatus = async () => status();
    c.setDisc = async (i) => { index = i; return status(); };
    window.__fakeDisc = { get: () => index };
  });
  // Re-run the app's own post-boot refresh so it picks the new status up exactly
  // as it would after a real multi-disc boot.
  await host.page.evaluate(() => window.__discSwap.refresh());
  await sleep(400);

  const h0 = await host.discState();
  ok(h0.panel.visible === true && h0.panel.label === '1 / 3', 'host panel shows DISC 1 / 3', h0.panel);
  ok(h0.published?.disc === 0 && h0.published?.discCount === 3,
    'the boot refresh published disc 0 of 3 to the room', h0.published);

  // The watcher must learn it from the room state alone — it has no core to ask.
  const w0 = await watcher.until(async () => {
    const d = await watcher.discState();
    return d.panel.discCount === 3 ? d : null;
  }, { timeoutMs: 15000, what: 'the watcher to receive the disc count' });
  ok(w0.panel.visible === true && w0.panel.label === '1 / 3', 'watcher panel shows DISC 1 / 3', w0.panel);
  ok(w0.panel.remote === true, 'the watcher knows this is second-hand (from the room, not its own core)', w0.panel);

  // Now the real Next button, through main.js's stepDisc.
  const h1 = await host.stepDisc(1);
  ok(h1.panel.label === '2 / 3', 'host Next → DISC 2 / 3', h1.panel);
  ok(h1.published?.disc === 1, 'a disc SWAP republishes `tv` with disc 1 (no reboot involved)', h1.published);
  ok((await host.page.evaluate(() => window.__fakeDisc.get())) === 1, 'the core really was told to switch');

  const w1 = await watcher.until(async () => {
    const d = await watcher.discState();
    return d.panel.index === 1 ? d : null;
  }, { timeoutMs: 15000, what: 'the watcher to follow the disc swap' });
  ok(w1.panel.label === '2 / 3', 'watcher follows to DISC 2 / 3 — the fix', w1.panel);
  ok(w1.published?.disc === 1, 'and the room state it read really says disc 1', w1.published);

  // Wrap-around, so this is not a one-off increment.
  await host.stepDisc(1);
  const w2 = await watcher.until(async () => {
    const d = await watcher.discState();
    return d.panel.index === 2 ? d : null;
  }, { timeoutMs: 15000, what: 'the watcher to follow to disc 3' });
  ok(w2.panel.label === '3 / 3', 'watcher follows to DISC 3 / 3', w2.panel);

  // A LATE JOINER gets it from the replayed room state, with no swap to observe.
  const late = await mp.open('LateJoiner');
  await late.waitUntilWatching();
  const lateDisc = await late.until(async () => {
    const d = await late.discState();
    return d.panel.discCount === 3 ? d : null;
  }, { timeoutMs: 20000, what: 'the late joiner to inherit the disc state' });
  ok(lateDisc.panel.label === '3 / 3', 'a late joiner arrives on DISC 3 / 3, not disc 1 — the fix', lateDisc.panel);
  ok(lateDisc.panel.remote === true, 'late joiner\'s reading is from the room state', lateDisc.panel);
  const lateSeat = await late.viewpoint();
  ok(lateSeat.seatIndex >= 1 && Math.hypot(lateSeat.seatOffset[0], lateSeat.seatOffset[2]) > 0.5,
    'and it took its own seat rather than the origin', lateSeat);

  // NC4 — losing disc control must CLEAR the room's disc fields and hide both
  // panels again. If the watcher had latched the label instead of following the
  // room state, this is where it would be caught.
  await host.page.evaluate(() => {
    window.__client.discStatus = async () => ({ index: 0, discCount: 1, ejected: false, supported: true });
    return window.__discSwap.refresh();
  });
  await sleep(400);
  const hEnd = await host.discState();
  ok(hEnd.panel.visible === false, 'NC4: host panel hides for single-disc content again', hEnd.panel);
  ok(hEnd.published?.disc === null, 'NC4: the disc fields were cleared from `tv`, not left stale', hEnd.published);
  const wEnd = await watcher.until(async () => {
    const d = await watcher.discState();
    return d.panel.visible === false ? d : null;
  }, { timeoutMs: 15000, what: 'the watcher panel to hide again' });
  ok(wEnd.panel.discCount === null, 'NC4: the watcher followed the room back to no-disc', wEnd.panel);

  // Floor on how much actually ran, so an early bail-out cannot report success.
  ok(pass >= 35, `enough checks ran (${pass})`);
} catch (e) {
  fail++;
  console.error(`\nFATAL: ${e.stack || e.message}`);
} finally {
  await mp.closeAll().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
