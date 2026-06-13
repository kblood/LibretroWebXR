// Unit tests for the M0 presence layer — pure protocol + peer registry
// ([[src/net/NetProtocol.js]], [[src/net/PresenceState.js]]). No THREE / no
// socket, so this runs in `npm test`.

import {
  MSG, POSE_LEN, SIGNAL_KINDS, isValidPart, roundPart, makePose, makeJoin, makeHello,
  makeLeave, makeSignal, makeState, makeInput, hostInputTarget, validate, encode, decode,
} from '../src/net/NetProtocol.js';
import { PresenceState } from '../src/net/PresenceState.js';
import { RoomObjects } from '../src/net/RoomObjects.js';
import { makeHoldKey, isHoldKey, parseHolds } from '../src/net/HoldState.js';
import { Hub } from '../server/Hub.js';

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
  ok(SIGNAL_KINDS.includes('ice') && SIGNAL_KINDS.length === 3, 'three signal kinds');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
