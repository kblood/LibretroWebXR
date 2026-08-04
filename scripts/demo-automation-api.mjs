// demo-automation-api — the end-to-end proof that window.__testApi +
// scripts/lib/mp-harness.mjs can drive a real multi-browser multiplayer session
// with NO legacy one-off hooks. It is also the worked example the docs point at:
// docs/TEST_AUTOMATION.md.
//
// WHAT IT PROVES, and why each check is shaped the way it is
// ---------------------------------------------------------
// The three questions asked of it, all answered BOTH WAYS (host→client AND
// client→host), because "the host acted and the client saw it" is only half of
// multiplayer and a one-directional test would have passed on several of the
// bugs this project has actually shipped:
//
//  A. ROOM OBJECTS, both directions. The host moves a prop and both clients
//     converge; then a NON-HOST client moves it and the host + the other client
//     converge; then the second client moves it and the first two converge.
//     Prop state is peer-scoped (only `tv`/`room`/`shelf:*` are host-owned), so
//     symmetry is the design — this asserts it for real props.
//
//  B. GAME CONTROL, both directions, verified in PIXELS. LWX Pong's right
//     paddle is CPU-driven until player 2 touches up/down, then a human owns it
//     (games/nes-pong/main.c). So:
//       - the CLIENT (non-host) holds P2 Down, then P2 Up. The right paddle must
//         travel to the bottom and then to the top — measured as a luma-profile
//         centroid over the paddle's own column, ON THE HOST'S CANVAS *AND* ON
//         THE CLIENT'S RECEIVED VIDEO. Both peers must see the same movement.
//       - the HOST holds P1 Down/Up and its LEFT paddle must move the same way,
//         proving the host still drives its own core rather than only relaying.
//     "The wire message was sent" is deliberately NOT the evidence here; it is
//     recorded as corroboration (session.recvInputs) but the assertion is the
//     picture.
//
//  C. VIDEO, checked from BOTH roles. Host side: its own screen is a live local
//     canvas whose picture advances and whose core is genuinely running. Client
//     side: it paints a remote <video>, runs ZERO cores, its decoded frame count
//     advances, and its picture CORRELATES with the host's canvas.
//
// NEGATIVE CONTROLS (3). Per this project's testing standard a green check is
// not evidence until it has been seen to go red on the same run:
//   NC1  pixel correlation — the host is compared against a peer deliberately
//        running a DIFFERENT game; the same samePicture() call must come back
//        near zero.
//   NC2  prop convergence — waitForPropPosition is asked for a position nobody
//        ever set; it must time out.
//   NC3  client→host input — the client presses with `route:'local'`, which
//        sends the button to its OWN idle core instead of forwarding it to the
//        host. The identical paddle measurement must NOT move.
//
// PREREQS (start these first, in two other terminals):
//   $env:PORT=8797; node server/room-server.mjs
//   npm run dev -- --port 5199
//
// RUN:
//   node scripts/demo-automation-api.mjs --app=http://localhost:5199/ --ws=ws://localhost:8797/
//
// FLAGS: --app --ws --room --headed --shots=<dir> --chrome=<path>

import { MpHarness, makeChecks, parseArgs, sleep } from './lib/mp-harness.mjs';

const args = parseArgs();
const SHOTS = typeof args.shots === 'string' ? args.shots : null;

const PONG = 'roms/freeware/lwx-nes-pong.nes';
const OTHER_GAME = 'roms/freeware/lwx-snes-demo.sfc';   // NC1: a different game

// --- where the paddles live, as fractions of the visible framebuffer ---------
// LWX Pong is 256x240: left paddle at x=16, right paddle at x=232, both 8 wide
// and 24 tall, travelling y=16..184 (see games/nes-pong/main.c). Normalised so
// the SAME rect works on the host's raw canvas and on the client's re-scaled
// WebRTC video. The right-paddle window deliberately stops short of x=248,
// where the score blocks are drawn.
const RIGHT_PADDLE = { rect: { u0: 0.895, v0: 0.03, u1: 0.945, v1: 0.90 }, axis: 'y', bins: 30, samples: 8 };
const LEFT_PADDLE = { rect: { u0: 0.055, v0: 0.03, u1: 0.105, v1: 0.90 }, axis: 'y', bins: 30, samples: 8 };

// A paddle pinned to the bottom / top of its travel, as a 0..1 centroid of the
// profile above. Generous margins: the ball crosses the column occasionally and
// the WebRTC re-encode is lossy.
const AT_BOTTOM = 0.68;
const AT_TOP = 0.36;
// Hold long enough to cross the whole travel: 168 px at 2 px/frame ≈ 84 frames
// ≈ 1.4 s at 60 Hz. Doubled for headroom on a busy headless machine.
const HOLD_MS = 3000;

const { ok, section, summary, state } = makeChecks();
const mp = new MpHarness({
  app: args.app, ws: args.ws, room: args.room, headed: !!args.headed, chrome: args.chrome,
});
console.log(`room "${mp.room}" · app ${mp.app} · ws ${mp.ws}`);

/**
 * Where is a paddle right now, on this peer's screen? Returns a 0..1 centroid
 * (0 = top of travel, 1 = bottom) or null when nothing bright is in the crop.
 * Identical measurement on host (canvas) and client (<video>) — that identity
 * is the point: it lets one assertion cover both peers.
 */
const paddle = (peer, which) => mp.spritePosition(peer, which === 'left' ? LEFT_PADDLE : RIGHT_PADDLE);

/** Hold `btn` for HOLD_MS, then measure both peers' view of `which` paddle. */
async function holdAndMeasure(presser, btn, player, which, observers) {
  await presser.press(btn, { player });
  await sleep(HOLD_MS);
  const seen = {};
  for (const [name, peer] of Object.entries(observers)) seen[name] = await paddle(peer, which);
  await presser.releaseButton(btn, { player });
  return seen;
}

let exitCode = 1;
try {
  // =========================================================================
  section('0 — the API surface is present and self-describing');
  // =========================================================================
  const host = await mp.openHost('Host');
  const methods = await host.methods();
  const wanted = [
    'session.join', 'session.leave', 'session.becomeHost', 'session.waitForHostElection',
    'props.list', 'props.grab', 'props.moveTo', 'props.release',
    'input.press', 'input.release', 'content.insert', 'content.loadFile',
    'rack.running', 'tv.sample', 'tv.profile', 'video.progress', 'room.published',
  ];
  const missing = wanted.filter((m) => !methods.includes(m));
  ok(missing.length === 0, `__testApi exposes the documented surface (${methods.length} methods)`, missing);
  ok((await host.clientKind()) === 'vr', 'clientKind reports the VR client');
  ok(await host.isHost(), 'the first peer in is the room host (server seniority)');

  // =========================================================================
  section('1 — two more peers join; roles settle deterministically');
  // =========================================================================
  const clientA = await mp.open('ClientA');
  const clientB = await mp.open('ClientB');
  await host.waitForPeers(2);
  ok(true, 'Host sees both clients');
  await clientA.waitUntilWatching();
  await clientB.waitUntilWatching();
  ok(!(await clientA.isHost()) && !(await clientB.isHost()), 'neither client thinks it is host');
  ok((await clientA.mayRunLocalCore()) === false, 'ClientA is display-only (may run no local core)');
  ok((await clientB.mayRunLocalCore()) === false, 'ClientB is display-only');
  ok((await host.mayRunLocalCore()) === true, 'Host may run a core');

  // =========================================================================
  section('2 — the HOST loads a ROM (C: host-side correctness)');
  // =========================================================================
  await host.loadFile({ url: PONG });
  const loaded = await host.waitForGame('lwx-nes-pong');
  ok(!!loaded?.core, `Host booted ${loaded?.title || loaded?.file} on ${loaded?.core}`);

  const hostTv = await host.tvState();
  ok(hostTv.kind === 'canvas', `Host's own screen paints a LOCAL canvas (kind=${hostTv.kind})`);
  const hostMotion = await host.waitForMotion(undefined, { timeoutMs: 45000 });
  ok(hostMotion.changed && !hostMotion.blank, 'Host\'s own picture is non-blank AND advancing');

  const hostCores = await host.runningCores({ ms: 1500 });
  const hostRunning = hostCores.filter((c) => c.running);
  ok(hostRunning.length === 1,
    `exactly ONE core is genuinely running on the host (not just unpaused)`,
    hostCores.map((c) => ({ id: c.id, core: c.core, live: c.live, running: c.running, framesDelta: c.framesDelta })));

  const publishedTv = await host.publishedTv();
  ok(String(publishedTv?.file || '').includes('lwx-nes-pong'),
    `the room's published tv state names the host's game`, publishedTv);

  // =========================================================================
  section('3 — host → client video (C: client-side reception)');
  // =========================================================================
  for (const [name, peer] of [['ClientA', clientA], ['ClientB', clientB]]) {
    const prog = await peer.waitForStream({ timeoutMs: 90000 });
    ok(prog.advanced, `${name}: decoded frames advance on the host's stream`, prog);
    const t = await peer.tvState();
    ok(t.kind === 'video', `${name}: its in-world TV paints the REMOTE <video> (kind=${t.kind})`);
    const cores = await peer.runningCores({ ms: 1200 });
    ok(cores.every((c) => !c.running), `${name}: runs ZERO cores of its own`,
      cores.map((c) => ({ id: c.id, live: c.live, running: c.running })));
  }
  const corrA = await mp.samePicture(host, clientA);
  ok(corrA != null && corrA > 0.85, `ClientA's picture correlates with the host's canvas (r=${corrA?.toFixed(3)})`);
  const corrB = await mp.samePicture(host, clientB);
  ok(corrB != null && corrB > 0.85, `ClientB's picture correlates with the host's canvas (r=${corrB?.toFixed(3)})`);

  // ---- NEGATIVE CONTROL 1: the correlation check can go red ----------------
  section('3-NC1 — negative control: correlate the host against a DIFFERENT game');
  const solo = await mp.open('Solo', { session: false });
  await solo.loadFile({ url: OTHER_GAME });
  await solo.waitForMotion(undefined, { timeoutMs: 45000 }).catch(() => null);
  const negCorr = await mp.samePicture(host, solo);
  ok(negCorr == null || negCorr < 0.5,
    `same check against an unrelated game is NOT a match (r=${negCorr == null ? 'null' : negCorr.toFixed(3)})`);
  await solo.close();

  // =========================================================================
  section('4 — A: room objects move in BOTH directions');
  // =========================================================================
  const poster = await host.addProp('poster', { pos: [0.6, 1.6, -3.2], texture: 'builtin:poster-2' });
  ok(!!poster.id, `Host spawned a poster (${poster.id})`);
  await clientA.waitForProp(poster.id, { timeoutMs: 20000 });
  await clientB.waitForProp(poster.id, { timeoutMs: 20000 });
  ok(true, 'both clients received the new prop');

  // NOTE on what we assert against. props.move() RELEASES through the app's own
  // release path, and the room editor's surface-snap pulls a poster onto the
  // nearest wall (RoomEditor.onEditRelease). So the authoritative transform is
  // the one the mover REPORTS BACK after release — not the coordinates we asked
  // for. Asserting on the requested position would be asserting that snapping is
  // broken. move() returns the settled prop view for exactly this reason.
  const converge = async (peer, at, tol = 0.02, timeoutMs = 15000) =>
    peer.tryCall('props.waitForPosition', [poster.id, at, { tol, timeoutMs }]);

  // 4a — host → clients
  const movedA = await host.moveObject(poster.id, [-1.2, 1.45, -3.2]);
  const a1 = await converge(clientA, movedA.pos);
  const a2 = await converge(clientB, movedA.pos);
  ok(a1.ok && a2.ok, `HOST moved the poster to [${movedA.pos.map((n) => n.toFixed(2))}] → both clients converged`,
    { a1: a1.error, a2: a2.error });

  // 4b — client → host  (the direction a one-way test never covers)
  const movedB = await clientA.moveObject(poster.id, [1.4, 1.75, -3.2]);
  const b1 = await converge(host, movedB.pos);
  const b2 = await converge(clientB, movedB.pos);
  ok(b1.ok, `CLIENT A moved the poster to [${movedB.pos.map((n) => n.toFixed(2))}] → the HOST converged`, b1.error);
  ok(b2.ok, 'CLIENT A moved the poster → the other CLIENT converged', b2.error);
  ok(Math.abs(movedB.pos[0] - movedA.pos[0]) > 0.5 || Math.abs(movedB.pos[2] - movedA.pos[2]) > 0.5,
    'the client\'s move really was a different place (not a no-op that would pass trivially)',
    { from: movedA.pos, to: movedB.pos });

  // 4c — the third peer moves it too (client → host + client)
  const movedC = await clientB.moveObject(poster.id, [0.2, 2.05, -3.9]);
  const c1 = await converge(host, movedC.pos);
  const c2 = await converge(clientA, movedC.pos);
  ok(c1.ok && c2.ok, 'CLIENT B moved the poster → host and ClientA converged', { c1: c1.error, c2: c2.error });

  // Grab/move/release as three separate steps: the live-drag channel carries the
  // in-flight transform, then release publishes the authoritative one.
  const GRAB_POS = [0.9, 1.3, -3.6];
  await clientA.grabProp(poster.id);
  await clientA.moveObjectTo(poster.id, GRAB_POS);
  const dragSeen = await converge(host, GRAB_POS, 0.05, 8000);
  const dropped = await clientA.releaseProp(poster.id);
  const dropSeen = await converge(host, dropped.pos, 0.05, 12000);
  ok(dragSeen.ok, 'a client\'s LIVE DRAG reaches the host mid-move (transient channel)', dragSeen.error);
  ok(dropSeen.ok, 'the authoritative transform survives the release', dropSeen.error);

  // ---- NEGATIVE CONTROL 2: the convergence check can go red ---------------
  section('4-NC2 — negative control: wait for a position nobody ever set');
  const bogus = await host.tryCall('props.waitForPosition', [poster.id, [9, 9, 9], { tol: 0.02, timeoutMs: 4000 }]);
  ok(!bogus.ok && bogus.error.code === 'timeout',
    'waitForPosition times out on a transform that was never broadcast', bogus.error);

  // =========================================================================
  section('5 — B: BOTH sides control the running game, proved in pixels');
  // =========================================================================
  // Each direction is asserted as a TRANSITION, never as an absolute position:
  // "the paddle is at the bottom after pressing Down" is vacuous whenever the
  // CPU happened to leave it there, and on one run of this demo it did exactly
  // that. So: drive it to one extreme, confirm, drive it to the other, and
  // require BOTH the new extreme AND a large move away from where it just was.
  const base = await paddle(host, 'right');
  ok(base != null, `baseline: right paddle is locatable on the host's canvas (y=${base?.toFixed(3)})`);

  // 5a — CLIENT drives player 2 UP. The first up/down latches p2_active in the
  // game, after which the paddle is human-driven and must climb to the top.
  const up = await holdAndMeasure(clientA, 'Up', 2, 'right', { host, clientA });
  ok(up.host != null && up.host < AT_TOP,
    `client's P2 Up → right paddle at the TOP on the HOST's canvas (y=${up.host?.toFixed(3)})`);
  ok(up.clientA != null && up.clientA < AT_TOP,
    `…and on the CLIENT's received video too (y=${up.clientA?.toFixed(3)})`);

  // Corroboration only — the pixels are the actual evidence.
  const relayed = await host.recvInputs();
  ok(relayed.some((e) => e.player === 2 && e.btn === 'Up'),
    `the host recorded the client's forwarded P2 Up (${relayed.length} inputs relayed)`);

  // 5b — CLIENT drives player 2 DOWN: from the top, so this cannot be vacuous.
  const down = await holdAndMeasure(clientA, 'Down', 2, 'right', { host, clientA });
  ok(down.host != null && down.host > AT_BOTTOM,
    `client's P2 Down → right paddle at the BOTTOM on the HOST's canvas (y=${down.host?.toFixed(3)})`);
  ok(down.clientA != null && down.clientA > AT_BOTTOM,
    `…and on the CLIENT's received video too (y=${down.clientA?.toFixed(3)})`);
  ok((down.host - up.host) > 0.35,
    `the client's input moved the host's paddle ACROSS its travel (${up.host?.toFixed(3)} → ${down.host?.toFixed(3)})`);
  ok((down.clientA - up.clientA) > 0.35,
    `the client SAW that movement in its own feed (${up.clientA?.toFixed(3)} → ${down.clientA?.toFixed(3)})`);

  // 5c — and back up again, so the client is proved to hold the paddle
  // continuously rather than having coincided with one CPU sweep.
  const up2 = await holdAndMeasure(clientA, 'Up', 2, 'right', { host, clientA });
  ok(up2.host != null && up2.host < AT_TOP && (down.host - up2.host) > 0.35,
    `client's P2 Up again → back to the TOP (${down.host?.toFixed(3)} → ${up2.host?.toFixed(3)})`);
  // The uninvolved third peer must see it as well — one shared game, not two.
  const bView = await paddle(clientB, 'right');
  ok(bView != null && bView < AT_TOP,
    `ClientB (uninvolved peer) also sees the paddle at the top (y=${bView?.toFixed(3)})`);

  // ---- NEGATIVE CONTROL 3: the input check can go red ---------------------
  section('5-NC3 — negative control: the client presses WITHOUT forwarding');
  // route:'local' sends the button to the client's OWN (idle, display-only) core
  // instead of the host. Same button, same measurement — must NOT move the game.
  await clientA.press('Down', { player: 2, route: 'local' });
  await sleep(HOLD_MS);
  const notForwarded = await paddle(host, 'right');
  await clientA.releaseButton('Down', { player: 2, route: 'local' });
  ok(notForwarded != null && notForwarded < 0.5,
    `un-forwarded press does NOT move the host's paddle (y=${notForwarded?.toFixed(3)}, still near the top)`);
  await clientA.releaseAllButtons();

  // 5d — HOST drives player 1 on its OWN core: it is not merely relaying.
  // Same transition discipline: up first, then a full sweep down.
  section('5d — the HOST\'s own local input still drives its own core');
  const hUp = await holdAndMeasure(host, 'Up', 1, 'left', { host, clientA });
  ok(hUp.host != null && hUp.host < AT_TOP,
    `host's own P1 Up → LEFT paddle at the top on its canvas (y=${hUp.host?.toFixed(3)})`);
  const hDown = await holdAndMeasure(host, 'Down', 1, 'left', { host, clientA });
  ok(hDown.host != null && hDown.host > AT_BOTTOM,
    `host's own P1 Down → LEFT paddle at the bottom (y=${hDown.host?.toFixed(3)})`);
  ok((hDown.host - hUp.host) > 0.35,
    `the host moved its OWN paddle across its travel (${hUp.host?.toFixed(3)} → ${hDown.host?.toFixed(3)})`);
  ok(hDown.clientA != null && (hDown.clientA - hUp.clientA) > 0.35,
    `the CLIENT saw the host's paddle move (${hUp.clientA?.toFixed(3)} → ${hDown.clientA?.toFixed(3)})`);
  await host.releaseAllButtons();

  // Both pictures still agree after all that input.
  const corrAfter = await mp.samePicture(host, clientA);
  ok(corrAfter != null && corrAfter > 0.8,
    `after both peers played, the two screens still show ONE evolving game (r=${corrAfter?.toFixed(3)})`);

  // =========================================================================
  section('6 — leaving hands the machine back');
  // =========================================================================
  await clientB.leaveRoom();
  const left = await clientB.until(async () => (await clientB.mayRunLocalCore()) || null,
    { timeoutMs: 15000, what: 'ClientB to regain local-core rights' }).catch(() => null);
  ok(!!left, 'ClientB may run its own core again after leaving');

  if (SHOTS) {
    for (const p of mp.peers) await p.screenshot(`${SHOTS}/${p.name}.png`).catch(() => {});
    console.log(`\nscreenshots → ${SHOTS}`);
  }

  exitCode = summary() ? 0 : 1;
} catch (e) {
  console.error('\nHARNESS ERROR:', e?.stack || e);
  summary();
  exitCode = 2;
} finally {
  await mp.closeAll();
}
// Sanity: a run that asserted almost nothing is not a pass, however green.
if (exitCode === 0 && state.passed < 25) {
  console.error(`\nFAIL — only ${state.passed} checks ran; the demo did not get far enough to prove anything.`);
  exitCode = 1;
}
process.exit(exitCode);
