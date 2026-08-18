// Unit tests for the M0 presence layer — pure protocol + peer registry
// ([[src/net/NetProtocol.js]], [[src/net/PresenceState.js]]). No socket, no
// server, no port, so this runs in `npm test`.
//
// It DOES import the two real client classes (NetMgr, DesktopNet) and drive their
// connection lifecycle over a fake global WebSocket — see the COR-9 block near the
// bottom. That pulls three in, which is fine in Node; what it buys is that the
// protocol claims are asserted against the code that ships, not against a
// reimplementation of it in this file.

import {
  MSG, POSE_LEN, SIGNAL_KINDS, isValidPart, roundPart, makePose, makeJoin, makeHello,
  makeLeave, makeSignal, makeState, makeInput, makeWire, makeHost, hostInputTarget, validate, encode, decode,
  buildIceServers,
  PROTOCOL_VERSION, PROTOCOL_CLOSE_CODE, parseProtocolVersion, checkProtocol, judgeServerVersion, isPermanentClose,
  MAX_INPUT_PLAYER, MAX_INPUT_BTN_LEN,
} from '../src/net/NetProtocol.js';
import { DesktopNet } from '../src/desktop/DesktopNet.js';
// The VR client, driven for real (over a fake global WebSocket) further down. It
// pulls in three + AvatarMgr/VoiceMgr/VideoMgr, none of which need a DOM until a
// capture or a mic starts — so it still runs in the pure `npm test` tier, with no
// browser, no server and no port.
import { NetMgr } from '../src/net/NetMgr.js';
import { PresenceState } from '../src/net/PresenceState.js';
import { RoomObjects } from '../src/net/RoomObjects.js';
import { makeHoldKey, isHoldKey, parseHolds } from '../src/net/HoldState.js';
import { Hub, HOST_RECLAIM_MS, HUB_LIMITS, isHostOwnedKey, isOwnerScopedKey } from '../server/Hub.js';
import { FALLBACK_HOST_KEY, claimWins, normaliseClaim, resolveFallbackHost } from '../src/net/HostElection.js';
// node:fs/node:path only — the RELAY-2 caps are calibrated against REAL files in
// this tree (a committed room descriptor), the same way the STATE budgets are in
// scripts/test-room-limits.mjs. Neither is on run-tests.mjs's impure list, so
// this stays a pure logic-tier suite: no socket, no port, no browser.
import { readFileSync } from 'node:fs';
import { dirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };

// Every test block below runs inside section(), and this is why (2026-08-15):
// an assertion's CONDITION can throw before ok() is ever called — a `.length` on
// something an inversion turned undefined, a decode() that returned null, a
// debugApi field that was deleted. A throw at module top level ABORTS the file,
// so a partial revert used to print three FAIL lines and then lose the remaining
// ~370 assertions, including the entire real-NetMgr/real-DesktopNet block. That
// is a crash, not a negative control. Here a throw costs exactly its own
// section: it is counted as one failure, printed as a FAIL line naming the
// section and the error, and the next section still runs. Individual assertions
// are ALSO written defensively (`?.`), so most inversions cost one line, not one
// section — this is the backstop for the ones nobody anticipated.
const section = (name, fn) => {
  try {
    fn();
  } catch (e) {
    failed++;
    console.error(`  FAIL: [${name}] section threw ${e?.constructor?.name ?? 'Error'}: ${e?.message} — remaining assertions in it did not run`);
  }
};

const HEAD = [1, 1.6, -2, 0, 0, 0, 1];
const HAND = [0.2, 1.2, -1.5, 0, 0, 0, 1];

// === Harness: a throwing section degrades to a FAIL line ====================
//
// The crash guard is itself a mechanism, so it gets its own assertion rather
// than a comment claiming it works. A deliberate TypeError is driven through
// section(); the FAIL line it emits is captured (so a green run stays clean) and
// the bookkeeping it added is rolled back, because that failure was on purpose.
// Take the try/catch out of section() and the throw escapes into the enclosing
// section instead — still red, just one level up.
section('Harness: section() contains a throw', () => {
  const before = failed;
  const realErr = console.error;
  let line = null;
  console.error = (s) => { line = String(s); };
  let escaped = null;
  // The escape hatch is caught here too, so that if section() STOPS containing
  // throws this reports a FAIL line instead of becoming the abort it exists to
  // prevent.
  try { section('deliberate', () => { const boom = null; return boom.nope; }); }
  catch (e) { escaped = e?.constructor?.name ?? 'Error'; }
  finally { console.error = realErr; }
  const contained = escaped === null && (failed === before + 1)
    && /FAIL: \[deliberate\] section threw TypeError/.test(line ?? '');
  failed = before;  // the deliberate throw is not a real failure
  ok(contained, `a throw inside a section is reported as one FAIL line, not an abort (escaped=${escaped}, saw: ${JSON.stringify(line)})`);
});

// === NetProtocol: pose parts ===============================================
section('NetProtocol: pose parts', () => {
  ok(isValidPart(null), 'null is a valid (untracked) part');
  ok(isValidPart(HEAD), 'a 7-tuple is a valid part');
  ok(!isValidPart([1, 2, 3]), 'a short tuple is invalid');
  ok(!isValidPart([0, 0, 0, 0, 0, 0, NaN]), 'NaN in a part is invalid');
  ok(!isValidPart('nope'), 'a string is not a part');
  ok(POSE_LEN === 7, 'pose length is 7');
});

// === NetProtocol: rounding keeps packets small =============================
section('NetProtocol: rounding keeps packets small', () => {
  const r = roundPart([1.23456, 0, 0, 0, 0, 0, 1], 3);
  ok(r[0] === 1.235, 'roundPart rounds to 3 decimals');
  ok(roundPart(null) === null, 'roundPart passes null through');
  const p = makePose({ head: [1.111111, 2.222222, 3.333333, 0, 0, 0, 1], decimals: 2 });
  ok(p.head[0] === 1.11 && p.head[1] === 2.22, 'makePose rounds at the requested precision');
  ok(p.left === null && p.right === null, 'makePose defaults untracked hands to null');
  ok(p.type === MSG.POSE, 'makePose stamps the POSE type');
});

// === NetProtocol: builders + validation ====================================
section('NetProtocol: builders + validation', () => {
  ok(validate(makeJoin({ id: 'a', nick: 'Kasper', color: '#f00' })).ok, 'JOIN validates');
  ok(validate(makeLeave({ id: 'a' })).ok, 'LEAVE validates');
  ok(validate(makeHello({ selfId: 'a', peers: [{ id: 'b', nick: 'B' }] })).ok, 'HELLO validates');
  ok(validate(makePose({ head: HEAD, left: HAND })).ok, 'POSE validates');

  ok(!validate({ type: 'bogus' }).ok, 'unknown type rejected');
  ok(!validate(null).ok, 'null rejected');
  ok(!validate({ type: MSG.POSE, head: [1, 2] }).ok, 'POSE with a bad part rejected');
  ok(!validate({ type: MSG.LEAVE }).ok, 'LEAVE without id rejected');

  // makeHello/makeJoin coerce defaults so the wire shape is always complete.
  const h = makeHello({ selfId: 7, peers: [{ id: 9 }] });
  ok(h.selfId === '7' && h.peers[0].id === '9', 'makeHello stringifies ids');
  ok(h.peers[0].nick === 'Player' && h.peers[0].color === '#88aaff', 'makeHello fills nick/color defaults');
});

// === NetProtocol: encode/decode round-trip + bad input =====================
section('NetProtocol: encode/decode round-trip + bad input', () => {
  const msg = makePose({ head: HEAD, left: HAND, id: 'x', t: 123 });
  const back = decode(encode(msg));
  ok(back && back.id === 'x' && back.head[0] === HEAD[0], 'encode→decode round-trips a POSE');
  ok(decode('{not json') === null, 'decode returns null on bad JSON');
  ok(decode(encode({ type: 'bogus' })) === null, 'decode returns null on invalid shape');
});

// === PresenceState: join / leave / self-exclusion ==========================
section('PresenceState: join / leave / self-exclusion', () => {
  const ps = new PresenceState({ selfId: 'me' });
  ps.apply(makeJoin({ id: 'me', nick: 'Me' }), 0);  // self must be ignored
  ok(ps.size === 0, 'a JOIN for self is ignored');

  ps.apply(makeJoin({ id: 'a', nick: 'Alice', color: '#0f0' }), 0);
  ps.apply(makeJoin({ id: 'b', nick: 'Bob' }), 0);
  ok(ps.size === 2, 'two remote peers tracked');
  ok(ps.get('a').nick === 'Alice' && ps.get('a').color === '#0f0', 'peer nick/color recorded');

  ps.apply(makeLeave({ id: 'a' }), 0);
  ok(ps.size === 1 && !ps.get('a'), 'LEAVE removes the peer');
});

// === PresenceState: HELLO seeds the roster and self id =====================
section('PresenceState: HELLO seeds the roster and self id', () => {
  const ps = new PresenceState();
  ps.apply(makeHello({ selfId: 'me', peers: [{ id: 'a', nick: 'A' }, { id: 'me', nick: 'self?' }] }), 0);
  ok(ps.selfId === 'me', 'HELLO sets selfId');
  ok(ps.size === 1 && !!ps.get('a'), 'HELLO seeds peers but excludes self');
});

// === PresenceState: pose updates ===========================================
section('PresenceState: pose updates', () => {
  const ps = new PresenceState({ selfId: 'me' });
  ps.apply(makePose({ id: 'a', head: HEAD, left: HAND }), 100);
  const a = ps.get('a');
  ok(!!a, 'POSE from an unknown peer auto-creates it');
  ok(a.pose.head[1] === HEAD[1] && a.pose.left[0] === HAND[0], 'pose head+left stored');
  ok(a.pose.right === null, 'untracked right hand stays null');
  ok(a.lastSeen === 100, 'lastSeen stamped from nowMs');

  ps.apply(makePose({ id: 'me', head: HEAD }), 200); // our own pose echoed back
  ok(ps.size === 1, 'a POSE for self is ignored (we never render our own avatar)');
});

// === PresenceState: prune stale peers ======================================
section('PresenceState: prune stale peers', () => {
  const ps = new PresenceState({ selfId: 'me', ttlMs: 5000 });
  ps.apply(makePose({ id: 'a', head: HEAD }), 0);
  ps.apply(makePose({ id: 'b', head: HEAD }), 4000);

  let removed = ps.prune(4000);
  ok(removed.length === 0 && ps.size === 2, 'nothing pruned within ttl');

  removed = ps.prune(6000); // a last seen at 0 → 6000ms stale > 5000; b at 4000 → 2000ms fresh
  ok(removed.length === 1 && removed[0] === 'a', 'prune drops only the peer past ttl');
  ok(ps.size === 1 && !!ps.get('b'), 'fresh peer survives prune');

  // A fresh pose resets the clock so it survives the next prune.
  ps.apply(makePose({ id: 'b', head: HEAD }), 7000);
  ok(ps.prune(8000).length === 0, 'a recent pose keeps a peer alive');
});

// === Hub (server relay logic): connect / hello roster ======================
section('Hub (server relay logic): connect / hello roster', () => {
  const hub = new Hub();
  const r1 = hub.connect('room1', 'p1');
  ok(r1.hello.type === MSG.HELLO && r1.hello.selfId === 'p1', 'connect returns HELLO with selfId');
  ok(r1.hello.peers.length === 0, 'first peer sees an empty roster');

  const r2 = hub.connect('room1', 'p2');
  ok(r2.hello.peers.length === 1 && r2.hello.peers[0].id === 'p1', 'second peer sees the first in its roster');
  ok(hub.size('room1') === 2, 'room has two peers');
});

// === Hub: M1.4 host election — first in hosts, seniority migration ==========
//
// The old rule ("whoever last wrote the shared `tv` state is the host") is gone:
// it flipped the role on every cartridge insert and could elect a peer that does
// not even have the ROM. The server now elects the LONGEST-PRESENT peer and
// re-elects only when that peer disconnects.
section('Hub: M1.4 host election — first in hosts, seniority migration', () => {
  const hub = new Hub();
  const a = hub.connect('r', 'a');
  ok(a.hello.host === 'a', 'the first peer in an empty room is elected host');
  ok(hub.hostOf('r') === 'a', 'hostOf reports the elected host');
  ok(!a.hostBroadcast, 'nobody to tell about the first election');

  const b = hub.connect('r', 'b');
  ok(b.hello.host === 'a', 'a later joiner is told the incumbent host, not itself');
  ok(!b.hostBroadcast, 'a plain join does not re-elect (no HOST broadcast)');
  const c = hub.connect('r', 'c');
  ok(c.hello.host === 'a', 'a third joiner also sees the incumbent');

  // An in-room action (writing `tv`) must NOT move the role any more.
  hub.setState('r', 'c', { key: 'tv', value: { file: 'g.nes', core: 'fceumm' } });
  ok(hub.hostOf('r') === 'a', 'writing the tv state does NOT make that peer the host');

  // Host leaves → seniority: 'b' joined before 'c', so 'b' takes over.
  const d = hub.disconnect('r', 'a');
  ok(d.hostChange && d.hostChange.type === MSG.HOST && d.hostChange.id === 'b',
    'when the host leaves, the longest-present remaining peer is promoted');
  ok(hub.hostOf('r') === 'b', 'hostOf reflects the migration');
  ok(validate(d.hostChange).ok, 'the HOST migration message validates on the wire');

  // A NON-host leaving changes nothing.
  ok(!hub.disconnect('r', 'c').hostChange, 'a non-host leaving does not re-elect');
  ok(hub.hostOf('r') === 'b', 'host unchanged after a client leaves');
});

// === Hub: M1.4 DEFERRED host migration + reclaim across the host's own reload =
//
// The app reloads the page for a cross-core cartridge swap, so the host vanishes
// for a couple of seconds on an ordinary game switch. Promoting a stand-in
// immediately (what this used to do) meant that stand-in got the role, BOOTED the
// room's cartridge into its own core, and was demoted ~150ms later when the real
// host came back — leaving every client running its own extra core. So the room now
// stays deliberately HOSTLESS for HOST_RECLAIM_MS and only migrates if the host
// really is gone.
section("Hub: M1.4 DEFERRED host migration + reclaim across the host's own reload", () => {
  const hub = new Hub();
  hub.connect('r', 'a', { sid: 'sidA', now: 1000 });
  hub.connect('r', 'b', { sid: 'sidB', now: 1000 });
  ok(hub.hostOf('r') === 'a', 'a hosts');

  const gone = hub.disconnect('r', 'a', { now: 2000 });          // host reloads
  ok(!gone.hostChange, 'the host leaving does NOT immediately promote a stand-in');
  ok(gone.hostGraceMs === HOST_RECLAIM_MS, 'the adapter is told to schedule the reclaim window');
  ok(hub.hostOf('r') === null, 'the room is deliberately hostless during the window');

  const back = hub.connect('r', 'a2', { sid: 'sidA', now: 4000 }); // same tab returns
  ok(back.hello.host === 'a2', 'the returning host reclaims the role (same sid, inside the window)');
  ok(back.hostBroadcast && back.hostBroadcast.id === 'a2', 'the others are told the role is back');
  ok(hub.hostOf('r') === 'a2', 'hostOf reflects the reclaim');
  ok(!hub.expireHostGrace('r', { now: 100000 }).hostChange,
    'a window that was reclaimed is inert when its timer finally fires');

  // The host never comes back → the window expires and seniority applies.
  const hub2 = new Hub();
  hub2.connect('r', 'a', { sid: 'sidA', now: 1000 });
  hub2.connect('r', 'b', { sid: 'sidB', now: 1000 });
  hub2.connect('r', 'c', { sid: 'sidC', now: 1100 });
  hub2.disconnect('r', 'a', { now: 2000 });
  ok(hub2.hostOf('r') === null, 'still hostless right after the host drops');
  ok(!hub2.expireHostGrace('r', { now: 2000 }).hostChange, 'expiring early is a no-op');
  const exp = hub2.expireHostGrace('r', { now: 2000 + HOST_RECLAIM_MS + 1 });
  ok(exp.hostChange && exp.hostChange.id === 'b',
    'once the window expires the LONGEST-PRESENT remaining peer is promoted (seniority)');
  ok(hub2.hostOf('r') === 'b', 'hostOf reflects the deferred migration');
  ok(!hub2.expireHostGrace('r', { now: 999999 }).hostChange, 'expireHostGrace is idempotent');

  // Joining DURING the window neither promotes the joiner nor steals the slot.
  const hub3 = new Hub();
  hub3.connect('r', 'a', { sid: 'sidA', now: 0 });
  hub3.connect('r', 'b', { sid: 'sidB', now: 0 });
  hub3.disconnect('r', 'a', { now: 0 });
  const z = hub3.connect('r', 'z', { sid: 'other', now: 10 });
  ok(z.hello.host === null, 'a joiner during the reclaim window is told there is no host yet');
  ok(!z.hostBroadcast, 'and no HOST broadcast is produced for it');
  ok(hub3.hostOf('r') === null, 'a different sid cannot claim the departed host slot');
  // …and when the window expires, seniority still picks 'b' (present before 'z').
  ok(hub3.expireHostGrace('r', { now: HOST_RECLAIM_MS + 1 }).hostChange?.id === 'b',
    'seniority ignores peers that joined during the window');

  // A reconnect AFTER the window is just a normal junior join.
  const hub4 = new Hub();
  hub4.connect('r', 'a', { sid: 'sidA', now: 1000 });
  hub4.connect('r', 'b', { sid: 'sidB', now: 1000 });
  hub4.disconnect('r', 'a', { now: 2000 });
  hub4.expireHostGrace('r', { now: 2000 + HOST_RECLAIM_MS + 1 });
  const late = hub4.connect('r', 'a2', { sid: 'sidA', now: 2000 + 60000 });
  ok(late.hello.host === 'b', 'a reconnect after the grace window does NOT reclaim');
  ok(!late.hostBroadcast, 'no HOST broadcast for a late (non-reclaiming) rejoin');

  // The LAST peer leaving takes the window with it: the next arrival hosts.
  const hub5 = new Hub();
  hub5.connect('r', 'a', { sid: 'sidA', now: 0 });
  const solo = hub5.disconnect('r', 'a', { now: 0 });
  ok(!solo.hostGraceMs, 'no reclaim window when there is nobody left to host for');
  ok(hub5.connect('r', 'n', { sid: 'sidN', now: 5 }).hello.host === 'n',
    'the next peer into an emptied room is the host straight away');

  // No sid (a client that cannot identify its tab) → immediate migration, as before.
  const hub6 = new Hub();
  hub6.connect('r', 'a', { now: 0 });
  hub6.connect('r', 'b', { now: 0 });
  const nosid = hub6.disconnect('r', 'a', { now: 0 });
  ok(nosid.hostChange && nosid.hostChange.id === 'b',
    'a host with no sid cannot reclaim, so the role migrates immediately');
  ok(!nosid.hostGraceMs, 'and no window is scheduled for it');
});

// === Hub: M1.4 host-OWNED shared keys are server-enforced ===================
//
// `tv` / `room` / `shelf:*` describe the room the HOST owns. A client-side check is
// worthless on its own: an older deployed build still writes `tv` on every local
// boot, and the host's own convergence path would then boot whatever that client
// wrote — i.e. any peer could hijack what the room plays.
section('Hub: M1.4 host-OWNED shared keys are server-enforced', () => {
  ok(isHostOwnedKey('tv') && isHostOwnedKey('room'), 'tv + room are host-owned');
  ok(isHostOwnedKey('shelf:local') && isHostOwnedKey('shelf:collections'), 'shelf:* is host-owned');
  ok(!isHostOwnedKey('prop:lamp') && !isHostOwnedKey('hold:x') && !isHostOwnedKey('gamepad:1'),
    'per-peer keys are NOT host-owned');

  const hub = new Hub();
  hub.connect('r', 'host', { sid: 's1', now: 0 });
  hub.connect('r', 'client', { sid: 's2', now: 0 });

  const good = hub.setState('r', 'host', { key: 'tv', value: { file: 'g.nes', core: 'fceumm' } });
  ok(good.broadcast && !good.rejected, 'the host may write tv');

  const bad = hub.setState('r', 'client', { key: 'tv', value: { file: 'other.sfc', core: 'snes9x' } });
  ok(bad.rejected === 'not-host', 'a client writing tv is rejected');
  ok(!bad.broadcast, 'and nothing is relayed to the room');
  ok(bad.direct?.to === 'client' && bad.direct?.msg?.value?.file === 'g.nes',
    'the rejected writer is sent the authoritative value back so it cannot diverge');

  const shelf = hub.setState('r', 'client', { key: 'shelf:local', value: [{ file: 'mine.gb' }] });
  ok(shelf.rejected === 'not-host', 'a client cannot push its own library onto the room shelf');

  // A per-peer key is still free for anyone.
  ok(hub.setState('r', 'client', { key: 'prop:lamp', value: { pos: [0, 0, 0] } }).broadcast,
    'a client may still write its own prop deltas');

  // …and during the reclaim window the ABSENT host still owns them.
  hub.disconnect('r', 'host', { now: 1000 });
  ok(hub.hostOf('r') === null, 'hostless during the window');
  const inWindow = hub.setState('r', 'client', { key: 'tv', value: { file: 'sneaky.gb', core: 'gambatte' }, now: 1500 });
  ok(inWindow.rejected === 'host-reclaim-window',
    'a client cannot redefine the room while its host is reloading');
  ok(inWindow.direct?.msg?.value?.file === 'g.nes', 'and it is corrected back to the real value');
  // Once the window expires the new host owns them.
  hub.expireHostGrace('r', { now: 1000 + HOST_RECLAIM_MS + 1 });
  ok(hub.hostOf('r') === 'client', 'the remaining peer is the host now');
  ok(hub.setState('r', 'client', { key: 'tv', value: { file: 'mine.gb', core: 'gambatte' } }).broadcast,
    'the promoted peer may write tv');
});

// === HostElection: the client-side fallback for a pre-M1.4 room server =======
//
// Shipping a client whose boot gate needs a host, against a relay that never names
// one, would mean nobody may ever host — no game at all for anyone. The peers then
// elect among themselves over the persisted STATE channel, reproducing the server's
// seniority rule: the EARLIEST claim by a still-present peer wins.
section('HostElection: the client-side fallback for a pre-M1.4 room server', () => {
  ok(FALLBACK_HOST_KEY === 'hostClaim', 'the fallback claim rides its own state key');

  ok(claimWins({ id: 'b', at: 10 }, { id: 'a', at: 20 }), 'the earlier claim wins');
  ok(!claimWins({ id: 'b', at: 20 }, { id: 'a', at: 10 }), 'the later claim loses');
  ok(claimWins({ id: 'a', at: 10 }, { id: 'b', at: 10 }), 'a tie is broken by the smaller id');
  ok(!claimWins({ id: 'b', at: 10 }, { id: 'a', at: 10 }), 'and the larger id loses that tie');

  ok(normaliseClaim({ id: 'a', at: 5 }).at === 5, 'a well-formed claim normalises');
  ok(normaliseClaim({ id: 7, at: '5' }).id === '7', 'ids/times are coerced');
  ok(normaliseClaim(null) === null && normaliseClaim({ at: 1 }) === null, 'a claim without an id is dropped');

  // One peer alone elects itself and announces.
  const solo = resolveFallbackHost({
    claims: [{ id: 'a', at: 100 }], presentIds: ['a'], selfId: 'a', now: 100, stored: null,
  });
  ok(solo.hostId === 'a', 'a lone peer elects itself');
  ok(solo.announce && solo.announce.id === 'a', 'and announces the claim so late joiners see it');

  // Two peers: the earlier claim wins for BOTH of them (same answer everywhere).
  const claims = [{ id: 'a', at: 100 }, { id: 'b', at: 200 }];
  ok(resolveFallbackHost({ claims, presentIds: ['a', 'b'], selfId: 'a', now: 200, stored: { id: 'a', at: 100 } }).hostId === 'a',
    'the senior peer sees itself as host');
  ok(resolveFallbackHost({ claims, presentIds: ['a', 'b'], selfId: 'b', now: 200, stored: { id: 'a', at: 100 } }).hostId === 'a',
    'the junior peer agrees');

  // A claim by a peer that has LEFT is ignored — that is the migration path.
  ok(resolveFallbackHost({ claims, presentIds: ['b'], selfId: 'b', now: 300, stored: { id: 'a', at: 100 } }).hostId === 'b',
    'when the elected fallback host leaves, the earliest REMAINING claim wins');

  // Last-writer-wins can leave a LOSING claim stored; the winner re-announces.
  const fix = resolveFallbackHost({
    claims, presentIds: ['a', 'b'], selfId: 'a', now: 200, stored: { id: 'b', at: 200 },
  });
  ok(fix.hostId === 'a', 'a stale stored claim does not change who wins');
  ok(fix.announce && fix.announce.id === 'a', 'the winner re-announces so the channel converges');
  // A non-winner never announces on someone else's behalf.
  ok(!resolveFallbackHost({ claims, presentIds: ['a', 'b'], selfId: 'b', now: 200, stored: { id: 'a', at: 100 } }).announce,
    'a peer that did not win stays quiet');
});

// === Hub: identify broadcasts a JOIN to others (not self) ==================
section('Hub: identify broadcasts a JOIN to others (not self)', () => {
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  const { broadcast } = hub.identify('r', 'a', { nick: 'Alice', color: '#0f0' });
  ok(broadcast.msg.type === MSG.JOIN && broadcast.msg.id === 'a', 'identify broadcasts a JOIN stamped with the peer id');
  ok(broadcast.msg.nick === 'Alice' && broadcast.msg.color === '#0f0', 'identify carries nick/color');
  ok(broadcast.exclude === 'a', 'the joining peer is excluded from its own JOIN broadcast');
});

// === Hub: pose is stamped with the server-side id (anti-spoof) =============
section('Hub: pose is stamped with the server-side id (anti-spoof)', () => {
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  // 'a' tries to send a pose claiming to be 'b' — server must overwrite the id.
  const { broadcast } = hub.pose('r', 'a', makePose({ id: 'b', head: HEAD }));
  ok(broadcast.msg.type === MSG.POSE && broadcast.msg.id === 'a', 'pose id is forced to the real sender (spoof rejected)');
  ok(broadcast.exclude === 'a', 'sender excluded from its own pose broadcast');
  ok(hub.pose('r', 'ghost', makePose({ head: HEAD })).broadcast === undefined, 'pose from an unknown peer is dropped');
});

// === NetProtocol: SIGNAL (voice) builder + validation ======================
section('NetProtocol: SIGNAL (voice) builder + validation', () => {
  const offer = makeSignal({ to: 'b', kind: 'offer', data: { sdp: 'v=0...', type: 'offer' } });
  ok(offer.type === MSG.SIGNAL && offer.to === 'b' && offer.kind === 'offer', 'makeSignal builds an offer');
  ok(validate(offer).ok, 'SIGNAL validates');
  // 'bye' joined offer/answer/ice on 2026-08-14: VideoMgr always sent it, but the
  // validator rejected it, so host video teardown never crossed the wire
  // (CLAUDE_REVIEW §5.2 / CODEX_REVIEW COR-1). Assert the exact set, not a count,
  // so both a dropped kind and a smuggled-in one fail here.
  ok(SIGNAL_KINDS.join(',') === 'offer,answer,ice,bye', 'four signal kinds, in contract order');
  ok(!validate({ type: MSG.SIGNAL, to: 'b', kind: 'bogus', data: {} }).ok, 'bad signal kind rejected');
  ok(!validate({ type: MSG.SIGNAL, kind: 'offer', data: {} }).ok, 'signal without `to` rejected');
  ok(!validate({ type: MSG.SIGNAL, to: 'b', kind: 'offer' }).ok, 'signal without data rejected');
  const back = decode(encode(makeSignal({ to: 'b', kind: 'ice', data: { candidate: 'x' } })));
  ok(back && back.kind === 'ice' && back.data.candidate === 'x', 'SIGNAL round-trips through encode/decode');

  // M1.2: optional `channel` multiplexes voice vs the host→client video stream.
  ok(makeSignal({ to: 'b', kind: 'offer', data: {} }).channel === undefined, 'voice SIGNAL carries no channel (back-compat)');
  const vid = makeSignal({ to: 'b', kind: 'offer', data: { sdp: 's' }, channel: 'video' });
  ok(vid.channel === 'video' && validate(vid).ok, 'a video-channel SIGNAL validates');
  ok(validate(makeSignal({ to: 'b', kind: 'offer', data: {}, channel: 'voice' })).ok, 'an explicit voice channel validates');
  ok(!validate({ type: MSG.SIGNAL, to: 'b', kind: 'offer', data: {}, channel: 'bogus' }).ok, 'an unknown channel is rejected');
  ok(decode(encode(vid)).channel === 'video', 'channel survives encode/decode');
});

// === Hub: signal is a DIRECTED relay, sender-id stamped ====================
section('Hub: signal is a DIRECTED relay, sender-id stamped', () => {
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  const { direct } = hub.signal('r', 'a', makeSignal({ to: 'b', kind: 'offer', data: { sdp: 's' } }));
  ok(direct && direct.to === 'b', 'signal is routed directly to the target peer');
  ok(direct.msg.from === 'a', 'signal is stamped with the real sender id (anti-spoof)');
  ok(hub.signal('r', 'a', makeSignal({ to: 'ghost', kind: 'offer', data: {} })).direct === undefined, 'signal to an absent peer is dropped');
  ok(hub.signal('r', 'x', makeSignal({ to: 'b', kind: 'offer', data: {} })).direct === undefined, 'signal from an absent peer is dropped');
});

// === Hub: disconnect broadcasts LEAVE and reaps empty rooms ================
section('Hub: disconnect broadcasts LEAVE and reaps empty rooms', () => {
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  const { broadcast } = hub.disconnect('r', 'a');
  ok(broadcast.msg.type === MSG.LEAVE && broadcast.msg.id === 'a', 'disconnect broadcasts a LEAVE for the peer');
  ok(hub.size('r') === 1, 'peer removed from room');
  ok(hub.roomCount() === 1, 'room still exists while one peer remains');
  hub.disconnect('r', 'b');
  ok(hub.roomCount() === 0, 'empty room is reaped');
});

// === NetProtocol: STATE (room-object sync) builder + validation ============
section('NetProtocol: STATE (room-object sync) builder + validation', () => {
  const tv = makeState({ key: 'tv', value: { file: 'pong.nes', core: 'nestopia' } });
  ok(tv.type === MSG.STATE && tv.key === 'tv' && tv.value.file === 'pong.nes', 'makeState builds a STATE entry');
  ok(validate(tv).ok, 'STATE validates');
  ok(validate(makeState({ key: 'tv', value: null })).ok, 'STATE with a null value (clear) validates');
  ok(!validate({ type: MSG.STATE, key: '', value: 1 }).ok, 'STATE with an empty key rejected');
  ok(!validate({ type: MSG.STATE, key: 'tv' }).ok, 'STATE without a value field rejected');
  const back = decode(encode(makeState({ key: 'hold:c1', value: { holder: 'a' }, id: 'a' })));
  ok(back && back.key === 'hold:c1' && back.value.holder === 'a' && back.id === 'a', 'STATE round-trips through encode/decode');
});

// === RoomObjects: apply / changed / clear ==================================
section('RoomObjects: apply / changed / clear', () => {
  const ro = new RoomObjects();
  const r1 = ro.apply(makeState({ key: 'tv', value: { file: 'a.nes' }, id: 'p1' }));
  ok(r1.changed && ro.get('tv').file === 'a.nes', 'first STATE sets the value and reports changed');
  ok(ro.ownerOf('tv') === 'p1', 'owner (setter id) recorded');

  const r2 = ro.apply(makeState({ key: 'tv', value: { file: 'a.nes' }, id: 'p1' }));
  ok(!r2.changed, 'an identical STATE is not flagged as changed (echo/replay dedup)');

  const r3 = ro.apply(makeState({ key: 'tv', value: { file: 'b.nes' }, id: 'p2' }));
  ok(r3.changed && ro.get('tv').file === 'b.nes', 'last-writer-wins overwrite reported as changed');

  const r4 = ro.apply(makeState({ key: 'tv', value: null }));
  ok(r4.changed && ro.get('tv') === null && !ro.has('tv'), 'a null value clears the key');
  ok(ro.size === 0, 'cleared key removed from the registry');
});

// === Hub: setState persists, broadcasts, and snapshots to late joiners ======
section('Hub: setState persists, broadcasts, and snapshots to late joiners', () => {
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  const { broadcast } = hub.setState('r', 'a', { key: 'tv', value: { file: 'pong.nes' } });
  ok(broadcast.msg.type === MSG.STATE && broadcast.msg.key === 'tv', 'setState broadcasts a STATE');
  ok(broadcast.msg.id === 'a', 'STATE stamped with the real setter id');
  ok(broadcast.exclude === 'a', 'setter excluded from its own STATE broadcast');

  // A peer joining now must receive the current state as a snapshot.
  const r3 = hub.connect('r', 'c');
  ok(Array.isArray(r3.state) && r3.state.length === 1, 'connect returns a state snapshot');
  ok(r3.state[0].key === 'tv' && r3.state[0].value.file === 'pong.nes' && r3.state[0].id === 'a',
    'snapshot carries the current value + owner');

  // Clearing removes it from future snapshots.
  hub.setState('r', 'a', { key: 'tv', value: null });
  ok(hub.connect('r', 'd').state.length === 0, 'a cleared key drops out of the snapshot');

  // Anti-spoof / membership.
  ok(hub.setState('r', 'ghost', { key: 'tv', value: 1 }).broadcast === undefined, 'setState from an unknown peer is dropped');

  // First peer in a fresh room sees no snapshot.
  ok(hub.connect('fresh', 'x').state.length === 0, 'first peer in a room gets an empty snapshot');
});

// === Hub: room state is reaped when the room empties ========================
section('Hub: room state is reaped when the room empties', () => {
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.setState('r', 'a', { key: 'tv', value: { file: 'g.nes' } });
  hub.disconnect('r', 'a'); // room now empty
  ok(hub.connect('r', 'a2').state.length === 0, 'state does not leak across an empty-room reset');
});

// === HoldState: hold keys + parseHolds filtering ===========================
section('HoldState: hold keys + parseHolds filtering', () => {
  ok(makeHoldKey('pong.nes') === 'hold:pong.nes', 'makeHoldKey namespaces the object id');
  ok(isHoldKey('hold:x') && !isHoldKey('tv') && !isHoldKey(null), 'isHoldKey matches only the hold namespace');

  const entries = [
    ['tv', { file: 'g.nes' }],                              // not a hold → ignored
    ['hold:pong.nes', { holder: 'a', hand: 'left' }],
    ['hold:snake.gb', { holder: 'me', hand: 'right' }],     // our own → ignored
    ['hold:ghost.sfc', { holder: 'gone', hand: null }],     // holder absent → ignored when filtered
    ['hold:bad.nes', null],                                 // cleared → ignored
  ];
  const all = parseHolds(entries, { selfId: 'me' });
  ok(all.length === 2, 'parseHolds keeps holds, drops tv/self/cleared');
  ok(all.some((h) => h.objId === 'pong.nes' && h.holder === 'a' && h.hand === 'left'), 'parseHolds yields objId/holder/hand');

  const present = parseHolds(entries, { selfId: 'me', presentIds: new Set(['a']) });
  ok(present.length === 1 && present[0].objId === 'pong.nes', 'parseHolds drops holders not in presentIds');
});

// === Hub: disconnect clears the leaving peer's hold:* state (not tv) ========
section("Hub: disconnect clears the leaving peer's hold:* state (not tv)", () => {
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  hub.setState('r', 'a', { key: 'tv', value: { file: 'g.nes' } });        // persistent
  hub.setState('r', 'a', { key: 'hold:pong.nes', value: { holder: 'a' } }); // owner-scoped
  hub.setState('r', 'b', { key: 'hold:snake.gb', value: { holder: 'b' } }); // b's, must survive a's leave

  const res = hub.disconnect('r', 'a');
  ok(Array.isArray(res.stateClears) && res.stateClears.length === 1, 'disconnect returns one state-clear (a\'s hold)');
  ok(res.stateClears[0].key === 'hold:pong.nes' && res.stateClears[0].value === null, 'the clear nulls a\'s held cart');

  // tv (persistent) and b's hold both survive — visible in a fresh joiner's snapshot.
  const snap = hub.connect('r', 'c').state;
  const keys = snap.map((m) => m.key).sort();
  ok(keys.length === 2 && keys[0] === 'hold:snake.gb' && keys[1] === 'tv', 'tv + b\'s hold persist; a\'s hold is gone');
});

// === NetProtocol: INPUT (game sync) builder + validation ===================
section('NetProtocol: INPUT (game sync) builder + validation', () => {
  const i = makeInput({ to: 'host', player: 2, btn: 'faceA', down: true, seq: 5 });
  ok(i.type === MSG.INPUT && i.to === 'host' && i.player === 2 && i.btn === 'faceA' && i.down === true, 'makeInput builds an input');
  ok(i.seq === 5, 'makeInput carries an optional seq');
  ok(validate(i).ok, 'INPUT validates');
  ok(validate(makeInput({ to: 'h', player: 1, btn: 'Up', down: false })).ok, 'a button-release INPUT validates');
  ok(!validate({ type: MSG.INPUT, player: 1, btn: 'Up', down: true }).ok, 'INPUT without `to` rejected');
  ok(!validate({ type: MSG.INPUT, to: 'h', btn: 'Up', down: true }).ok, 'INPUT without player rejected');
  ok(!validate({ type: MSG.INPUT, to: 'h', player: 1, btn: '', down: true }).ok, 'INPUT with empty btn rejected');
  ok(!validate({ type: MSG.INPUT, to: 'h', player: 1, btn: 'Up' }).ok, 'INPUT without down rejected');
  const back = decode(encode(makeInput({ to: 'h', player: 3, btn: 'Left', down: true })));
  ok(back && back.player === 3 && back.btn === 'Left', 'INPUT round-trips through encode/decode');
});

// === M1.1: hostInputTarget — who a peer forwards its captured input to ======
section('M1.1: hostInputTarget — who a peer forwards its captured input to', () => {
  ok(hostInputTarget({ hostId: 'h', selfId: 'c' }) === 'h', 'a client forwards to the host');
  ok(hostInputTarget({ hostId: 'h', selfId: 'h' }) === null, 'the host does NOT forward to itself');
  ok(hostInputTarget({ hostId: null, selfId: 'c' }) === null, 'no host yet → nothing to forward');
  ok(hostInputTarget({ hostId: 'h', selfId: null }) === 'h', 'forwards even before our own id is known');
  ok(hostInputTarget({ hostId: 5, selfId: 5 }) === null, 'host id compared as a string (no self-send on numeric ids)');
  ok(hostInputTarget({}) === null, 'empty args → no target');
});

// === Hub: input is a DIRECTED relay to the host, sender-id stamped ==========
// The host is the FIRST peer in (Hub elects by seniority), so 'host' connects
// first here — before RELAY-4 the order didn't matter, because `to` only had to
// be a member.
section('Hub: input is a DIRECTED relay to the host, sender-id stamped', () => {
  const hub = new Hub();
  hub.connect('r', 'host');
  hub.connect('r', 'client');
  const { direct } = hub.input('r', 'client', makeInput({ to: 'host', player: 2, btn: 'B', down: true }));
  ok(direct && direct.to === 'host', 'input is routed directly to the host peer');
  ok(direct.msg.from === 'client' && direct.msg.player === 2 && direct.msg.btn === 'B', 'input stamped with the real sender id');
  ok(hub.input('r', 'client', makeInput({ to: 'ghost', player: 1, btn: 'Up', down: true })).direct === undefined, 'input to an absent host is dropped');
  ok(hub.input('r', 'x', makeInput({ to: 'host', player: 1, btn: 'Up', down: true })).direct === undefined, 'input from an absent peer is dropped');
  // `seq` survives (makeInput sends it); a junk field does not.
  const seqd = hub.input('r', 'client', { ...makeInput({ to: 'host', player: 1, btn: 'A', down: true, seq: 7 }), junk: 'x'.repeat(4096) });
  ok(seqd.direct.msg.seq === 7, 'a real INPUT field (seq) is carried through the relay');
  ok(seqd.direct.msg.junk === undefined, 'RELAY-2: a junk field attached to an INPUT is NOT forwarded to the host');
});

// === RELAY-4: INPUT reaches the ELECTED HOST or nobody =======================
// `Hub.input`'s docstring said "directed to the host peer" from the start; the
// code checked only that `to` was A MEMBER, so any peer could drive any other
// peer's core (the desktop client applies an INPUT with no host check of its own)
// and feed it unbounded distinct `player` values to key a Map on.
section('RELAY-4: INPUT reaches the ELECTED HOST or nobody', () => {
  const hub = new Hub();
  hub.connect('r', 'host', { sid: 'host-sid' });   // first in → elected host
  hub.connect('r', 'alice');
  hub.connect('r', 'bob');
  ok(hub.hostOf('r') === 'host', 'setup: the first peer in is the elected host');

  const atHost = hub.input('r', 'alice', makeInput({ to: 'host', player: 2, btn: 'A', down: true }));
  ok(atHost.direct?.to === 'host' && !atHost.rejected, 'a client INPUT aimed at the host is relayed');

  const atPeer = hub.input('r', 'alice', makeInput({ to: 'bob', player: 1, btn: 'A', down: true }));
  ok(atPeer.direct === undefined, 'an INPUT aimed at a NON-HOST member is not relayed');
  // The reason is returned but NOT logged: unlike STATE, the room-server dispatcher
  // destructures only `{ direct }` from hub.input(). That is deliberate — INPUT is a
  // per-button-press message, so an unconditional console.log here is a log-flood
  // primitive for exactly the misbehaving client this rejection exists to stop.
  ok(atPeer.rejected === 'input-not-host', '…and says why (input-not-host), for the caller to act on');

  // The host driving another member is the same injection, so it is refused too:
  // being the host is authority over the room's core, not over a peer's tab.
  ok(hub.input('r', 'host', makeInput({ to: 'alice', player: 1, btn: 'A', down: true })).rejected === 'input-not-host',
    'even the HOST cannot aim an INPUT at another member');

  // …and during the host-reclaim window there is deliberately NO host, so INPUT
  // is dropped rather than delivered to the peer that is about to be promoted.
  // Nobody is running the core in that window — see HOST_RECLAIM_MS.
  const t0 = 1_000_000;
  hub.disconnect('r', 'host', { now: t0 });
  ok(hub.hostOf('r') === null, 'setup: the room is hostless inside the reclaim window');
  const inWindow = hub.input('r', 'alice', makeInput({ to: 'bob', player: 1, btn: 'A', down: true }));
  ok(inWindow.direct === undefined && inWindow.rejected === 'input-not-host',
    'inside the reclaim window every INPUT is dropped (no host = nothing to drive)');
  // …and the moment the window expires and a host exists again, it flows.
  hub.expireHostGrace('r', { now: t0 + HOST_RECLAIM_MS + 1 });
  const promoted = hub.hostOf('r');
  ok(promoted === 'alice', 'setup: the longest-present remaining peer is promoted');
  ok(hub.input('r', 'bob', makeInput({ to: promoted, player: 1, btn: 'A', down: true })).direct?.to === promoted,
    'once the window expires, INPUT to the newly promoted host is relayed again');
});

// === RELAY-4: validate() bounds an INPUT's player slot and button name =======
section('RELAY-4: validate() bounds an INPUT\'s player slot and button name', () => {
  const base = { type: MSG.INPUT, to: 'h', btn: 'A', down: true };
  ok(validate({ ...base, player: 1 }).ok && validate({ ...base, player: MAX_INPUT_PLAYER }).ok,
    `player 1..${MAX_INPUT_PLAYER} (every slot the app can route to) validates`);
  ok(!validate({ ...base, player: 0 }).ok, 'player 0 rejected (slots are 1-based)');
  ok(!validate({ ...base, player: -1e9 }).ok, 'a huge negative player is rejected (it used to land on player 1)');
  ok(!validate({ ...base, player: 0.5 }).ok, 'a fractional player is rejected (it used to land on player 1)');
  ok(!validate({ ...base, player: MAX_INPUT_PLAYER + 1 }).ok, 'a player past the last slot is rejected');
  ok(!validate({ ...base, player: NaN }).ok, 'NaN player still rejected');
  ok(validate({ ...base, player: 2, btn: 'x'.repeat(MAX_INPUT_BTN_LEN) }).ok, 'a btn at the length cap validates');
  ok(!validate({ ...base, player: 2, btn: 'x'.repeat(MAX_INPUT_BTN_LEN + 1) }).ok, 'an over-long btn is rejected');
  // The bounds must not be able to refuse anything a shipped client sends: every
  // RetroPad name the routing table can produce, on every port it can produce.
  for (const btn of ['A', 'B', 'X', 'Y', 'L', 'R', 'L2', 'R2', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right']) {
    for (const player of [1, 2, 3, 4]) {
      if (!validate(makeInput({ to: 'h', player, btn, down: true })).ok) ok(false, `real INPUT ${btn}/P${player} must validate`);
    }
  }
  ok(true, 'every real RetroPad button on every real port slot still validates');
});

// === NetProtocol: WIRE (transient relay) builder + validation ===============
section('NetProtocol: WIRE (transient relay) builder + validation', () => {
  const w = makeWire({ ch: 'gp', data: { cableId: 'gp-1', btns: 5 } });
  ok(w.type === MSG.WIRE && w.ch === 'gp' && w.data.btns === 5, 'makeWire builds a wire message');
  ok(validate(w).ok, 'WIRE validates');
  ok(validate(makeWire({ ch: 'drag', data: null })).ok, 'WIRE with null data validates (data key present)');
  ok(!validate({ type: MSG.WIRE, ch: '', data: {} }).ok, 'WIRE with empty ch rejected');
  ok(!validate({ type: MSG.WIRE, ch: 'gp' }).ok, 'WIRE without a data key rejected');
  const back = decode(encode(makeWire({ ch: 'drag', data: { id: 'p7', p: [1, 2, 3] } })));
  ok(back && back.ch === 'drag' && back.data.p[2] === 3, 'WIRE round-trips through encode/decode');
});

// === Hub: wire is a BROADCAST relay, sender-id stamped, NOT persisted =======
section('Hub: wire is a BROADCAST relay, sender-id stamped, NOT persisted', () => {
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  const { broadcast } = hub.wire('r', 'a', makeWire({ ch: 'gp', data: { cableId: 'gp-1', btns: 3 } }));
  ok(broadcast && broadcast.exclude === 'a', 'wire is broadcast to everyone except the sender');
  ok(broadcast.msg.id === 'a' && broadcast.msg.ch === 'gp' && broadcast.msg.data.btns === 3, 'wire stamped with the real sender id');
  ok(hub.wire('r', 'ghost', makeWire({ ch: 'gp', data: {} })).broadcast === undefined, 'wire from an unknown peer is dropped');
  // A late joiner's snapshot must NOT include any transient wire data.
  const snap = hub.connect('r', 'c').state;
  ok(snap.length === 0, 'wire is never persisted into the late-join state snapshot');
});

// === RELAY-2: per-kind body caps on the RELAYED (never-retained) messages ====
// The STATE budgets bound retained memory and say nothing at all about WIRE,
// SIGNAL or POSE, whose only bound was `ws`'s 1 MiB maxPayload — 4x the largest
// STATE VALUE the same server accepts. A 1 MiB WIRE is broadcast to every other
// peer in the room, which is the ingress half of RELAY-1's outbound blow-up.
section('RELAY-2: per-kind body caps on the RELAYED (never-retained) messages', () => {
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');

  // --- POSE: projected, so its size is the protocol's choice, not the sender's.
  const fat = hub.pose('r', 'a', { ...makePose({ head: HEAD, t: 42 }), junk: 'x'.repeat(500_000) });
  ok(fat.broadcast.msg.junk === undefined, 'a junk field attached to a POSE is NOT rebroadcast');
  ok(JSON.stringify(fat.broadcast.msg).length < 512, `a POSE body stays ~fixed-size whatever is attached (${JSON.stringify(fat.broadcast.msg).length} B)`);
  ok(fat.broadcast.msg.t === 42, '…while a real POSE field (t) still crosses');
  ok(hub.pose('r', 'a', { ...makePose({ head: HEAD }), t: 'x'.repeat(100_000) }).broadcast.msg.t === undefined,
    'a non-numeric `t` is dropped rather than relayed (it is only ever a timestamp)');

  // --- WIRE: capped, because `data` is opaque AND the message is broadcast.
  const bigWire = makeWire({ ch: 'gun', data: { pad: 'x'.repeat(HUB_LIMITS.wireBytes) } });
  ok(hub.wire('r', 'a', bigWire).broadcast === undefined, 'an over-cap WIRE is not relayed');
  ok(hub.wire('r', 'a', bigWire).rejected === 'wire-too-large', '…and says why (wire-too-large)');
  ok(hub.wire('r', 'a', makeWire({ ch: 'gun', data: { u: 0.5, v: 0.5, trigger: true, port: 1 } })).broadcast !== undefined,
    'a real gun-aim WIRE is relayed untouched');
  ok(hub.wire('r', 'a', { ...makeWire({ ch: 'gp', data: { buttons: 3 } }), junk: 'x'.repeat(4096) }).broadcast.msg.junk === undefined,
    'a junk field attached to a WIRE is NOT rebroadcast');
  // NEGATIVE CONTROL: the identical frame with the cap lifted IS relayed, so the
  // refusal above is this code and not some other check further up.
  const loose = new Hub({ limits: { wireBytes: 4 * 1024 * 1024 } });
  loose.connect('r', 'a'); loose.connect('r', 'b');
  ok(loose.wire('r', 'a', bigWire).broadcast !== undefined, 'control: with ROOM_MAX_WIRE_BYTES raised, the same frame is relayed');

  // …and the cap is nowhere near real traffic. These are the shapes the app
  // actually sends (src/main.js sendWire call sites), with the 'drag' payload
  // built from the biggest prop in a committed room descriptor.
  const props = JSON.parse(readFileSync(pathJoin(ROOT, 'public/roms/bedroom.room.json'), 'utf8')).props || [];
  const biggestProp = props.map((p) => JSON.stringify(p)).sort((x, y) => y.length - x.length)[0];
  const REAL_WIRES = [
    makeWire({ ch: 'gun', data: { cableId: 'gun-1', u: 0.5, v: 0.5, trigger: true, port: 1 } }),
    makeWire({ ch: 'mouse', data: { cableId: 'mouse-1', dx: 3, dy: -2, buttons: 1, port: 1 } }),
    makeWire({ ch: 'gp', data: { cableId: 'gp-1', buttons: 5, axes: [0, 0, 0.5, -0.5] } }),
    makeWire({ ch: 'kbd', data: { type: 'keydown', code: 'KeyZ', key: 'z', keyCode: 90, location: 0 } }),
    makeWire({ ch: 'drag', data: { id: 'prop-7', payload: JSON.parse(biggestProp) } }),
    makeWire({ ch: 'insert', data: { file: 'roms/local/some-fairly-long-game-name.sfc', core: 'snes9x', system: 'snes', title: 'Some Fairly Long Game Name (USA) (Rev 1)', consoleId: null } }),
  ];
  const worst = Math.max(...REAL_WIRES.map((w) => JSON.stringify(w).length));
  for (const w of REAL_WIRES) {
    if (hub.wire('r', 'a', w).broadcast === undefined) ok(false, `real WIRE '${w.ch}' must be relayed`);
  }
  ok(worst * 8 < HUB_LIMITS.wireBytes,
    `the largest real WIRE in the tree is ${worst} B — the cap is ${HUB_LIMITS.wireBytes} B (${Math.floor(HUB_LIMITS.wireBytes / worst)}x)`);

  // --- SIGNAL: capped, because an SDP is opaque and passed through verbatim.
  const bigSignal = makeSignal({ to: 'b', kind: 'offer', data: { sdp: 'x'.repeat(HUB_LIMITS.signalBytes) } });
  ok(hub.signal('r', 'a', bigSignal).direct === undefined, 'an over-cap SIGNAL is not relayed');
  ok(hub.signal('r', 'a', bigSignal).rejected === 'signal-too-large', '…and says why (signal-too-large)');
  // A realistic WebRTC offer — a few kB of SDP — must be nowhere near the cap: a
  // dropped offer costs a whole call, not one frame.
  const realSdp = makeSignal({ to: 'b', kind: 'offer', channel: 'video', data: { type: 'offer', sdp: 'v=0\r\n'.repeat(600), epoch: 3 } });
  ok(JSON.stringify(realSdp).length * 8 < HUB_LIMITS.signalBytes,
    `a ~${JSON.stringify(realSdp).length} B video offer is ${Math.floor(HUB_LIMITS.signalBytes / JSON.stringify(realSdp).length)}x inside the SIGNAL cap`);
  ok(hub.signal('r', 'a', realSdp).direct?.msg.channel === 'video', '…and it is relayed with its channel intact');
  ok(hub.signal('r', 'a', { ...makeSignal({ to: 'b', kind: 'ice', data: { candidate: 'x' } }), junk: 'y'.repeat(4096) }).direct.msg.junk === undefined,
    'a junk field attached to a SIGNAL is NOT forwarded');
});

// === RELAY-6: an owner-scoped STATE key may only be CLEARED by its owner =====
// Any member could send `{key:'hold:<cartId>', value:null}` and rip a cartridge
// out of another player's hand — broadcast to the room as authoritative, and
// unrecoverable from the victim's side (a client writes that key only on its own
// grab/release events, and its next write is the release).
section('RELAY-6: an owner-scoped STATE key may only be CLEARED by its owner', () => {
  const hub = new Hub();
  hub.connect('r', 'host', { sid: 'h' });
  hub.connect('r', 'alice');
  hub.connect('r', 'bob');
  const KEY = makeHoldKey('roms/zelda.nes');
  ok(isOwnerScopedKey(KEY) && isOwnerScopedKey('gamepad:gp-1'), 'hold: and gamepad: are the owner-scoped namespaces');
  ok(!isOwnerScopedKey('prop:p1') && !isOwnerScopedKey('power:console:c0') && !isOwnerScopedKey('tv'),
    'prop:/power:/tv are NOT owner-scoped — they stay collaborative / host-owned');

  hub.setState('r', 'alice', { key: KEY, value: { holder: 'alice', hand: 'right' } });
  const stolen = hub.setState('r', 'bob', { key: KEY, value: null });
  ok(stolen.broadcast === undefined && stolen.rejected === 'not-key-owner', "bob cannot clear alice's hold");
  ok(stolen.direct?.to === 'bob' && stolen.direct.msg.value?.holder === 'alice',
    '…and bob gets the authoritative value back, so his local copy re-converges');
  ok(hub.roomState.get('r').get(KEY)?.id === 'alice', "…and the key still belongs to alice");

  // The two writes that MUST keep working, because the shipped clients make them:
  // a handoff (an overwrite by a different peer — a cartridge changing hands, a
  // grab-any gamepad) and the owner's own release.
  const handoff = hub.setState('r', 'bob', { key: KEY, value: { holder: 'bob', hand: 'left' } });
  ok(handoff.broadcast?.msg.value?.holder === 'bob', 'an OVERWRITE by another peer is still allowed (cartridge handoff / grab-any pad)');
  ok(hub.setState('r', 'bob', { key: KEY, value: null }).broadcast !== undefined, 'the current owner can clear its own key');

  // The host may clear anything owner-scoped (room reset / cleaning up a ghost).
  hub.setState('r', 'alice', { key: 'gamepad:gp-1', value: { port: 0 } });
  ok(hub.setState('r', 'host', { key: 'gamepad:gp-1', value: null }).broadcast !== undefined,
    "the elected host may clear another peer's owner-scoped key");

  // A clear on a key nobody owns is not an ownership question — a client that
  // releases an object whose hold the server already auto-cleared (its previous
  // owner disconnected) must not be refused.
  ok(hub.setState('r', 'bob', { key: makeHoldKey('roms/never-held.nes'), value: null }).broadcast !== undefined,
    'clearing a key that has no current owner is allowed');

  // Collaborative namespaces are deliberately untouched by this rule.
  hub.setState('r', 'alice', { key: 'prop:p1', value: { pos: [0, 0, 0] } });
  ok(hub.setState('r', 'bob', { key: 'prop:p1', value: null }).broadcast !== undefined,
    'prop: stays fully collaborative — anyone may clear it (props are room furniture, not a grip)');

  // The disconnect auto-clear and this ACL read the SAME namespace list, which is
  // the invariant that keeps a key clearable by its owner and by the server on
  // that owner's behalf.
  hub.setState('r', 'alice', { key: KEY, value: { holder: 'alice', hand: 'right' } });
  const cleared = hub.disconnect('r', 'alice').stateClears.map((m) => m.key);
  ok(cleared.includes(KEY), 'a departed peer\'s owner-scoped keys are still auto-cleared on disconnect');
});

// === NetMgr onPeerLeave: fires when a LEAVE message is applied ================
// NetMgr itself requires THREE + a real DOM, so we exercise the underlying seam
// here: PresenceState.apply(MSG.LEAVE, …) is what NetMgr calls just before
// firing _onPeerLeave. We assert the peer is removed (the callback fires AFTER
// apply) and that MSG.LEAVE carries the right id — i.e. the id the callback
// would receive.
section('NetMgr onPeerLeave: fires when a LEAVE message is applied', () => {
  const ps = new PresenceState({ selfId: 'host' });
  ps.apply(makeJoin({ id: 'client1', nick: 'Alice' }), 0);
  ps.apply(makeJoin({ id: 'client2', nick: 'Bob' }), 0);
  ok(ps.size === 2, 'onPeerLeave setup: two peers present before LEAVE');

  // Simulate the NetMgr message path: detect LEAVE, apply, then fire callback.
  const leaveMsg = makeLeave({ id: 'client1' });
  ok(leaveMsg.type === MSG.LEAVE && leaveMsg.id === 'client1', 'LEAVE message carries the departing peer id');

  const fired = [];
  // This mirrors the NetMgr._onPeerLeave?.(leftId) pattern exactly.
  const leftId = (leaveMsg.type === MSG.LEAVE) ? leaveMsg.id : null;
  ps.apply(leaveMsg, 100);
  if (leftId != null) fired.push(leftId);

  ok(fired.length === 1 && fired[0] === 'client1', 'onPeerLeave fires with the departing peer id on MSG.LEAVE');
  ok(ps.size === 1 && !ps.get('client1'), 'presence updated before callback fires (peer is gone)');
  ok(!!ps.get('client2'), 'remaining peer unaffected');
});

// === NetMgr onPeerLeave: prune path fires callback for each stale peer =======
section('NetMgr onPeerLeave: prune path fires callback for each stale peer', () => {
  const ps = new PresenceState({ selfId: 'host', ttlMs: 1000 });
  ps.apply(makePose({ id: 'stale1', head: HEAD }), 0);
  ps.apply(makePose({ id: 'stale2', head: HEAD }), 0);
  ps.apply(makePose({ id: 'fresh',  head: HEAD }), 2000);

  const pruned = ps.prune(2500);  // stale1 + stale2 are > 1000ms old; fresh is not
  ok(pruned.length === 2, 'prune returns two stale peer ids (onPeerLeave fires for each)');
  ok(pruned.includes('stale1') && pruned.includes('stale2'), 'both stale peer ids returned by prune');
  ok(ps.size === 1 && !!ps.get('fresh'), 'fresh peer survives the prune');
});

// === NetProtocol: HOST message + hello.host (M1.4) ==========================
section('NetProtocol: HOST message + hello.host (M1.4)', () => {
  const h = makeHost({ id: 'p7' });
  ok(h.type === MSG.HOST && h.id === 'p7', 'makeHost builds a HOST message');
  ok(validate(h).ok, 'HOST validates');
  ok(!validate({ type: MSG.HOST }).ok, 'HOST without an id is rejected');
  ok(!validate({ type: MSG.HOST, id: '' }).ok, 'HOST with an empty id is rejected');
  ok(decode(encode(h)).id === 'p7', 'HOST survives encode → decode');

  ok(makeHello({ selfId: 'a', host: 'a' }).host === 'a', 'hello carries the elected host');
  ok(makeHello({ selfId: 'a' }).host === null, 'hello.host defaults to null');
  ok(validate(makeHello({ selfId: 'a', host: 'a' })).ok, 'hello with a host validates');

  // Input routing follows the ELECTED host now, not the tv-state owner.
  ok(hostInputTarget({ hostId: 'h', selfId: 'c' }) === 'h', 'a client forwards input to the elected host');
  ok(hostInputTarget({ hostId: 'h', selfId: 'h' }) === null, 'the host never forwards to itself');
  ok(hostInputTarget({ hostId: null, selfId: 'c' }) === null, 'no host yet → nothing to forward to');
});

// === NetProtocol: protocol version + compatibility rule (COR-9) =============
//
// The app and the room server ship by SEPARATE commands (`npm run deploy` vs
// `npm run deploy-room`), so a version-skewed pair is the normal state during a
// rollout. Before this, skew showed up only as silently dropped messages — the
// exact way the missing 'bye' SIGNAL kind hid for months.
section('NetProtocol: protocol version + compatibility rule (COR-9)', () => {
  ok(typeof PROTOCOL_VERSION === 'string' && /^\d+\.\d+$/.test(PROTOCOL_VERSION),
    `PROTOCOL_VERSION is a MAJOR.MINOR string ("${PROTOCOL_VERSION}")`);
  ok(PROTOCOL_CLOSE_CODE === 4010, 'the protocol close code is 4010 (4008/4009 are taken by rate/backpressure)');

  ok(parseProtocolVersion('2.7')?.major === 2 && parseProtocolVersion('2.7')?.minor === 7, 'MAJOR.MINOR parses');
  ok(parseProtocolVersion('3')?.major === 3, 'a bare MAJOR parses as MAJOR.0');
  ok(parseProtocolVersion('') === null && parseProtocolVersion('x.y') === null && parseProtocolVersion(null) === null,
    'garbage does not parse');

  // The RULE: same MAJOR = compatible, whatever the minor.
  ok(checkProtocol('1.0', '1.0').verdict === 'ok', 'an identical version is compatible');
  ok(checkProtocol('1.9999', '1.0').verdict === 'ok', 'a NEWER minor is compatible (additive changes only)');
  ok(checkProtocol('1.0', '1.4').verdict === 'ok', 'an OLDER minor is compatible too');
  ok(checkProtocol('2.0', '1.0').verdict === 'incompatible', 'a different MAJOR is incompatible');
  ok(checkProtocol('0.9', '1.0').verdict === 'incompatible', 'and so is a lower MAJOR');
  ok(checkProtocol('gibberish', '1.0').verdict === 'incompatible', 'an unparseable version is incompatible');
  // NEGATIVE CONTROL for the rule itself: the same call, same code path, with the
  // versions swapped for a matching pair — if `checkProtocol` refused everything
  // (or accepted everything) exactly one of these two lines would go red.
  ok(checkProtocol('2.3', '2.9').verdict === 'ok', 'control: the same comparison ACCEPTS when only the minor differs');

  // A client that says nothing is a pre-COR-9 build. It must be ACCEPTED: an
  // already-deployed app cannot be bricked by deploying a newer relay.
  ok(checkProtocol(null).verdict === 'legacy' && checkProtocol(undefined).verdict === 'legacy',
    'no announced version is "legacy", not "incompatible"');
  ok(checkProtocol('').verdict === 'legacy', 'an empty version string is legacy too');

  // The reason lands in a WebSocket close frame, which is capped at 123 BYTES —
  // over that, `ws` throws inside the send path. A hostile client controls `v`.
  const hostile = checkProtocol('9'.repeat(5000));
  ok(hostile?.verdict === 'incompatible', 'a 5000-char version is refused');
  // `String(… ?? '')` rather than a bare deref: Buffer.byteLength(undefined)
  // THROWS, and an assertion that aborts the file is not a negative control.
  ok(Buffer.byteLength(String(hostile?.reason ?? '')) <= 123,
    `and its close reason still fits a close frame (${Buffer.byteLength(String(hostile?.reason ?? ''))} bytes)`);
  ok(!!checkProtocol('2.0', '1.0')?.reason?.includes('2.0') && !!checkProtocol('2.0', '1.0')?.reason?.includes('1.'),
    'the reason names BOTH versions, so a journal line is actionable');

  // Which closes a client may retry.
  ok(isPermanentClose(4010), '4010 is permanent');
  ok(!isPermanentClose(1006) && !isPermanentClose(1001) && !isPermanentClose(4008) && !isPermanentClose(4009),
    'a dropped connection, a server restart, a rate kill and a backpressure evict are all retryable');
});

// === NetProtocol: both ends ANNOUNCE their version on the wire (COR-9) ======
section('NetProtocol: both ends ANNOUNCE their version on the wire (COR-9)', () => {
  const j = makeJoin({ nick: 'Kasper' });
  ok(j.v === PROTOCOL_VERSION, 'JOIN carries the client protocol version by default');
  ok(validate(j).ok && decode(encode(j))?.v === PROTOCOL_VERSION, 'the version survives validate + encode/decode');
  ok(!('v' in makeJoin({ nick: 'old', v: null })), 'v:null omits the field (used when relaying a legacy peer)');

  const h = makeHello({ selfId: 'a' });
  ok(h.v === PROTOCOL_VERSION, 'HELLO carries the SERVER protocol version (an old server is detectable client-side)');
  ok(validate(h).ok && decode(encode(h))?.v === PROTOCOL_VERSION, 'HELLO version survives the wire');

  // Optional on the wire, in BOTH directions: a pre-COR-9 peer sends none, and
  // if validate() rejected that, the compatibility handshake would itself be the
  // thing that broke compatibility.
  ok(validate({ type: MSG.JOIN, nick: 'legacy' }).ok, 'a JOIN with no version still validates');
  ok(validate({ type: MSG.HELLO, selfId: 'a', peers: [] }).ok, 'a HELLO with no version still validates');

  // The server relays the version the PEER announced, never its own.
  const hub = new Hub();
  hub.connect('vr', 'a');
  hub.connect('vr', 'b');
  const modern = hub.identify('vr', 'a', { nick: 'A', v: '1.3' });
  ok(modern?.broadcast?.msg?.v === '1.3', "a roster JOIN relays the peer's OWN announced version");
  const legacy = hub.identify('vr', 'b', { nick: 'B' });
  ok(!!legacy?.broadcast?.msg && !('v' in legacy.broadcast.msg),
    'a peer that announced nothing is relayed WITHOUT a version (not credited with the server\'s)');
  // `?.` throughout on purpose: under an inversion that stops stamping `v` this
  // must print a FAIL line, not abort the file on a TypeError and take the ~370
  // assertions below it (the whole real-client block) with it.
  ok(hub.identify('vr', 'a', { nick: 'A', v: 'z'.repeat(200) })?.broadcast?.msg?.v?.length === 16,
    'a hostile version string is capped before it is retained + rebroadcast');
  // A NUMERIC but compatible version (`v: 1`) reaches identify() now that
  // validate() lets it through, and must be recorded as the version it is —
  // `typeof v === 'string'` would drop it and relay a modern peer as legacy.
  ok(hub.identify('vr', 'b', { nick: 'B', v: 1 })?.broadcast?.msg?.v === '1',
    'a non-string but compatible version is coerced and relayed, not silently dropped');
});

// === `v` MUST NEVER MAKE A MESSAGE UNDECODABLE (COR-9 regression, 2026-08-15) =
//
// Between 2026-08-14 and 2026-08-15, validate() carried
// `if (msg.v != null && typeof msg.v !== 'string') return {ok:false,...}` on both
// JOIN and HELLO. decode() turns a failed validate() into null, and EVERY
// consumer — server/room-server.mjs's message handler, NetMgr's and DesktopNet's
// — does `if (!msg) return`. So a peer announcing `v: 2` was dropped BEFORE
// checkProtocol ran: no 4010, no close, no roster entry on the server; no selfId,
// no roster, no fatal and no reconnect on the client. That silent drop is the
// exact failure COR-9 was written to remove.
//
// The contract asserted here: the version field decides NOTHING about
// readability. decode() always yields a message; checkProtocol() always renders
// the verdict. The socket-level consequences of those verdicts are asserted
// further down (client, real NetMgr + real DesktopNet) and in
// scripts/test-room-protocol.mjs (server, real relay over a real socket).
section('`v` MUST NEVER MAKE A MESSAGE UNDECODABLE (COR-9 regression, 2026-08-15)', () => {
  // absent → legacy | '1.0' → ok | everything else present → incompatible.
  const CASES = [
    { label: 'absent',        make: (m) => m,                       want: 'legacy' },
    { label: 'null',          v: null,                              want: 'legacy' },
    { label: "'' (empty)",    v: '',                                want: 'legacy' },
    { label: "'1.0'",         v: PROTOCOL_VERSION,                  want: 'ok' },
    { label: '2 (number)',    v: 2,                                 want: 'incompatible' },
    { label: '{major:2}',     v: { major: 2 },                      want: 'incompatible' },
    { label: "'garbage'",     v: 'garbage',                         want: 'incompatible' },
  ];
  for (const c of CASES) {
    for (const [kind, base] of [['JOIN', { type: MSG.JOIN, nick: 'x', color: '#fff' }],
                                ['HELLO', { type: MSG.HELLO, selfId: 'a', peers: [] }]]) {
      const msg = c.make ? c.make({ ...base }) : { ...base, v: c.v };
      const wire = decode(encode(msg));
      // THE FIX: readable, whatever `v` was. This is the assertion that goes red
      // if the type check is reinstated in validate().
      ok(wire !== null, `a ${kind} with v=${c.label} survives encode→decode (never silently dropped)`);
      ok(validate(msg).ok, `and validate() accepts it — the version is not a readability gate (${kind}, v=${c.label})`);
      // …and the COMPATIBILITY CHECK is what classifies it, on the value that
      // actually came off the wire.
      ok(checkProtocol(wire?.v).verdict === c.want,
        `checkProtocol says "${c.want}" for ${kind} v=${c.label} (got "${checkProtocol(wire?.v).verdict}")`);
    }
  }
  // Every refusal still produces a reason a human can act on, inside the 123-byte
  // close-frame budget — including the ones that are not strings at all.
  for (const v of [2, { major: 2 }, 'garbage', [1, 0], true]) {
    const r = checkProtocol(v);
    ok(r?.verdict === 'incompatible' && (r?.reason?.length ?? 0) > 0 && Buffer.byteLength(String(r?.reason ?? '')) <= 123,
      `a v of ${JSON.stringify(v)} is refused with a close-frame-sized reason ("${r?.reason}")`);
  }
  // checkProtocol is now the ONLY gate on `v`, and on the server it runs inside
  // ws.on('message') — a throw there would take the relay down.
  // Caught rather than let fly, so removing the guard reports a FAIL line instead
  // of aborting the whole suite with an uncaught error.
  let threwOnCoerce = false;
  let coerceVerdict = null;
  try { coerceVerdict = checkProtocol({ toString() { throw new Error('boom'); } }).verdict; }
  catch { threwOnCoerce = true; }
  ok(!threwOnCoerce && coerceVerdict === 'incompatible',
    'a version whose toString throws is refused, not propagated as an exception');

  // …and the REACHABLE form of the same hazard, which is why versionText()'s
  // try/catch is a live guard and not decoration (2026-08-15). The case above is
  // synthetic — nothing on the wire can carry a custom toString. THIS one can:
  // `String()` recurses through Array.prototype.toString, so a deeply nested
  // array raises RangeError, and JSON.parse builds one from a ~40 KB frame that
  // is well under the relay's 1 MiB ROOM_MAX_PAYLOAD_BYTES. It decodes into a
  // perfectly readable JOIN and reaches checkProtocol inside the room server's
  // synchronous ws.on('message'). Delete the try/catch in versionText and the
  // three assertions below go red (they catch, so they FAIL rather than abort).
  {
    const DEEP = 20000;
    const deepWire = `{"type":"${MSG.JOIN}","nick":"deep","color":"#fff","v":${'['.repeat(DEEP)}${']'.repeat(DEEP)}}`;
    const bytes = Buffer.byteLength(deepWire);
    ok(bytes < 1024 * 1024, `the nested-array attack frame (${bytes} bytes) is UNDER the relay's 1 MiB payload cap`);
    const deepMsg = decode(deepWire);
    ok(deepMsg !== null, 'a JOIN whose v is a deeply nested array still DECODES (v is not a readability gate)');
    // Proof the hazard is real and not hypothetical: the same value, coerced
    // WITHOUT the guard, is exactly the RangeError versionText exists to swallow.
    let rawCoerce = null;
    try { String(deepMsg?.v); } catch (e) { rawCoerce = e?.constructor?.name ?? 'Error'; }
    ok(rawCoerce === 'RangeError', `an unguarded String() on it throws RangeError (got ${rawCoerce ?? 'no throw'})`);

    let deepThrew = null; let deepVerdict = null; let deepReason = '';
    try { const r = checkProtocol(deepMsg?.v); deepVerdict = r?.verdict; deepReason = r?.reason; }
    catch (e) { deepThrew = e?.constructor?.name ?? 'Error'; }
    ok(deepThrew === null, `checkProtocol SURVIVES a deeply nested array v (threw ${deepThrew ?? 'nothing'})`);
    ok(deepVerdict === 'incompatible', 'and refuses it rather than accepting an unreadable version');
    ok(Buffer.byteLength(String(deepReason ?? '')) <= 123, 'with a reason that still fits a close frame');

    let judgeThrew = null; let judged = null;
    try { judged = judgeServerVersion(deepMsg?.v); } catch (e) { judgeThrew = e?.constructor?.name ?? 'Error'; }
    ok(judgeThrew === null, `judgeServerVersion survives it too (threw ${judgeThrew ?? 'nothing'})`);
    ok(judged?.action === 'refuse' && judged?.code === PROTOCOL_CLOSE_CODE,
      'and the CLIENT half turns it into a 4010 refusal, not an exception in the message handler');
  }

  // judgeServerVersion is the ONE mapping from a verdict to what a client does
  // about it (ARC-2 — NetMgr and DesktopNet each used to write their own). The
  // end-to-end proof that both classes go through it is the COR-9 client block
  // below; this pins the mapping itself.
  ok(judgeServerVersion(PROTOCOL_VERSION).action === 'accept', 'judgeServerVersion: a matching version → accept');
  ok(judgeServerVersion(null).action === 'accept-legacy', 'judgeServerVersion: no version → accept-legacy (a pre-COR-9 relay is not refused)');
  ok(judgeServerVersion('9.0').action === 'refuse' && judgeServerVersion('9.0').code === PROTOCOL_CLOSE_CODE,
    'judgeServerVersion: an incompatible MAJOR → refuse, with the 4010 close code');
  ok(judgeServerVersion(2).action === 'refuse', 'judgeServerVersion: a NUMERIC junk version → refuse (not accepted, not dropped)');
  ok(judgeServerVersion(2).serverVersion === '2',
    'judgeServerVersion: and records it as readable text for the log, not as a raw value');
  ok(judgeServerVersion(null).serverVersion === null, 'judgeServerVersion: "announced nothing" is recorded as unknown');
  ok(judgeServerVersion('z'.repeat(200))?.serverVersion?.length === 16,
    'judgeServerVersion: a hostile version is capped before it is retained');
});

// === Client reconnect gate: 4010 is permanent, everything else is retried ===
//
// Driven through BOTH REAL client classes over a fake socket — no ports, no
// browser — because the claim under test is about the shipped classes' close
// handlers, not about a re-implementation of them living in this file:
//
//   • [[src/net/NetMgr.js]]        — the VR client that actually ships to headsets
//   • [[src/desktop/DesktopNet.js]] — the flat-screen client
//
// BOTH, not one (2026-08-15). They own two hand-duplicated copies of the
// connection lifecycle (CODEX ARC-2), and until this suite ran the identical
// assertions against each, NetMgr's entire COR-9 change could have been deleted
// wholesale with every suite still green — the negative controls were all driven
// through DesktopNet. NetMgr imports three and constructs AvatarMgr/VoiceMgr/
// VideoMgr, but none of that touches the DOM until a capture/mic starts, so a
// stub scene is enough to reach its real connect()/message/close handlers.
section('Client reconnect gate: 4010 is permanent, everything else is retried', () => {
  // The relay's "try again later" close. Spelled out rather than imported:
  // NetProtocol owns the codes that are part of the CONTRACT, and 1013 is
  // deliberately not one of them — it must never join PERMANENT_CLOSE_CODES,
  // because the whole point of it is that the client comes back. Both client
  // classes spell it the same way, for the same reason.
  const TRY_AGAIN = 1013;
  // Minimal WebSocket stand-in: both classes look `WebSocket` up on globalThis at
  // connect() time, so this substitution exercises their real code path.
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; this._l = new Map();
      FakeWS.last = this;
      // `made` counts CONSTRUCTIONS, so "did the client re-open a socket?" is
      // measured directly rather than inferred from a timer handle.
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
  const prevWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  // The fatal path console.error()s on purpose (it is how a user finds out); keep
  // it out of this suite's output but assert it happened.
  const errs = [];
  const realErr = console.error;
  const realWarn = console.warn;
  const realLog = console.log;
  // ok()'s own FAIL lines go to console.error, so they MUST still get through —
  // a capture that swallowed them would turn every failure in this block into a
  // silent pass, which is precisely the false-green shape this suite guards.
  console.error = (...a) => {
    const s = a.join(' ');
    if (s.includes('FAIL')) realErr(...a); else errs.push(s);
  };
  console.warn = () => {};
  console.log = () => {};

  // A scene stub for NetMgr: only the members its constructor/close path read.
  // AvatarMgr/VoiceMgr/VideoMgr are constructed FOR REAL against it — faking them
  // instead would hollow out the very path this block exists to reach.
  const stubScene = { addObject() {}, removeObject() {}, playerRig: null, renderer: null, camera: null, controllers: [] };
  // `build(opts)` forwards extra constructor options (used by case 3c to pass a
  // real `onFatal` callback), so both classes are driven through the SAME
  // construction path whether or not the app supplies one.
  const CLIENTS = [
    ['NetMgr', (opts = {}) => new NetMgr({ scene: stubScene, room: 'r', serverUrl: 'ws://x/ws/', sessionId: 'sid-test', ...opts }).connect()],
    ['DesktopNet', (opts = {}) => new DesktopNet({ room: 'r', serverUrl: 'ws://x/ws/', sessionId: 'sid-test', ...opts }).connect()],
  ];

  try {
    for (const [name, build] of CLIENTS) {
      // 1. The client announces its version in the JOIN it sends on open.
      const a = build();
      FakeWS.last.accept();
      // decode() rather than a bare JSON.parse: if an inversion stops the client
      // sending anything, this must FAIL, not abort on a SyntaxError.
      ok(decode(FakeWS.last.sent[0] ?? '')?.v === PROTOCOL_VERSION, `${name}: announces its protocol version on JOIN`);
      a.disconnect();

      // 2. CONTROL — an ordinary drop (1006) on the identical path DOES reconnect.
      //    Without this pair, "4010 does not reconnect" could equally mean "nothing
      //    ever reconnects", which is the vacuous-green failure this repo has a
      //    documented history of.
      const b = build();
      const bws = FakeWS.last;
      bws.accept();
      bws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      bws.drop(1006);
      ok(b._reconnectTimer !== null && b._reconnectTries === 1,
        `${name} control: a 1006 (Wi-Fi blip / server restart) schedules a reconnect`);
      ok(b._fatal === null, `${name} control: and is not treated as fatal`);
      b.disconnect();

      // 2b. A FIRST-CONNECT failure is retried too, and it says WHY (2026-08-18).
      //     The gate used to be `if (wasConnected || this._reconnectTries)`, and
      //     on a fresh client's first connect BOTH are falsy — so a socket that
      //     never opened scheduled nothing, and (only 4010 producing status text)
      //     said nothing either. That went from theoretical to live the moment
      //     the relay grew per-address admission caps: those refused the UPGRADE
      //     with 503/429, which in the browser is precisely a close with no open
      //     before it. A user behind a busy NAT got "Offline" for the rest of the
      //     page's life with nothing retrying behind it — the COR-9 dead end,
      //     reached from the other side. Both ends of it are closed now: the
      //     relay soft-refuses instead (1013 after an open, see
      //     server/room-server.mjs refuseSoftly) AND this gate is gone.
      //     Driven exactly as a browser drives it: construct, never accept, drop.
      const retries = [];
      const n = build({ onRetry: (r) => retries.push(r) });
      const nws = FakeWS.last;
      ok(n._connected === false && n._reconnectTries === 0,
        `${name} (2b precondition): the socket never opened — the exact state the old gate refused to retry from`);
      nws.drop(1013, 'too many connections from this address (16/16)');
      ok(n._reconnectTimer !== null && n._reconnectTries === 1,
        `${name}: a close BEFORE the first open still schedules a reconnect`);
      ok(n._fatal === null, `${name}: and a transient refusal is not latched as fatal`);
      ok(retries.length === 1 && retries[0]?.code === 1013,
        `${name}: onRetry fires with the close code the relay sent (got ${JSON.stringify(retries[0] ?? null)})`);
      ok(!!retries[0]?.reason?.includes('too many connections'),
        `${name}: and with the relay's own reason — the UI can say WHY instead of only "Offline"`);
      ok(retries[0]?.attempt === 1 && retries[0]?.delayMs > 0,
        `${name}: and with which attempt this is and how long until it happens`);
      ok(n.debugApi().lastClose?.()?.code === 1013,
        `${name}: the same reaches debugApi().lastClose, which is how a headless probe reads it`);
      n.disconnect();

      // CONTROL for 2b: OUR OWN disconnect() before an open must stay silent.
      // Without this pair, "retry every close" could equally mean "the user
      // pressing Leave now reconnects forever", which is a worse bug than the
      // one 2b fixes.
      const q = build({ onRetry: (r) => retries.push(r) });
      q.disconnect();
      ok(retries.length === 1 && q._reconnectTimer === null,
        `${name} control: a deliberate disconnect() before the open schedules nothing (still ${retries.length} onRetry call)`);

      // 2c. The backoff resets on a SESSION, not on an 'open' (2026-08-18).
      //     `_reconnectTries = 0` lived in the socket's 'open' handler, which was
      //     right while the only way to get an 'open' was to be admitted — and
      //     wrong from the moment the relay started refusing capacity SOFTLY, i.e.
      //     by accepting the upgrade and closing it with 1013 so a deployed client
      //     retries at all. A refusal now MAKES 'open' fire, so resetting there
      //     reset the backoff on every refusal: 500 ms, open, refused, 500 ms,
      //     for the life of the page. Two of those behind one NAT drained that
      //     address's entire upgrade budget and locked out the household,
      //     already-connected headsets included. Move the reset one message later
      //     — to the HELLO, which is the first proof a SESSION exists — and the
      //     chain advances the way it was always meant to.
      const t = build();
      const tws = FakeWS.last;
      tws.accept();
      tws.drop(TRY_AGAIN, 'room "r" full (16/16)');
      ok(t._reconnectTries === 1, `${name}: a soft refusal advances the backoff to attempt 1`);
      // The retry's socket opens — and is refused again before any HELLO. This is
      // the exact state the old reset fired in.
      tws.accept();
      ok(t._reconnectTries === 1,
        `${name}: an 'open' with no HELLO behind it does NOT reset the backoff — 'open' means the handshake completed, not that we have a session`);
      // …and a real session does reset it, or a headset that reconnects after an
      // hour of good play would start its next blip deep in the backoff chain.
      tws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      ok(t._reconnectTries === 0 && t.lastClose === null,
        `${name}: a HELLO does reset it, and clears the transient "why are we offline" with it`);
      t.disconnect();

      // 2d. A soft refusal gets its OWN, slower backoff table.
      //     1013 is "we are busy", not "the network broke", and retrying it on the
      //     500 ms table is what turns one refused client into a 2 Hz knock on a
      //     relay that just said it was full.
      const fast = build();
      FakeWS.last.drop(1006);
      const slow = build();
      FakeWS.last.drop(TRY_AGAIN, 'server at capacity (256/256 sockets)');
      ok(fast.lastClose.delayMs === 500,
        `${name}: an ordinary drop still retries fast (${fast.lastClose.delayMs}ms) — a Wi-Fi blip must not cost the user 5 s`);
      ok(slow.lastClose.delayMs >= 5000 && slow.lastClose.delayMs >= fast.lastClose.delayMs * 10,
        `${name}: a 1013 waits at least 10x longer (${slow.lastClose.delayMs}ms vs ${fast.lastClose.delayMs}ms) — ~12 upgrades a minute instead of 120`);
      fast.disconnect();

      // 2e. …and it STAYS on the slow table until a session exists. The relay's
      //     second-tier refusal (an address over its soft-refusal budget) kills
      //     the upgrade outright, which reaches a browser as a bare 1006 —
      //     indistinguishable from a Wi-Fi blip. Without the sticky flag a client
      //     that had just been told 1013 would drop straight back to 500 ms and
      //     hammer the exact relay that asked it not to.
      clearTimeout(slow._reconnectTimer); slow._reconnectTimer = null;
      slow._scheduleReconnect({ code: 1006, reason: '' });
      ok(slow.lastClose.delayMs >= 10000,
        `${name}: the 1006 that a killed upgrade produces stays on the slow table after a 1013 (${slow.lastClose.delayMs}ms)`);
      // A session clears it, so a genuine blip AFTER we got in is fast again.
      const sws = FakeWS.last;
      clearTimeout(slow._reconnectTimer); slow._reconnectTimer = null;
      sws.accept();
      sws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      sws.drop(1006);
      ok(slow.lastClose.delayMs === 500,
        `${name}: and once a session has existed, an ordinary drop is fast again (${slow.lastClose.delayMs}ms)`);
      slow.disconnect();

      // 3. THE FIX — the same handler, same instance shape, close code 4010.
      const c = build();
      const cws = FakeWS.last;
      cws.accept();
      cws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      errs.length = 0;
      cws.drop(PROTOCOL_CLOSE_CODE, 'protocol 9.0 incompatible (this end speaks 1.x)');
      ok(c._reconnectTimer === null && c._reconnectTries === 0, `${name}: a 4010 does NOT schedule a reconnect`);
      ok(c._fatal && c._fatal.code === 4010, `${name}: the refusal is recorded as fatal`);
      ok(!!c._fatal?.reason?.includes('9.0'), `${name}: and the server's reason is kept, not discarded`);
      ok(errs.some((e) => e.includes('4010') && e.includes('9.0')), `${name}: the reason is surfaced to the console`);
      // _noteFatal also sets `_closing`, so every later path sees the same
      // "this session is finished" state a deliberate disconnect() produces.
      // FALSIFIABLE ON ITS OWN: delete `this._closing = true;` from _noteFatal
      // and this line goes red — once per class. (Until 2026-08-15 the comment
      // here claimed the opposite, that removing the assignment turned nothing
      // red; one mutation disproves that, so the claim is gone.) The reconnect
      // gate does NOT depend on it — case 3b isolates `_fatal` on its own.
      ok(c._closing === true, `${name}: a permanent refusal also marks the session closed`);
      // Even calling the reconnect scheduler directly (the pre-fix close handler's
      // very next line) must not re-open the socket. NOTE this is the COMPOSITE
      // state after a real refusal: _noteFatal sets BOTH `_fatal` and `_closing`,
      // so this line alone does not isolate the `_fatal` guard — case 3b below
      // does that, and it is the one that fails if the guard is removed.
      c._scheduleReconnect();
      ok(c._reconnectTimer === null, `${name}: _scheduleReconnect refuses to re-open after a permanent refusal`);
      c.disconnect();

      // 3c. THE `onFatal` CONSTRUCTOR OPTION (2026-08-15). Until now nothing
      //     passed it and nothing asserted it, so the whole invocation block in
      //     _noteFatal could be deleted from BOTH classes with the suite still
      //     green — a console.error is not a UI. It is the app's only hook for
      //     telling the user "this build cannot talk to the relay" instead of
      //     leaving them in a room that never fills. Delete the
      //     `if (this._onFatal) { … }` block and the four lines below go red.
      const fatals = [];
      const k = build({ onFatal: (f) => fatals.push(f) });
      const kws = FakeWS.last;
      kws.accept();
      kws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      kws.drop(PROTOCOL_CLOSE_CODE, 'protocol 9.0 incompatible (this end speaks 1.x)');
      ok(fatals.length === 1, `${name}: onFatal fires exactly once on a permanent refusal (got ${fatals.length})`);
      ok(fatals[0]?.code === PROTOCOL_CLOSE_CODE, `${name}: onFatal is handed the close code`);
      ok(!!fatals[0]?.reason?.includes('9.0'), `${name}: onFatal is handed the server's own reason`);
      // Idempotent: _noteFatal returns early once `_fatal` is set, so a later
      // path noting the same refusal must not re-fire the callback into the UI.
      k._noteFatal({ code: PROTOCOL_CLOSE_CODE, reason: 'again' });
      ok(fatals.length === 1, `${name}: and NOT again when a later path notes the same fatal`);
      k.disconnect();

      // CONTROL for 3c: the identical callback on the identical path with a
      // RETRYABLE close is never invoked — so the four lines above measure "the
      // permanent refusal reached the app", not "the callback fires on any close".
      const kk = build({ onFatal: (f) => fatals.push(f) });
      const kkws = FakeWS.last;
      kkws.accept();
      kkws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      kkws.drop(1006);
      ok(fatals.length === 1, `${name} control: a 1006 does NOT invoke onFatal (still ${fatals.length} call)`);
      kk.disconnect();

      // …and an app callback that throws must not take the fatal path with it:
      // the refusal still has to be recorded, or the client would keep retrying.
      const m = build({ onFatal: () => { throw new Error('ui blew up'); } });
      const mws = FakeWS.last;
      mws.accept();
      mws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      let noteThrew = null;
      try { mws.drop(PROTOCOL_CLOSE_CODE, 'protocol 9.0 incompatible (this end speaks 1.x)'); }
      catch (e) { noteThrew = e?.constructor?.name ?? 'Error'; }
      ok(noteThrew === null, `${name}: a throwing onFatal is contained (threw ${noteThrew ?? 'nothing'})`);
      ok(m._fatal?.code === PROTOCOL_CLOSE_CODE && m._reconnectTimer === null,
        `${name}: and the refusal is still recorded + still not retried`);
      m.disconnect();

      // 3b. THE `_fatal` GUARD IN _scheduleReconnect, ISOLATED (2026-08-15).
      //     The verifier showed case 3 above still passed with the guard deleted,
      //     because _noteFatal also sets `_closing` and the two mask each other.
      //     Here `_fatal` is set with `_closing` left FALSE — the state the guard's
      //     own comment claims to cover ("even if some future caller reaches it
      //     another way") — so ONLY the `_fatal` term of
      //     `if (this._closing || this._fatal || this._reconnectTimer) return;`
      //     can prevent a reconnect. Delete that term and this goes red.
      const g = build();
      const gws = FakeWS.last;
      gws.accept();
      gws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      g._fatal = { code: PROTOCOL_CLOSE_CODE, reason: 'set directly, _closing left false' };
      ok(g._closing === false, `${name}: (guard isolation precondition) _closing is false`);
      // Take over the backoff timer so "did it RE-OPEN?" is measured rather than
      // inferred: _scheduleReconnect only ARMS a setTimeout, so counting sockets
      // right after the call would pass even with the guard gone. Running the
      // armed callback is what actually calls connect().
      const realSetTimeout = globalThis.setTimeout;
      const armed = [];
      let timerAfterFatal, triesAfterFatal, openedWhileFatal, openedAfterClear;
      try {
        globalThis.setTimeout = (fn) => { armed.push(fn); return { fakeTimer: true }; };
        const before = FakeWS.made;
        g._scheduleReconnect();
        timerAfterFatal = g._reconnectTimer;
        triesAfterFatal = g._reconnectTries;
        for (const fn of armed.splice(0)) fn();
        openedWhileFatal = FakeWS.made - before;
        // CONTROL for 3b: the identical call on the identical instance with
        // `_fatal` cleared DOES re-open — so the lines above measure the guard,
        // not a client that had simply stopped reconnecting for some other reason.
        const mid = FakeWS.made;
        g._fatal = null;
        g._scheduleReconnect();
        for (const fn of armed.splice(0)) fn();
        openedAfterClear = FakeWS.made - mid;
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      ok(timerAfterFatal === null, `${name}: _scheduleReconnect is blocked by _fatal ALONE (no _closing)`);
      ok(triesAfterFatal === 0, `${name}: and does not even count an attempt`);
      ok(openedWhileFatal === 0, `${name}: and no new socket is opened even after the backoff fires`);
      ok(openedAfterClear === 1, `${name} control: with _fatal cleared the SAME call re-opens the socket`);
      g.disconnect();

      // 4. An OLD SERVER talking to a NEW client: the server cannot judge our JOIN
      //    (it has never heard of `v`), so the client judges its HELLO.
      const d = build();
      const dws = FakeWS.last;
      dws.accept();
      errs.length = 0;
      dws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me', v: '9.0' }));
      ok(d._fatal && d._fatal.code === 4010, `${name}: an incompatible SERVER version in HELLO is fatal client-side`);
      ok(d.selfId === null, `${name}: and its roster is NOT adopted (an incompatible HELLO is not trusted)`);
      ok(dws.readyState === 3, `${name}: the client closes the socket itself`);
      ok(d._reconnectTimer === null, `${name}: and does not reconnect into the same refusal`);
      d.disconnect();

      // 4b. THE SILENT-DROP REGRESSION (2026-08-15). A HELLO whose `v` is not a
      //     string used to fail validate(), so decode() returned null and the
      //     client's `if (!msg) return` swallowed it: no selfId, no roster, no
      //     fatal, no reconnect — a permanently dead client with nothing in the
      //     log. Each of these must now be LOUD instead.
      for (const badV of [2, { major: 2 }, 'garbage']) {
        const h = build();
        const hws = FakeWS.last;
        hws.accept();
        errs.length = 0;
        hws.deliver({ type: MSG.HELLO, selfId: 'me', room: 'r', peers: [], host: 'me', v: badV });
        ok(h._fatal && h._fatal.code === PROTOCOL_CLOSE_CODE,
          `${name}: a HELLO with v=${JSON.stringify(badV)} is FATAL, not silently dropped`);
        ok(hws.readyState === 3, `${name}: and the socket is closed for v=${JSON.stringify(badV)}`);
        ok(h.selfId === null, `${name}: and the roster of an unreadable-version HELLO is not adopted`);
        ok(errs.some((e) => e.includes('4010')), `${name}: and the user gets told (v=${JSON.stringify(badV)})`);
        h.disconnect();
      }

      // 5. CONTROL — a pre-COR-9 server (no `v` at all) is ACCEPTED, so deploying
      //    the app before the relay cannot brick multiplayer.
      const e = build();
      const ews = FakeWS.last;
      ews.accept();
      ews.deliver({ type: MSG.HELLO, selfId: 'me', room: 'r', peers: [], host: 'me' });
      ok(e._fatal === null, `${name} control: a server that announces no version is accepted (legacy)`);
      ok(e.selfId === 'me', `${name} control: and its roster IS adopted`);
      ok(e.serverVersion === null, `${name}: the missing server version is recorded as unknown`);
      e.disconnect();

      // 6. CONTROL — a compatible server version is accepted and recorded.
      const f = build();
      const fws = FakeWS.last;
      fws.accept();
      fws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      ok(f._fatal === null && f.serverVersion === PROTOCOL_VERSION, `${name} control: a matching server version connects normally`);
      f.disconnect();

      // 7. THE COR-9 DEBUG SURFACE (window.__net / window.__desktop). The three
      //    fields below were added by this change with nothing reading them, so
      //    all six (three per class) could be deleted with the suite still green.
      //    They are kept rather than deleted because debugApi() IS the contract a
      //    headless probe reads the client through — `fatal()` in particular is
      //    how a probe distinguishes "refused permanently, stop waiting" from
      //    "still connecting" — and the tests above reach `_fatal`/`serverVersion`
      //    as PRIVATE fields, which proves nothing about the public surface.
      //    Optional-call syntax (`?.()`) on purpose: a deleted field must FAIL
      //    here, not abort the file with a TypeError.
      const p = build();
      const pws = FakeWS.last;
      pws.accept();
      const dbg = p.debugApi();
      ok(dbg.protocolVersion?.() === PROTOCOL_VERSION, `${name}: debugApi reports the version WE speak`);
      ok(dbg.serverProtocol?.() === null, `${name}: debugApi reports the server version as unknown before HELLO`);
      ok(dbg.fatal?.() === null, `${name}: debugApi reports no fatal on a healthy socket`);
      pws.deliver(makeHello({ selfId: 'me', room: 'r', peers: [], host: 'me' }));
      ok(p.debugApi().serverProtocol?.() === PROTOCOL_VERSION, `${name}: and the announced server version once HELLO lands`);
      errs.length = 0;
      pws.drop(PROTOCOL_CLOSE_CODE, 'protocol 9.0 incompatible (this end speaks 1.x)');
      const shot = p.debugApi().fatal?.();
      ok(shot?.code === PROTOCOL_CLOSE_CODE && !!shot?.reason?.includes('9.0'),
        `${name}: and the permanent refusal, so a probe stops waiting for a reconnect that never comes`);
      ok(shot !== p._fatal, `${name}: debugApi hands out a COPY of the fatal (a probe cannot corrupt client state)`);
      p.disconnect();
    }
  } finally {
    console.error = realErr;
    console.warn = realWarn;
    console.log = realLog;
    if (prevWS === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = prevWS;
  }
});

// === Reconnect rule, with the permanence check DISABLED (negative control) ===
//
// The pair above proves the shipped class consults `isPermanentClose`. This
// proves the RULE is what stops the loop: the identical backoff loop, driven
// twice over the identical close sequence, differing only in whether the check
// is the shipped one or the pre-fix "retry everything" (`() => false`).
section('Reconnect rule, with the permanence check DISABLED (negative control)', () => {
  const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];
  // A faithful reduction of NetMgr/DesktopNet's chain: each close either ends the
  // session or schedules attempt N, which produces the same close again.
  const runLoop = (code, permanent, cap = 5) => {
    let tries = 0;
    for (let i = 0; i < cap; i++) {
      if (permanent(code)) break;
      tries++;
      void RETRY_DELAYS[Math.min(tries, RETRY_DELAYS.length - 1)];
    }
    return tries;
  };
  ok(runLoop(4010, isPermanentClose) === 0, 'with the shipped rule, a 4010 is retried zero times');
  ok(runLoop(4010, () => false) === 5,
    'NEGATIVE CONTROL: with the rule disabled the same loop retries the same 4010 forever (5/5 attempts)');
  ok(runLoop(1006, isPermanentClose) === 5, 'and the shipped rule still retries a 1006 (it is not "never reconnect")');
});

// === buildIceServers: STUN default + optional TURN relay (M0 hardening) =====
section('buildIceServers: STUN default + optional TURN relay (M0 hardening)', () => {
  const stunOnly = buildIceServers();
  ok(stunOnly.length === 1 && stunOnly[0].urls.startsWith('stun:'), 'default is STUN-only (one server)');
  ok(buildIceServers({}).length === 1, 'empty args → STUN-only too');

  const withTurn = buildIceServers({ turn: 'turn:relay.example:3478', turnUsername: 'u', turnCredential: 'p' });
  ok(withTurn.length === 2, 'a TURN url appends a second server (keeps STUN)');
  ok(withTurn[1].urls === 'turn:relay.example:3478' && withTurn[1].username === 'u' && withTurn[1].credential === 'p', 'TURN entry carries url + credentials');
  ok(withTurn[0].urls.startsWith('stun:'), 'STUN stays first (preferred when it works)');

  const noCreds = buildIceServers({ turn: 'turn:relay.example:3478' });
  ok(!('username' in noCreds[1]) && !('credential' in noCreds[1]), 'credential fields omitted when not supplied');
  ok(buildIceServers({ turn: 'turn:relay.example:3478', turnCredential: 0 })[1].credential === '0', 'falsy-but-present credential is coerced to a string, not dropped');
  ok(buildIceServers({ stun: null, turn: 'turn:relay.example:3478' }).length === 1, 'stun:null drops the STUN entry, leaving TURN only');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
