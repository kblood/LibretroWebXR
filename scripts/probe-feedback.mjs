// Throwaway: end-to-end headless verification of the rack-feedback fixes
// (items 1-7) against the live build. Exercises the REAL THREE/main.js wiring
// via the window.__rack / __cable / __grab / __editor hooks.
//   node scripts/probe-feedback.mjs [url]
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const URL = process.argv[2] || 'https://dionysus.dk/webxr/libretrowebxr2/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await p.goto(URL, { waitUntil: 'load' });
await p.waitForFunction(() => window.__rack && window.__cable && Array.isArray(window.__games) && window.__games.length, { timeout: 45000 });

const out = await p.evaluate(async () => {
  const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
  const R = {};

  // Boot a SNES game on the primary console (item 1 path must still work).
  const snes = window.__games.find((g) => g.system === 'snes') || window.__games[0];
  await window.__loadCartridge(snes);
  await sleep(1500);
  R.item1_boot = { game: snes.title, live: window.__rackMgr.runtimes().map((r) => ({ id: r.id, core: r.coreName, live: r.isLive() })) };

  // Item 7 — walls toggle.
  const w0 = window.__rack.walls();
  const w1 = window.__rack.walls(false);
  const w2 = window.__rack.walls();
  window.__rack.walls(true);
  R.item7_walls = { initial: w0, afterHide: w2, ok: w0 === true && w1 === false && w2 === false };

  // Item 2/3 — default gamepad seat + console-aware patch graph.
  R.item23_defaultSeat = window.__rack.seats();          // [{cableId, seat:{consoleId,port}}]
  const def = R.item23_defaultSeat[0];
  R.item23_playerOf = window.__cable.playerOf(def.cableId); // {consoleId, player}

  // Spawn a second console (item 4 — must not throw; lands in-room).
  const before = window.__rack.live().length;
  await window.__rack.spawn('genesis').catch((e) => { R.spawnErr = String(e); });
  await sleep(1800);
  R.item4_spawn = { liveBefore: before, liveAfter: window.__rack.live().length, video: window.__rack.video() };

  // Add a gamepad → seats into console0's next free port, gets a controller plug.
  const seatsBefore = new Set(window.__rack.seats().map((s) => s.cableId));
  window.__add.gamepad();
  await sleep(300);
  const seatsNow = window.__rack.seats();
  const added = seatsNow.find((s) => !seatsBefore.has(s.cableId));
  R.item23_addGamepad = { newCableId: added?.cableId || null, seat: added?.seat || null, allSeats: seatsNow };

  // Repatch that new gamepad's CONTROLLER plug onto console1's port 0.
  if (added) {
    const after = window.__rack.plugCtrl(added.cableId, 'console1', 0);
    const moved = after.find((s) => s.cableId === added.cableId);
    R.item23_repatch = { seats: after, movedSeat: moved?.seat || null, playerOf: window.__cable.playerOf(added.cableId) };
    // Pull it out into mid-air → unplugged → drives nothing.
    const afterPull = window.__rack.plugCtrl(added.cableId, null);
    R.item23_unplug = { seat: afterPull.find((s) => s.cableId === added.cableId)?.seat ?? null, playerOf: window.__cable.playerOf(added.cableId) };
  }

  // Item 6 — TVs + consoles are editable grabbables.
  const grabbables = window.__grab.grabbables;
  R.item6_editable = {
    tvs: grabbables.filter((o) => o.userData?.kind === 'tv').map((o) => ({ editable: !!o.userData.editable })),
    consoles: grabbables.filter((o) => o.userData?.kind === 'console').map((o) => ({ editable: !!o.userData.editable })),
  };

  // Item 5 — spawn a poster; it must land at/in front of a wall, inside the room.
  // Room is 6×8 → |x|≤3, |z|≤4. A wall-snapped poster sits within ~0.1 of a wall.
  window.__add.poster();
  await sleep(300);
  const posters = (window.__editor.placed || []).filter((e) => e.prop.type === 'poster');
  const last = posters[posters.length - 1];
  if (last) {
    const pos = last.object.position;
    const nearWall = Math.abs(Math.abs(pos.x) - 3) < 0.2 || Math.abs(Math.abs(pos.z) - 4) < 0.2;
    R.item5_poster = {
      pos: { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2) },
      insideRoom: Math.abs(pos.x) <= 3.01 && Math.abs(pos.z) <= 4.01,
      atWall: nearWall,
    };
  }

  return R;
});
console.log(JSON.stringify(out, null, 2));
await b.close();
