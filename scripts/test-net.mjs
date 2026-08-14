// Unit tests for the M0 presence layer — pure protocol + peer registry
// ([[src/net/NetProtocol.js]], [[src/net/PresenceState.js]]). No THREE / no
// socket, so this runs in `npm test`.

import {
  MSG, POSE_LEN, SIGNAL_KINDS, isValidPart, roundPart, makePose, makeJoin, makeHello,
  makeLeave, makeSignal, makeState, makeInput, makeWire, makeHost, hostInputTarget, validate, encode, decode,
  buildIceServers,
} from '../src/net/NetProtocol.js';
import { PresenceState } from '../src/net/PresenceState.js';
import { RoomObjects } from '../src/net/RoomObjects.js';
import { makeHoldKey, isHoldKey, parseHolds } from '../src/net/HoldState.js';
import { Hub, HOST_RECLAIM_MS, isHostOwnedKey } from '../server/Hub.js';
import { FALLBACK_HOST_KEY, claimWins, normaliseClaim, resolveFallbackHost } from '../src/net/HostElection.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };

const HEAD = [1, 1.6, -2, 0, 0, 0, 1];
const HAND = [0.2, 1.2, -1.5, 0, 0, 0, 1];

// === NetProtocol: pose parts ===============================================
{
  ok(isValidPart(null), 'null is a valid (untracked) part');
  ok(isValidPart(HEAD), 'a 7-tuple is a valid part');
  ok(!isValidPart([1, 2, 3]), 'a short tuple is invalid');
  ok(!isValidPart([0, 0, 0, 0, 0, 0, NaN]), 'NaN in a part is invalid');
  ok(!isValidPart('nope'), 'a string is not a part');
  ok(POSE_LEN === 7, 'pose length is 7');
}

// === NetProtocol: rounding keeps packets small =============================
{
  const r = roundPart([1.23456, 0, 0, 0, 0, 0, 1], 3);
  ok(r[0] === 1.235, 'roundPart rounds to 3 decimals');
  ok(roundPart(null) === null, 'roundPart passes null through');
  const p = makePose({ head: [1.111111, 2.222222, 3.333333, 0, 0, 0, 1], decimals: 2 });
  ok(p.head[0] === 1.11 && p.head[1] === 2.22, 'makePose rounds at the requested precision');
  ok(p.left === null && p.right === null, 'makePose defaults untracked hands to null');
  ok(p.type === MSG.POSE, 'makePose stamps the POSE type');
}

// === NetProtocol: builders + validation ====================================
{
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
}

// === NetProtocol: encode/decode round-trip + bad input =====================
{
  const msg = makePose({ head: HEAD, left: HAND, id: 'x', t: 123 });
  const back = decode(encode(msg));
  ok(back && back.id === 'x' && back.head[0] === HEAD[0], 'encode→decode round-trips a POSE');
  ok(decode('{not json') === null, 'decode returns null on bad JSON');
  ok(decode(encode({ type: 'bogus' })) === null, 'decode returns null on invalid shape');
}

// === PresenceState: join / leave / self-exclusion ==========================
{
  const ps = new PresenceState({ selfId: 'me' });
  ps.apply(makeJoin({ id: 'me', nick: 'Me' }), 0);  // self must be ignored
  ok(ps.size === 0, 'a JOIN for self is ignored');

  ps.apply(makeJoin({ id: 'a', nick: 'Alice', color: '#0f0' }), 0);
  ps.apply(makeJoin({ id: 'b', nick: 'Bob' }), 0);
  ok(ps.size === 2, 'two remote peers tracked');
  ok(ps.get('a').nick === 'Alice' && ps.get('a').color === '#0f0', 'peer nick/color recorded');

  ps.apply(makeLeave({ id: 'a' }), 0);
  ok(ps.size === 1 && !ps.get('a'), 'LEAVE removes the peer');
}

// === PresenceState: HELLO seeds the roster and self id =====================
{
  const ps = new PresenceState();
  ps.apply(makeHello({ selfId: 'me', peers: [{ id: 'a', nick: 'A' }, { id: 'me', nick: 'self?' }] }), 0);
  ok(ps.selfId === 'me', 'HELLO sets selfId');
  ok(ps.size === 1 && !!ps.get('a'), 'HELLO seeds peers but excludes self');
}

// === PresenceState: pose updates ===========================================
{
  const ps = new PresenceState({ selfId: 'me' });
  ps.apply(makePose({ id: 'a', head: HEAD, left: HAND }), 100);
  const a = ps.get('a');
  ok(!!a, 'POSE from an unknown peer auto-creates it');
  ok(a.pose.head[1] === HEAD[1] && a.pose.left[0] === HAND[0], 'pose head+left stored');
  ok(a.pose.right === null, 'untracked right hand stays null');
  ok(a.lastSeen === 100, 'lastSeen stamped from nowMs');

  ps.apply(makePose({ id: 'me', head: HEAD }), 200); // our own pose echoed back
  ok(ps.size === 1, 'a POSE for self is ignored (we never render our own avatar)');
}

// === PresenceState: prune stale peers ======================================
{
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
}

// === Hub (server relay logic): connect / hello roster ======================
{
  const hub = new Hub();
  const r1 = hub.connect('room1', 'p1');
  ok(r1.hello.type === MSG.HELLO && r1.hello.selfId === 'p1', 'connect returns HELLO with selfId');
  ok(r1.hello.peers.length === 0, 'first peer sees an empty roster');

  const r2 = hub.connect('room1', 'p2');
  ok(r2.hello.peers.length === 1 && r2.hello.peers[0].id === 'p1', 'second peer sees the first in its roster');
  ok(hub.size('room1') === 2, 'room has two peers');
}

// === Hub: M1.4 host election — first in hosts, seniority migration ==========
//
// The old rule ("whoever last wrote the shared `tv` state is the host") is gone:
// it flipped the role on every cartridge insert and could elect a peer that does
// not even have the ROM. The server now elects the LONGEST-PRESENT peer and
// re-elects only when that peer disconnects.
{
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
}

// === Hub: M1.4 DEFERRED host migration + reclaim across the host's own reload =
//
// The app reloads the page for a cross-core cartridge swap, so the host vanishes
// for a couple of seconds on an ordinary game switch. Promoting a stand-in
// immediately (what this used to do) meant that stand-in got the role, BOOTED the
// room's cartridge into its own core, and was demoted ~150ms later when the real
// host came back — leaving every client running its own extra core. So the room now
// stays deliberately HOSTLESS for HOST_RECLAIM_MS and only migrates if the host
// really is gone.
{
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
}

// === Hub: M1.4 host-OWNED shared keys are server-enforced ===================
//
// `tv` / `room` / `shelf:*` describe the room the HOST owns. A client-side check is
// worthless on its own: an older deployed build still writes `tv` on every local
// boot, and the host's own convergence path would then boot whatever that client
// wrote — i.e. any peer could hijack what the room plays.
{
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
}

// === HostElection: the client-side fallback for a pre-M1.4 room server =======
//
// Shipping a client whose boot gate needs a host, against a relay that never names
// one, would mean nobody may ever host — no game at all for anyone. The peers then
// elect among themselves over the persisted STATE channel, reproducing the server's
// seniority rule: the EARLIEST claim by a still-present peer wins.
{
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
}

// === Hub: identify broadcasts a JOIN to others (not self) ==================
{
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  const { broadcast } = hub.identify('r', 'a', { nick: 'Alice', color: '#0f0' });
  ok(broadcast.msg.type === MSG.JOIN && broadcast.msg.id === 'a', 'identify broadcasts a JOIN stamped with the peer id');
  ok(broadcast.msg.nick === 'Alice' && broadcast.msg.color === '#0f0', 'identify carries nick/color');
  ok(broadcast.exclude === 'a', 'the joining peer is excluded from its own JOIN broadcast');
}

// === Hub: pose is stamped with the server-side id (anti-spoof) =============
{
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  // 'a' tries to send a pose claiming to be 'b' — server must overwrite the id.
  const { broadcast } = hub.pose('r', 'a', makePose({ id: 'b', head: HEAD }));
  ok(broadcast.msg.type === MSG.POSE && broadcast.msg.id === 'a', 'pose id is forced to the real sender (spoof rejected)');
  ok(broadcast.exclude === 'a', 'sender excluded from its own pose broadcast');
  ok(hub.pose('r', 'ghost', makePose({ head: HEAD })).broadcast === undefined, 'pose from an unknown peer is dropped');
}

// === NetProtocol: SIGNAL (voice) builder + validation ======================
{
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
}

// === Hub: signal is a DIRECTED relay, sender-id stamped ====================
{
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  const { direct } = hub.signal('r', 'a', makeSignal({ to: 'b', kind: 'offer', data: { sdp: 's' } }));
  ok(direct && direct.to === 'b', 'signal is routed directly to the target peer');
  ok(direct.msg.from === 'a', 'signal is stamped with the real sender id (anti-spoof)');
  ok(hub.signal('r', 'a', makeSignal({ to: 'ghost', kind: 'offer', data: {} })).direct === undefined, 'signal to an absent peer is dropped');
  ok(hub.signal('r', 'x', makeSignal({ to: 'b', kind: 'offer', data: {} })).direct === undefined, 'signal from an absent peer is dropped');
}

// === Hub: disconnect broadcasts LEAVE and reaps empty rooms ================
{
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.connect('r', 'b');
  const { broadcast } = hub.disconnect('r', 'a');
  ok(broadcast.msg.type === MSG.LEAVE && broadcast.msg.id === 'a', 'disconnect broadcasts a LEAVE for the peer');
  ok(hub.size('r') === 1, 'peer removed from room');
  ok(hub.roomCount() === 1, 'room still exists while one peer remains');
  hub.disconnect('r', 'b');
  ok(hub.roomCount() === 0, 'empty room is reaped');
}

// === NetProtocol: STATE (room-object sync) builder + validation ============
{
  const tv = makeState({ key: 'tv', value: { file: 'pong.nes', core: 'nestopia' } });
  ok(tv.type === MSG.STATE && tv.key === 'tv' && tv.value.file === 'pong.nes', 'makeState builds a STATE entry');
  ok(validate(tv).ok, 'STATE validates');
  ok(validate(makeState({ key: 'tv', value: null })).ok, 'STATE with a null value (clear) validates');
  ok(!validate({ type: MSG.STATE, key: '', value: 1 }).ok, 'STATE with an empty key rejected');
  ok(!validate({ type: MSG.STATE, key: 'tv' }).ok, 'STATE without a value field rejected');
  const back = decode(encode(makeState({ key: 'hold:c1', value: { holder: 'a' }, id: 'a' })));
  ok(back && back.key === 'hold:c1' && back.value.holder === 'a' && back.id === 'a', 'STATE round-trips through encode/decode');
}

// === RoomObjects: apply / changed / clear ==================================
{
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
}

// === Hub: setState persists, broadcasts, and snapshots to late joiners ======
{
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
}

// === Hub: room state is reaped when the room empties ========================
{
  const hub = new Hub();
  hub.connect('r', 'a');
  hub.setState('r', 'a', { key: 'tv', value: { file: 'g.nes' } });
  hub.disconnect('r', 'a'); // room now empty
  ok(hub.connect('r', 'a2').state.length === 0, 'state does not leak across an empty-room reset');
}

// === HoldState: hold keys + parseHolds filtering ===========================
{
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
}

// === Hub: disconnect clears the leaving peer's hold:* state (not tv) ========
{
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
}

// === NetProtocol: INPUT (game sync) builder + validation ===================
{
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
}

// === M1.1: hostInputTarget — who a peer forwards its captured input to ======
{
  ok(hostInputTarget({ hostId: 'h', selfId: 'c' }) === 'h', 'a client forwards to the host');
  ok(hostInputTarget({ hostId: 'h', selfId: 'h' }) === null, 'the host does NOT forward to itself');
  ok(hostInputTarget({ hostId: null, selfId: 'c' }) === null, 'no host yet → nothing to forward');
  ok(hostInputTarget({ hostId: 'h', selfId: null }) === 'h', 'forwards even before our own id is known');
  ok(hostInputTarget({ hostId: 5, selfId: 5 }) === null, 'host id compared as a string (no self-send on numeric ids)');
  ok(hostInputTarget({}) === null, 'empty args → no target');
}

// === Hub: input is a DIRECTED relay to the host, sender-id stamped ==========
{
  const hub = new Hub();
  hub.connect('r', 'client');
  hub.connect('r', 'host');
  const { direct } = hub.input('r', 'client', makeInput({ to: 'host', player: 2, btn: 'faceB', down: true }));
  ok(direct && direct.to === 'host', 'input is routed directly to the host peer');
  ok(direct.msg.from === 'client' && direct.msg.player === 2 && direct.msg.btn === 'faceB', 'input stamped with the real sender id');
  ok(hub.input('r', 'client', makeInput({ to: 'ghost', player: 1, btn: 'Up', down: true })).direct === undefined, 'input to an absent host is dropped');
  ok(hub.input('r', 'x', makeInput({ to: 'host', player: 1, btn: 'Up', down: true })).direct === undefined, 'input from an absent peer is dropped');
}

// === NetProtocol: WIRE (transient relay) builder + validation ===============
{
  const w = makeWire({ ch: 'gp', data: { cableId: 'gp-1', btns: 5 } });
  ok(w.type === MSG.WIRE && w.ch === 'gp' && w.data.btns === 5, 'makeWire builds a wire message');
  ok(validate(w).ok, 'WIRE validates');
  ok(validate(makeWire({ ch: 'drag', data: null })).ok, 'WIRE with null data validates (data key present)');
  ok(!validate({ type: MSG.WIRE, ch: '', data: {} }).ok, 'WIRE with empty ch rejected');
  ok(!validate({ type: MSG.WIRE, ch: 'gp' }).ok, 'WIRE without a data key rejected');
  const back = decode(encode(makeWire({ ch: 'drag', data: { id: 'p7', p: [1, 2, 3] } })));
  ok(back && back.ch === 'drag' && back.data.p[2] === 3, 'WIRE round-trips through encode/decode');
}

// === Hub: wire is a BROADCAST relay, sender-id stamped, NOT persisted =======
{
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
}

// === NetMgr onPeerLeave: fires when a LEAVE message is applied ================
// NetMgr itself requires THREE + a real DOM, so we exercise the underlying seam
// here: PresenceState.apply(MSG.LEAVE, …) is what NetMgr calls just before
// firing _onPeerLeave. We assert the peer is removed (the callback fires AFTER
// apply) and that MSG.LEAVE carries the right id — i.e. the id the callback
// would receive.
{
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
}

// === NetMgr onPeerLeave: prune path fires callback for each stale peer =======
{
  const ps = new PresenceState({ selfId: 'host', ttlMs: 1000 });
  ps.apply(makePose({ id: 'stale1', head: HEAD }), 0);
  ps.apply(makePose({ id: 'stale2', head: HEAD }), 0);
  ps.apply(makePose({ id: 'fresh',  head: HEAD }), 2000);

  const pruned = ps.prune(2500);  // stale1 + stale2 are > 1000ms old; fresh is not
  ok(pruned.length === 2, 'prune returns two stale peer ids (onPeerLeave fires for each)');
  ok(pruned.includes('stale1') && pruned.includes('stale2'), 'both stale peer ids returned by prune');
  ok(ps.size === 1 && !!ps.get('fresh'), 'fresh peer survives the prune');
}

// === NetProtocol: HOST message + hello.host (M1.4) ==========================
{
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
}

// === buildIceServers: STUN default + optional TURN relay (M0 hardening) =====
{
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
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
