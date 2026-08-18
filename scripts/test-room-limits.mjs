// test-room-limits: end-to-end proof that the room relay's admission control
// (CLAUDE_REVIEW §4.4 / CODEX_REVIEW SEC-3) actually rejects an abusive client
// AND that a legitimate 4-player room is untouched by it.
//
//   node scripts/test-room-limits.mjs          (exit 0 = all caps behave)
//
// Every cap is asserted as a PAIR against two real servers spawned side by side:
//
//   TIGHT  (:8892) — the same abusive action, with the cap turned DOWN → refused
//   LOOSE  (:8893) — the same abusive action, with the cap turned UP   → accepted
//
// The LOOSE half is the negative control: it proves each assertion is measuring
// the cap and not some unrelated failure (a typo'd message, a closed socket, a
// server that refuses everything). A test that only ever sees a rejection cannot
// tell "the limit works" from "nothing works" — this repo has a documented
// history of exactly that kind of vacuous "verified N/N".
//
// LOOSE also runs on the SHIPPED DEFAULTS for rate + payload, so the run doubles
// as evidence that a real 4-peer room (POSE at 12 Hz, WIRE at frame rate, voice
// SIGNAL, host-directed INPUT, room-object STATE) stays comfortably inside them.

import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join as pathJoin } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer, connect } from 'node:net';
import { WebSocket } from 'ws';
import {
  encode, decode, makeJoin, makePose, makeState, makeSignal, makeInput, makeWire, MSG,
  isPermanentClose,
} from '../src/net/NetProtocol.js';
import { Hub, HUB_LIMITS, measureValue } from '../server/Hub.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// ROOM_SERVER_ENTRY lets this suite be pointed at a DIFFERENT room-server build —
// e.g. a pre-fix copy checked out of git — to prove the assertions below actually
// fail without the admission control, rather than passing for some unrelated
// reason. (The in-process Hub section near the end always exercises the tree's
// own server/Hub.js, so it stays green in that mode.)
const SERVER = process.env.ROOM_SERVER_ENTRY || pathJoin(ROOT, 'server', 'room-server.mjs');
const TIGHT_PORT = 8892;
const LOOSE_PORT = 8893;

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else { failed++; console.error(`  FAIL ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- server harness --------------------------------------------------------

// Applied to EVERY spawned relay, before that server's own env.
//
// This suite drives dozens of sockets from ONE address — 127.0.0.1 for all of
// them — and section 0b alone opens 64, four times the RELAY-3 per-address
// concurrency cap (16 sockets, 256 upgrades/minute at the shipped defaults —
// both derived from ROOM_MAX_PEERS, and printed verbatim in the boot line
// section 14g asserts on). Left alone those caps would refuse most of the run and
// every measurement above would silently become a measurement of THAT. They are
// raised out of the way here and set back DOWN by section 14, which is the
// section that tests them; anything that overrides them wins, because this
// spreads first.
const BASE_ENV = {
  ROOM_MAX_SOCKETS_PER_IP: '512',
  ROOM_MAX_UPGRADES_PER_IP: '100000',
  // …and the per-address SOFT-REFUSAL budget, for the same reason: every
  // refusal this suite provokes is billed to 127.0.0.1, and past that budget a
  // refusal arrives as a killed upgrade (429) instead of the 1013 + reason the
  // sections above assert on. Section 14e is where it is turned back DOWN and
  // tested; a section that wants the SHIPPED default passes an empty string,
  // which parses as "unset" and restores it (see 14g).
  ROOM_MAX_SOFT_REFUSALS_PER_IP: '100000',
};

function startServer(port, env, { entry = SERVER, args = [] } = {}) {
  const full = { ...process.env, PORT: String(port), ...BASE_ENV, ...env };
  const child = args.length
    ? spawn(process.execPath, args, { cwd: ROOT, env: full })
    : spawn(process.execPath, [entry], { cwd: ROOT, env: full });
  const out = [];
  let exited = null;
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  child.on('exit', (code) => { exited = code ?? -1; });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server :${port} did not report listening\n${out.join('')}`)), 8000);
    const tick = setInterval(() => {
      if (out.join('').includes(`listening on :${port}`)) { clearInterval(tick); clearTimeout(t); resolve(); }
      if (exited != null) { clearInterval(tick); clearTimeout(t); reject(new Error(`server :${port} exited ${exited}\n${out.join('')}`)); }
    }, 40);
  });
  // Wait for a line to APPEAR in the child's output, rather than sampling
  // `log()` the instant `ready` resolves. `ready` fires on "listening on :PORT",
  // which is only the FIRST of four lines the 'listening' handler prints — the
  // limits/per-address/state-budget banners follow in the same tick in the child
  // but arrive here in separate stdout chunks. Sampling raced them, and an
  // assertion on a boot line that is merely LATE is a flake, not a finding.
  const waitLog = (re, ms = 3000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (re.test(out.join('')) || Date.now() - t0 > ms) { clearInterval(tick); resolve(re.test(out.join(''))); }
    }, 25);
  });
  return { child, out, ready, port, waitLog, get exited() { return exited; }, log: () => out.join('') };
}

async function stop(s) {
  if (!s) return;
  if (s.exited == null) {
    await new Promise((r) => {
      s.child.once('exit', () => r());
      s.child.kill();                   // by PID — never by process name
      setTimeout(r, 1500);
    });
  }
  // …and do not return until the port is actually reusable (see waitPortFree).
  if (s.port) await waitPortFree(s.port);
}

/**
 * Wait until nothing is listening on `port` — i.e. until the port can be bound.
 *
 * `stop()` resolves on the child's 'exit', which is NOT the same instant the OS
 * releases its listening socket, and several sections below now re-spawn on the
 * SAME port back to back. Without this the next server loses the bind race, and
 * the failure is silent in the worst possible way: the assertions that follow
 * connect to whatever IS still listening on that port (the previous section's
 * relay, with the previous section's env) and quietly measure the wrong process.
 * That produced impossible readings — a section reporting more refusals than it
 * had sent writes, and RSS read from an already-dead pid.
 */
async function waitPortFree(port, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      // Wildcard, like the relay itself: a probe bound to 127.0.0.1 could succeed
      // while a server still holds 0.0.0.0 on the same port.
      probe.listen(port, () => probe.close(() => resolve(true)));
    });
    if (free || Date.now() > deadline) return free;
    await sleep(60);
  }
}

/**
 * Resident set size of another process, in MiB, or null if it can't be read.
 *
 * There is no cross-platform way to ask Node for a CHILD's RSS, and measuring the
 * child's own `process.memoryUsage()` would mean trusting the process under test
 * to report on itself. So: `tasklist` on Windows, `ps` everywhere else. The digit
 * strip on the Windows path is locale-proofing — the column is "225,432 K" in
 * en-US and "225.432 K" in de-DE.
 */
function rssMiB(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
      const m = /"([\d.,\u00a0 ]+)\s*K"/.exec(out);
      return m ? Math.round((Number(m[1].replace(/\D/g, '')) / 1024) * 10) / 10 : null;
    }
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    const kib = Number(out.trim());
    return Number.isFinite(kib) && kib > 0 ? Math.round((kib / 1024) * 10) / 10 : null;
  } catch { return null; }
}

// --- client harness (same shape as server/smoke.mjs) -----------------------

function client(port, room, name, { sid = null, headers = null, autoPong = true } = {}) {
  const url = `ws://127.0.0.1:${port}/?room=${encodeURIComponent(room)}${sid ? `&sid=${sid}` : ''}`;
  // `autoPong: false` turns this client into a GHOST: the socket stays open at
  // the TCP level and simply stops answering the relay's heartbeat, which is
  // exactly what a Quest that sleeps (or an app killed without a clean close)
  // looks like from the server. `ws` answers pings from inside its receiver, so
  // there is no way to reproduce that from the outside of the client object.
  const opts = {};
  if (headers) opts.headers = headers;
  if (!autoPong) opts.autoPong = false;
  const ws = new WebSocket(url, Object.keys(opts).length ? opts : undefined);
  const msgs = [];
  const waiters = [];
  const c = {
    ws, name, msgs, selfId: null, closeCode: null, closeReason: '', error: null,
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', (e) => reject(e));
    }),
    send: (m) => { try { ws.send(encode(m)); } catch { /* closed */ } },
    sendRaw: (s) => { try { ws.send(s); } catch { /* closed */ } },
    count: (pred) => msgs.filter(pred).length,
    waitFor: (pred, ms = 2000) => new Promise((resolve, reject) => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) { waiters.splice(i, 1); reject(new Error(`${name}: timeout waiting`)); }
      }, ms);
    }),
    // Resolves { code:null } if the socket is STILL OPEN after `ms` — a server
    // without the cap never closes anything, and this suite must report that as a
    // failed assertion, not hang forever (see ROOM_SERVER_ENTRY above).
    closed: (ms = 3000) => new Promise((resolve) => {
      if (ws.readyState === ws.CLOSED) return resolve({ code: c.closeCode, reason: c.closeReason });
      const t = setTimeout(() => resolve({ code: null, reason: 'still open' }), ms);
      ws.once('close', (code, reason) => { clearTimeout(t); resolve({ code, reason: String(reason || '') }); });
    }),
  };
  ws.on('message', (data) => {
    const m = decode(data.toString());
    if (!m) return;
    msgs.push(m);
    if (m.type === MSG.HELLO) c.selfId = m.selfId;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  });
  ws.on('close', (code, reason) => { c.closeCode = code; c.closeReason = String(reason || ''); });
  ws.on('error', (e) => { c.error = e; });
  return c;
}

/**
 * A WebSocket upgrade driven over a RAW socket that then answers NOTHING —
 * not the close frame, not a ping.
 *
 * The `ws` client library replies to a close frame at once, so a softly refused
 * `ws` client leaves the relay's client set within one RTT and CANNOT reproduce
 * the residency section 14d is about. An attacker does not reply. These sockets
 * stay in wss.clients until the relay's own ROOM_REFUSAL_GRACE_MS terminate
 * timer fires — which is exactly the condition under which `wss.clients.size`
 * was the wrong number for the global capacity gate to compare against.
 *
 * Resolves the HTTP status the relay answered with, which is also how the two
 * refusal TIERS are told apart from the outside: 101 = the upgrade was accepted
 * (a soft refusal, costing the relay a real socket), 429 = the cheap door, no
 * WebSocket at all.
 */
function rawUpgrade(port, room) {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    let buf = '';
    let done = false;
    const finish = (status) => { if (done) return; done = true; resolve({ sock, status }); };
    sock.on('connect', () => {
      sock.write(`GET /?room=${encodeURIComponent(room)} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    // The status line is the first thing on the wire either way, so the first
    // chunk is enough — and we deliberately never read past it.
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n')) finish(Number(buf.slice(9, 12))); });
    sock.on('error', () => finish(0));
    sock.on('close', () => finish(0));
    const t = setTimeout(() => finish(0), 3000);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** Connect and settle: resolves with the peer once its HELLO has landed. */
async function join(port, room, name, opts) {
  const c = client(port, room, name, opts);
  await c.open();
  await c.waitFor((m) => m.type === MSG.HELLO);
  return c;
}

/** Try to connect; resolve { ok:false, reason } instead of throwing. */
async function tryJoin(port, room, name, opts) {
  const c = client(port, room, name, opts);
  try { await c.open(); } catch (e) { return { ok: false, reason: e.message, c }; }
  return { ok: true, c };
}

/**
 * Attempt a connection and report how the relay ANSWERED it.
 *
 * `tryJoin` above asks a narrower question — did the HTTP upgrade survive — and
 * that stopped being the same question. A capacity cap normally does NOT kill
 * the upgrade: it accepts the socket and closes it with 1013 + a reason, because
 * the clients already deployed to headsets only retry a socket that opened at
 * least once, so a killed upgrade left them on "Offline" forever with nothing
 * retrying behind it (server/README.md, "How a cap refuses"). So admission is
 * now decided by what arrives AFTER the open: a HELLO, or a close.
 *
 * `opened` is what tells the two refusal TIERS apart, and sections 14d/14e rely
 * on it: `opened: true` is the soft tier (the relay spent a handshake to say why),
 * `opened: false` with a 429 in the reason is the cheap door an address gets once
 * it has burned its soft-refusal budget.
 *
 * Both are awaited in the same race, so a slow HELLO can never be misreported
 * as a refusal — and a relay that answers with neither says so explicitly
 * rather than resolving one way by default.
 */
async function admit(port, room, name, opts) {
  const c = client(port, room, name, opts);
  // A KILLED upgrade still has to be reportable — `opened:false` is what an
  // assertion tests when it wants "the handshake itself was refused".
  try { await c.open(); }
  catch (e) { return { admitted: false, opened: false, code: null, reason: e.message, c }; }
  const verdict = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ admitted: false, code: null, reason: 'neither HELLO nor close arrived' }), 3000);
    const done = (v) => { clearTimeout(t); resolve(v); };
    if (c.selfId) return done({ admitted: true, code: null, reason: '' });
    if (c.ws.readyState === c.ws.CLOSED) return done({ admitted: false, code: c.closeCode, reason: c.closeReason });
    c.ws.on('message', () => { if (c.selfId) done({ admitted: true, code: null, reason: '' }); });
    c.ws.on('close', (code, reason) => done({ admitted: false, code, reason: String(reason || '') }));
  });
  return { ...verdict, opened: true, c };
}

// --- the caps under test, tightened on :8892 -------------------------------

const TIGHT_ENV = {
  LOG_PORT: '8896',
  ROOM_MAX_PEERS: '4',
  ROOM_MAX_PAYLOAD_BYTES: '8192',
  ROOM_MSG_RATE: '20',
  ROOM_MSG_BURST: '20',
  ROOM_MAX_RATE_VIOLATIONS: '30',
  ROOM_MAX_STATE_VALUE_BYTES: '2048',
  ROOM_MAX_STATE_KEYS_PER_PEER: '5',
  ROOM_MAX_STATE_KEY_LEN: '32',
  // Aggregate budgets, scaled down by the same ratio as the per-axis caps so the
  // sections below can trip them with ~2 kB writes instead of megabytes. Chosen
  // so the AGGREGATE cap bites BEFORE the key cap (4 x ~2.4 kB accounted fits,
  // the 5th does not, and the 5-key cap would still have allowed it) — otherwise
  // the test could not tell the new cap from the old one.
  //
  // The unit is ACCOUNTED bytes — serialized characters plus 128 per JSON node —
  // so `{blob:'b'.repeat(1980)}` costs 1991 + 2x128 = 2247, not 1991. These two
  // numbers are ~4x/~6x that, not ~4x/~6x the raw length.
  ROOM_MAX_STATE_BYTES_PER_PEER: '10000',
  ROOM_MAX_STATE_BYTES_PER_ROOM: '15000',
};
// The control: peers/state caps raised out of the way, rate + payload left on the
// SHIPPED DEFAULTS (600 msg/s, 1 MiB) so the "real traffic still fits" half is
// testing what production actually runs.
const LOOSE_ENV = {
  LOG_PORT: '8897',
  ROOM_MAX_PEERS: '16',
  ROOM_MAX_STATE_VALUE_BYTES: String(256 * 1024),
  ROOM_MAX_STATE_KEYS_PER_PEER: '512',
};

const BIG_VALUE = 'x'.repeat(4000);          // > 2048 tight, < 256 KiB loose
const HUGE_FRAME = 'y'.repeat(20000);        // > 8192 tight, < 1 MiB loose
const HEAD = [1, 1.6, -2, 0, 0, 0, 1];

// The backpressure sections (12, 13, 13b) queue ~13 MB at ONE stalled socket by
// aiming big DIRECTED frames at it. SIGNAL is the vehicle — a broadcast would
// back up the healthy observer too — and a SIGNAL body is now capped by the
// relay at HUB_LIMITS.signalBytes (RELAY-2). Sizing the frame from that cap is
// not cosmetic: a body OVER it is refused, so nothing would queue at all and
// three sections would quietly stop testing backpressure while still passing
// their negative controls. Half the cap, twice the frames, same total bytes.
const FAT = 'f'.repeat(Math.floor(HUB_LIMITS.signalBytes / 2));
const FAT_FRAMES = Math.ceil((13 * 1024 * 1024) / FAT.length);   // ~13 MB queued

/**
 * The largest STATE value the shipped app actually sends, built from the REAL
 * files in this tree rather than from a guess: `shelf:collections` is
 * `[[ref, {id,title,author,games:[…]}], …]` (src/main.js `_publishHostShelf`),
 * and this inlines EVERY collection in public/roms at once — more than any
 * single host publishes. The structural caps are calibrated against this, so if
 * a future collection grows past them the suite says so instead of a headset
 * silently losing its shelf.
 */
const REAL_ROOM_STATE = (() => {
  const out = [];
  for (const dir of ['public/roms', 'public/roms/local']) {   // local/ = the user's own library (read-only)
    let names = [];
    try { names = readdirSync(pathJoin(ROOT, dir)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.collection.json')) continue;
      try {
        const col = JSON.parse(readFileSync(pathJoin(ROOT, dir, n), 'utf8'));
        out.push([`dropped:${col.id || n}`, {
          id: col.id, title: col.title, author: col.author,
          games: (col.games || []).map(({ boxartList, ...g }) => g),
        }]);
      } catch { /* not a collection we can inline */ }
    }
  }
  return out;
})();

let tight = null, loose = null;

try {
  // ============================================================ 0. THE MEASUREMENT
  // The acceptance test. A skeptic pointed a single WebSocket at the SHIPPED
  // DEFAULTS and parked 512 x 250 KiB STATE values in one room; the server's RSS
  // went 56.9 MiB → 212.7 MiB with "writes refused: 0, server limit lines: 0".
  // Every per-axis cap was in force and none of them fired, because 512 keys x
  // 256 KiB is 128 MiB per socket and each individual write was legal.
  //
  // This section is that exact probe, kept as a regression test, and it is the
  // reason server/Hub.js has aggregate byte budgets. It measures the SERVER's RSS
  // from the outside (rssMiB → tasklist/ps), not the server's own self-report.
  //
  // The negative control is the same binary, same probe, with only the three
  // aggregate budgets raised to 1 GiB — so the pair isolates the new caps and
  // nothing else. Without it a flat RSS number could equally mean "the probe
  // didn't send anything".
  console.log('\n--- 0. the skeptic\'s memory probe: 512 x 250 KiB STATE from ONE socket ---');
  {
    const N = 512, SIZE = 250 * 1024, BLOB = 'x'.repeat(SIZE);
    const OFF = String(1024 * 1024 * 1024);   // 1 GiB — effectively "budget disabled"

    const probe = async (env, label) => {
      const s = startServer(TIGHT_PORT, { LOG_PORT: '8896', ...env });
      await s.ready;
      await sleep(400);
      const before = rssMiB(s.child.pid);
      const c = await join(TIGHT_PORT, 'dos', 'DOS');
      for (let i = 0; i < N; i++) {
        c.send(makeState({ key: `prop:pad${i}`, value: BLOB }));
        if (i % 32 === 31) await sleep(30);          // let the relay drain
      }
      await sleep(2500);
      const after = rssMiB(s.child.pid);
      const refused = (s.log().match(/refused by an admission limit/g) || []).length;
      const corrections = c.count((m) => m.type === MSG.STATE && m.value === null);
      c.ws.close();
      await stop(s);
      const r = {
        label, before, after,
        delta: before != null && after != null ? Math.round((after - before) * 10) / 10 : null,
        refused, corrections,
      };
      console.log(`       ${label}: RSS ${before} → ${after} MiB (Δ ${r.delta}), refusals ${refused}, corrections ${corrections}`);
      return r;
    };

    const capped = await probe({}, 'shipped defaults');
    const uncapped = await probe({
      ROOM_MAX_STATE_BYTES_PER_PEER: OFF, ROOM_MAX_STATE_BYTES_PER_ROOM: OFF, ROOM_MAX_STATE_BYTES_TOTAL: OFF,
    }, 'aggregate budget raised to 1 GiB (negative control)');

    // If RSS can't be read this section proves nothing, and a silent skip is
    // exactly the vacuous green this suite exists to avoid — so it FAILS instead.
    ok(capped.before != null && capped.after != null && uncapped.after != null,
      `the server's RSS is externally readable on ${process.platform} (before ${capped.before} MiB)`);
    ok(capped.refused > 500 && capped.corrections > 500,
      `SHIPPED DEFAULTS: ${capped.refused} of ${N} writes refused, ${capped.corrections} null corrections sent back to the writer`);
    ok(capped.delta != null && capped.delta < 60,
      `SHIPPED DEFAULTS: RSS stays flat — ${capped.before} → ${capped.after} MiB (Δ ${capped.delta}) while ${Math.round(N * SIZE / 1048576)} MiB was offered`);
    ok(uncapped.refused === 0 && uncapped.corrections === 0,
      'NEGATIVE CONTROL: with the aggregate budget raised the identical writes are all accepted (0 refusals)');
    ok(uncapped.delta != null && uncapped.delta > 100,
      `NEGATIVE CONTROL: …and RSS balloons — ${uncapped.before} → ${uncapped.after} MiB (Δ ${uncapped.delta}), reproducing the reported 58 → 225 MB`);
    ok(capped.delta != null && uncapped.delta != null && uncapped.delta > capped.delta * 3,
      `the aggregate budget is what makes the difference: Δ ${capped.delta} MiB capped vs Δ ${uncapped.delta} MiB uncapped`);
  }

  // ======================================================== 0b. THE SHAPE PROBE
  // Round 2 gave the relay a real aggregate BYTE budget and it worked. A skeptic
  // then attacked the ACCOUNTING instead of the cap: filling the entire shipped
  // 64 MiB budget — 64 sockets, 64 rooms, every per-axis and every aggregate cap
  // honoured, ZERO refusals — with a JSON array of EMPTY OBJECTS (3 characters
  // per V8 allocation) drove the server from 57.4 MiB to 1515.3 MiB. A 22.78x
  // heap multiplier, reproduced twice; arrays of empty arrays 15.26x; the same
  // harness with one plain string blob 1.24x. The defender had picked the unit,
  // the attacker picked the shape, and the documented "336 MiB, fits a 1 GB VPS"
  // was ~6x optimistic — the real number was ~1.5 GB.
  //
  // The fix is in server/Hub.js: a per-value STRUCTURAL cap (node count + depth)
  // plus a per-node charge folded into the aggregate budgets, so the unit is
  // ACCOUNTED bytes (characters + stateNodeCostBytes per node) instead of
  // characters. This section is the measurement that says whether that worked.
  //
  // The pair below is single-variable: identical clients, identical writes,
  // identical budgets — only ROOM_STATE_NODE_COST_BYTES (and the structural caps
  // it protects) differ. The control is precisely the round-2 byte-only build.
  // It runs at a REDUCED 8 MiB global budget on purpose: at the shipped 64 MiB
  // the byte-only arm would allocate ~2.6 GB on this machine to prove a point it
  // proves just as well at 8 MiB. The shipped-budget number is measured
  // separately, in the arm that is now bounded.
  console.log('\n--- 0b. the skeptic\'s SHAPE probe: the same budget, filled with empty containers ---');
  {
    const NODE_COST_OFF = { ROOM_STATE_NODE_COST_BYTES: '0', ROOM_MAX_STATE_VALUE_NODES: '100000000', ROOM_MAX_STATE_VALUE_DEPTH: '1000000' };

    /**
     * Fill a relay's whole STATE budget with `[{},{},…]` / `[[],[],…]` and read
     * the SERVER's RSS from outside (tasklist/ps — never its self-report).
     * Returns the resident delta, what the server actually accounted for, and
     * the ratio between them: the heap multiplier the shape bought.
     */
    const fill = async ({ label, kind, env = {}, sockets, nodesPerValue, writes, port = TIGHT_PORT }) => {
      const value = Array.from({ length: nodesPerValue }, () => (kind === 'obj' ? {} : []));
      const rawChars = JSON.stringify(value).length;
      const nodes = nodesPerValue + 1;                       // the elements + the array
      const nodeCost = Number(env.ROOM_STATE_NODE_COST_BYTES ?? HUB_LIMITS.stateNodeCostBytes);
      const costPerValue = rawChars + nodes * nodeCost;
      const s = startServer(port, { LOG_PORT: '8896', ...env });
      await s.ready;
      await sleep(400);
      const before = rssMiB(s.child.pid);
      const cs = [];
      for (let i = 0; i < sockets; i++) cs.push(await join(port, `shape${i}`, `S${i}`));   // one socket per ROOM
      for (let w = 0; w < writes; w++) {
        for (const c of cs) c.send(makeState({ key: `prop:pad${w}`, value }));
        await sleep(20);
      }
      await sleep(2500);
      const after = rssMiB(s.child.pid);
      const refused = (s.log().match(/refused by an admission limit/g) || []).length;
      const accepted = sockets * writes - refused;
      for (const c of cs) c.ws.close();
      await stop(s);
      const delta = before != null && after != null ? Math.round((after - before) * 10) / 10 : null;
      const accountedMiB = Math.round((accepted * costPerValue / 1048576) * 10) / 10;
      const offeredMiB = Math.round((sockets * writes * rawChars / 1048576) * 10) / 10;
      const mult = delta != null && accountedMiB > 0 ? Math.round((delta / accountedMiB) * 100) / 100 : null;
      console.log(`       ${label}: RSS ${before} → ${after} MiB (Δ ${delta}) · offered ${offeredMiB} MiB of JSON · `
        + `accepted ${accepted}/${sockets * writes} = ${accountedMiB} MiB accounted · refused ${refused} · heap multiplier ${mult}x`);
      return { before, after, delta, accepted, refused, accountedMiB, mult };
    };

    // --- the pair, per shape. 8 sockets x 8 rooms x a 12 kB value, 8 MiB budget.
    const SMALL = { sockets: 8, nodesPerValue: 4000, writes: 100 };
    const BUDGET_8 = { ROOM_MAX_STATE_BYTES_TOTAL: String(8 * 1024 * 1024) };
    for (const [kind, human] of [['obj', 'arrays of EMPTY OBJECTS'], ['arr', 'arrays of EMPTY ARRAYS']]) {
      const fixed = await fill({ ...SMALL, kind, env: BUDGET_8, label: `${human} — shipped structural caps` });
      const naive = await fill({ ...SMALL, kind, env: { ...BUDGET_8, ...NODE_COST_OFF }, label: `${human} — NEGATIVE CONTROL, node charge 0 (= the round-2 byte-only budget)` });

      ok(fixed.refused > 0 && fixed.accepted > 0,
        `${human}: the budget was really FILLED under the structural caps (${fixed.accepted} writes accepted, ${fixed.refused} refused)`);
      // The threshold is 6x, not ~1.4x, ONLY because the pool is deliberately
      // small here: ~20 MiB of this arm's delta is fixed harness overhead (800
      // inbound 12 kB frames, 8 sockets, GC slack) that does not scale with the
      // budget, so it swamps an 8 MiB pool and is noise at 64 MiB. The real
      // multiplier is the shipped-budget arm below (measured 1.35x). What this
      // pair isolates is the CONTROL: same shape, same clients, same budget.
      ok(fixed.mult != null && fixed.mult < 6,
        `${human}: heap multiplier is bounded — ${fixed.delta} MiB resident for ${fixed.accountedMiB} MiB accounted = ${fixed.mult}x (of which ~20 MiB is fixed harness overhead at this pool size)`);
      ok(naive.refused > 0 && naive.accepted > fixed.accepted,
        `NEGATIVE CONTROL: with the node charge off the identical writes are accepted until the same budget is full (${naive.accepted} vs ${fixed.accepted})`);
      ok(naive.mult != null && naive.mult > 10,
        `NEGATIVE CONTROL: …and the byte-only unit is ${naive.mult}x, reproducing the reported ~15-23x — the accounting, not the cap, was the hole`);
      ok(naive.delta != null && fixed.delta != null && naive.delta > fixed.delta * 5,
        `NEGATIVE CONTROL: same shape, same budget, same clients — Δ ${naive.delta} MiB vs Δ ${fixed.delta} MiB. Only ROOM_STATE_NODE_COST_BYTES differed.`);
    }

    // --- and the number the docs quote: the ENTIRE shipped 64 MiB budget, 64
    //     sockets in 64 rooms, filled with the strongest shape the caps still
    //     allow (values sized just under the per-value node cap). No env at all.
    const full = await fill({
      kind: 'obj', sockets: 64, nodesPerValue: 500, writes: 20,
      label: 'the WHOLE shipped 64 MiB budget, 64 sockets x 64 rooms (the number server/README.md quotes)',
    });
    ok(full.refused > 0 && full.accountedMiB > 48,
      `the shipped budget really is filled to the ceiling: ${full.accountedMiB} MiB accounted of 64 MiB, ${full.refused} further writes refused`);
    ok(full.delta != null && full.delta < 120,
      `…and the server's RSS grows ${full.delta} MiB (${full.before} → ${full.after}) for ${full.accountedMiB} MiB accounted = ${full.mult}x, not the 1457.9 MiB the byte-only accounting allowed`);
  }

  console.log(`\n=== spawning relays: TIGHT :${TIGHT_PORT}  LOOSE :${LOOSE_PORT} ===`);
  tight = startServer(TIGHT_PORT, TIGHT_ENV);
  loose = startServer(LOOSE_PORT, LOOSE_ENV);
  await Promise.all([tight.ready, loose.ready]);
  // This used to be `ok(true, 'both relays listening')` — an assertion that
  // could not fail, counted in the total, in a suite whose whole point is that a
  // green run means something. What actually matters here is not that two
  // processes started but that each one took ITS OWN env: every pair below is
  // meaningless if TIGHT silently came up on the shipped defaults. Both relays
  // print their effective limits at boot, so assert on those.
  ok(await tight.waitLog(/payload 8192B, 4 peers\/room/),
    'TIGHT came up with the TIGHTENED env it was given (payload 8192B, 4 peers/room in its own boot line)');
  ok(await loose.waitLog(/payload 1048576B, 16 peers\/room/),
    'LOOSE came up with the SHIPPED payload/rate defaults (payload 1048576B, 16 peers/room) — the control is a real control');

  // ---------------------------------------------------------------- 1. peers
  console.log('\n--- per-room peer cap ---');
  {
    const room = 'cap-peers';
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await join(TIGHT_PORT, room, `T${i}`));
    ok(held.every((c) => c.selfId), 'TIGHT: 4 peers (a full shipped 4-player room) all join');
    const fifth = await admit(TIGHT_PORT, room, 'T4');
    ok(!fifth.admitted && /full/.test(fifth.reason), `TIGHT: the 5th peer is refused — "${fifth.reason}"`);
    // --- and refused in a way the DEPLOYED client survives ------------------
    // This trio is the regression guard, not decoration. The caps used to answer
    // cb(false, 429) — a killed upgrade — and the shipped clients only retry a
    // socket that has been OPEN at least once (`wasConnected || _reconnectTries`,
    // both falsy on a fresh client's first connect), while only 4010 produces any
    // status text. So a transient "room is full" put the multiplayer widget on
    // "Offline" for the rest of the page's life with no reason and no retry —
    // the exact COR-9 dead end. Put the 503/429 back in verifyClient and all
    // three of these go red.
    ok(fifth.opened, 'TIGHT: …by ACCEPTING the upgrade and then closing it — a deployed client only retries a socket that opened once');
    ok(fifth.code === 1013 && !isPermanentClose(fifth.code),
      `TIGHT: …with 1013 "try again later", which NetProtocol.isPermanentClose does NOT treat as final (got ${fifth.code})`);
    ok(fifth.reason.length > 0,
      `TIGHT: …and with a human-readable reason on the close, so a client can say why instead of just "Offline" — "${fifth.reason}"`);
    ok(held[0].closeCode === null, 'TIGHT: the refusal did not disturb the peers already in the room');

    // control: same 5th client, cap raised
    const heldL = [];
    for (let i = 0; i < 4; i++) heldL.push(await join(LOOSE_PORT, room, `L${i}`));
    const fifthL = await admit(LOOSE_PORT, room, 'L4');
    ok(fifthL.admitted, 'LOOSE (control): the identical 5th peer connects when the cap is 16');
    for (const c of [...held, ...heldL, fifthL.c]) c.ws.close();
    await sleep(120);
  }

  // ------------------------------------------------------------- 2. payload
  console.log('\n--- ws maxPayload ---');
  {
    const room = 'cap-payload';
    const a = await join(TIGHT_PORT, room, 'A');
    a.sendRaw(HUGE_FRAME);
    const closed = await a.closed();
    ok(closed.code === 1009, `TIGHT: a ${HUGE_FRAME.length}-byte frame closes the socket with 1009 (message too big), got ${closed.code}`);

    const b = await join(LOOSE_PORT, room, 'B');
    const watcher = await join(LOOSE_PORT, room, 'W');
    b.send(makeState({ key: 'prop:huge', value: { blob: 'y'.repeat(20000) } }));
    const relayed = await watcher.waitFor((m) => m.type === MSG.STATE && m.key === 'prop:huge');
    ok(relayed.value.blob.length === 20000,
      'LOOSE (control): the same ~20 kB payload rides through on the DEFAULT 1 MiB cap');
    ok(b.closeCode === null, 'LOOSE (control): sender stayed connected');
    b.ws.close(); watcher.ws.close();
    await sleep(120);
  }

  // --------------------------------------------------------- 3. STATE value
  console.log('\n--- per-key STATE value cap ---');
  {
    const room = 'cap-value';
    const a = await join(TIGHT_PORT, room, 'A');
    const w = await join(TIGHT_PORT, room, 'W');
    a.send(makeState({ key: 'prop:small', value: { blob: 'x'.repeat(100) } }));
    const small = await w.waitFor((m) => m.type === MSG.STATE && m.key === 'prop:small');
    // This used to be a literal `ok(true, ...)` — an assertion that could not
    // fail, counted in the total. Assert the RELAYED VALUE instead: the payload
    // arrives intact and carries the server-stamped setter id.
    ok(small.value?.blob?.length === 100 && small.id === a.selfId,
      `TIGHT: an under-cap STATE is relayed intact (blob ${small.value?.blob?.length}/100 chars, id stamped ${small.id === a.selfId})`);

    a.send(makeState({ key: 'prop:big', value: { blob: BIG_VALUE } }));
    const corr = await a.waitFor((m) => m.type === MSG.STATE && m.key === 'prop:big');
    ok(corr.value === null, 'TIGHT: an over-cap STATE is refused and the writer gets a null correction back');
    await sleep(200);
    ok(w.count((m) => m.type === MSG.STATE && m.key === 'prop:big') === 0,
      'TIGHT: the over-cap STATE was NOT broadcast to the room');

    const aL = await join(LOOSE_PORT, room, 'AL');
    const wL = await join(LOOSE_PORT, room, 'WL');
    aL.send(makeState({ key: 'prop:big', value: { blob: BIG_VALUE } }));
    const got = await wL.waitFor((m) => m.type === MSG.STATE && m.key === 'prop:big');
    ok(got.value.blob.length === BIG_VALUE.length,
      'LOOSE (control): the identical 4 kB STATE is accepted under a 256 KiB cap');
    for (const c of [a, w, aL, wL]) c.ws.close();
    await sleep(120);
  }

  // ----------------------------------------------------------- 4. key count
  console.log('\n--- per-peer STATE key cap + key length ---');
  {
    const room = 'cap-keys';
    const a = await join(TIGHT_PORT, room, 'A');
    const w = await join(TIGHT_PORT, room, 'W');
    for (let i = 0; i < 10; i++) a.send(makeState({ key: `prop:k${i}`, value: { i } }));
    await sleep(300);
    const relayed = w.count((m) => m.type === MSG.STATE && m.key.startsWith('prop:k'));
    ok(relayed === 5, `TIGHT: only the first 5 of 10 distinct keys were accepted (relayed=${relayed})`);
    ok(a.count((m) => m.type === MSG.STATE && m.key.startsWith('prop:k') && m.value === null) === 5,
      'TIGHT: the 5 refused writes each came back to the writer as a null correction');

    const longKey = `prop:${'z'.repeat(200)}`;
    a.send(makeState({ key: longKey, value: { n: 1 } }));
    await sleep(200);
    ok(w.count((m) => m.type === MSG.STATE && m.key === longKey) === 0,
      'TIGHT: a 205-char STATE key is dropped outright (and not echoed back)');
    ok(a.count((m) => m.type === MSG.STATE && m.key === longKey) === 0,
      'TIGHT: …the abusive key is never put back on the wire, not even as a correction');

    const aL = await join(LOOSE_PORT, room, 'AL');
    const wL = await join(LOOSE_PORT, room, 'WL');
    for (let i = 0; i < 10; i++) aL.send(makeState({ key: `prop:k${i}`, value: { i } }));
    await sleep(300);
    const relayedL = wL.count((m) => m.type === MSG.STATE && m.key.startsWith('prop:k'));
    ok(relayedL === 10, `LOOSE (control): all 10 keys accepted under a 512-key cap (relayed=${relayedL})`);
    for (const c of [a, w, aL, wL]) c.ws.close();
    await sleep(120);
  }

  // ------------------------------------------- 4b. AGGREGATE STATE byte caps
  // The cap the per-axis ones didn't add up to. Values here are UNDER the
  // per-value cap and the key count is UNDER the per-peer key cap, so the ONLY
  // thing that can refuse them is the aggregate byte budget.
  console.log('\n--- aggregate STATE byte budget (per peer, per room) ---');
  {
    const CHUNK = { blob: 'b'.repeat(1980) };                  // ~2 kB of JSON
    const CHUNK_BYTES = JSON.stringify(CHUNK).length;
    // 2 nodes: the object and its one string property.
    const CHUNK_COST = CHUNK_BYTES + 2 * HUB_LIMITS.stateNodeCostBytes;
    ok(CHUNK_BYTES < 2048, `each write is ${CHUNK_BYTES} B — inside the 2048 B per-VALUE cap, so only an aggregate cap can refuse it`);
    ok(CHUNK_COST === 2247 && measureValue(CHUNK).nodes === 2,
      `…and ${CHUNK_COST} B ACCOUNTED (${CHUNK_BYTES} chars + ${measureValue(CHUNK).nodes} nodes x ${HUB_LIMITS.stateNodeCostBytes} B), which is the unit the aggregate budgets below use`);

    // --- per peer: 10000 B accounted budget, 5-key budget. 4 chunks fit
    //     (8988 B), the 5th does not (11235 B), and the key cap would still have
    //     allowed a 5th.
    {
      const room = 'cap-bytes-peer';
      const a = await join(TIGHT_PORT, room, 'A');
      const w = await join(TIGHT_PORT, room, 'W');
      for (let i = 0; i < 5; i++) a.send(makeState({ key: `prop:b${i}`, value: CHUNK }));
      await sleep(300);
      const relayed = w.count((m) => m.type === MSG.STATE && m.key.startsWith('prop:b') && m.value !== null);
      ok(relayed === 4, `TIGHT: 4 of 5 x ${CHUNK_COST} B accounted accepted before the 10000 B per-peer budget refuses (relayed=${relayed})`);
      ok(a.count((m) => m.type === MSG.STATE && m.key === 'prop:b4' && m.value === null) === 1,
        'TIGHT: the refused write comes back to the writer as a null correction, exactly like an over-cap value');
      ok(/peer-byte-limit/.test(tight.log()), 'TIGHT: the server logged the refusal as peer-byte-limit (not a key-count refusal)');

      // Releasing a key must hand the bytes back — a budget you cannot climb out
      // of would brick a room after one big write.
      a.send(makeState({ key: 'prop:b0', value: null }));
      await sleep(200);
      a.send(makeState({ key: 'prop:b4', value: CHUNK }));
      const back = await w.waitFor((m) => m.type === MSG.STATE && m.key === 'prop:b4' && m.value !== null).catch(() => null);
      ok(back?.value?.blob?.length === 1980, 'TIGHT: clearing a key releases its bytes — the same write then succeeds');

      // control: identical writes on the shipped 1 MiB per-peer budget.
      const aL = await join(LOOSE_PORT, room, 'AL');
      const wL = await join(LOOSE_PORT, room, 'WL');
      for (let i = 0; i < 5; i++) aL.send(makeState({ key: `prop:b${i}`, value: CHUNK }));
      await sleep(300);
      const relayedL = wL.count((m) => m.type === MSG.STATE && m.key.startsWith('prop:b') && m.value !== null);
      ok(relayedL === 5, `LOOSE (control): all 5 identical writes accepted under the shipped 1 MiB per-peer budget (relayed=${relayedL})`);
      for (const c of [a, w, aL, wL]) c.ws.close();
      await sleep(150);
    }

    // --- per room: 15000 B accounted budget shared by two peers. B is refused
    //     while its OWN peer budget still has room — so this can only be the
    //     room cap.
    {
      const room = 'cap-bytes-room';
      const a = await join(TIGHT_PORT, room, 'A');
      const b = await join(TIGHT_PORT, room, 'B');
      for (let i = 0; i < 4; i++) a.send(makeState({ key: `prop:a${i}`, value: CHUNK }));   // ~8 kB, A at its peer cap
      await sleep(250);
      for (let i = 0; i < 3; i++) b.send(makeState({ key: `prop:c${i}`, value: CHUNK }));   // 2 fit, the 3rd busts the room
      await sleep(300);
      const bAccepted = a.count((m) => m.type === MSG.STATE && m.key.startsWith('prop:c') && m.value !== null);
      ok(bAccepted === 2, `TIGHT: B got 2 of 3 in before the 15000 B ROOM budget refused (A saw ${bAccepted})`);
      ok(b.count((m) => m.type === MSG.STATE && m.key === 'prop:c2' && m.value === null) === 1,
        'TIGHT: B\'s refused write comes back as a null correction');
      ok(/room-byte-limit/.test(tight.log()),
        'TIGHT: logged as room-byte-limit — B was refused on the ROOM budget while its own peer budget still had ~3.2 kB free');

      const aL = await join(LOOSE_PORT, room, 'AL');
      const bL = await join(LOOSE_PORT, room, 'BL');
      for (let i = 0; i < 4; i++) aL.send(makeState({ key: `prop:a${i}`, value: CHUNK }));
      for (let i = 0; i < 3; i++) bL.send(makeState({ key: `prop:c${i}`, value: CHUNK }));
      await sleep(400);
      const allL = aL.count((m) => m.type === MSG.STATE && m.key.startsWith('prop:c') && m.value !== null);
      ok(allL === 3, `LOOSE (control): all 3 of B's identical writes land under the shipped 2 MiB room budget (${allL})`);
      for (const c of [a, b, aL, bL]) c.ws.close();
      await sleep(150);
    }

    // --- the accounting itself, in-process: totals must go back to zero when a
    //     room empties, or the global budget leaks a little on every room.
    {
      const h = new Hub({ limits: { stateBytesPerRoom: 6000, stateBytesTotal: 8192 } });
      h.connect('rb', 'p1', {});
      h.setState('rb', 'p1', { key: 'prop:x', value: CHUNK });
      const after1 = h.usage('rb').roomCost;
      h.setState('rb', 'p1', { key: 'prop:y', value: CHUNK });
      ok(after1 === CHUNK_COST && h.usage('rb').roomCost === CHUNK_COST * 2,
        `Hub accounting: two ${CHUNK_COST} B accounted writes tally to ${h.usage('rb').roomCost} B`);
      ok(h.usage('rb').roomBytes === CHUNK_BYTES * 2 && h.usage('rb').roomNodes === 4,
        `Hub accounting: …and the raw side is still tracked for diagnostics (${h.usage('rb').roomBytes} chars, ${h.usage('rb').roomNodes} nodes)`);
      const refused = h.setState('rb', 'p1', { key: 'prop:z', value: CHUNK });
      ok(refused.rejected === 'room-byte-limit' && !refused.broadcast,
        `Hub accounting: the third is refused ("${refused.rejected}") and is NOT broadcast`);
      h.setState('rb', 'p1', { key: 'prop:x', value: null });
      ok(h.usage('rb').roomCost === CHUNK_COST, 'Hub accounting: clearing a key gives its cost back');
      h.disconnect('rb', 'p1');
      ok(h.totalStateCost() === 0 && h.roomCost.size === 0 && h.peerOwn.size === 0,
        'Hub accounting: an emptied room releases its whole tally — the global budget cannot leak');
    }
  }

  // ------------------------------- 4c. STRUCTURAL caps (shape, not just length)
  // Byte length is not a proxy for retained heap: `[{},{},…]` is 3 characters
  // per V8 allocation. These are the in-process unit assertions for the caps
  // that bound the SHAPE; section 0b is the end-to-end RSS measurement.
  console.log('\n--- per-value STRUCTURAL caps (node count + nesting depth) ---');
  {
    const nodesOf = (v) => measureValue(v).nodes;
    ok(nodesOf({}) === 1 && nodesOf({ a: 1 }) === 2 && nodesOf([1, 2, 3]) === 4 && nodesOf('x') === 1,
      `measureValue counts one node per JSON value — container or leaf ({}=1, {a:1}=2, [1,2,3]=4, "x"=1)`);
    const deep = JSON.parse('['.repeat(200) + ']'.repeat(200));
    ok(measureValue(deep, { maxDepth: 16 }).over === 'depth' && measureValue(deep).depth === 200,
      'measureValue walks a 200-deep value ITERATIVELY (no stack overflow) and reports over="depth"');
    const wide = Array.from({ length: 50000 }, () => ({}));
    const bailed = measureValue(wide, { maxNodes: 8192 });
    ok(bailed.over === 'nodes' && bailed.nodes <= 8192 + 50000 && bailed.nodes > 8192,
      `measureValue bails on a 50,000-element array as soon as the node cap is provably passed (reported ${bailed.nodes})`);

    // The pair that matters: SAME byte length, different shape.
    const h = new Hub();
    h.connect('sc', 'p1', {});
    const emptyObjs = Array.from({ length: 40000 }, () => ({}));       // 120 kB, 40,001 nodes
    const sameBytes = 'x'.repeat(JSON.stringify(emptyObjs).length - 2); // same bytes, 1 node
    const shaped = h.setState('sc', 'p1', { key: 'prop:shape', value: emptyObjs });
    const flat = h.setState('sc', 'p1', { key: 'prop:flat', value: sameBytes });
    ok(shaped.rejected === 'value-too-complex' && !shaped.broadcast,
      `a ${JSON.stringify(emptyObjs).length} B array of 40,000 EMPTY OBJECTS is refused ("${shaped.rejected}") — inside every byte cap, outside the node cap`);
    ok(!!flat.broadcast && !flat.rejected,
      '…while a plain string of the SAME byte length is accepted — the cap is on the shape, not the length');
    ok(!!shaped.direct?.msg && shaped.direct.msg.value === null,
      'the refused writer still gets the authoritative value back as a correction (same contract as every other refusal)');
    const deepWrite = h.setState('sc', 'p1', { key: 'prop:deep', value: deep });
    ok(deepWrite.rejected === 'value-too-deep' && !deepWrite.broadcast,
      `a 200-level nested value is refused separately ("${deepWrite.rejected}")`);
    // Real traffic must be nowhere near either cap.
    ok(measureValue(REAL_ROOM_STATE).nodes * 8 < HUB_LIMITS.stateValueNodes
      && measureValue(REAL_ROOM_STATE).depth * 2 <= HUB_LIMITS.stateValueDepth,
      `the biggest real STATE value in the tree (${JSON.stringify(REAL_ROOM_STATE).length} B) is ${measureValue(REAL_ROOM_STATE).nodes} nodes / depth ${measureValue(REAL_ROOM_STATE).depth} — against caps of ${HUB_LIMITS.stateValueNodes} / ${HUB_LIMITS.stateValueDepth}`);
    const realWrite = h.setState('sc', 'p1', { key: 'shelf:collections', value: REAL_ROOM_STATE });
    ok(!!realWrite.broadcast && !realWrite.rejected, '…and it is accepted, unchanged, by a default Hub');
  }

  // ------------------------------------------------------------ 5. rate cap
  console.log('\n--- inbound rate limit ---');
  {
    const room = 'cap-rate';
    const a = await join(TIGHT_PORT, room, 'A');
    const w = await join(TIGHT_PORT, room, 'W');
    for (let i = 0; i < 300; i++) a.send(makePose({ head: HEAD }));
    const closed = await a.closed();
    ok(closed.code === 4008, `TIGHT: a 300-message burst gets the flooder closed with 4008 (got ${closed.code} "${closed.reason}")`);
    const seen = w.count((m) => m.type === MSG.POSE);
    ok(seen > 0 && seen <= 40, `TIGHT: the room only saw ${seen} of the 300 flooded poses (burst budget 20)`);

    // control 1: cap off — the same flood is relayed in full.
    const aL = await join(LOOSE_PORT, room, 'AL');
    const wL = await join(LOOSE_PORT, room, 'WL');
    for (let i = 0; i < 300; i++) aL.send(makePose({ head: HEAD }));
    await sleep(500);
    ok(aL.closeCode === null, 'LOOSE (control): the identical 300-message burst is inside the DEFAULT 1200 burst — no close');
    ok(wL.count((m) => m.type === MSG.POSE) === 300, `LOOSE (control): all 300 relayed (${wL.count((m) => m.type === MSG.POSE)})`);

    // control 2: the realistic worst case a Quest peer actually generates —
    // ~275 msg/s (gun + mouse WIRE at frame rate, 20 Hz drag, 12 Hz pose) — must
    // survive on the shipped defaults with ZERO drops.
    const busy = await join(LOOSE_PORT, 'cap-rate-real', 'BUSY');
    const obs = await join(LOOSE_PORT, 'cap-rate-real', 'OBS');
    const REAL_HZ = 300, SECONDS = 2;
    for (let s = 0; s < SECONDS * 10; s++) {
      for (let i = 0; i < REAL_HZ / 10; i++) busy.send(makeWire({ ch: 'gun', data: { u: 0.5, v: 0.5, trigger: false, port: 1 } }));
      await sleep(100);
    }
    await sleep(300);
    const relayed = obs.count((m) => m.type === MSG.WIRE);
    ok(busy.closeCode === null && relayed === REAL_HZ * SECONDS,
      `LOOSE (control): ${REAL_HZ} msg/s for ${SECONDS}s — a peer aiming a light gun while dragging a prop — passes untouched (${relayed}/${REAL_HZ * SECONDS})`);
    for (const c of [w, aL, wL, busy, obs]) c.ws.close();
    await sleep(120);
  }

  // ----------------------------------------------- 6. a real 4-player room
  console.log('\n--- a legitimate 4-peer room on the shipped defaults ---');
  {
    const room = 'four-player';
    const p = [];
    for (let i = 0; i < 4; i++) {
      p.push(await join(LOOSE_PORT, room, `P${i}`, { sid: `sid-p${i}` }));
      p[i].send(makeJoin({ nick: `Player${i}`, color: '#88aaff' }));
    }
    await sleep(250);
    const host = p[0].msgs.find((m) => m.type === MSG.HELLO)?.host;
    ok(host === p[0].selfId, 'host election intact: the first peer in is the host');
    ok(p[3].msgs.find((m) => m.type === MSG.HELLO).peers.length === 3, 'the 4th peer sees the other 3 in its HELLO roster');
    ok(p[0].count((m) => m.type === MSG.JOIN) === 3, 'the host received a JOIN for each of the other 3');

    // POSE at 12 Hz from all four, for a second — the real presence load.
    for (let t = 0; t < 12; t++) {
      for (const c of p) c.send(makePose({ head: HEAD, left: HEAD, right: HEAD }));
      await sleep(80);
    }
    await sleep(200);
    ok(p[1].count((m) => m.type === MSG.POSE) === 36,
      `12 Hz POSE from 4 peers for 1 s fully relayed (P1 saw ${p[1].count((m) => m.type === MSG.POSE)}/36)`);

    // Voice signalling, host-directed input, room-object sync, transient WIRE.
    p[1].send(makeSignal({ to: p[0].selfId, kind: 'offer', data: { sdp: 'v=0' } }));
    const sig = await p[0].waitFor((m) => m.type === MSG.SIGNAL);
    ok(sig.from === p[1].selfId && sig.kind === 'offer', 'SIGNAL (voice offer) relayed to the host with a server-stamped `from`');

    p[2].send(makeInput({ to: p[0].selfId, player: 2, btn: 'a', down: true, seq: 1 }));
    const inp = await p[0].waitFor((m) => m.type === MSG.INPUT);
    ok(inp.from === p[2].selfId && inp.btn === 'a', 'INPUT relayed to the host with a server-stamped `from`');

    p[0].send(makeState({ key: 'tv', value: { file: 'game.nes', core: 'fceumm' } }));
    const tv = await p[3].waitFor((m) => m.type === MSG.STATE && m.key === 'tv');
    ok(tv.value.file === 'game.nes', 'host-owned STATE `tv` still broadcasts to every client');

    p[1].send(makeState({ key: 'tv', value: { file: 'hijack.nes' } }));
    const nack = await p[1].waitFor((m) => m.type === MSG.STATE && m.key === 'tv' && m.value?.file === 'game.nes');
    ok(!!nack, 'a non-host still cannot write `tv` (the host ACL survived the new checks)');

    // The REAL host publish, over the wire, on the shipped defaults: the two
    // biggest values the app actually sends (`shelf:collections` with every
    // collection in this tree inlined, and a committed `room` descriptor — the
    // deepest real value there is). The structural caps are calibrated from
    // these files, so this is the assertion that says a headset's shelf still
    // crosses the relay after they were added.
    const realRoom = JSON.parse(readFileSync(pathJoin(ROOT, 'public/roms/bedroom.room.json'), 'utf8'));
    p[0].send(makeState({ key: 'shelf:collections', value: REAL_ROOM_STATE }));
    p[0].send(makeState({ key: 'room', value: realRoom }));
    const gotShelf = await p[2].waitFor((m) => m.type === MSG.STATE && m.key === 'shelf:collections').catch(() => null);
    const gotRoom = await p[2].waitFor((m) => m.type === MSG.STATE && m.key === 'room').catch(() => null);
    ok(JSON.stringify(gotShelf?.value) === JSON.stringify(REAL_ROOM_STATE),
      `the real host shelf publish (${JSON.stringify(REAL_ROOM_STATE).length} B / ${measureValue(REAL_ROOM_STATE).nodes} nodes / depth ${measureValue(REAL_ROOM_STATE).depth}) is relayed byte-identical on the shipped defaults`);
    ok(JSON.stringify(gotRoom?.value) === JSON.stringify(realRoom),
      `…and so is a committed room descriptor (${JSON.stringify(realRoom).length} B / ${measureValue(realRoom).nodes} nodes / depth ${measureValue(realRoom).depth}, the deepest real value in the tree)`);

    p[3].send(makeWire({ ch: 'gp', data: { buttons: 3 } }));
    const wire = await p[0].waitFor((m) => m.type === MSG.WIRE);
    ok(wire.id === p[3].selfId && wire.ch === 'gp', 'WIRE relayed and id-stamped');

    // RELAY-2, end to end on the shipped defaults: an over-cap WIRE is refused by
    // the RELAY (not by `ws`'s 1 MiB maxPayload — this frame is 8 kB) and never
    // reaches the room, while the socket keeps working. The marker frame is sent
    // second on the same socket, so TCP ordering makes "the big one is missing"
    // an assertion rather than a race.
    p[3].send(makeWire({ ch: 'gp', data: { pad: 'x'.repeat(HUB_LIMITS.wireBytes) } }));
    p[3].send(makeWire({ ch: 'gp', data: { buttons: 7 } }));
    const marker = await p[0].waitFor((m) => m.type === MSG.WIRE && m.data?.buttons === 7).catch(() => null);
    ok(!!marker && p[0].count((m) => m.type === MSG.WIRE && typeof m.data?.pad === 'string') === 0,
      `an over-cap WIRE (> ${HUB_LIMITS.wireBytes} B) is dropped by the relay and the sender keeps working`);

    // A late joiner still converges on the room's persisted state.
    const late = await join(LOOSE_PORT, room, 'LATE');
    // The state replay follows HELLO on the same socket, but not necessarily in
    // the same 'message' event batch — wait for it rather than sampling.
    const replay = await late.waitFor((m) => m.type === MSG.STATE && m.key === 'tv').catch(() => null);
    ok(replay?.value?.file === 'game.nes', 'a 5th (late) joiner still gets the room-state replay');
    for (const c of [...p, late]) c.ws.close();
    await sleep(150);
  }

  // ------------------------------------------------------ 7. room id bounds
  console.log('\n--- room id normalisation ---');
  {
    const nasty = `${'A'.repeat(200)}/../../etc/passwd`;
    const c = await join(LOOSE_PORT, nasty, 'N');
    const hello = c.msgs.find((m) => m.type === MSG.HELLO);
    ok(hello.room.length <= 40 && /^[A-Za-z0-9_-]+$/.test(hello.room),
      `a 216-char path-shaped room name is normalised to "${hello.room}" (${hello.room.length} chars, safe charset)`);
    c.ws.close();
    await sleep(100);
  }

  // ------------------------------------------------------- 8. empty rooms
  console.log('\n--- empty-room reaping (Hub.sweepEmptyRooms, in-process) ---');
  {
    const h = new Hub();
    h.connect('r1', 'p1', {});
    h.setState('r1', 'p1', { key: 'prop:a', value: { n: 1 } });
    h.rooms.get('r1').delete('p1');                 // simulate a missed teardown
    ok(h.roomCount() === 1 && h.roomState.get('r1')?.size === 1,
      'control: a leaked empty room and its state map are still resident before the sweep');
    const swept = h.sweepEmptyRooms();
    ok(h.roomCount() === 0 && !h.roomState.has('r1') && swept.rooms === 1,
      `the sweep reaps it (${JSON.stringify(swept)})`);
    const h2 = new Hub();
    h2.connect('live', 'p1', {});
    h2.sweepEmptyRooms();
    ok(h2.roomCount() === 1, 'control: a room that still has a peer is NOT reaped');
  }

  // ------------------------------------------- 8b. every knob is documented
  // server/README.md calls itself "every env knob", and it was wrong: it
  // documented 24 of the 26 that existed, silently omitting ROOM_MAX_NICK_LEN
  // and ROOM_MAX_COLOR_LEN — both of which change observable behaviour
  // (Hub.identify truncates a nick to them). A prose claim nothing checks decays
  // on the next knob added, so check it: every env var the server modules read
  // must have a row in the table, and every documented row must be real.
  //
  // The first version of this guard decayed exactly that way within one session.
  // It scanned only room-server.mjs and Hub.js, hard-exempted LOG_PORT as
  // "documented but not read here", and asserted nothing tighter than
  // `size >= 25` — so the README's own "All N are in the tables below" sentence
  // was free to disagree with the table it introduces, and the three other knobs
  // log-server.mjs reads (LOG_TOKEN, LOG_CORS_ORIGINS, LOG_DIR) were invisible
  // to it by construction. Both holes are closed below: log-server.mjs is part
  // of THIS process (room-server.mjs imports it), so it is part of the scan, and
  // every number the prose states is parsed out and checked against reality.
  console.log('\n--- server/README.md documents every env knob (both directions) ---');
  {
    const ENV_RE = /env(?:Int|IntZeroOk)\('([A-Z_]+)'|process\.env\??[.[]'?([A-Z_]+)/g;
    const knobsIn = (f) => new Set([...readFileSync(pathJoin(ROOT, f), 'utf8').matchAll(ENV_RE)]
      .map((m) => m[1] || m[2]));
    // log-server.mjs is imported by room-server.mjs and runs in the same process,
    // so its knobs are this server's knobs — no exemptions, no special cases.
    const perModule = {
      'room-server.mjs': knobsIn('server/room-server.mjs'),
      'Hub.js': knobsIn('server/Hub.js'),
      'log-server.mjs': knobsIn('server/log-server.mjs'),
    };
    const inCode = new Set(Object.values(perModule).flatMap((s) => [...s]));
    const doc = readFileSync(pathJoin(ROOT, 'server/README.md'), 'utf8');
    const docRows = [...doc.matchAll(/^\| `([A-Z_]+)`/gm)].map((m) => m[1]);
    const inDoc = new Set(docRows);
    const undocumented = [...inCode].filter((k) => !inDoc.has(k)).sort();
    const invented = [...inDoc].filter((k) => !inCode.has(k)).sort();
    ok(inCode.size >= 25 && inDoc.size >= 25,
      `the scan found real data on both sides (${inCode.size} knobs in the code, ${inDoc.size} rows in the README)`);
    // The table can only be one row per knob: a duplicated row would let a knob
    // be "documented" twice and mask a missing one in any count-based check.
    ok(docRows.length === inDoc.size,
      `no knob is documented twice (${docRows.length} rows, ${inDoc.size} distinct)`);
    // The prose that introduces the tables states four numbers. Every one of them
    // is checked here, against the code and against the table — that sentence is
    // the thing that was wrong twice, so it does not get to go unverified.
    const claim = doc.match(
      /All \*\*(\d+)\*\* are in the tables below: the (\d+) read by `room-server\.mjs`, the (\d+) in\s+`Hub\.js`'s `HUB_LIMITS`, and the (\d+) read by `log-server\.mjs`/);
    ok(!!claim, 'the README still states its knob counts in the expected sentence');
    if (claim) {
      const [total, roomN, hubN, logN] = claim.slice(1).map(Number);
      ok(total === inDoc.size,
        `the prose count matches the table it introduces (says ${total}, table has ${inDoc.size})`);
      ok(total === inCode.size,
        `the prose count matches the code (says ${total}, server reads ${inCode.size})`);
      ok(roomN + hubN + logN === total,
        `the per-module breakdown sums to the total (${roomN}+${hubN}+${logN} = ${roomN + hubN + logN}, claimed ${total})`);
      for (const [file, claimed] of [['room-server.mjs', roomN], ['Hub.js', hubN], ['log-server.mjs', logN]]) {
        ok(perModule[file].size === claimed,
          `${file} really reads the ${claimed} knobs the README credits it with (found ${perModule[file].size})`);
      }
    }
    // …and the log server's knobs specifically: the earlier guard was blind to
    // three of these four, which is how they stayed undocumented.
    for (const k of ['LOG_PORT', 'LOG_DIR', 'LOG_TOKEN', 'LOG_CORS_ORIGINS']) {
      ok(inDoc.has(k) && perModule['log-server.mjs'].has(k),
        `${k} is read by log-server.mjs and documented (no exemption)`);
    }
    ok(undocumented.length === 0, `every env knob the server reads has a README row (missing: ${undocumented.join(', ') || 'none'})`);
    ok(invented.length === 0, `every README row is a knob the server actually reads (stale: ${invented.join(', ') || 'none'})`);
    for (const k of ['ROOM_MAX_NICK_LEN', 'ROOM_MAX_COLOR_LEN', 'ROOM_MAX_STATE_VALUE_NODES', 'ROOM_STATE_NODE_COST_BYTES']) {
      ok(inDoc.has(k) && inCode.has(k), `${k} is both read and documented`);
    }
    // …and the two that were missing really do change behaviour, which is why
    // "it's only cosmetic" was not a reason to leave them out.
    const h = new Hub({ limits: { nickLen: 4, colorLen: 3 } });
    h.connect('nk', 'p1', {});
    const { broadcast } = h.identify('nk', 'p1', { nick: 'abcdefgh', color: '#ff0000' });
    ok(broadcast.msg.nick === 'abcd' && broadcast.msg.color === '#ff',
      `ROOM_MAX_NICK_LEN/ROOM_MAX_COLOR_LEN truncate rather than reject ("abcdefgh"→"${broadcast.msg.nick}", "#ff0000"→"${broadcast.msg.color}")`);
  }

  await Promise.all([stop(tight), stop(loose)]);
  tight = loose = null;

  // ------------------------------------------------------- 9. Origin check
  console.log('\n--- Origin allow-list (opt-in) ---');
  {
    const s = startServer(TIGHT_PORT, { ...TIGHT_ENV, ROOM_ALLOWED_ORIGINS: 'https://dionysus.dk' });
    await s.ready;
    const bad = await tryJoin(TIGHT_PORT, 'origin', 'BAD', { headers: { Origin: 'https://evil.example' } });
    ok(!bad.ok && /403/.test(bad.reason), `a foreign Origin is refused with 403 — "${bad.reason}"`);
    const good = await tryJoin(TIGHT_PORT, 'origin', 'GOOD', { headers: { Origin: 'https://dionysus.dk' } });
    ok(good.ok, 'control: the deployed origin still connects');
    const none = await tryJoin(TIGHT_PORT, 'origin', 'NONE');
    ok(none.ok, 'control: a non-browser client with no Origin header still connects (smoke tests, curl)');
    for (const r of [good, none]) r.c?.ws?.close();
    await stop(s);
  }
  {
    const s = startServer(LOOSE_PORT, LOOSE_ENV);
    await s.ready;
    const any = await tryJoin(LOOSE_PORT, 'origin', 'ANY', { headers: { Origin: 'https://some.headset.example' } });
    ok(any.ok, 'control: with ROOM_ALLOWED_ORIGINS unset (the shipped default) ANY origin connects — production is not broken');
    any.c?.ws?.close();
    await stop(s);
  }

  // ------------------------------------------- 10. uncaughtException containment
  console.log('\n--- crash containment (an unhandled throw must not kill netplay) ---');
  {
    const boom = (killHandler) => [
      '--input-type=module', '-e',
      `import(${JSON.stringify(pathToFileURL(SERVER).href)}).then(() => {` +
      (killHandler ? "process.removeAllListeners('uncaughtException');" : '') +
      "setTimeout(() => { throw new Error('simulated log-server bug'); }, 400); });",
    ];

    const survivor = startServer(TIGHT_PORT, { ...TIGHT_ENV }, { args: boom(false) });
    await survivor.ready;
    await sleep(1200);
    ok(survivor.exited === null, 'with the handler: the process is STILL RUNNING 800 ms after an uncaught throw');
    ok(/UNCAUGHT/.test(survivor.log()), 'with the handler: it logged the exception loudly');
    const alive = await tryJoin(TIGHT_PORT, 'after-boom', 'A');
    ok(alive.ok, 'with the handler: the relay still accepts a new peer afterwards');
    const hello = alive.ok ? await alive.c.waitFor((m) => m.type === MSG.HELLO) : null;
    ok(!!hello?.selfId, 'with the handler: that peer gets a normal HELLO — netplay survived');
    alive.c?.ws?.close();
    await stop(survivor);

    // Negative control: the SAME throw, with only the handler removed.
    const victim = startServer(LOOSE_PORT, { ...LOOSE_ENV }, { args: boom(true) });
    await victim.ready;
    await sleep(1400);
    ok(victim.exited !== null && victim.exited !== 0,
      `negative control: without the handler the identical throw kills the process (exit ${victim.exited})`);
    await stop(victim);
  }

  // ------------------------------------- 11. rate violations DECAY over time
  // ROOM_MAX_RATE_VIOLATIONS used to be counted against a LIFETIME counter that
  // was set to 0 at connect and only ever incremented. "600 violations" therefore
  // meant "the 600th over-budget message this socket ever sent", so a headset
  // parked in a room all evening — dropping a handful of frames on each wake from
  // a compositor stall or Wi-Fi roam — accumulated its way to a 4008 mid-game,
  // with nothing client-side that retries a 4008.
  //
  // Now it is a leaky bucket that drains MAX_RATE_VIOLATIONS per window. The
  // client below is the long-session shape: six separated bursts that drop ~10
  // messages each — 60 lifetime drops against a cap of 20 — spaced further apart
  // than the window, so the score never reaches the cap.
  //
  // The negative control is the SAME server, SAME client, with only the decay
  // window widened to an hour: the score then behaves exactly like the old
  // lifetime counter and the socket is closed with 4008. That isolates the decay.
  console.log('\n--- rate-violation score decays (a long session is not killed by its own history) ---');
  {
    const RATE_ENV = {
      LOG_PORT: '8896',
      ROOM_MSG_RATE: '10', ROOM_MSG_BURST: '10', ROOM_MAX_RATE_VIOLATIONS: '20',
    };
    const ROUNDS = 6, PER_ROUND = 20;                   // 10 pass, ~10 dropped per round

    const longSession = async (port, windowMs, label) => {
      const s = startServer(port, { ...RATE_ENV, ROOM_RATE_VIOLATION_WINDOW_MS: String(windowMs) });
      await s.ready;
      const a = await join(port, 'long', 'A');
      const w = await join(port, 'long', 'W');
      for (let r = 0; r < ROUNDS; r++) {
        for (let i = 0; i < PER_ROUND; i++) a.send(makePose({ head: HEAD }));
        await sleep(1200);                              // > the 1000 ms decay window
      }
      await sleep(300);
      const relayed = w.count((m) => m.type === MSG.POSE);
      const res = { code: a.closeCode, sent: ROUNDS * PER_ROUND, relayed, dropped: ROUNDS * PER_ROUND - relayed };
      console.log(`       ${label}: sent ${res.sent}, relayed ${res.relayed}, dropped ${res.dropped}, closeCode ${res.code}`);
      a.ws.close(); w.ws.close();
      await stop(s);
      return res;
    };

    const decaying = await longSession(TIGHT_PORT, 1000, 'window 1000 ms (the fix)');
    ok(decaying.dropped > 20,
      `the session really did exceed the ${RATE_ENV.ROOM_MAX_RATE_VIOLATIONS}-violation cap in LIFETIME terms (${decaying.dropped} drops)`);
    ok(decaying.code === null,
      `…and was NOT closed, because the score decayed between bursts (closeCode ${decaying.code})`);
    ok(decaying.relayed >= ROUNDS * 8,
      `…and kept relaying throughout (${decaying.relayed} poses reached the room)`);

    const lifetime = await longSession(LOOSE_PORT, 3600000, 'window 1 h (negative control = the old lifetime counter)');
    ok(lifetime.code === 4008,
      `NEGATIVE CONTROL: with the window widened to an hour the score never drains and the identical client IS closed with 4008 (got ${lifetime.code})`);
    ok(lifetime.relayed < decaying.relayed,
      `NEGATIVE CONTROL: it was killed part-way through, so it relayed only ${lifetime.relayed} of the ${decaying.relayed} poses the decaying build got through`);
  }

  // ------------------------------ 12. bufferedAmount eviction + a reachable 4009
  // This had ZERO coverage: nothing in the suite had ever made a socket back up.
  //
  // Two things are asserted. (a) The eviction fires at all — a client that stops
  // reading is dropped and the room sees it leave. (b) The 4009 close code is
  // actually REACHABLE. It was not: `ws.close(4009,'slow client')` was followed on
  // the next line by `ws.terminate()`, which destroys the socket before a close
  // frame queued behind >4 MiB of backlog can flush, so every evicted peer saw a
  // bare 1006 and the reason string was a lie. The fix gives close() a grace
  // period; the negative control sets that grace to 0 (the old behaviour) and
  // shows the SAME eviction delivering 1006 instead.
  console.log('\n--- backpressure eviction (bufferedAmount) + the 4009 close code ---');
  {
    const BP_ENV = {
      LOG_PORT: '8896',
      ROOM_MAX_BUFFERED_BYTES: '65536',                 // evict a socket at 64 kB queued
      ROOM_MSG_RATE: '2000', ROOM_MSG_BURST: '2000',    // the sender must not be rate-limited
    };

    const stall = async (port, graceMs, label) => {
      const s = startServer(port, { ...BP_ENV, ROOM_BACKPRESSURE_GRACE_MS: String(graceMs) });
      await s.ready;
      const victim = await join(port, 'stall', 'VICTIM');
      const obs = await join(port, 'stall', 'OBS');
      const sender = await join(port, 'stall', 'SENDER');
      // Stop reading, exactly like a suspended headset tab / half-open TCP peer.
      victim.ws._socket.pause();
      // DIRECTED at the victim (SIGNAL, not a broadcast) on purpose: a broadcast
      // would push the same 13 MB at the observer too, and at a 64 kB eviction
      // threshold even a healthy reader gets evicted mid-blast — which would make
      // "the room saw it leave" untestable and the whole section ambiguous.
      for (let i = 0; i < FAT_FRAMES; i++) {
        sender.send(makeSignal({ to: victim.selfId, kind: 'offer', data: { sdp: FAT } }));
      }
      await sleep(900);
      // Start reading again INSIDE the grace window: a merely-slow client drains
      // its backlog and should then see the close frame that was queued behind it.
      victim.ws._socket.resume();
      const closed = await victim.closed(6000);
      // The CLIENT sees the close frame before the server finishes its own
      // closing handshake, so the room's LEAVE lands a moment later — wait for it
      // rather than sampling the instant the client's socket reports closed.
      await obs.waitFor((m) => m.type === MSG.LEAVE, 4000).catch(() => null);
      const left = obs.count((m) => m.type === MSG.LEAVE);
      const evicted = /x evicting/.test(s.log());
      console.log(`       ${label}: evicted=${evicted} closeCode=${closed.code} reason="${closed.reason}" observerSawLeave=${left}`);
      for (const c of [obs, sender]) c.ws.close();
      await stop(s);
      return { ...closed, evicted, left };
    };

    const graceful = await stall(TIGHT_PORT, 4000, 'grace 4000 ms (the fix)');
    ok(graceful.evicted, 'the server evicted the socket that stopped reading (bufferedAmount > 64 kB)');
    ok(graceful.left >= 1, `…and the rest of the room saw it leave (${graceful.left} LEAVE)`);
    ok(graceful.code === 4009 && graceful.reason === 'slow client',
      `…and the peer received the 4009 BACKPRESSURE code with its reason (got ${graceful.code} "${graceful.reason}")`);

    const abrupt = await stall(LOOSE_PORT, 0, 'grace 0 ms (negative control = the old terminate-immediately)');
    ok(abrupt.evicted, 'NEGATIVE CONTROL: the identical stall evicts the socket too — same code path');
    ok(abrupt.code !== 4009,
      `NEGATIVE CONTROL: …but with no grace the close frame never flushes and the peer sees ${abrupt.code} instead of 4009 — which is what the old code always did`);
  }

  // ------------------------- 13. AGGREGATE outbound budget (the heartbeat sweep)
  // ROOM_MAX_BUFFERED_BYTES is per socket, so on its own it multiplies out to
  // ROOM_MAX_SOCKETS x 4 MiB = 1 GiB — the same "each cap is fine, nobody added
  // them up" shape as the STATE caps. The heartbeat now sums bufferedAmount
  // across every client and evicts the biggest offenders until the PROCESS total
  // is under ROOM_MAX_BUFFERED_TOTAL_BYTES.
  //
  // The per-socket cap is raised out of the way here (100 MiB) so the only thing
  // that can evict is the aggregate sweep, and the assertion is on the sweep's own
  // log line — the heartbeat's unrelated dead-socket path would also close a
  // paused peer eventually, and "the socket closed" alone cannot tell them apart.
  console.log('\n--- aggregate outbound budget (ROOM_MAX_BUFFERED_TOTAL_BYTES) ---');
  {
    const AGG_ENV = {
      LOG_PORT: '8896',
      ROOM_MAX_BUFFERED_BYTES: String(100 * 1024 * 1024),   // per-socket cap effectively off
      ROOM_HEARTBEAT_MS: '1500',
      ROOM_BACKPRESSURE_GRACE_MS: '4000',
      ROOM_MSG_RATE: '2000', ROOM_MSG_BURST: '2000',
    };

    const sweep = async (port, totalBudget, label) => {
      const s = startServer(port, { ...AGG_ENV, ROOM_MAX_BUFFERED_TOTAL_BYTES: String(totalBudget) });
      await s.ready;
      const victim = await join(port, 'agg', 'VICTIM');
      const sender = await join(port, 'agg', 'SENDER');
      victim.ws._socket.pause();
      for (let i = 0; i < FAT_FRAMES; i++) sender.send(makeSignal({ to: victim.selfId, kind: 'offer', data: { sdp: FAT } }));
      await sleep(2200);                       // one heartbeat tick (1500 ms), not two
      const swept = /aggregate backpressure/.test(s.log());
      victim.ws._socket.resume();
      const closed = await victim.closed(5000);
      console.log(`       ${label}: aggregateSweep=${swept} closeCode=${closed.code}`);
      sender.ws.close();
      await stop(s);
      return { swept, code: closed.code };
    };

    const over = await sweep(TIGHT_PORT, 256 * 1024, 'total budget 256 kB (the fix)');
    ok(over.swept, '~13 MB queued for one stalled socket trips the process-wide budget in the heartbeat sweep');
    ok(over.code === 4009, `…and the socket is evicted with the same 4009/"slow client" contract (got ${over.code})`);

    const under = await sweep(LOOSE_PORT, 1024 * 1024 * 1024, 'total budget 1 GiB (negative control)');
    ok(!under.swept,
      'NEGATIVE CONTROL: identical stall, budget raised to 1 GiB — the sweep does not fire, so it is the budget doing the work and not the heartbeat\'s dead-socket path');
    ok(under.code !== 4009,
      `NEGATIVE CONTROL: …and nothing evicts the socket (got ${under.code})`);
  }

  // ------- 13b. the aggregate budget WITHOUT a heartbeat to hide behind (RELAY-1)
  // Section 13 above passes only because it shortens ROOM_HEARTBEAT_MS to 1500 ms.
  // Production runs 10 s, and the aggregate budget used to be enforced ONLY in
  // that sweep — so the real transient ceiling was ROOM_MAX_SOCKETS x
  // ROOM_MAX_BUFFERED_BYTES (256 x 4 MiB ≈ 1.25 GiB), reachable in well under a
  // second, and the advertised 32 MiB was a ten-second AVERAGE rather than a
  // ceiling. The check now also runs on the send path, where the bytes are
  // actually queued.
  //
  // So: the same stall, with the heartbeat set LONGER THAN THE WHOLE RUN. Anything
  // that evicts here can only be the send-path check. The negative control puts
  // ROOM_BUFFER_SWEEP_MS past the run too — which IS the pre-fix build, heartbeat
  // only — and must not evict. The third case is the regression that matters more
  // than the DoS: a legitimate late joiner draining a big room-state replay must
  // survive a sweep that now runs on every send.
  console.log('\n--- aggregate budget enforced ON SEND, not once per heartbeat (RELAY-1) ---');
  {
    const NOHB_ENV = {
      LOG_PORT: '8896',
      ROOM_MAX_BUFFERED_BYTES: String(100 * 1024 * 1024),    // per-socket cap effectively off
      ROOM_MAX_BUFFERED_TOTAL_BYTES: String(4 * 1024 * 1024),
      ROOM_HEARTBEAT_MS: '60000',                            // longer than this whole section
      ROOM_BACKPRESSURE_GRACE_MS: '4000',
      ROOM_MSG_RATE: '2000', ROOM_MSG_BURST: '2000',
    };

    const stall = async (port, sweepMs, label) => {
      const s = startServer(port, { ...NOHB_ENV, ROOM_BUFFER_SWEEP_MS: String(sweepMs) });
      await s.ready;
      const victim = await join(port, 'nohb', 'VICTIM');
      const sender = await join(port, 'nohb', 'SENDER');
      victim.ws._socket.pause();
      for (let i = 0; i < FAT_FRAMES; i++) sender.send(makeSignal({ to: victim.selfId, kind: 'offer', data: { sdp: FAT } }));
      await sleep(1200);                       // 1/50th of the heartbeat period
      const swept = /aggregate backpressure \(send\)/.test(s.log());
      victim.ws._socket.resume();
      const closed = await victim.closed(5000);
      console.log(`       ${label}: sendPathSweep=${swept} closeCode=${closed.code} (the 60 s heartbeat never ran)`);
      sender.ws.close();
      await stop(s);
      return { swept, code: closed.code };
    };

    const onSend = await stall(TIGHT_PORT, 0, 'ROOM_BUFFER_SWEEP_MS=0 (the fix, unthrottled)');
    ok(onSend.swept,
      '~13 MB queued past a 4 MiB total budget is caught ON THE SEND PATH within 1.2 s — no heartbeat has run');
    ok(onSend.code === 4009,
      `…and the stalled socket is evicted with the same 4009/"slow client" contract (got ${onSend.code})`);

    const hbOnly = await stall(LOOSE_PORT, 3600000, 'ROOM_BUFFER_SWEEP_MS=1 h (negative control = heartbeat-only enforcement)');
    ok(!hbOnly.swept,
      'NEGATIVE CONTROL: with the send-path check throttled past the run, the identical stall goes unnoticed — which is exactly what the shipped build did for up to 10 s at a time');
    ok(hbOnly.code !== 4009,
      `NEGATIVE CONTROL: …and nothing evicts the socket (got ${hbOnly.code})`);

    // The eviction is not allowed to become trigger-happy: the sweep now runs
    // during ordinary sends, and the biggest legitimate queue in this app is a
    // late joiner's room-state replay (server/README.md keeps the per-socket cap
    // ABOVE the per-room STATE budget for precisely this reason).
    const s = startServer(TIGHT_PORT, { ...NOHB_ENV, ROOM_BUFFER_SWEEP_MS: '0' });
    await s.ready;
    const host = await join(TIGHT_PORT, 'latejoin', 'HOST');
    const CHUNK = 'c'.repeat(120000);
    for (let i = 0; i < 6; i++) host.send(makeState({ key: `prop:big${i}`, value: CHUNK }));
    await sleep(500);
    const late = await join(TIGHT_PORT, 'latejoin', 'LATE');
    const replay = await late.waitFor((m) => m.type === MSG.STATE && m.key === 'prop:big5', 4000).catch(() => null);
    const lateClose = await late.closed(700);
    ok(!!replay, 'a late joiner still receives the whole ~720 kB room-state replay with the send-path sweep running on every frame of it');
    ok(lateClose.code === null,
      `…and is NOT evicted by it (closeCode ${lateClose.code}) — the sweep only acts when the PROCESS total is over budget, and then only on the biggest queue`);
    host.ws.close(); late.ws.close();
    await stop(s);
  }

  // ------------------------------- 14. per-address admission control (RELAY-3)
  // Before this, `verifyClient` capped only GLOBAL sockets/rooms and per-room
  // peers: one client could hold all 256 sockets (every later headset gets a 503)
  // and — worse — could CHURN for free, because the per-socket token bucket is
  // created fresh in the connection handler, so reconnecting reset it. Each of
  // those upgrades makes the server replay the room's whole STATE map, so a TCP
  // handshake buys up to ~2 MiB of serialization on a single-threaded relay.
  //
  // The two hazards this must not introduce are both asserted below: a spoofable
  // key (any client could then buy a fresh budget with a header) and, in the other
  // direction, billing every proxied headset in the world to 127.0.0.1.
  console.log('\n--- per-address caps: concurrent sockets (RELAY-3) ---');
  {
    const s = startServer(TIGHT_PORT, {
      LOG_PORT: '8896', ROOM_MAX_SOCKETS_PER_IP: '4', ROOM_MAX_UPGRADES_PER_IP: '1000',
      // Raised for the residency assertion below only: a refused socket has to
      // still BE there when the next upgrade is judged, or the claim it makes is
      // vacuous. Harmless to everything else here — the `ws` clients answer their
      // close frame and leave regardless of how long the terminate timer is.
      ROOM_REFUSAL_GRACE_MS: '5000',
    });
    await s.ready;
    // Assert the relay we are about to talk to is the one we just configured.
    // Not paranoia: when a spawn lost a bind race the clients below silently
    // talked to the PREVIOUS section's server and every cap "failed to fire".
    ok(await s.waitLog(/per-address: 4 sockets/), 'the relay under test came up with the tightened per-address cap in its own boot line');
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await join(TIGHT_PORT, `ip${i}`, `H${i}`));
    ok(held.length === 4, 'control: the first 4 sockets from one address connect normally (a household of headsets is not the target)');
    const fifth = await admit(TIGHT_PORT, 'ip-extra', 'FIFTH');
    ok(!fifth.admitted && fifth.code === 1013 && /too many connections/.test(fifth.reason),
      `the 5th is refused with a retryable 1013 — "${fifth.reason}"`);
    // Spoof control: with ROOM_TRUST_PROXY unset the header is ignored outright,
    // so a client cannot buy itself a fresh budget by inventing a forwarded hop.
    const spoof = await admit(TIGHT_PORT, 'ip-spoof', 'SPOOF', { headers: { 'X-Forwarded-For': '9.9.9.9' } });
    ok(!spoof.admitted && /too many connections/.test(spoof.reason),
      `…and an X-Forwarded-For header buys nothing while ROOM_TRUST_PROXY is unset — still "${spoof.reason}"`);
    // A refused socket must not itself hold a slot: if surveyClients() counted
    // one the refusals would compound, and one turned-away headset would make the
    // next one likelier to be turned away too.
    //
    // Proving that needs a refused socket that is STILL RESIDENT when the next
    // upgrade is judged, and a `ws` client is not one — it answers the close frame
    // within a loopback RTT and is out of wss.clients before the next attempt
    // (see rawUpgrade()'s docstring). The version of this assertion that used
    // `admit()` for both halves therefore passed against a deliberately broken
    // build whose surveyClients() counted `_refused` sockets, because by the time
    // it asked there was nothing left to miscount. A raw socket answers nothing
    // and sits in the client set for the whole 5 s grace this server was started
    // with, so the count below is taken while a refusal is genuinely resident.
    const stuck = await rawUpgrade(TIGHT_PORT, 'ip-stuck');
    ok(stuck.status === 101,
      'control: the extra upgrade was refused the SOFT way (101), so it really is a resident socket and not a killed handshake');
    const fifthAgain = await admit(TIGHT_PORT, 'ip-extra2', 'FIFTH2');
    ok(!fifthAgain.admitted && /\(4\/4\)/.test(fifthAgain.reason),
      `a socket that was itself refused does not count toward the cap — with one still resident the next refusal reads 4/4, not 5/4 ("${fifthAgain.reason}")`);
    try { stuck.sock.destroy(); } catch { /* gone */ }
    // Freeing a slot must free the cap, or a headset that reconnects after a
    // Wi-Fi drop would be locked out by its own ghost.
    held.pop().ws.close();
    await sleep(300);
    const again = await admit(TIGHT_PORT, 'ip-again', 'AGAIN');
    ok(again.admitted, 'control: closing one socket frees the slot and the same address connects again');
    again.c?.ws?.close();
    for (const c of held) c.ws.close();
    await stop(s);
  }

  console.log('\n--- per-address caps: upgrade rate, the churn amplifier (RELAY-3) ---');
  {
    const s = startServer(TIGHT_PORT, {
      LOG_PORT: '8896', ROOM_MAX_SOCKETS_PER_IP: '64',
      ROOM_MAX_UPGRADES_PER_IP: '3', ROOM_UPGRADE_WINDOW_MS: '60000',
    });
    await s.ready;
    ok(await s.waitLog(/per-address: 64 sockets, 3 upgrades per 60000ms/),
      'the relay under test came up with a 3-upgrade budget and the concurrent cap out of the way — so only the RATE can refuse anything below');
    for (let i = 0; i < 3; i++) {
      const c = await join(TIGHT_PORT, 'churn', `C${i}`);
      c.ws.close();
      await sleep(80);
    }
    const fourth = await admit(TIGHT_PORT, 'churn', 'C4');
    ok(!fourth.admitted && fourth.code === 1013 && /too many connection attempts/.test(fourth.reason),
      `connect/disconnect churn is throttled even though it holds NO sockets — the 4th upgrade in the window is refused ("${fourth.reason}")`);
    await stop(s);

    const l = startServer(LOOSE_PORT, { LOG_PORT: '8897', ROOM_MAX_UPGRADES_PER_IP: '100' });
    await l.ready;
    let cycles = 0;
    for (let i = 0; i < 6; i++) {
      const r = await admit(LOOSE_PORT, 'churn', `L${i}`);
      if (!r.admitted) break;
      cycles++;
      r.c.ws.close();
      await sleep(60);
    }
    ok(cycles === 6,
      `NEGATIVE CONTROL: with the budget at 100/min the identical loop is never throttled (${cycles}/6 reconnects accepted) — a headset that flaps its Wi-Fi is not the target`);
    await stop(l);
  }

  console.log('\n--- per-address caps behind a proxy (ROOM_TRUST_PROXY) ---');
  {
    // On the deployed box Apache proxies from 127.0.0.1, so keying on the socket
    // address would bill the entire internet to one key and refuse the 3rd
    // connection to the whole site. Keyed on X-Forwarded-For instead — the LAST
    // hop, which is the one the proxy itself appended.
    const s = startServer(TIGHT_PORT, {
      LOG_PORT: '8896', ROOM_TRUST_PROXY: '1', ROOM_MAX_SOCKETS_PER_IP: '2', ROOM_MAX_UPGRADES_PER_IP: '1000',
    });
    await s.ready;
    ok(await s.waitLog(/keyed on the last X-Forwarded-For hop/),
      'the relay under test says in its boot line that it is keyed on the forwarded address, not the socket address');
    const xff = (v) => ({ headers: { 'X-Forwarded-For': v } });
    const a1 = await admit(TIGHT_PORT, 'prox', 'A1', xff('203.0.113.7'));
    const a2 = await admit(TIGHT_PORT, 'prox', 'A2', xff('203.0.113.7'));
    ok(a1.admitted && a2.admitted, 'two connections from one forwarded address are accepted');
    const a3 = await admit(TIGHT_PORT, 'prox', 'A3', xff('203.0.113.7'));
    ok(!a3.admitted && /too many connections/.test(a3.reason), `…and the 3rd from that same forwarded address is refused ("${a3.reason}")`);
    // A client that fabricates a first hop still has the proxy append the address
    // it really came from, so the LAST entry is the one it cannot forge. Reading
    // the FIRST (the usual "original client" convention) is what would make this
    // cap free to evade.
    const chained = await admit(TIGHT_PORT, 'prox', 'CHAIN', xff('1.2.3.4, 203.0.113.7'));
    ok(!chained.admitted && /too many connections/.test(chained.reason),
      `a spoofed first hop does not escape the cap — "1.2.3.4, 203.0.113.7" is billed to the LAST hop ("${chained.reason}")`);
    const b1 = await admit(TIGHT_PORT, 'prox', 'B1', xff('198.51.100.9'));
    ok(b1.admitted, 'control: a DIFFERENT forwarded address has its own budget — one household cannot lock out another');
    // Header absent while trusting the proxy ⇒ exempt, never lumped into one
    // bucket: a proxy that turns out not to send XFF must degrade to the old
    // global-caps-only behaviour, not to a site-wide outage at the 3rd visitor.
    const bare = [];
    for (let i = 0; i < 3; i++) bare.push(await admit(TIGHT_PORT, 'prox', `N${i}`));
    ok(bare.every((r) => r.admitted),
      'with no X-Forwarded-For at all, connections are EXEMPT rather than all billed to one key — a proxy that does not forward the header degrades to no per-IP cap, not to an outage');
    for (const r of [a1, a2, b1, ...bare]) r.c?.ws?.close();
    await stop(s);
  }

  // ------- 14b. the JOIN-TIME REPLAY goes through the outbound budget too
  // RELAY-1 put the aggregate check on the send path, but the biggest single
  // outbound write in the relay did not use that path: the connection handler
  // did `ws.send(encode(hello))` and then one raw `ws.send()` per key of the
  // room's STATE map. So the one write RELAY-3's own comment calls "the
  // expensive thing a handshake buys" — up to a room's whole 2 MiB — passed
  // NEITHER the per-socket cap NOR the process total, and sockets that join and
  // then read nothing could pile up hundreds of MiB with only the 10 s heartbeat
  // behind them. Both halves are asserted here against a real replay, each with
  // the control that shows the same replay is untouched when the budget is fine.
  console.log('\n--- the join-time HELLO + STATE replay is budgeted like every other send (RELAY-1) ---');
  {
    const OFF = String(100 * 1024 * 1024);      // "this cap is not the one under test"
    const REPLAY_ENV = {
      LOG_PORT: '8896',
      ROOM_HEARTBEAT_MS: '60000',               // longer than this whole section: no sweep can rescue anything
      ROOM_MSG_RATE: '2000', ROOM_MSG_BURST: '2000',
      ROOM_BACKPRESSURE_GRACE_MS: '5000',
      // The STATE budgets are raised out of the way: this section is about the
      // OUTBOUND queue, and on the shipped 1 MiB-per-peer budget the host's 5th
      // 200 kB write is refused, so there would be no big replay to measure.
      ROOM_MAX_STATE_VALUE_BYTES: String(256 * 1024),
      ROOM_MAX_STATE_BYTES_PER_PEER: String(8 * 1024 * 1024),
      ROOM_MAX_STATE_BYTES_PER_ROOM: String(16 * 1024 * 1024),
    };
    const CHUNK = 'r'.repeat(200000);
    const KEYS = 8;                             // ~1.6 MB of replay handed to one joiner

    // Fill a room, then join it and report what the joiner got: the LAST replayed
    // key (i.e. the whole replay) and how — or whether — the socket was closed.
    const replayInto = async (env, label) => {
      const s = startServer(TIGHT_PORT, { ...REPLAY_ENV, ...env });
      await s.ready;
      const host = await join(TIGHT_PORT, 'replay', 'HOST');
      for (let i = 0; i < KEYS; i++) host.send(makeState({ key: `prop:r${i}`, value: CHUNK }));
      await sleep(700);
      const late = client(TIGHT_PORT, 'replay', 'LATE');
      // Stop draining the instant the handshake lands. A joiner that is handed a
      // big replay and does not read it is the whole hazard — a suspended tab, a
      // headset mid-sleep — and on loopback a reading client absorbs 1.6 MB
      // faster than the relay can queue it, so without this every arm below
      // measures nothing. `ws` emits 'open' synchronously from setSocket, before
      // any 'data' event has been processed, so no part of the replay has been
      // consumed yet.
      late.ws.once('open', () => { try { late.ws._socket.pause(); } catch { /* gone */ } });
      await late.open();
      await sleep(1500);           // the relay writes the whole replay into a socket nobody is reading
      const swept = /aggregate backpressure \(send\)/.test(s.log());
      try { late.ws._socket.resume(); } catch { /* already destroyed */ }
      const whole = await late.waitFor((m) => m.type === MSG.STATE && m.key === `prop:r${KEYS - 1}`, 3000).catch(() => null);
      const closed = await late.closed(3000);
      console.log(`       ${label}: wholeReplay=${!!whole} closeCode=${closed.code} sendPathSweep=${swept}`);
      host.ws.close(); try { late.ws.close(); } catch { /* already gone */ }
      await stop(s);
      return { whole: !!whole, code: closed.code, swept };
    };

    // (a) PER-SOCKET cap. 1.6 MB of replay written in one tick against a 64 kB
    //     cap: the second frame already sees the first still queued.
    const capped = await replayInto(
      { ROOM_MAX_BUFFERED_BYTES: '65536', ROOM_MAX_BUFFERED_TOTAL_BYTES: OFF },
      'per-socket cap 64 kB');
    ok(!capped.whole && capped.code === 4009,
      `the replay obeys ROOM_MAX_BUFFERED_BYTES: a joiner that outruns its own queue is evicted with 4009 mid-replay (whole=${capped.whole}, code=${capped.code})`);

    // (b) CONTROL for (a): the identical replay to the identical client with the
    //     cap out of the way. Without this, "evicted" could mean "the join path
    //     is broken", not "the join path is now budgeted".
    const roomy = await replayInto(
      { ROOM_MAX_BUFFERED_BYTES: OFF, ROOM_MAX_BUFFERED_TOTAL_BYTES: OFF },
      'both caps out of the way');
    ok(roomy.whole && roomy.code === null,
      `CONTROL: the same joiner receives the entire ~1.6 MB replay and is never closed when the budget is fine (whole=${roomy.whole}, code=${roomy.code})`);

    // (c) AGGREGATE budget. Per-socket cap off, so ONLY the process total can
    //     act — and the heartbeat is 60 s away, so only the SEND path can run it.
    const total = await replayInto(
      { ROOM_MAX_BUFFERED_BYTES: OFF, ROOM_MAX_BUFFERED_TOTAL_BYTES: String(512 * 1024), ROOM_BUFFER_SWEEP_MS: '0' },
      'aggregate 512 kB, send-path sweep on');
    ok(total.swept,
      'the replay runs the AGGREGATE check from the send path — the relay logs "aggregate backpressure (send)" during a join, which it could never do while the replay used a raw ws.send()');
    ok(!total.whole && total.code === 4009,
      `…and the over-budget joiner is evicted by it (whole=${total.whole}, code=${total.code})`);

    // (d) NEGATIVE CONTROL for (c): identical budget, send-path sweep throttled
    //     past the end of the run, heartbeat 60 s away. Nothing enforces the
    //     total, so the same over-budget replay sails through — which is what the
    //     relay did on EVERY join before this fix.
    const unswept = await replayInto(
      { ROOM_MAX_BUFFERED_BYTES: OFF, ROOM_MAX_BUFFERED_TOTAL_BYTES: String(512 * 1024), ROOM_BUFFER_SWEEP_MS: '600000' },
      'aggregate 512 kB, send-path sweep throttled off');
    ok(!unswept.swept && unswept.whole && unswept.code === null,
      `NEGATIVE CONTROL: with the send-path sweep throttled out, the identical over-budget replay is delivered whole and nothing is evicted (swept=${unswept.swept}, whole=${unswept.whole}, code=${unswept.code}) — so (c) measures the check, not the client`);
  }

  // ------- 14c. a slept headset's ghost must not hold its household's slot
  // MAX_SOCKETS_PER_IP counts sockets, and a Quest that sleeps leaves one that
  // answers nothing until the heartbeat reaps it — up to TWO ping periods later.
  // For that whole window a ghost was billed to a live household's address, so
  // the very common "my headset woke up / I relaunched the app" rejoin could be
  // refused by the user's own dead socket. billable() stops counting a socket
  // that has ignored a ping for a quarter of the period, long before the sweep
  // agrees.
  console.log('\n--- a slept headset\'s ghost socket stops holding its address\'s slot ---');
  {
    // One socket per address makes the household's whole budget observable in a
    // single client. The heartbeat is short enough to run in a test and long
    // enough that a quarter of it is genuinely shorter than the period.
    const s = startServer(TIGHT_PORT, {
      LOG_PORT: '8896', ROOM_MAX_SOCKETS_PER_IP: '1', ROOM_MAX_UPGRADES_PER_IP: '1000',
      ROOM_HEARTBEAT_MS: '4800',
    });
    await s.ready;
    ok(await s.waitLog(/per-address: 1 sockets/),
      'the relay under test came up with a one-socket-per-address budget, so one client is the whole household');
    const ghost = await join(TIGHT_PORT, 'ghost', 'GHOST', { autoPong: false });
    // CONTROL, taken BEFORE the relay has asked this socket anything: a socket
    // that has failed nothing holds its slot. Without this pair, the assertion
    // below could equally pass on a cap that stopped counting altogether.
    const early = await admit(TIGHT_PORT, 'ghost', 'EARLY');
    ok(!early.admitted && /too many connections/.test(early.reason),
      `control: a socket that has not been asked anything yet still holds the address's only slot ("${early.reason}")`);
    await new Promise((r) => ghost.ws.once('ping', r));   // the sweep has just pinged the ghost
    await sleep(1500);                                    // > PING_GRACE_MS (4800 / 4 = 1200)
    const rejoin = await admit(TIGHT_PORT, 'ghost', 'REJOIN');
    ok(rejoin.admitted,
      'the same address is admitted once the ghost has ignored a ping for a quarter of the heartbeat — a slept headset cannot lock its own household out for two whole ping periods while the sweep catches up');
    ok(ghost.closeCode === null,
      'and the ghost is still open at this point, so the slot was freed by the liveness check and not merely by the sweep having already reaped it');
    rejoin.c?.ws?.close(); early.c?.ws?.close();
    try { ghost.ws.terminate(); } catch { /* already gone */ }
    await stop(s);
  }


  // ===================== 14d. a flood of REFUSALS must not deny service (I1)
  // Round 2 of this fix made every capacity refusal SOFT — accept the upgrade,
  // close 1013 + reason — so the clients already on headsets would retry instead
  // of sitting on "Offline" forever. It did not account for what a soft refusal
  // IS: a real entry in wss.clients for ROOM_REFUSAL_GRACE_MS. The global gate
  // was `wss.clients.size >= MAX_SOCKETS`, which counts those, so one address
  // sending upgrades faster than the grace period could hold the relay at
  // capacity with ZERO peers in any room — a total outage, and neither per-IP cap
  // could shed it because a rate refusal was itself a full accept.
  //
  // Two things close it, and this section asserts both: the gate counts only
  // sockets that can BECOME a session, and the number of refused sockets
  // resident at once is itself capped (MAX_REFUSALS_IN_FLIGHT = MAX_SOCKETS / 8,
  // derived — the rest get the cheap door).
  console.log('\n--- a flood of soft refusals does not consume the global capacity (I1) ---');
  {
    const s = startServer(TIGHT_PORT, {
      LOG_PORT: '8896', ROOM_MAX_SOCKETS: '6', ROOM_MAX_PEERS: '64',
      // Long enough that a refused socket is unambiguously still resident when
      // the assertions below run. A real attacker gets this for free by never
      // answering the close frame, which is what rawUpgrade() does.
      ROOM_REFUSAL_GRACE_MS: '5000',
    });
    await s.ready;
    ok(await s.waitLog(/6 sockets, /), 'the relay under test came up with a 6-socket global cap');
    const held = [];
    for (let i = 0; i < 6; i++) held.push(await join(TIGHT_PORT, `glob${i}`, `G${i}`));
    ok(held.every((c) => c.selfId), 'control: 6 real peers fill the 6-socket relay');
    const atCap = await admit(TIGHT_PORT, 'glob-x', 'OVER');
    ok(!atCap.admitted && /at capacity/.test(atCap.reason),
      `control: the gate still works — a 7th peer at a genuinely full relay is refused ("${atCap.reason}")`);

    // 20 upgrades from one address that never answer anything. Only
    // MAX_REFUSALS_IN_FLIGHT of them are worth a polite answer; the rest must cost
    // a status line. At the 6-socket cap this section needs, that number is the
    // Math.max FLOOR of 8 — ceil(6/8) is 1 — so this assertion pins the floor and
    // ONLY the floor. The ratio is pinned by the sub-section after this one; the
    // two are separate because no single ROOM_MAX_SOCKETS can be binding for both.
    const flood = [];
    for (let i = 0; i < 20; i++) flood.push(await rawUpgrade(TIGHT_PORT, 'glob-flood'));
    const accepted = flood.filter((f) => f.status === 101).length;
    const cheap = flood.filter((f) => f.status === 429).length;
    ok(accepted === 8 && cheap === 12,
      `MAX_REFUSALS_IN_FLIGHT never drops below its floor of 8: 8 of 20 flood upgrades at a 6-socket cap were answered the EXPENSIVE way and the other 12 got a 429 with no WebSocket (101s=${accepted}, 429s=${cheap})`);

    // …and now the point of the whole section. Free ONE real slot. The relay is
    // still holding 8 refused sockets that answer nothing, so under the old gate
    // wss.clients.size is 5 + 8 = 13 against a cap of 6 and this join is refused
    // — a legitimate peer denied service by sockets that can never become one.
    held.pop().ws.close();
    await sleep(200);
    const legit = await admit(TIGHT_PORT, 'glob-legit', 'LEGIT');
    ok(legit.admitted,
      'a legitimate peer is admitted into the slot that just freed, while 8 unanswering refused sockets are still resident — the capacity gate counts only sockets that can become a session');
    legit.c?.ws?.close();
    for (const c of held) c.ws.close();
    for (const f of flood) { try { f.sock.destroy(); } catch { /* gone */ } }
    await stop(s);
  }

  // ---- …and the same bound where the RATIO, not the floor, is the binding half.
  // MAX_REFUSALS_IN_FLIGHT = Math.max(8, ceil(MAX_SOCKETS / 8)), and the section
  // above runs at MAX_SOCKETS=6, where that is 8 — the floor. A floor is satisfied
  // by ANY divisor, so on its own it pins nothing: a build with `/2` instead of
  // `/8` (which at the shipped MAX_SOCKETS=256 quadruples resident refused sockets
  // from 32 to 128 — a material loosening of the only bound that makes MAX_SOCKETS
  // a real ceiling) still reads 8 there and still passes. Nothing else in the tree
  // checks the derivation, so this is the assertion that has to. 96 sockets puts
  // the ratio clear of the floor: ceil(96/8) = 12 vs 8.
  //
  // The refusals are provoked by a ONE-PEER ROOM rather than by a full relay:
  // filling 96 global sockets would cost 96 handshakes to measure a number that
  // does not depend on which cap said no — refuse() is reached the same way from
  // every cap, and section 14d above already proves the global one reaches it.
  console.log('\n--- MAX_REFUSALS_IN_FLIGHT tracks MAX_SOCKETS/8, not just its floor (I1) ---');
  {
    const s = startServer(TIGHT_PORT, {
      LOG_PORT: '8896', ROOM_MAX_SOCKETS: '96', ROOM_MAX_PEERS: '1',
      ROOM_REFUSAL_GRACE_MS: '5000',
    });
    await s.ready;
    ok(await s.waitLog(/96 sockets, /), 'the relay under test came up with a 96-socket global cap');
    const one = await join(TIGHT_PORT, 'ratio', 'ONE');
    ok(!!one.selfId, 'control: the one-peer room takes its peer, so every upgrade after this one is refused');
    const flood = [];
    for (let i = 0; i < 16; i++) flood.push(await rawUpgrade(TIGHT_PORT, 'ratio'));
    const accepted = flood.filter((f) => f.status === 101).length;
    const cheap = flood.filter((f) => f.status === 429).length;
    ok(accepted === 12 && cheap === 4,
      `exactly ceil(96/8) = 12 of 16 refusals were answered the EXPENSIVE way and the other 4 got a 429 (101s=${accepted}, 429s=${cheap}) — change the divisor and this number moves, which is the whole point of asserting it above the floor`);
    one.ws.close();
    for (const f of flood) { try { f.sock.destroy(); } catch { /* gone */ } }
    await stop(s);
  }

  // ================== 14e. the cheap door: a per-address soft-refusal budget
  // A soft refusal costs a handshake, a socket, a log line and a timer; the
  // clients already deployed reset their backoff on the 'open' a soft refusal
  // itself produces, so a refused one knocks at 2 Hz for the life of its page and
  // no client-side fix can reach it. The bound therefore lives here: an address
  // gets MAX_SOFT_REFUSALS_PER_IP expensive answers per window and cheap ones
  // after that.
  console.log('\n--- refusals are rationed: soft while the address has budget, 429 after (I5/I6) ---');
  {
    const s = startServer(TIGHT_PORT, {
      LOG_PORT: '8896', ROOM_MAX_PEERS: '1', ROOM_MAX_SOFT_REFUSALS_PER_IP: '3',
      ROOM_UPGRADE_WINDOW_MS: '600000',
    });
    await s.ready;
    ok(await s.waitLog(/3 soft refusals per 600000ms/),
      'the relay under test came up with a 3-refusal soft budget in its own boot line');
    const one = await join(TIGHT_PORT, 'onefull', 'ONE');
    ok(!!one.selfId, 'control: the room takes its one peer');
    const answers = [];
    for (let i = 0; i < 6; i++) {
      const r = await admit(TIGHT_PORT, 'onefull', `X${i}`);
      answers.push(r);
      r.c?.ws?.close();
    }
    const soft = answers.filter((r) => r.opened && r.code === 1013 && /full/.test(r.reason));
    const hard = answers.filter((r) => !r.opened && /429/.test(r.reason));
    ok(soft.length === 3 && hard.length === 3,
      `the first 3 refusals are soft (1013 + reason) and the next 3 are killed upgrades (429): soft=${soft.length}, hard=${hard.length}`);
    ok(answers.slice(0, 3).every((r) => r.opened) && answers.slice(3).every((r) => !r.opened),
      'and in that order — the budget is spent before the door gets cheap, so a real user always learns WHY before anyone stops explaining');
    // (the key is whatever the OS reports — `::ffff:127.0.0.1` on a dual-stack
    // listener — so the assertion is that the LINE names an address and the
    // tier, not that it names one particular spelling of loopback.)
    ok(await s.waitLog(/x HARD refused [^\n]*127\.0\.0\.1[^\n]*answered 429/),
      'the transition into the cheap tier is logged once, with the address — an operator can see which address went abusive without a line per attempt');
    one.ws.close();
    await stop(s);

    // NEGATIVE CONTROL: the identical loop with the budget out of the way stays
    // soft all six times, so the assertion above measures the budget and not
    // "this relay refuses upgrades".
    const l = startServer(LOOSE_PORT, { LOG_PORT: '8897', ROOM_MAX_PEERS: '1' });
    await l.ready;
    const oneL = await join(LOOSE_PORT, 'onefull', 'ONEL');
    let softL = 0;
    for (let i = 0; i < 6; i++) {
      const r = await admit(LOOSE_PORT, 'onefull', `Y${i}`);
      if (r.opened && r.code === 1013) softL++;
      r.c?.ws?.close();
    }
    ok(softL === 6,
      `NEGATIVE CONTROL: with the soft budget raised, all 6 identical refusals are still answered with 1013 + a reason (${softL}/6)`);
    oneL.ws.close();
    await stop(l);
  }

  // ============ 14f. a refusal loop must not lock out its own household (I3/I6)
  // The reported failure, exactly: a room reaches MAX_PEERS and two more devices
  // at the same address press Join. Each is refused, each retries, and because
  // the old bucket charged EVERY attempt — admitted or refused — those retries
  // drove the address over its upgrade budget. From then on every upgrade from
  // that address was refused, including a device joining a different half-empty
  // room and including any of the sixteen already-connected headsets reconnecting
  // after a Wi-Fi blip. The refusal loop fed itself, so it never stopped.
  //
  // The fix is a budget split, and this is what proves it: only ADMISSIONS are
  // charged to the churn budget, so a refusal can never make the next attempt
  // likelier to be refused. The second half of the section proves the churn
  // budget is still a real bound — the protection was split, not removed.
  console.log('\n--- a client stuck in a refusal loop cannot lock out its own household (I3) ---');
  {
    const s = startServer(TIGHT_PORT, {
      LOG_PORT: '8896', ROOM_MAX_PEERS: '2', ROOM_MAX_UPGRADES_PER_IP: '6',
      // A window far longer than the run, so the counts below are exact rather
      // than "exact, plus however much the score drained while we measured".
      ROOM_UPGRADE_WINDOW_MS: '600000',
    });
    await s.ready;
    ok(await s.waitLog(/6 upgrades per 600000ms/), 'the relay under test came up with a 6-admission churn budget');
    const packed = [];
    for (let i = 0; i < 2; i++) packed.push(await join(TIGHT_PORT, 'packed', `P${i}`));   // 2 admissions
    let refusals = 0;
    for (let i = 0; i < 20; i++) {
      const r = await admit(TIGHT_PORT, 'packed', `R${i}`);
      if (!r.admitted && /full/.test(r.reason)) refusals++;
      r.c?.ws?.close();
    }
    ok(refusals === 20, `20 attempts at the full room are all refused for being full (${refusals}/20)`);
    // 20 refusals, 3.3x the whole churn budget. If any of them were charged to
    // it, everything below this line fails.
    const other = await admit(TIGHT_PORT, 'elsewhere', 'OTHER');
    ok(other.admitted,
      'a third device joining a DIFFERENT, empty room is still admitted after 20 refusals at the same address — a refused attempt is not charged to the churn budget');
    packed.pop().ws.close();
    await sleep(200);
    const back = await admit(TIGHT_PORT, 'packed', 'BACK');
    ok(back.admitted,
      'and a device already in the room reconnects into it after a drop — the Wi-Fi-blip case the old bucket locked out');
    other.c?.ws?.close(); back.c?.ws?.close();
    await sleep(200);

    // …and the churn budget still bites. 4 admissions are spent (2 + OTHER +
    // BACK), so exactly 2 more fit and the 7th admission attempt is refused.
    let admitted = 0, churnRefusal = null;
    for (let i = 0; i < 10 && !churnRefusal; i++) {
      const r = await admit(TIGHT_PORT, `chn${i}`, `C${i}`);
      if (r.admitted) { admitted++; r.c?.ws?.close(); }
      else churnRefusal = r;
    }
    ok(admitted === 2 && churnRefusal && /too many connection attempts/.test(churnRefusal.reason),
      `the churn budget is still a real bound — 6 admissions in the window and the 7th is refused for churn ("${churnRefusal?.reason}"), so the protection was split, not removed`);
    for (const c of packed) c.ws.close();
    await stop(s);
  }

  // ========= 14g. the shipped defaults, against the case they are derived from
  // I3: a legitimate room of up to MAX_PEERS_PER_ROOM behind ONE NAT must work,
  // including everyone reconnecting after a Wi-Fi blip. This runs on the SHIPPED
  // numbers — the three per-address knobs are passed as EMPTY STRINGS, which
  // parse as "unset" and therefore defeat BASE_ENV's overrides and restore the
  // real defaults. The boot line is asserted first so the section cannot quietly
  // measure some other configuration.
  console.log('\n--- the shipped per-address defaults against a 16-peer room behind one NAT (I3) ---');
  {
    const SHIPPED = {
      LOG_PORT: '8896',
      ROOM_MAX_SOCKETS_PER_IP: '', ROOM_MAX_UPGRADES_PER_IP: '', ROOM_MAX_SOFT_REFUSALS_PER_IP: '',
    };
    const s = startServer(TIGHT_PORT, SHIPPED);
    await s.ready;
    ok(await s.waitLog(/per-address: 16 sockets, 256 upgrades per 60000ms, 64 soft refusals per 60000ms/),
      'the shipped defaults are 16 sockets / 256 upgrades / 64 soft refusals per address per minute');
    const nat = [];
    for (let i = 0; i < 16; i++) nat.push(await join(TIGHT_PORT, 'nat', `N${i}`));
    ok(nat.every((c) => c.selfId),
      'all 16 peers of a full room assemble from ONE address — the concurrency cap starts AT ROOM_MAX_PEERS, so it can never bite before the per-room cap does');
    const seventeenth = await admit(TIGHT_PORT, 'nat', 'N16');
    // WHICH of the two 16s answers is decided by check order, and it is worth
    // pinning: the per-address concurrency cap DEFAULTS to ROOM_MAX_PEERS, so
    // with the whole room behind one NAT both caps are reached in the same
    // breath and the per-address one is checked first. Either way it is a SOFT
    // 1013 with a human-readable reason, which is the property that matters —
    // being turned away from a full room must never look like being blocked.
    ok(!seventeenth.admitted && seventeenth.opened && seventeenth.code === 1013
      && /too many connections from this address \(16\/16\)/.test(seventeenth.reason),
      `the 17th is refused softly, with 1013 and a reason — a full room is a legitimate state, not an abusive one ("${seventeenth.reason}")`);
    seventeenth.c?.ws?.close();
    // The Wi-Fi blip: every device drops and comes back. 32 admissions and one
    // refusal, all billed to one address.
    for (const c of nat) c.ws.close();
    await sleep(300);
    const again = [];
    for (let i = 0; i < 16; i++) again.push(await admit(TIGHT_PORT, 'nat', `M${i}`));
    ok(again.every((r) => r.admitted),
      'and the whole room reassembles after every device drops at once — the relay-restart shape, on the shipped budget');
    for (const r of again) r.c?.ws?.close();
    await stop(s);
  }

  // The arithmetic the old default failed. The client's backoff chain is
  // 500/1000/2000/4000/8000 ms, so a device that keeps failing spends 7.5 s on
  // its first four attempts and 8 s on each one after — ~10.5 upgrades in the
  // first minute, not the 7.5 the x8 default was justified with. Sixteen of them
  // behind one NAT is ~168/minute against a budget of 128: the shipped relay
  // refused the exact case its own comment claimed to cover. This drives those
  // 160 upgrades for real.
  console.log('\n--- 16 devices x 10 reconnects in one window fit the shipped upgrade budget (I3/I5) ---');
  {
    const s = startServer(TIGHT_PORT, {
      LOG_PORT: '8896',
      ROOM_MAX_SOCKETS_PER_IP: '', ROOM_MAX_UPGRADES_PER_IP: '', ROOM_MAX_SOFT_REFUSALS_PER_IP: '',
    });
    await s.ready;
    let ok160 = 0, firstRefusal = null;
    for (let i = 0; i < 160 && !firstRefusal; i++) {
      const r = await admit(TIGHT_PORT, 'blip', `B${i}`);
      if (r.admitted) { ok160++; r.c?.ws?.close(); } else firstRefusal = r;
    }
    ok(ok160 === 160 && !firstRefusal,
      `160 reconnects from one address inside one window are all admitted (${ok160}/160${firstRefusal ? `, first refusal "${firstRefusal.reason}"` : ''}) — under the previous x8 default this failed at 129`);
    // …and it is still a budget: keep going and it closes. (Charged only on
    // admission, so this counts real joins, not knocks.)
    let extra = 0, churn = null;
    for (let i = 0; i < 160 && !churn; i++) {
      const r = await admit(TIGHT_PORT, 'blip', `E${i}`);
      if (r.admitted) { extra++; r.c?.ws?.close(); } else churn = r;
    }
    ok(!!churn && /too many connection attempts/.test(churn.reason) && extra < 140,
      `and the budget still closes on sustained churn — refused after ${160 + extra} admissions in the window ("${churn?.reason}")`);
    await stop(s);
  }

  // --------------------------------------------- 15. bind address (RELAY-5)
  // The relay listened on every interface with no way to change that, so on the
  // production box :8787 was reachable DIRECTLY from the internet as well as
  // through Apache — bypassing TLS termination and everything the vhost enforces.
  // The deployed unit now sets ROOM_HOST=127.0.0.1 (Apache proxies from loopback);
  // LAN dev leaves it unset, because a Quest connects straight to the dev box.
  console.log('\n--- bind address (ROOM_HOST) ---');
  {
    const anyIf = startServer(TIGHT_PORT, { LOG_PORT: '8896' });
    await anyIf.ready;
    const loop = await tryJoin(TIGHT_PORT, 'bind', 'LOOP');
    ok(loop.ok, 'control: unset (the shipped default) still binds every interface — LAN dev and the headset path are unchanged');
    loop.c?.ws?.close();
    await stop(anyIf);

    const lan = Object.values(networkInterfaces()).flat()
      .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
    if (!lan) {
      console.log('       (no non-internal IPv4 on this box — the restricted-bind half is skipped)');
    } else {
      // Bound to the LAN address ONLY, so a LOOPBACK connect must be refused.
      // Asserted this way round on purpose: a refused connect to 127.0.0.1 is
      // deterministic, where probing the LAN address would drag the host firewall
      // into the test.
      const bound = startServer(TIGHT_PORT, { LOG_PORT: '8896', ROOM_HOST: lan });
      await bound.ready;
      ok(bound.log().includes(`bind ${lan}`), `the relay reports its bind address in the journal (bind ${lan})`);
      const blocked = await tryJoin(TIGHT_PORT, 'bind', 'LOOP2');
      ok(!blocked.ok,
        `ROOM_HOST=${lan} really restricts the listener — a 127.0.0.1 connect is refused ("${blocked.reason}"), which is the same mechanism that keeps the deployed ROOM_HOST=127.0.0.1 relay off the public interface`);
      blocked.c?.ws?.close();
      await stop(bound);
    }
  }
} catch (e) {
  failed++;
  console.error('  FAIL (threw):', e.stack || e.message);
} finally {
  await stop(tight);
  await stop(loose);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
