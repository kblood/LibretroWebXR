// Headless two-bug smoke: the pose a peer sees for a prop somebody else is
// HOLDING, and the layout a peer sees when it JOINS. Both were reported from a
// real headset session:
//
//   "when one player releases a controller it seems to fall below the floor for
//    the other player, but stays in the air for the player that released it"
//   "the room failed to sync when a player joins the lobby … if something was
//    moved AFTER the client had joined, those moves would sync correctly"
//
// Section A — held pose. GrabMgr re-parents a grabbed prop onto the holder's
//   controller, so `object.position` stops being a room position while it is
//   carried. Both the ~20 Hz `drag` wire and the release `prop:` STATE published
//   that controller-local vector as if it were one, i.e. a few centimetres from
//   the world origin: under the floor. The holder's own copy never moved, so
//   only the peers saw it. This section grabs the room's gamepad on Peer A,
//   walks away with it, and asserts Peer B's copy tracks Peer A's WORLD pose
//   both mid-carry and after the release.
//
// Section B — join layout. The `room` STATE snapshot is the room DESCRIPTOR, so
//   it carries authored positions, not where the host has since put things. Only
//   a networked edit emitted a `prop:` delta, which is exactly why moves made
//   after a join arrived and the layout at join time did not. The host now
//   publishes a `prop:` BASELINE for what it has actually placed. This section
//   moves a prop on the host with no broadcast at all, waits for the baseline,
//   then joins a fresh peer and asserts it builds the room as it IS.
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8803; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-prop-hold-join.mjs --app=http://localhost:5173/ --ws=ws://localhost:8803/
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/';
const WS = args.ws || 'ws://localhost:8803/';
const ROOM = args.room || 'holdjoin-test';
const urlFor = (nick, room) =>
  `${APP}${APP.includes('?') ? '&' : '?'}session=${room}&server=${encodeURIComponent(WS)}&nick=${nick}`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(2); }

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (p) => (p ? `[${p.map((n) => n.toFixed(3)).join(', ')}]` : 'null');

const browsers = [];

async function openPeer(nick, room) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: !args.headed,
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer'],
  });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(`  [${nick}]`, m.text());
  });
  await page.goto(urlFor(nick, room), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 15000 });
  await page.waitForFunction(() => !!window.__props, { timeout: 20000 });
  return page;
}

async function waitFor(page, fn, ms = 10000, ...evalArgs) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if (await page.evaluate(fn, ...evalArgs)) return true; } catch { /* mid-reload */ }
    await sleep(150);
  }
  return false;
}

// ── page-side reads ─────────────────────────────────────────────────────────
// The app's CSP has no 'unsafe-eval' (see SEC-5), so every page-side helper is a
// real function passed to page.evaluate, never a string the page has to compile.

// World position of a prop, as an array. Peers apply payloads to scene-parented
// copies, so on a peer this equals the local position — but on the HOLDER it is
// the only honest answer while the prop hangs off a controller. Every prop
// RoomBuilder places carries userData.roomProp, which is what the sync registry
// keys off too, so that is how we find the object.
const worldPos = (propId) => {
  let o = null;
  window.__scene.scene.traverse((x) => { if (!o && x.userData?.roomProp?.id === propId) o = x; });
  if (!o) return null;
  o.updateMatrixWorld(true);
  const v = o.position.clone();   // a THREE.Vector3 without importing THREE
  o.getWorldPosition(v);
  return [v.x, v.y, v.z];
};
// What a peer thinks the prop's room position is (its own copy, scene-parented).
const peerPos = (propId) => {
  const p = window.__props.list().find((x) => x.propId === propId);
  return p ? p.pos : null;
};
// peerPos, plus the "is it within tol of `want`" test, for polling.
const peerPosNear = (propId, want, tol) => {
  const p = window.__props.list().find((x) => x.propId === propId);
  if (!p) return false;
  return Math.hypot(p.pos[0] - want[0], p.pos[1] - want[1], p.pos[2] - want[2]) < tol;
};
// World position of the desktop controller — where this peer's hand is.
const handPos = () => {
  const ctrl = window.__scene.desktopController;
  ctrl.updateMatrixWorld(true);
  const v = ctrl.position.clone();
  ctrl.getWorldPosition(v);
  return [v.x, v.y, v.z];
};
// Grab a prop with the desktop controller the way GrabMgr does for a real hand:
// reach for it (it will not attach anything the hand is not near), register the
// hold, then _finalizeAttach — which is what re-parents it onto the controller.
const grabWithHand = (propId) => {
  let o = null;
  window.__scene.scene.traverse((x) => { if (!o && x.userData?.roomProp?.id === propId) o = x; });
  const ctrl = window.__scene.desktopController;
  if (!o || !ctrl) return false;
  const v = ctrl.position.clone();
  o.getWorldPosition(v);
  ctrl.parent.worldToLocal(v);
  ctrl.position.copy(v);
  ctrl.updateMatrixWorld(true);
  window.__grab.held.set(ctrl, o);
  window.__grab._finalizeAttach(ctrl, o);
  return o.parent === ctrl;
};
// Walk somewhere else, carrying whatever is in hand.
const walk = (dx, dz) => {
  const rig = window.__scene.playerRig;
  rig.position.set(rig.position.x + dx, rig.position.y, rig.position.z + dz);
  rig.updateMatrixWorld(true);
};
// Move a prop's object directly, with no broadcast of any kind.
const moveSilently = (propId, pos) => {
  let o = null;
  window.__scene.scene.traverse((x) => { if (!o && x.userData?.roomProp?.id === propId) o = x; });
  if (!o) return false;
  o.position.set(pos[0], pos[1], pos[2]);
  o.updateMatrixWorld(true);
  return true;
};

try {
  // =========================================================================
  // Section A: a prop in a hand reads as a ROOM pose on every peer.
  // =========================================================================
  console.log('\n--- Section A: the pose peers see for a held prop');
  const roomA = `${ROOM}-hold`;
  const peerA = await openPeer('PeerA', roomA);
  const peerB = await openPeer('PeerB', roomA);
  ok(await waitFor(peerA, () => window.__net.peerCount() >= 1), 'PeerA sees PeerB');
  ok(await waitFor(peerB, () => window.__net.peerCount() >= 1), 'PeerB sees PeerA');

  const padId = await peerA.evaluate(() => {
    const p = window.__props.list().find((x) => x.type === 'gamepad');
    return p ? p.propId : null;
  });
  ok(typeof padId === 'string', `the room has a gamepad prop to grab (id: ${padId})`);

  const restPos = await peerA.evaluate(worldPos, padId);
  ok(restPos !== null && restPos[1] > 0.3,
    `at rest the gamepad is up in the room on PeerA ${fmt(restPos)}`);

  ok(await peerA.evaluate(grabWithHand, padId),
    'PeerA grabbed the gamepad — it is now parented to the controller');

  // Walk away with it. The rig carries the controller, and the controller the
  // prop; only its WORLD transform changes.
  await peerA.evaluate(walk, 1.7, 2.4);

  const carriedA = await peerA.evaluate(worldPos, padId);
  ok(carriedA !== null && dist(carriedA, restPos) > 1.0,
    `PeerA carried it ${dist(carriedA, restPos).toFixed(2)} m from where it started ${fmt(carriedA)}`);

  // Compare SIMULTANEOUS reads, not a snapshot: DesktopControls keeps driving the
  // desktop controller from the camera every frame, so the prop in that hand is
  // still moving. Polling for a fixed target would race the hand rather than test
  // the sync. A 15 cm tolerance covers the ~20 Hz drag cadence plus a frame.
  let carriedB = null, carriedAtSameMoment = null;
  const bTracked = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const [a, b] = await Promise.all([
        peerA.evaluate(worldPos, padId).catch(() => null),
        peerB.evaluate(peerPos, padId).catch(() => null),
      ]);
      carriedAtSameMoment = a; carriedB = b;
      if (a && b && dist(a, b) < 0.15 && dist(b, restPos) > 1.0) return true;
      await sleep(150);
    }
    return false;
  })();
  ok(bTracked, `mid-carry PeerB has it where PeerA is carrying it ${fmt(carriedB)} vs ${fmt(carriedAtSameMoment)}`);
  ok(carriedB !== null && carriedB[1] > 0.5,
    `and it is up in the room on PeerB, not on the floor (y=${carriedB?.[1]?.toFixed(3)})`);
  // The bug's own signature: a controller-local vector published as a room pose
  // put the prop within a few centimetres of the world origin, every packet.
  ok(carriedB !== null && Math.hypot(carriedB[0], carriedB[1], carriedB[2]) > 1.0,
    `and it is not sitting at the world origin (${Math.hypot(...(carriedB || [0, 0, 0])).toFixed(2)} m away)`);

  // Let go. The release broadcast is the authoritative resting pose, and it must
  // agree with what the holder sees — this is the bug as reported.
  await peerA.evaluate(() => {
    const ctrl = window.__scene.desktopController;
    window.__grab._release(ctrl);
  });
  await sleep(500);
  const restedA = await peerA.evaluate(worldPos, padId);
  const bRested = await waitFor(peerB, peerPosNear, 8000, padId, restedA, 0.02);
  const restedB = await peerB.evaluate(peerPos, padId);
  ok(bRested, `on release PeerB has it where PeerA let go ${fmt(restedB)} vs ${fmt(restedA)}`);
  ok(restedB !== null && restedB[1] > 0.3,
    `the released gamepad did not fall through PeerB's floor (y=${restedB?.[1]?.toFixed(3)})`);
  ok(restedA !== null && restedA[1] > 0.3,
    `and PeerA still has it in the air too (y=${restedA?.[1]?.toFixed(3)}) — both peers agree`);

  // =========================================================================
  // Section A2: the host's baseline must not reach into a client's hand.
  // The baseline republishes every prop the host has placed — including one a
  // CLIENT is dragging, whose pose the host learns from the drag wire. That
  // payload is a room pose, so applying it to the object the client has
  // parented to its own controller would jump the prop by however far that
  // client is from the origin, and the next drag packet would publish the jump.
  // The local hand owns what it holds until it lets go.
  // =========================================================================
  console.log('\n--- Section A2: a client carrying a prop while the host baselines');
  ok(await peerA.evaluate(() => window.__net.isHost()), 'PeerA is the host of this room');

  ok(await peerB.evaluate(grabWithHand, padId), 'PeerB (a client) grabbed the gamepad');
  await peerB.evaluate(walk, -2.6, -1.9);
  // Two full baseline cycles (the host publishes every 2 s).
  await sleep(5000);

  const [padOnB, handOnB] = await Promise.all([
    peerB.evaluate(worldPos, padId),
    peerB.evaluate(handPos),
  ]);
  ok(padOnB !== null && dist(padOnB, handOnB) < 0.3,
    `after two host baselines the gamepad is still in PeerB's hand (${dist(padOnB, handOnB).toFixed(3)} m from it)`);

  const aTracksB = await waitFor(peerA, peerPosNear, 6000, padId, padOnB, 0.15);
  ok(aTracksB, `and the host still sees it where PeerB is carrying it ${fmt(await peerA.evaluate(peerPos, padId))}`);

  await peerB.evaluate(() => window.__grab._release(window.__scene.desktopController));
  await sleep(500);
  const bLetGo = await peerB.evaluate(worldPos, padId);
  ok(await waitFor(peerA, peerPosNear, 8000, padId, bLetGo, 0.02),
    `a client's release lands on the host too ${fmt(bLetGo)}`);

  // =========================================================================
  // Section B: a peer that JOINS sees the host's actual layout.
  // =========================================================================
  console.log('\n--- Section B: the layout a joining peer builds');
  const roomB = `${ROOM}-join-${restedA.map((n) => Math.round(n * 100)).join('')}`;
  const host = await openPeer('Host', roomB);
  ok(await waitFor(host, () => window.__net.isHost()), 'the first peer in the room is the host');

  // Pick a static prop that is not the gamepad (whose release path snaps to a
  // port) and not a TV (whose group the rack re-places).
  const target = await host.evaluate(() => {
    const p = window.__props.list().find((x) => x.static && !['gamepad', 'tv', 'lightgun', 'mouse'].includes(x.type));
    return p ? { propId: p.propId, type: p.type, pos: p.pos } : null;
  });
  ok(target !== null, `the host room has a movable static prop (${target?.type} ${target?.propId})`);

  // Move it the way the host would have before anyone joined: the object moves,
  // and nothing broadcasts. This is the case the room descriptor cannot express.
  const MOVED = [target.pos[0] + 1.25, target.pos[1] + 0.6, target.pos[2] - 0.9];
  ok(await host.evaluate(moveSilently, target.propId, MOVED), 'the host moved it with no broadcast');
  const stateRightAfter = await host.evaluate((id) => window.__net.objectState(`prop:${id}`), target.propId);
  ok(stateRightAfter === undefined || stateRightAfter === null,
    'the move itself broadcast nothing — room state is still silent about it');

  // The host's periodic baseline is what has to close the gap.
  const published = await waitFor(host, (id) => {
    const s = window.__net.objectState(`prop:${id}`);
    return !!s && Array.isArray(s.pos);
  }, 12000, target.propId);
  const baseline = await host.evaluate((id) => window.__net.objectState(`prop:${id}`), target.propId);
  ok(published, `the host baseline published prop:${target.propId} on its own ${fmt(baseline?.pos)}`);
  ok(baseline !== null && baseline !== undefined && dist(baseline.pos, MOVED) < 0.005,
    'and it describes where the prop actually is, not where it was authored');

  // Now someone joins.
  const joiner = await openPeer('Joiner', roomB);
  ok(await waitFor(joiner, () => window.__net.peerCount() >= 1), 'the joiner is in the room');

  const joinerConverged = await waitFor(joiner, peerPosNear, 12000, target.propId, MOVED, 0.005);
  const joinerPos = await joiner.evaluate(peerPos, target.propId);
  ok(joinerConverged, `the joiner built the room as it IS ${fmt(joinerPos)} vs host ${fmt(MOVED)}`);
  ok(joinerPos !== null && dist(joinerPos, target.pos) > 1.0,
    `not as it was authored (${dist(joinerPos || [0, 0, 0], target.pos).toFixed(2)} m from the room-file position ${fmt(target.pos)})`);

  // And the post-join path still works — it always did, and must keep doing so.
  const AGAIN = [MOVED[0] - 0.7, MOVED[1], MOVED[2] + 0.4];
  await host.evaluate((id, pos) => {
    let o = null;
    window.__scene.scene.traverse((x) => { if (!o && x.userData?.roomProp?.id === id) o = x; });
    o.position.set(pos[0], pos[1], pos[2]);
    o.updateMatrixWorld(true);
    window.__props.broadcastMove(id);
  }, target.propId, AGAIN);
  ok(await waitFor(joiner, peerPosNear, 8000, target.propId, AGAIN, 0.005),
    'a move made after the join still syncs');

} catch (e) {
  failed++;
  console.error('  FAIL:', e.message, e.stack?.split('\n')[1] || '');
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
