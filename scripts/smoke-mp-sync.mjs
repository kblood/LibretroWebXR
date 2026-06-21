// Headless smoke for the multiplayer full-sync epic (Phases 1-4): proves the
// NEW sync paths added this round actually propagate between two real peers
// through the real app + room server — not just unit-level. Complements
// smoke-prop-sync (props) and smoke-object-sync (raw STATE) by covering:
//
//   Section 1 (Phase 1) — host publishes a `room` STATE snapshot; a late-joiner
//     receives it from the server snapshot (host->late-joiner room handoff).
//   Section 2 (Phase 2) — the transient WIRE channel: gp (held-pad buttons) and
//     drag (live prop transform) sent on A are RECEIVED on B (__wireRx tap).
//   Section 3 (Phase 3) — power is host-broadcast over STATE: A powers a console
//     off; B observes the power:console:<id> key AND its local console toggles.
//     reset rides WIRE: A resets; B receives the reset wire.
//   Section 4 (Phase 4) — an added Light Gun / TV prop syncs to a peer (the new
//     addable objects ride the same prop:* STATE as posters).
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8797; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-mp-sync.mjs --app=http://localhost:5177/ --ws=ws://localhost:8797/
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5177/';
const WS  = args.ws  || 'ws://localhost:8797/';
const ROOM = args.room || 'mpsync-test';
const urlFor = (nick) =>
  `${APP}${APP.includes('?') ? '&' : '?'}session=${ROOM}&server=${encodeURIComponent(WS)}&nick=${nick}`;

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
const LAUNCH_ARGS = ['--no-sandbox', '--enable-features=SharedArrayBuffer'];

const browsers = [];
async function openPeer(nick) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(`  [${nick}]`, m.text());
  });
  await page.goto(urlFor(nick), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 15000 });
  await page.waitForFunction(() => !!window.__props && !!window.__rack, { timeout: 20000 });
  return page;
}

async function waitFor(page, fn, ms = 10000, ...evalArgs) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await page.evaluate(fn, ...evalArgs)) return true;
    await sleep(150);
  }
  return false;
}

try {
  const peerA = await openPeer('PeerA');
  const peerB = await openPeer('PeerB');
  ok(true, 'Peer A + Peer B connected, world built');
  ok(await waitFor(peerA, () => window.__net.peerCount() >= 1), 'PeerA sees PeerB');
  ok(await waitFor(peerB, () => window.__net.peerCount() >= 1), 'PeerB sees PeerA');

  // =========================================================================
  // Section 1 (Phase 1): host->late-joiner room snapshot.
  // The first peer to build the world publishes its room under the `room`
  // STATE key. A late joiner must receive it from the server snapshot.
  // =========================================================================
  console.log('\n--- Section 1: host room snapshot (Phase 1)');
  const roomKeyOnA = await waitFor(peerA, () => window.__net.objectState('room') != null, 8000);
  const roomKeyOnB = await waitFor(peerB, () => window.__net.objectState('room') != null, 8000);
  // At least one peer must own the `room` key (the host). Identify the host.
  const aHost = await peerA.evaluate(() => window.__net.isHost());
  const bHost = await peerB.evaluate(() => window.__net.isHost());
  ok(roomKeyOnA || roomKeyOnB, `a 'room' snapshot is published (A=${roomKeyOnA} B=${roomKeyOnB}, hostA=${aHost} hostB=${bHost})`);

  // Late joiner C must converge on the room snapshot from the server snapshot.
  const peerC = await openPeer('PeerC');
  ok(await waitFor(peerC, () => window.__net.peerCount() >= 2), 'PeerC sees >=2 peers');
  ok(await waitFor(peerC, () => window.__net.objectState('room') != null, 10000),
    'late-joining PeerC receives the room snapshot from server STATE');

  // =========================================================================
  // Section 2 (Phase 2): transient WIRE channel gp + drag reach the other peer.
  // =========================================================================
  console.log('\n--- Section 2: transient WIRE channel (Phase 2)');
  // gp: a held-pad button bitmask. Send from A; B's onWire records it.
  await peerA.evaluate(() => window.__net.sendWire('gp', { cableId: 'smoke-pad', a: true, b: false, start: false, select: false, axisX: 0, axisY: 0 }));
  ok(await waitFor(peerB, () => window.__wireRx('gp').some((d) => d?.cableId === 'smoke-pad' && d.a === true), 8000),
    'PeerB receives the gp WIRE (held-pad buttons) from PeerA');

  // drag: a prop's live transform while held. Send from A; B records it.
  await peerA.evaluate(() => window.__net.sendWire('drag', { id: 'smoke-prop', payload: { pos: [1, 2, 3], rot: [0, 0, 0] } }));
  ok(await waitFor(peerB, () => window.__wireRx('drag').some((d) => d?.id === 'smoke-prop'), 8000),
    'PeerB receives the drag WIRE (live prop transform) from PeerA');

  // The transient channel must NOT pollute the persisted snapshot: a late joiner
  // must not see a gp/drag STATE key (WIRE is relay-not-store).
  const dWireLeaked = await peerC.evaluate(() =>
    window.__net.objectEntries().some(([k]) => k === 'gp' || k === 'drag' || k.startsWith('wire')));
  ok(!dWireLeaked, 'WIRE messages are NOT persisted into the STATE snapshot');

  // =========================================================================
  // Section 3 (Phase 3): power over STATE + reset over WIRE.
  // =========================================================================
  console.log('\n--- Section 3: power + reset sync (Phase 3)');
  const consoleId = await peerA.evaluate(() => {
    const live = window.__rack.live();
    return live && live.length ? live[0].id : null;
  });
  ok(typeof consoleId === 'string', `PeerA has a console to power (id: ${consoleId})`);

  if (consoleId) {
    // A powers the console OFF and broadcasts it.
    await peerA.evaluate((id) => window.__rack.powerConsole(id, false), consoleId);
    // B must observe the power STATE key...
    ok(await waitFor(peerB, (id) => {
      const v = window.__net.objectState(`power:console:${id}`);
      return v && v.on === false;
    }, 8000, consoleId), `PeerB sees power:console:${consoleId} = {on:false}`);
    // ...AND its local console must actually toggle off (remote apply).
    ok(await waitFor(peerB, (id) => window.__rack.isOn(id) === false, 8000, consoleId),
      `PeerB's console ${consoleId} actually powered off (remote apply)`);

    // Power back on, then reset over the WIRE channel.
    await peerA.evaluate((id) => window.__rack.powerConsole(id, true), consoleId);
    ok(await waitFor(peerB, (id) => window.__rack.isOn(id) === true, 8000, consoleId),
      `PeerB's console ${consoleId} powered back on`);

    await peerA.evaluate((id) => window.__rack.resetConsole(id), consoleId);
    ok(await waitFor(peerB, (id) => window.__wireRx('reset').some((d) => d?.consoleId === id), 8000, consoleId),
      `PeerB receives the reset WIRE for console ${consoleId}`);
  }

  // =========================================================================
  // Section 4 (Phase 4): addable Light Gun + TV sync as props.
  // These ride the same prop:* STATE channel as posters (smoke-prop-sync
  // proves the channel; here we prove the NEW prop types round-trip).
  // =========================================================================
  console.log('\n--- Section 4: addable Light Gun + TV (Phase 4)');
  // Add a light gun + a TV on A via the real menu actions (__add.*), then confirm
  // B receives both as synced props over the prop:* STATE channel.
  const addRes = await peerA.evaluate(() => {
    // Free the default gun's port (boot seats default pad→port0, default gun→port1)
    // so the newly-added gun has a free port to seat into — otherwise a 2-port
    // console is full and the add correctly reports port -1 (unplugged).
    window.__cable.unplugController('gun-1');
    const gun = window.__add.lightgun();
    const tv = window.__add.tv();
    return { gun: gun?.id || null, gunType: gun?.type || null, tv: tv?.id || null, tvType: tv?.type || null };
  });
  ok(addRes.gunType === 'lightgun', `PeerA added a light gun prop (id: ${addRes.gun})`);
  ok(addRes.tvType === 'tvset', `PeerA added a TV prop (id: ${addRes.tv})`);

  ok(await waitFor(peerB, (id) => window.__props.list().some((p) => p.propId === id && p.type === 'lightgun'), 10000, addRes.gun),
    `PeerB sees the synced light-gun prop ${addRes.gun}`);
  ok(await waitFor(peerB, (id) => window.__props.list().some((p) => p.propId === id && p.type === 'tvset'), 10000, addRes.tv),
    `PeerB sees the synced TV prop ${addRes.tv}`);

  // =========================================================================
  // Section 5 (gun cable): the light gun is now a pluggable peripheral. Its
  // PORT binding rides a dedicated gun:<cableId> STATE channel (the mesh rides
  // prop:*). Prove: A's added gun has a cableId + seated port; the gun: key is
  // published; B converges its OWN patchbay onto the same port (remote-create +
  // _reconcileGunState); a re-plug on A re-routes B; a late joiner sees it.
  // =========================================================================
  console.log('\n--- Section 5: light-gun port binding sync (gun: channel)');
  const gunCableId = await peerA.evaluate((pid) => {
    const p = window.__props.list().find((q) => q.propId === pid);
    return p?.cableId || null;
  }, addRes.gun);
  ok(typeof gunCableId === 'string' && gunCableId.startsWith('gun-'),
    `PeerA's added gun has a peer-scoped cableId (${gunCableId})`);

  if (gunCableId) {
    // A seated the gun in a free port on its own patchbay.
    const aPort = await peerA.evaluate((cid) => window.__cable.portOf(cid)?.port ?? null, gunCableId);
    ok(typeof aPort === 'number' && aPort >= 0, `PeerA seated the gun in port ${aPort}`);

    // The gun: STATE key is published with that port.
    ok(await waitFor(peerA, (cid) => {
      const v = window.__net.objectState(`gun:${cid}`);
      return v && typeof v.port === 'number' && v.port >= 0;
    }, 8000, gunCableId), `gun:${gunCableId} STATE published with the seated port`);

    // B converges its OWN patchbay onto the same port (remote prop create →
    // adopt cableId → _reconcileGunState seats the cord at the named jack).
    ok(await waitFor(peerB, (args) => {
      const seat = window.__cable.portOf(args.cid);
      return seat != null && seat.port === args.port;
    }, 12000, { cid: gunCableId, port: aPort }),
      `PeerB's patchbay seats the gun at port ${aPort} (remote-create + reconcile)`);

    // Re-plug on A: move the binding to a different port, confirm B re-routes.
    const newPort = aPort === 0 ? 1 : 0;
    await peerA.evaluate((args) => window.__net.setObjectState(`gun:${args.cid}`, { port: args.port }), { cid: gunCableId, port: newPort });
    ok(await waitFor(peerB, (args) => window.__cable.portOf(args.cid)?.port === args.port, 8000, { cid: gunCableId, port: newPort }),
      `PeerB re-routes the gun to port ${newPort} on re-plug (gun: apply path)`);

    // Late joiner D converges on the gun's port binding from the server snapshot.
    const peerD = await openPeer('PeerD');
    ok(await waitFor(peerD, (args) => window.__cable.portOf(args.cid)?.port === args.port, 12000, { cid: gunCableId, port: newPort }),
      `late-joining PeerD seats the gun at port ${newPort} from the STATE snapshot`);
  }

} catch (e) {
  failed++;
  console.error('  FAIL:', e.message, e.stack?.split('\n')[1] || '');
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
