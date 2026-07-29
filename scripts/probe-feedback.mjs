// End-to-end headless verification of the rack-feedback fixes (items 1-7)
// against a running build. Exercises the REAL THREE/main.js wiring via the
// window.__rack / __cable / __grab / __editor hooks.
//   node scripts/probe-feedback.mjs [url]      (default: local dev server)
//
// ── AUDIT NOTE (2026-07-29) ────────────────────────────────────────────────
// This script used to print a JSON blob containing self-reported `ok`,
// `atWall` and `editable` booleans and then ALWAYS exit 0. It was cited as
// proof that items 1-7 worked. A negative control (walls toggle no-op'd,
// `SURFACE_KIND.poster` flipped to 'floor', the `editable` flag dropped in
// registerMovableProp) produced `item7_walls.ok:false`, `item5_poster.atWall:
// false` and `editable:false` on 3 of 4 rack props — and STILL EXITED 0.
// It proved nothing.
//
// Every check below now gates the exit code, and the ones that could pass for
// an unrelated reason are PAIRED: two arms read out of the same run, off the
// same state, differing only in the single variable under test —
//   • walls    → hide arm vs show arm on the same getter (a stuck constant
//                fails one of the two, whichever way it is stuck)
//   • boot     → same getter before vs after the cartridge load
//   • editable → rack props (tv/console, must be editable) vs play-mode
//                grabbables (cartridge/plug, must NOT be) in the same array
//   • poster   → poster arm vs table arm through the SAME spawn path, the
//                only difference being the prop's surface kind
//   • repatch  → the SAME cable at console0 → console1 → mid-air
// The default URL is the local dev server, not production: a probe that claims
// to verify the working tree must be pointed at the working tree.
//
// VALIDATED RED. Each check below was watched failing against a scratch
// checkout with the capability deliberately broken:
//   walls / editable / poster  → break #1 (walls toggle no-op'd,
//                                SURFACE_KIND.poster → 'floor', `editable`
//                                dropped): 7/7 → 4/7
//   repatch                    → break #2 (handleControllerPlugReleased only
//                                collects console0's jacks): 7/7 → 6/7
//   boot, spawn                → break #3 (loadCartridge returns early):
//                                7/7 → 4/7
// NOT yet validated red: `item23 default seat`. It has a non-vacuity guard
// (a seat and a playerOf must both exist and agree) but no negative control
// has been run against it — treat it as the weakest line here.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const URL = process.argv[2] || 'http://localhost:5173/';
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

  // Item 1 — boot a SNES game on the primary console. PAIRED: the same
  // live() getter is read immediately before and immediately after the load,
  // so a getter that reports "live" unconditionally fails the before arm.
  const snes = window.__games.find((g) => g.system === 'snes') || window.__games[0];
  const liveBeforeBoot = window.__rack.live();
  await window.__loadCartridge(snes);
  await sleep(1500);
  R.item1_boot = {
    game: snes.title,
    expectedCore: snes.core || null,
    beforeLoad: liveBeforeBoot,
    live: window.__rackMgr.runtimes().map((r) => ({ id: r.id, core: r.coreName, live: r.isLive() })),
  };

  // Item 7 — walls toggle. PAIRED: hide arm AND show arm, each read back off
  // the same getter. A no-op that returns a constant fails one of the two
  // whichever constant it is stuck on; an absolute "walls are visible" read
  // would not.
  const wInitial = window.__rack.walls();
  window.__rack.walls(false);
  const wHidden = window.__rack.walls();
  window.__rack.walls(true);
  const wShown = window.__rack.walls();
  R.item7_walls = { initial: wInitial, afterHide: wHidden, afterShow: wShown };

  // Item 2/3 — default gamepad seat + console-aware patch graph.
  R.item23_defaultSeat = window.__rack.seats();          // [{cableId, seat:{consoleId,port}}]
  const def = R.item23_defaultSeat.find((s) => s.seat) || R.item23_defaultSeat[0];
  R.item23_playerOf = def ? window.__cable.playerOf(def.cableId) : null; // {consoleId, player}

  // Spawn a second console (item 4 — must not throw; lands in-room, gets its
  // own TV). Deliberately pick a system whose core DIFFERS from the one
  // console0 just booted, so "console1 runs a different core" is a meaningful
  // arm rather than an accident of shelf ordering. (spawnConsole falls back to
  // games[0] when the requested system isn't on the shelf, so asking for a
  // system that isn't there would silently give a same-core spawn.)
  const other = window.__games.find((g) => g.core && g.core !== snes.core) || null;
  const before = window.__rack.live().length;
  R.item4_request = other ? { system: other.system, core: other.core } : null;
  await window.__rack.spawn(other?.system || 'genesis').catch((e) => { R.spawnErr = String(e); });
  await sleep(1800);
  R.item4_spawn = {
    liveBefore: before,
    liveAfter: window.__rack.live().length,
    cores: window.__rack.live().map((r) => ({ id: r.id, core: r.core })),
    video: window.__rack.video(),
  };

  // Add a gamepad → seats into console0's next free port, gets a controller plug.
  const seatsBefore = new Set(window.__rack.seats().map((s) => s.cableId));
  window.__add.gamepad();
  await sleep(300);
  const seatsNow = window.__rack.seats();
  const added = seatsNow.find((s) => !seatsBefore.has(s.cableId));
  R.item23_addGamepad = { newCableId: added?.cableId || null, seat: added?.seat || null, allSeats: seatsNow };

  // Repatch that new gamepad's CONTROLLER plug onto console1's port 0.
  // PAIRED: the SAME cable observed at three patch targets, so a plugCtrl that
  // silently ignores its console argument cannot pass.
  if (added) {
    const after = window.__rack.plugCtrl(added.cableId, 'console1', 0);
    const moved = after.find((s) => s.cableId === added.cableId);
    R.item23_repatch = { seats: after, movedSeat: moved?.seat || null, playerOf: window.__cable.playerOf(added.cableId) };
    // Pull it out into mid-air → unplugged → drives nothing.
    const afterPull = window.__rack.plugCtrl(added.cableId, null);
    R.item23_unplug = { seat: afterPull.find((s) => s.cableId === added.cableId)?.seat ?? null, playerOf: window.__cable.playerOf(added.cableId) };
  }

  // Item 6 — TVs + consoles are editable grabbables. PAIRED against the
  // play-mode grabbables in the SAME array: cartridges and plugs are grabbed
  // during play and must NOT carry `editable`. Without that second arm,
  // "everything is editable" and "the array is empty" both read as a pass.
  const grabbables = window.__grab.grabbables;
  const byKind = (k) => grabbables.filter((o) => o.userData?.kind === k);
  const edCount = (k) => byKind(k).filter((o) => !!o.userData.editable).length;
  R.item6_editable = {
    tvs: { n: byKind('tv').length, editable: edCount('tv') },
    consoles: { n: byKind('console').length, editable: edCount('console') },
    // control arm — these are play-mode grabbables, editable must stay 0
    cartridges: { n: byKind('cartridge').length, editable: edCount('cartridge') },
    plugs: { n: byKind('plug').length, editable: edCount('plug') },
  };

  // Item 5 — a poster must land ON a wall. PAIRED with a table spawned from
  // the same camera pose through the same addProp path: the only difference
  // is the prop's surface kind, so a placement that degenerates into
  // "clamp inside the room" (or into "snap everything to a wall") fails one
  // of the two arms. An absolute |x|≈3 test on the poster alone does not.
  const bounds = window.__scene?.getRoomBounds?.() || { minX: -3, maxX: 3, minZ: -4, maxZ: 4 };
  const wallDist = (pos) => Math.min(
    Math.abs(pos.x - bounds.minX), Math.abs(pos.x - bounds.maxX),
    Math.abs(pos.z - bounds.minZ), Math.abs(pos.z - bounds.maxZ),
  );
  const lastOfType = (t) => {
    const list = (window.__editor.placed || []).filter((e) => e.prop.type === t);
    return list[list.length - 1] || null;
  };
  window.__add.poster();
  await sleep(300);
  window.__add.table();
  await sleep(300);
  const armOf = (t) => {
    const rec = lastOfType(t);
    if (!rec) return null;
    const q = rec.object.position;
    const pos = { x: +q.x.toFixed(2), y: +q.y.toFixed(2), z: +q.z.toFixed(2) };
    return {
      pos,
      wallDist: +wallDist(q).toFixed(3),
      insideRoom: q.x >= bounds.minX - 0.01 && q.x <= bounds.maxX + 0.01
               && q.z >= bounds.minZ - 0.01 && q.z <= bounds.maxZ + 0.01,
    };
  };
  R.item5_poster = { poster: armOf('poster'), table: armOf('table') };

  return R;
});

// ── Gating assertions ──────────────────────────────────────────────────────
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

// Item 1 — boot. PAIRED before/after on the SAME console: console0 carries no
// core before the load and the cartridge's own core after it. Asserting only
// "a core is loaded" would pass on a stale/pre-existing runtime.
{
  const b1 = out.item1_boot || {};
  const pre = (b1.beforeLoad || []).find((r) => r.id === 'console0');
  const post = (b1.live || []).find((r) => r.id === 'console0');
  check('item1 boot: console0 core null → the cartridge’s core, and live',
    !!pre && !pre.core && !!post && post.live && !!post.core
      && (!b1.expectedCore || post.core === b1.expectedCore),
    `expected=${b1.expectedCore} before=${JSON.stringify(pre)} after=${JSON.stringify(post)}`);
}

// Item 7 — walls toggle, both directions.
{
  const w = out.item7_walls || {};
  check('item7 walls: hide arm reads false AND show arm reads true',
    w.afterHide === false && w.afterShow === true,
    `initial=${w.initial} afterHide=${w.afterHide} afterShow=${w.afterShow}`);
}

// Items 2/3 — default seat.
{
  const seat = out.item23_defaultSeat?.find((s) => s.seat)?.seat || null;
  const po = out.item23_playerOf;
  check('item23 default seat: a gamepad is seated on console0 and resolves to a player',
    !!seat && seat.consoleId === 'console0' && Number.isInteger(seat.port)
      && !!po && po.consoleId === seat.consoleId && Number.isInteger(po.player),
    `seat=${JSON.stringify(seat)} playerOf=${JSON.stringify(po)}`);
}

// Item 4 — spawn a second console; it lands live and gets its own TV.
{
  const s = out.item4_spawn || {};
  const routed = (s.video || []).filter((v) => v.console);
  const distinct = new Set(routed.map((v) => v.console));
  // Second arm: console1 was asked for a different system than console0, so
  // its core name must differ. Equal core names would mean the spawn reused
  // console0's runtime rather than standing a new one up.
  const c0 = (s.cores || []).find((c) => c.id === 'console0')?.core || null;
  const c1 = (s.cores || []).find((c) => c.id === 'console1')?.core || null;
  const wantC1 = out.item4_request?.core || null;
  check('item4 spawn: live count +1, own TV, console1 on the REQUESTED (different) core',
    !out.spawnErr && s.liveAfter === s.liveBefore + 1 && routed.length >= 2 && distinct.size >= 2
      && !!c0 && !!c1 && c0 !== c1 && (!wantC1 || c1 === wantC1),
    `err=${out.spawnErr || 'none'} live ${s.liveBefore}→${s.liveAfter} requested=${wantC1} cores=${c0}/${c1} video=${JSON.stringify(s.video)}`);
}

// Items 2/3 — same cable across three patch targets.
{
  const a = out.item23_addGamepad || {};
  const rp = out.item23_repatch || {};
  const up = out.item23_unplug || {};
  check('item23 repatch: same cable console0 → console1 → unplugged (drives nothing)',
    !!a.newCableId && a.seat?.consoleId === 'console0'
      && rp.movedSeat?.consoleId === 'console1' && rp.playerOf?.consoleId === 'console1'
      && up.seat === null && up.playerOf === null,
    `added=${JSON.stringify(a.seat)} moved=${JSON.stringify(rp.movedSeat)} unplugged=${JSON.stringify(up.seat)}`);
}

// Item 6 — rack props editable, play-mode grabbables not.
{
  const e = out.item6_editable || {};
  const rackOk = e.tvs?.n >= 2 && e.tvs.editable === e.tvs.n
              && e.consoles?.n >= 2 && e.consoles.editable === e.consoles.n;
  const controlOk = e.cartridges?.n > 0 && e.cartridges.editable === 0
                 && e.plugs?.n > 0 && e.plugs.editable === 0;
  check('item6 editable: every tv/console editable, every cartridge/plug NOT',
    rackOk && controlOk, JSON.stringify(e));
}

// Item 5 — poster on a wall, table not, from the same spawn path.
{
  const q = out.item5_poster || {};
  const po = q.poster; const ta = q.table;
  check('item5 poster: poster arm snaps to a wall, table arm does not (same spawn path)',
    !!po && !!ta && po.insideRoom && ta.insideRoom
      && po.wallDist < 0.15 && ta.wallDist > 0.5 && (ta.wallDist - po.wallDist) > 0.5,
    `poster=${JSON.stringify(po)} table=${JSON.stringify(ta)}`);
}

console.log(JSON.stringify(out, null, 2));
console.log('\n── rack-feedback items 1-7 ───────────────────────────────');
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`);
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
await b.close();
process.exit(passed === checks.length ? 0 : 1);
