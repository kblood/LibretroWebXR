// Unit tests for [[src/net/RoomConnection.js]] — the transport half that
// [[src/net/NetMgr.js]] (VR) and [[src/desktop/DesktopNet.js]] (flat screen) now
// COMPOSE instead of each writing out for itself (CODEX ARC-2 / CLAUDE_REVIEW
// §3.4). Pure logic tier: no socket, no server, no port, no browser — the
// WebSocket is a fake installed on globalThis, exactly as scripts/test-net.mjs
// does it, so the real code path is exercised.
//
// WHY A SEPARATE SUITE FROM test-net.mjs. That one drives the two CLIENT classes
// through the identical case table, which is the right shape for "the shipped
// clients behave the same". It cannot, by construction, say anything about WHY
// they behave the same — before this extraction they agreed because two hand
// written copies happened to agree, and the whole finding was that the next
// protocol change would break that. This suite asserts the STRUCTURAL claim:
//
//   1. there is exactly ONE lifecycle object and both clients hold one,
//   2. the field/method surface the rest of the app reaches through those
//      clients (`_connected`, `_fatal`, `lastClose`, `_serverElects`, …) is
//      still there after the move — accessors, not a rename,
//   3. the shared module drags no `three` (nor any DOM) into the desktop chunk,
//   4. and the transport rules themselves hold when driven on RoomConnection
//      directly, including the fallback election, which no suite reached before.
//
// Point 2 matters more than it looks: src/main.js reads `net._connected` and
// `net.lastClose`, src/TestApi.js reads `net._serverElects`, and
// scripts/test-net.mjs both reads AND WRITES `_fatal` / `_reconnectTimer` to
// isolate the reconnect guard. A move that quietly dropped one of those would
// leave every existing suite green and break the app.

import { RoomConnection, RECONNECT_DELAYS_MS, RETRY_LATER_DELAYS_MS } from '../src/net/RoomConnection.js';
import { NetMgr } from '../src/net/NetMgr.js';
import { DesktopNet } from '../src/desktop/DesktopNet.js';
import { RoomObjects } from '../src/net/RoomObjects.js';
import {
  MSG, makeHello, encode, decode, PROTOCOL_VERSION, PROTOCOL_CLOSE_CODE,
} from '../src/net/NetProtocol.js';
import { FALLBACK_HOST_KEY } from '../src/net/HostElection.js';
// node:fs/node:path only (the same pair scripts/test-net.mjs uses): the "no
// three in the transport" claim is checked against the REAL files in this tree,
// not against a remembered import list. Neither module is on run-tests.mjs's
// impure list, so this stays a logic-tier suite.
import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };

// Same crash guard as scripts/test-net.mjs: an assertion's CONDITION can throw
// (a `.length` on something a regression turned undefined), and a throw at top
// level would abort the file and lose every later assertion. Here it costs one
// section, printed as a FAIL line naming it.
const section = (name, fn) => {
  try {
    fn();
  } catch (e) {
    failed++;
    console.error(`  FAIL: [${name}] section threw ${e?.constructor?.name ?? 'Error'}: ${e?.message} — remaining assertions in it did not run`);
  }
};

// Minimal WebSocket stand-in. Both clients and RoomConnection look `WebSocket`
// up on globalThis at open() time, so substituting it here exercises the real
// code path rather than a reimplementation of it.
class FakeWS {
  constructor(url) {
    this.url = url; this.readyState = 0; this.sent = []; this._l = new Map();
    FakeWS.last = this;
    FakeWS.made = (FakeWS.made || 0) + 1;
  }
  addEventListener(t, f) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(f); }
  _emit(t, ev) { for (const f of this._l.get(t) || []) f(ev); }
  send(s) { this.sent.push(s); }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this._emit('close', { code, reason }); }
  /* test-side drivers */
  accept() { this.readyState = 1; this._emit('open', {}); }
  deliver(msg) { this._emit('message', { data: encode(msg) }); }
  drop(code, reason = '') { this.readyState = 3; this._emit('close', { code, reason }); }
}

// A scene stub for NetMgr: only the members its constructor / close path read.
const stubScene = { addObject() {}, removeObject() {}, playerRig: null, renderer: null, camera: null, controllers: [] };
const makeNetMgr = (opts = {}) => new NetMgr({ scene: stubScene, room: 'r', serverUrl: 'ws://x/ws/', sessionId: 'sid-test', ...opts });
const makeDesktopNet = (opts = {}) => new DesktopNet({ room: 'r', serverUrl: 'ws://x/ws/', sessionId: 'sid-test', ...opts });

// Silence the deliberate console noise (the fatal path console.error()s on
// purpose — it is how a user finds out) while still letting ok()'s own FAIL
// lines through, or every failure in a quiet block would read as a pass.
const withQuietConsole = (fn) => {
  const realErr = console.error;
  const realWarn = console.warn;
  const realLog = console.log;
  const errs = [];
  console.error = (...a) => { const s = a.join(' '); if (s.includes('FAIL')) realErr(...a); else errs.push(s); };
  console.warn = (...a) => { errs.push(a.join(' ')); };
  console.log = () => {};
  try { return fn(errs); }
  finally { console.error = realErr; console.warn = realWarn; console.log = realLog; }
};

const withFakeWS = (fn) => {
  const prev = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  try { return fn(); }
  finally { if (prev === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = prev; }
};

// === 1. One lifecycle object, two owners ====================================
//
// The finding this module closes was never "the two clients disagree today" —
// they agreed. It was that they agreed by coincidence of two hand-maintained
// copies. These assertions are what makes that structural rather than hopeful:
// if a future edit re-inlines the socket into either client, `_conn` stops being
// a RoomConnection and this goes red.
section('One lifecycle object, two owners', () => {
  const vr = makeNetMgr();
  const flat = makeDesktopNet();
  ok(vr._conn instanceof RoomConnection, 'NetMgr composes a RoomConnection');
  ok(flat._conn instanceof RoomConnection, 'DesktopNet composes a RoomConnection');
  ok(vr._conn !== flat._conn, 'each client gets its OWN instance (shared CODE, not shared STATE)');
  // The one difference that is allowed to exist, asserted so nobody "tidies" it
  // away into a single prefix and makes two clients indistinguishable in a log.
  ok(vr._conn._log === '[net]', 'the VR client logs as [net]');
  ok(flat._conn._log === '[desktop-net]', 'the flat-screen client logs as [desktop-net]');
  // …and the asymmetry the extraction had to preserve rather than unify: only
  // DesktopNet fires an app callback from its close handler.
  ok(typeof flat._conn._onClosed === 'function' && typeof flat._conn._onFatalTeardown === 'function',
    'DesktopNet supplies the close-handler teardown hooks (its onDisconnect)');
  ok(vr._conn._onClosed == null && vr._conn._onFatalTeardown == null,
    'NetMgr supplies none — the asymmetry is parameterised, not unified away');
});

// === 2. The delegated surface still exists on BOTH clients ==================
//
// Accessors, not a rename. Every name below is read (some are written) by code
// this change is forbidden to touch: src/main.js, src/TestApi.js,
// scripts/test-net.mjs. A getter with no setter would pass a read-only smoke
// test and then throw in strict mode on the two lines of test-net.mjs that
// assign, so both halves are asserted.
section('The delegated transport surface survives the move', () => {
  const FIELDS = [
    'room', 'nick', 'color', 'serverUrl', 'sessionId', 'ws', 'lastClose', 'serverVersion',
    '_connected', '_closing', '_reconnectTries', '_reconnectTimer', '_retryLater', '_fatal',
    '_hostId', '_serverElects',
  ];
  const METHODS = [
    '_setHost', '_noteFatal', '_checkServerProtocol', '_noteSessionEstablished',
    '_scheduleReconnect', '_noteFallbackClaim', '_runFallbackElection',
    '_armFallbackElection', '_clearFallbackTimer',
  ];
  for (const [name, Klass] of [['NetMgr', NetMgr], ['DesktopNet', DesktopNet]]) {
    for (const f of FIELDS) {
      const d = Object.getOwnPropertyDescriptor(Klass.prototype, f);
      ok(!!d?.get && !!d?.set, `${name}.${f} is still readable AND writable after the move`);
    }
    for (const m of METHODS) {
      ok(typeof Klass.prototype[m] === 'function', `${name}.${m}() is still callable after the move`);
    }
    // `_fallbackClaims` is a Map mutated in place, so a getter is enough — but it
    // must be the SAME map the connection holds, or the clients' LEAVE handling
    // (`_fallbackClaims.delete(id)`) would silently stop reaching the election.
    ok(!!Object.getOwnPropertyDescriptor(Klass.prototype, '_fallbackClaims')?.get,
      `${name}._fallbackClaims is still readable`);
  }
  // And the delegation is live in BOTH directions — a write through the client
  // reaches the connection, and a write on the connection is visible through the
  // client. A getter that returned a stale copy would pass the shape check above.
  for (const [name, client] of [['NetMgr', makeNetMgr()], ['DesktopNet', makeDesktopNet()]]) {
    client._fatal = { code: 4010, reason: 'written through the client' };
    ok(client._conn._fatal?.code === 4010, `${name}: writing _fatal reaches the shared connection`);
    client._conn.lastClose = { code: 1006, reason: '', attempt: 3, delayMs: 2000 };
    ok(client.lastClose?.attempt === 3, `${name}: reading lastClose sees the shared connection`);
    ok(client._fallbackClaims === client._conn._fallbackClaims, `${name}: the fallback-claim map is the SAME object`);
    // Public identity fields moved too; main.js paints the room name from them.
    ok(client.room === 'r' && client.sessionId === 'sid-test', `${name}: room/sessionId still read as plain properties`);
  }
});

// === 3. The transport drags no `three` (and no DOM) into the desktop chunk ==
//
// §3.4 flags this as the constraint worth preserving, and scripts/check-dist.mjs
// enforces a 60 KB raw / 20 KB gzip budget on the `desktop` chunk to catch a
// regression. That check only runs on a BUILD; this one runs in `npm test`, on
// the source, and names the offending import — which is the difference between
// "the budget went red, why?" and "RoomConnection.js started importing three".
section('The shared transport imports nothing the flat-screen build must not have', () => {
  const read = (rel) => readFileSync(pathResolve(ROOT, rel), 'utf8');
  const importsOf = (src) => [...src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  // The transitive closure of the transport's imports, walked for real.
  const ALLOWED = new Set(['./NetProtocol.js', './HostElection.js']);
  const conn = read('src/net/RoomConnection.js');
  const direct = importsOf(conn);
  ok(direct.length > 0, 'RoomConnection.js has imports at all (the scan is not vacuously green)');
  for (const spec of direct) {
    ok(ALLOWED.has(spec), `RoomConnection.js imports only pure net modules (found '${spec}')`);
  }
  for (const rel of ['src/net/RoomConnection.js', 'src/net/NetProtocol.js', 'src/net/HostElection.js']) {
    const src = read(rel);
    ok(!importsOf(src).some((s) => s === 'three' || s.startsWith('three/')),
      `${rel} does not import three`);
    ok(!/\bdocument\.|\bwindow\./.test(src), `${rel} touches no DOM globals`);
  }
  // NEGATIVE CONTROL for the scan itself: the VR client DOES import three, so if
  // this line ever goes green-by-accident the detector is broken, not the code.
  ok(importsOf(read('src/net/NetMgr.js')).includes('three'),
    'NEGATIVE CONTROL: the same scan does detect three in NetMgr.js');
  // Importing the module under plain node must not need a DOM either — which is
  // the run-tests.mjs contract for a logic-tier module, and is proved by the fact
  // that this file constructed one at the top of section 1.
  ok(typeof RoomConnection === 'function' && Array.isArray(RECONNECT_DELAYS_MS) && Array.isArray(RETRY_LATER_DELAYS_MS),
    'RoomConnection and both backoff tables import cleanly under node');
});

// === 4. The transport rules, driven on RoomConnection directly ==============
//
// The same claims scripts/test-net.mjs makes about the two clients, made here
// about the one implementation behind them. Driven through open() over the fake
// socket, so the real listeners run.
section('Transport rules on RoomConnection itself', () => {
  withFakeWS(() => withQuietConsole((errs) => {
    const build = (opts = {}) => {
      const c = new RoomConnection({
        room: 'r', serverUrl: 'ws://x/ws/', sessionId: 'sid-test', logPrefix: '[test]',
        reopen: () => c.open(),
        ...opts,
      });
      c.open();
      return c;
    };

    // The JOIN announces our protocol version — the half the SERVER checks.
    const a = build();
    FakeWS.last.accept();
    ok(decode(FakeWS.last.sent[0] ?? '')?.v === PROTOCOL_VERSION, 'the JOIN announces our protocol version');
    a.beginDisconnect(); a.closeSocket();

    // A HELLO is routed to the owner ONLY after the version gate passed.
    const seen = [];
    const b = build({ onMessage: (m) => seen.push(m.type) });
    FakeWS.last.accept();
    FakeWS.last.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
    ok(seen.length === 1 && seen[0] === MSG.HELLO, 'a compatible HELLO reaches the owner');
    ok(b.serverVersion === PROTOCOL_VERSION, 'and its version is recorded');
    b.beginDisconnect(); b.closeSocket();

    const c2 = build({ onMessage: (m) => seen.push(m.type) });
    const c2ws = FakeWS.last;
    c2ws.accept();
    const before = seen.length;
    c2ws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me', v: '9.0' }));
    ok(seen.length === before, 'an INCOMPATIBLE HELLO is NOT routed to the owner (its contents are not trusted)');
    ok(c2._fatal?.code === PROTOCOL_CLOSE_CODE, 'it is recorded as fatal');
    ok(c2ws.readyState === 3, 'and the socket is closed from our side');
    ok(c2._reconnectTimer === null, 'with no reconnect scheduled into the same refusal');

    // Backoff: the fast table for a drop, the slow one for a soft refusal, and
    // the soft one is STICKY until a session exists.
    const fast = build();
    FakeWS.last.drop(1006);
    ok(fast.lastClose?.delayMs === RECONNECT_DELAYS_MS[0], `an ordinary drop uses the fast table (${fast.lastClose?.delayMs}ms)`);
    clearTimeout(fast._reconnectTimer); fast._reconnectTimer = null;

    const slow = build();
    FakeWS.last.drop(1013, 'room "r" full (16/16)');
    ok(slow.lastClose?.delayMs === RETRY_LATER_DELAYS_MS[0], `a 1013 uses the slow table (${slow.lastClose?.delayMs}ms)`);
    ok(slow._retryLater === true, 'and latches the sticky "they are refusing us" flag');
    clearTimeout(slow._reconnectTimer); slow._reconnectTimer = null;
    slow._scheduleReconnect({ code: 1006, reason: '' });
    ok(slow.lastClose?.delayMs >= RETRY_LATER_DELAYS_MS[1],
      `the bare 1006 a killed upgrade produces stays on the slow table (${slow.lastClose?.delayMs}ms)`);
    clearTimeout(slow._reconnectTimer); slow._reconnectTimer = null;
    // Only a SESSION clears it — an 'open' must not, which is the whole 2026-08-18 fix.
    const sws = FakeWS.last;
    sws.accept();
    ok(slow._retryLater === true, "an 'open' with no HELLO behind it does not clear the sticky flag");
    sws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
    ok(slow._retryLater === false && slow._reconnectTries === 0 && slow.lastClose === null,
      'a HELLO clears it, resets the backoff, and clears the transient "why are we offline"');
    slow.beginDisconnect(); slow.closeSocket();

    // onFatal reaches the app exactly once, and a throwing app callback is contained.
    const fatals = [];
    const k = build({ onFatal: (f) => fatals.push(f) });
    FakeWS.last.accept();
    errs.length = 0;
    FakeWS.last.drop(PROTOCOL_CLOSE_CODE, 'protocol 9.0 incompatible (this end speaks 1.x)');
    ok(fatals.length === 1 && fatals[0]?.code === PROTOCOL_CLOSE_CODE, 'onFatal fires once with the close code');
    ok(errs.some((e) => e.includes('[test]') && e.includes('4010')), 'the refusal is logged under the supplied prefix');
    k._noteFatal({ code: PROTOCOL_CLOSE_CODE, reason: 'again' });
    ok(fatals.length === 1, 'and NOT again when a later path notes the same refusal');

    // beginDisconnect() must stop the chain the way each client's disconnect() did.
    const d = build();
    FakeWS.last.accept();
    d.beginDisconnect();
    FakeWS.last.drop(1006);
    ok(d._reconnectTimer === null && d._reconnectTries === 0,
      'a deliberate beginDisconnect() means a later close schedules nothing');
    // …and closeSocket() gives up the role WITHOUT firing the app's host callback,
    // because the app has already reverted its screen (see _setHost `silent`).
    const roles = [];
    const e2 = build({ onHostChange: (r) => roles.push(r) });
    FakeWS.last.accept();
    e2._setHost('someone-else');
    ok(roles.length === 1, 'an ordinary host change DOES notify the app');
    e2.beginDisconnect();
    e2.closeSocket();
    ok(roles.length === 1, 'but the disconnect demotion is silent (still 1 call)');
    ok(e2._hostId === null && e2._serverElects === false && e2._fallbackClaims.size === 0,
      'and the role + election bookkeeping is cleared');
  }));
});

// === 5. The pre-M1.4 fallback election, on the shared implementation ========
//
// This is the part of the move with the least prior coverage: the four election
// methods existed in both clients and no suite drove either copy through a real
// connection. They are the reason a client can host a game at all against an
// un-upgraded relay, so they get driven here.
section('Fallback election (pre-M1.4 relay) on the shared connection', () => {
  withQuietConsole(() => {
    const announced = [];
    const objects = new RoomObjects();
    const peers = [];
    const conn = new RoomConnection({
      room: 'r', serverUrl: 'ws://x/ws/', sessionId: 'sid-test', logPrefix: '[test]',
      presence: () => ({ selfId: 'me', peers: () => peers }),
      objects: () => objects,
      setObjectState: (key, value) => { announced.push({ key, value }); return true; },
    });
    // The election is gated on a live socket: a client with no socket is not the
    // room's authority, whatever it last computed.
    conn._runFallbackElection();
    ok(conn._hostId === null, 'no election happens while disconnected');
    conn._connected = true;

    conn._runFallbackElection();
    ok(conn._hostId === 'me', 'the only peer in the room elects itself');
    ok(announced.some((a) => a.key === FALLBACK_HOST_KEY && a.value?.id === 'me'),
      'and announces its claim on the shared STATE channel');

    // An EARLIER claim from a peer that is present wins — the seniority rule.
    peers.push({ id: 'older' });
    conn._noteFallbackClaim({ id: 'older', at: conn._fallbackClaims.get('me').at - 5000 });
    ok(conn._hostId === 'older', 'an earlier claim from a present peer takes the role');

    // A re-announcement must not make a peer look YOUNGER than it is, or the
    // roles would reshuffle every time somebody repeated itself.
    const wasAt = conn._fallbackClaims.get('older').at;
    conn._noteFallbackClaim({ id: 'older', at: wasAt + 60000 });
    ok(conn._fallbackClaims.get('older').at === wasAt, 'the EARLIEST claim per peer is kept');
    ok(conn._hostId === 'older', 'so the host does not flip on a re-announcement');

    // Once the SERVER speaks, the fallback must go quiet for good.
    conn._serverElects = true;
    conn._setHost('server-said-this-one');
    conn._noteFallbackClaim({ id: 'ancient', at: 0 });
    ok(conn._hostId === 'server-said-this-one', 'a server-elected host is never overridden by a fallback claim');

    // The armed deadline is idempotent and is cancelled cleanly (a leaked timer
    // would keep a disconnected page ticking).
    const fresh = new RoomConnection({ room: 'r', serverUrl: 'ws://x/ws/', sessionId: 's', logPrefix: '[test]' });
    fresh._armFallbackElection();
    const t = fresh._fallbackTimer;
    ok(t !== null, 'arming the fallback deadline sets a timer');
    fresh._armFallbackElection();
    ok(fresh._fallbackTimer === t, 'arming it twice does not stack a second timer');
    fresh._clearFallbackTimer();
    ok(fresh._fallbackTimer === null, 'and clearing it releases the handle');
  });
});

// === 6. The two clients cannot diverge: identical drive, identical state ====
//
// The end of the finding, stated as an assertion. The same close sequence is
// driven through a real NetMgr and a real DesktopNet and their whole transport
// state is compared field by field. Before the extraction this compared two
// implementations and could only ever be evidence; now it compares two callers
// of one implementation, and it stays here as the tripwire for anyone who
// re-inlines either half.
section('NetMgr and DesktopNet: same drive, same transport state', () => {
  withFakeWS(() => withQuietConsole(() => {
    const snapshot = (c) => JSON.stringify({
      connected: c._connected,
      closing: c._closing,
      tries: c._reconnectTries,
      timerArmed: c._reconnectTimer !== null,
      retryLater: c._retryLater,
      fatal: c._fatal,
      lastClose: c.lastClose,
      serverVersion: c.serverVersion,
      hostId: c._hostId,
      serverElects: c._serverElects,
    });
    // A sequence that touches every branch worth comparing: a soft refusal (slow
    // table + sticky flag), a session (reset), an ordinary drop (fast table).
    const drive = (client) => {
      client.connect();
      const ws = FakeWS.last;
      ws.drop(1013, 'room "r" full (16/16)');
      clearTimeout(client._reconnectTimer); client._reconnectTimer = null;
      ws.accept();
      ws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      ws.drop(1006);
      clearTimeout(client._reconnectTimer); client._reconnectTimer = null;
      return snapshot(client);
    };
    const vr = drive(makeNetMgr());
    const flat = drive(makeDesktopNet());
    ok(vr === flat, `the same close sequence leaves both clients in the same transport state\n    NetMgr:     ${vr}\n    DesktopNet: ${flat}`);

    // NEGATIVE CONTROL: the comparison can tell states apart at all. Without it,
    // a snapshot() that had quietly started returning a constant would make the
    // line above pass forever.
    const driftedDrive = (client) => {
      client.connect();
      FakeWS.last.drop(PROTOCOL_CLOSE_CODE, 'protocol 9.0 incompatible (this end speaks 1.x)');
      return snapshot(client);
    };
    ok(driftedDrive(makeNetMgr()) !== vr,
      'NEGATIVE CONTROL: a DIFFERENT sequence produces a different snapshot (the comparison is not vacuous)');

    // …and the permanent-refusal path agrees between the two as well, which is
    // the specific rule that had to be written twice before this change.
    const fatalVr = driftedDrive(makeNetMgr());
    const fatalFlat = driftedDrive(makeDesktopNet());
    ok(fatalVr === fatalFlat, `a 4010 leaves both clients identical too\n    NetMgr:     ${fatalVr}\n    DesktopNet: ${fatalFlat}`);
  }));
});

// === 7. DesktopNet's close-handler callbacks, the one asymmetry =============
//
// The extraction had to keep exactly one behavioural difference: DesktopNet
// fires its `onDisconnect` from the close handler on BOTH the permanent and the
// retryable path, and NetMgr fires nothing there. That is now an `onFatalTeardown`
// / `onClosed` hook pair rather than a second copy of the handler — which means
// it is exactly the kind of thing a later "simplification" could drop without any
// other suite noticing, since src/desktop/main.js is the only caller.
section('DesktopNet still fires onConnect/onDisconnect from the shared handler', () => {
  withFakeWS(() => withQuietConsole(() => {
    const log = [];
    const flat = makeDesktopNet({
      onConnect: (id) => log.push(`connect:${id}`),
      onDisconnect: () => log.push('disconnect'),
    });
    flat.connect();
    const ws = FakeWS.last;
    ws.accept();
    ws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
    ok(log.join(',') === 'connect:me', 'onConnect fires once, with our server-assigned id');
    ws.drop(1006);
    ok(log.join(',') === 'connect:me,disconnect', 'a retryable close fires onDisconnect');
    clearTimeout(flat._reconnectTimer); flat._reconnectTimer = null;

    const log2 = [];
    const flat2 = makeDesktopNet({ onDisconnect: () => log2.push('disconnect') });
    flat2.connect();
    FakeWS.last.accept();
    FakeWS.last.drop(PROTOCOL_CLOSE_CODE, 'protocol 9.0 incompatible (this end speaks 1.x)');
    ok(log2.length === 1, 'and so does a PERMANENT refusal — the app must not be left showing "connected"');

    // CONTROL: the VR client deliberately does NOT have this callback, so the
    // hook is an asymmetry that was preserved, not a behaviour that leaked into
    // both. (NetMgr signals the same thing through onHostChange/onRetry.)
    ok(!('_onDisconnect' in makeNetMgr()), 'NEGATIVE CONTROL: NetMgr has no onDisconnect to fire');
  }));
});

// === 8. LEAVE → REJOIN → blip still reconnects (the one behaviour the ========
//        extraction CHANGED, on purpose)
//
// This is the only place the move is not byte-for-byte. NetMgr's 'open' handler
// cleared `_closing`; DesktopNet's did not, and the shared handler does — so the
// flat-screen client's behaviour changed here, and it changed because the copy
// was wrong.
//
// The bug it fixes is reachable from the UI: src/desktop/main.js binds Leave and
// Join to disconnect()/connect() on the SAME instance (its mp button toggles
// between them). disconnect() sets `_closing = true`; without the reset, the
// rejoined socket's close handler still saw a "we are deliberately leaving"
// session, so `if (!this._closing)` skipped BOTH the demotion and the reconnect.
// A Wi-Fi blip after a rejoin therefore left the desktop client offline for the
// rest of the page's life while still believing it was the room's host — the
// second-host bug the demotion exists to prevent, plus the dead end the
// first-connect retry gate was fixed for. Asserted for both classes because
// after the extraction there is one rule, and it is now this one.
section('Rejoin after a deliberate leave still arms the reconnect', () => {
  withFakeWS(() => withQuietConsole(() => {
    for (const [name, make] of [['NetMgr', makeNetMgr], ['DesktopNet', makeDesktopNet]]) {
      const c = make();
      c.connect();
      FakeWS.last.accept();
      FakeWS.last.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      ok(c.isHost(), `${name} (precondition): we are the room's host`);
      c.disconnect();                       // the user pressed Leave
      ok(c._closing === true, `${name} (precondition): a deliberate leave marks the session closed`);
      c.connect();                          // …and then Join again
      FakeWS.last.accept();
      ok(c._closing === false, `${name}: rejoining clears the "we are leaving" flag`);
      FakeWS.last.deliver(makeHello({ selfId: 'me2', room: 'r', peers: [], host: 'me2' }));
      FakeWS.last.drop(1006);               // a Wi-Fi blip after the rejoin
      ok(c._reconnectTimer !== null && c._reconnectTries === 1,
        `${name}: a blip after a rejoin still schedules a reconnect`);
      ok(c.hostId() === null, `${name}: and still demotes us, so we cannot run as a second host`);
      c.disconnect();
    }
  }));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
