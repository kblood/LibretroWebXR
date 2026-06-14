// Headless shared-gamepad smoke: proves that gamepads are exclusive network-synced
// shared objects — any peer can grab any free gamepad, but a remotely-held gamepad
// is locked from local grab, shows a ghost in the holder's hand, and the input
// paths for distinct gamepads reach distinct players on the host.
//
// Section 1 (original): Two peers join the same room; host claims `tv` state.
//   Peer A grabs gamepad gp-1 → B sees gp-1 as remotely-held (cannot grab it).
//   Simulate A's gp-1 input → host receives player-1 input.
//   Release / disconnect frees the gamepad for others.
//
// Section 2 (GAP 1 — existence sync): Host spawns a NEW shared gamepad via
//   spawnGamepad(). ClientA (current peer) sees it appear in gamepads() with the
//   SAME id and SAME player number. A LATE-JOINING peer C also receives it via
//   the server's state snapshot. ClientA can grab the spawned gamepad.
//   When Host disconnects, the spawned gamepad is removed from all peers.
//
// Section 3 (GAP 2 — hide real gamepad while remotely held): When a peer holds
//   a gamepad, the real local gamepad mesh is hidden (visible === false) on other
//   peers (ghost in the holder's hand represents it); shown again on release.
//
// Prereqs (start first): a room server + the vite dev server.
//   $env:PORT=8799; node server/room-server.mjs        # terminal 1
//   npm run dev                                         # terminal 2
//   node scripts/smoke-gamepad-share.mjs --ws=ws://localhost:8799/   # this
//
// Flags: --app=<url> --ws=<url> --room=<id> --headed

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || true] : [a, true];
}));
const APP = args.app || 'http://localhost:5173/';
const WS = args.ws || 'ws://localhost:8799/';
const ROOM = args.room || 'gpshare-test';
const urlFor = (nick) => `${APP}${APP.includes('?') ? '&' : '?'}session=${ROOM}&server=${encodeURIComponent(WS)}&nick=${nick}`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!CHROME) { console.error('No Chrome/Edge found'); process.exit(2); }

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; } else { failed++; console.error(`  FAIL: ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LAUNCH_ARGS = ['--no-sandbox', '--enable-features=SharedArrayBuffer'];

const browsers = [];
async function openPeer(nick) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: !args.headed, args: LAUNCH_ARGS });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      console.log(`  [${nick}]`, m.text());
    }
  });
  await page.goto(urlFor(nick), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__net && window.__net.connected(), { timeout: 15000 });
  // Wait for the rack debug hooks (set inside buildCartridgeWorld after the async world-build).
  await page.waitForFunction(() => !!window.__rack && !!window.__ghostGp, { timeout: 15000 });
  return page;
}

async function waitFor(page, fn, ms = 8000, ...evalArgs) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await page.evaluate(fn, ...evalArgs)) return true;
    await sleep(150);
  }
  return false;
}

try {
  const host = await openPeer('Host');
  const clientA = await openPeer('ClientA');
  ok(true, 'both peers connected');
  ok(await waitFor(host, () => window.__net.peerCount() >= 1), 'Host sees ClientA');
  ok(await waitFor(clientA, () => window.__net.peerCount() >= 1), 'ClientA sees Host');

  // Host claims the tv state (becomes authoritative game host).
  await host.evaluate(() => {
    window.__net.setObjectState('tv', { file: 'roms/test.nes', core: 'nestopia', system: 'nes', title: 'Test' });
  });
  ok(await waitFor(host, () => window.__net.isHost()), 'Host is now the authoritative tv-state host');
  ok(await waitFor(clientA, () => window.__net.hostId() !== null), 'ClientA resolved the host id');

  // --- gamepad listing: verify gamepads() returns the default gamepad ---
  const gamepads = await host.evaluate(() => window.__rack.gamepads());
  ok(gamepads.length >= 1, `host.gamepads() returns ≥1 gamepad (got ${gamepads.length})`);
  const gp1 = gamepads.find((g) => g.cableId === 'gp-1');
  ok(!!gp1, 'gamepad gp-1 exists in host\'s list');
  ok(gp1?.heldBy === null, 'gp-1 starts free (heldBy null)');

  // --- ClientA grabs gp-1 via the debug hook ---
  const grabbed = await clientA.evaluate(() => window.__rack.grabGamepad('gp-1'));
  ok(grabbed, 'ClientA grabbed gp-1 (grabGamepad returned true)');

  // Host should now see gp-1 as remotely held by ClientA.
  const aId = await clientA.evaluate(() => window.__net.selfId());
  ok(await waitFor(host, (aId) => window.__rack.gamepads().find(g => g.cableId === 'gp-1')?.heldBy === aId, 8000, aId),
    'Host sees gp-1 as held by ClientA');

  // Host cannot grab gp-1 while ClientA holds it.
  const hostGrabBlocked = await host.evaluate(() => {
    const isLocked = window.__ghostGp.isRemotelyHeld('gp-1');
    return isLocked; // true means grab would be blocked
  });
  ok(hostGrabBlocked, 'Host sees gp-1 as remotely-held (grab lock in place)');

  // Host ghost-gamepad manager should have a ghost for gp-1.
  ok(await waitFor(host, () => window.__ghostGp.has('gp-1')),
    'Host shows a ghost for the remotely-held gp-1');

  // --- Player routing: forward game inputs with correct player numbers ---
  // ClientA's gp-1 is plugged into port 0 → player 1.
  // Simulate ClientA forwarding player-1 input to the host (which owns tv state).
  // forwardGameInput already encodes the player number; this proves the path works.
  await clientA.evaluate(() => {
    window.__net.forwardGameInput({ player: 1, btn: 'A', down: true });
    window.__net.forwardGameInput({ player: 1, btn: 'Up', down: true });
    window.__net.forwardGameInput({ player: 1, btn: 'A', down: false });
  });
  ok(await waitFor(host, () => window.__net.recvInputs().some(e => e.player === 1 && e.btn === 'A' && e.down), 8000),
    'Host received player-1 A press from ClientA (correct player routing)');
  ok(await waitFor(host, () => window.__net.recvInputs().some(e => e.player === 1 && e.btn === 'Up' && e.down), 8000),
    'Host received player-1 Up press from ClientA');

  // Host self-forward is a no-op (host injects locally, doesn't forward to itself).
  ok((await host.evaluate(() => window.__net.forwardGameInput({ player: 1, btn: 'B', down: true }))) === false,
    'Host self-forward is a no-op (host drives core locally)');

  // --- Release gp-1: ClientA releases → Host can grab again ---
  await clientA.evaluate(() => window.__rack.releaseGamepad('gp-1'));
  ok(await waitFor(host, () => window.__rack.gamepads().find(g => g.cableId === 'gp-1')?.heldBy === null, 8000),
    'gp-1 is free again after ClientA releases it');
  ok(await waitFor(host, () => !window.__ghostGp.has('gp-1'), 8000),
    'Host ghost for gp-1 removed after release');

  // Host can now grab gp-1 (lock is cleared).
  ok(!(await host.evaluate(() => window.__ghostGp.isRemotelyHeld('gp-1'))),
    'Host lock on gp-1 cleared after ClientA release');

  // --- Disconnect clears the hold ---
  // Re-grab gp-1 as ClientA, then disconnect → host should see gp-1 freed.
  await clientA.evaluate(() => window.__rack.grabGamepad('gp-1'));
  ok(await waitFor(host, (aId) => window.__rack.gamepads().find(g => g.cableId === 'gp-1')?.heldBy === aId, 8000, aId),
    'gp-1 re-locked by ClientA (re-hold)');

  // Disconnect ClientA.
  await clientA.browser().close();
  browsers.splice(browsers.indexOf(clientA.browser()), 1);

  ok(await waitFor(host, () => window.__rack.gamepads().find(g => g.cableId === 'gp-1')?.heldBy === null, 12000),
    'gp-1 freed automatically when ClientA disconnects (server cleared hold)');
  ok(await waitFor(host, () => !window.__ghostGp.has('gp-1'), 12000),
    'Host ghost removed when disconnected peer\'s hold is cleared');

  // =========================================================================
  // GAP 1: Gamepad existence sync — spawning on one peer propagates to all.
  // Open a fresh clientB for this section (clientA has disconnected above).
  // =========================================================================
  const clientB = await openPeer('ClientB');
  ok(await waitFor(host, () => window.__net.peerCount() >= 1), 'Host sees ClientB');
  ok(await waitFor(clientB, () => window.__net.peerCount() >= 1), 'ClientB sees Host');

  // Host spawns a new shared gamepad via the debug hook.
  const spawnedId = await host.evaluate(() => window.__rack.spawnGamepad());
  ok(typeof spawnedId === 'string' && spawnedId.startsWith('gp-'), `Host spawned gamepad: ${spawnedId}`);

  // ClientB should see the spawned gamepad appear (state arrives via socket relay).
  ok(await waitFor(clientB, (id) => {
    const gps = window.__rack.gamepads();
    return gps.some(g => g.cableId === id);
  }, 10000, spawnedId), `ClientB sees spawned gamepad ${spawnedId}`);

  // Both peers must agree on the player number (port is broadcast).
  const hostGpInfo = await host.evaluate((id) => {
    const gp = window.__rack.gamepads().find(g => g.cableId === id);
    return gp ? { player: gp.player, port: gp.port } : null;
  }, spawnedId);
  const clientBGpInfo = await clientB.evaluate((id) => {
    const gp = window.__rack.gamepads().find(g => g.cableId === id);
    return gp ? { player: gp.player, port: gp.port } : null;
  }, spawnedId);
  ok(hostGpInfo !== null && clientBGpInfo !== null, 'Both peers have the spawned gamepad');
  ok(hostGpInfo?.player === clientBGpInfo?.player,
    `Both peers agree on player: Host=${hostGpInfo?.player} ClientB=${clientBGpInfo?.player}`);

  // ClientB can grab the spawned gamepad (it sees it and it's not held).
  const clientBGrabbed = await clientB.evaluate((id) => window.__rack.grabGamepad(id), spawnedId);
  ok(clientBGrabbed, 'ClientB can grab the spawned gamepad');

  // Host sees it held by ClientB.
  const bId = await clientB.evaluate(() => window.__net.selfId());
  ok(await waitFor(host, (args) => {
    const gp = window.__rack.gamepads().find(g => g.cableId === args[0]);
    return gp && gp.heldBy === args[1];
  }, 8000, [spawnedId, bId]), 'Host sees spawned gamepad held by ClientB');

  // Release it.
  await clientB.evaluate((id) => window.__rack.releaseGamepad(id), spawnedId);
  ok(await waitFor(host, (id) => {
    const gp = window.__rack.gamepads().find(g => g.cableId === id);
    return gp && gp.heldBy === null;
  }, 8000, spawnedId), 'Spawned gamepad freed after ClientB releases it');

  // LATE JOINER: a new peer joining after spawn sees the gamepad via server snapshot.
  const clientC = await openPeer('ClientC');
  ok(await waitFor(clientC, (id) => {
    const gps = window.__rack.gamepads();
    return gps.some(g => g.cableId === id);
  }, 10000, spawnedId), `Late-joining ClientC also sees spawned gamepad ${spawnedId} (server snapshot)`);

  const clientCGpInfo = await clientC.evaluate((id) => {
    const gp = window.__rack.gamepads().find(g => g.cableId === id);
    return gp ? { player: gp.player, port: gp.port } : null;
  }, spawnedId);
  ok(clientCGpInfo?.player === hostGpInfo?.player,
    `ClientC agrees on player: ${clientCGpInfo?.player} === ${hostGpInfo?.player}`);

  // =========================================================================
  // GAP 2: Hide real local gamepad on other peers while remotely held.
  // When Host grabs a gamepad, its real local Object3D is hidden on ClientB/C
  // (visible=false), and shown again after release. The ghost represents it.
  // =========================================================================
  // Host grabs gp-1 (the default gamepad that all peers always have).
  const hostGrabGp1 = await host.evaluate(() => window.__rack.grabGamepad('gp-1'));
  ok(hostGrabGp1, 'Host grabbed gp-1 (GAP 2 setup)');

  // Wait for ClientB to see gp-1 remotely held.
  const hId2 = await host.evaluate(() => window.__net.selfId());
  ok(await waitFor(clientB, (hId) => {
    const gp = window.__rack.gamepads().find(g => g.cableId === 'gp-1');
    return gp && gp.heldBy === hId;
  }, 8000, hId2), 'ClientB sees gp-1 held by Host (GAP 2)');

  // GAP 2 CORE: the real local gamepad object MUST be hidden on ClientB.
  ok(await waitFor(clientB, () => {
    return window.__ghostGp.isHidden('gp-1');
  }, 5000), 'ClientB: real gp-1 object hidden while Host holds it (GAP 2)');

  // The ghost must exist on ClientB.
  ok(await waitFor(clientB, () => window.__ghostGp.has('gp-1'), 5000),
    'ClientB: ghost for gp-1 exists while Host holds it');

  // Same check on ClientC.
  ok(await waitFor(clientC, () => {
    return window.__ghostGp.isHidden('gp-1');
  }, 5000), 'ClientC: real gp-1 object hidden while Host holds it (GAP 2)');

  // Host releases gp-1 → real gamepad becomes visible again on ClientB and C.
  await host.evaluate(() => window.__rack.releaseGamepad('gp-1'));
  ok(await waitFor(clientB, () => !window.__ghostGp.isHidden('gp-1'), 5000),
    'ClientB: real gp-1 visible again after Host releases it (GAP 2)');
  ok(await waitFor(clientC, () => !window.__ghostGp.isHidden('gp-1'), 5000),
    'ClientC: real gp-1 visible again after Host releases it (GAP 2)');
  ok(await waitFor(clientB, () => !window.__ghostGp.has('gp-1'), 5000),
    'ClientB: ghost for gp-1 removed after release');

  // =========================================================================
  // GAP 1 cleanup: When Host disconnects, the spawned gamepad disappears.
  // =========================================================================
  await host.browser().close();
  browsers.splice(browsers.indexOf(host.browser()), 1);

  ok(await waitFor(clientB, (id) => {
    const gps = window.__rack.gamepads();
    return !gps.some(g => g.cableId === id);
  }, 12000, spawnedId), `ClientB: spawned gamepad ${spawnedId} removed when Host disconnects (GAP 1 cleanup)`);
  ok(await waitFor(clientC, (id) => {
    const gps = window.__rack.gamepads();
    return !gps.some(g => g.cableId === id);
  }, 12000, spawnedId), `ClientC: spawned gamepad ${spawnedId} removed when Host disconnects (GAP 1 cleanup)`);
} catch (e) {
  failed++; console.error('  FAIL:', e.message);
}

for (const br of browsers) { try { await br.close(); } catch { /* ok */ } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
