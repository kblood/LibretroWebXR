// COR-8: per-sender ownership of remote desired-state in src/GameInputMgr.js.
//
// The bug: _remoteDesired was keyed by console/player/code with NO notion of who
// put the entry there. Two permitted senders holding the SAME logical button
// (two peers wired to the same port, or a peer plus one of the local
// click-to-test lasers) shared one slot, so:
//   * the first release DELETED the shared entry and the button went up under
//     the other player's still-pressed finger — and since senders only ever send
//     TRANSITIONS, the holder never reasserted it; and
//   * one peer leaving ran clearRemote(), which lifted EVERY peer's held keys
//     (main.js even carried a comment admitting the multi-peer blip).
//
// The fix makes ownership the tuple {sender, console, player, control} and
// reduces with OR semantics: a control is DOWN while ANY sender holds it.
//
// ROUND 5 (2026-08-15) — what the adversarial verifier demonstrated, and what
// this file now covers. OR semantics turned a SELF-HEALING failure into a
// PERMANENT one: an ORPHANED owner (a peer id that will never send another
// transition and will never be handed to clearRemoteFrom) pinned its button DOWN
// for the rest of the session. Nothing could lift it — not another sender's
// release, not flushReleases() (which clears _state only; the next tick()
// re-latches from _remoteDesired). Pre-fix, the next release by anybody healed
// it. T8/T9 cover the cure (reconcileRemoteSenders + clearRemote); T10 covers the
// id-less-wire-input bucket; T11 covers the sender-id stringification.
//
// ROUND 6 (2026-08-15) — the round-5 cure covered NETWORKED owners ONLY, and
// round 5 simultaneously made every click-to-test laser its own owner
// (`local-gp:<n>` in main.js) so both hands could squeeze one virtual button.
// Together those rebuilt the identical permanent latch one layer down: a
// `selectstart` whose `selectend` never arrives (controller lost mid-press) pins
// its button DOWN, the other hand's release cannot lift it, flushReleases()
// cannot, and the roster rule deliberately skips local senders — and is `net`-
// gated besides, so in SOLO play nothing ran at all. reconcileLocalSenders() is
// the matching rule; T12 is the regression test for the latch itself and T13 pins
// down exactly whom the rule may and may not drop.
//
// Everything below drives REAL GameInputMgr instances through their real public
// API (setRemoteButton / clearRemoteFrom / reconcileRemoteSenders / clearRemote /
// tick / flushReleases). No part of the ownership logic is reimplemented here.
//
// WHAT THIS FILE CANNOT COVER: the other half of the change lives in
// src/main.js — WHO calls reconcileRemoteSenders / reconcileLocalSenders and WHEN
// (the persistent tick, disconnectFromRoom, _applyHostRole), the `remote: true`
// flag on onGameInput, and how main.js decides a laser owner is still live (the
// XRInputSource identity check in _reconcileLocalInputOwners). main.js pulls in
// three.js and the whole world build, so there is no pure-logic harness for it;
// that half is verified by reading, not by this suite. Said plainly rather than
// implied. What IS covered here is the module contract main.js codes against:
// given a roster, exactly whose holds are withdrawn and whose are not.
//
// HONEST NEGATIVE CONTROL. Two different things are checked, and they are not
// the same thing:
//   1. The "--- N: ---" section runs the identical sequences through the SAME
//      class with sender identity collapsed — no `from` and no `remote` flag, so
//      every hold lands on the single LOCAL_SENDER slot, and departure done with
//      clearRemote() instead of clearRemoteFrom(). That is an inversion of the
//      CALL PATTERN, not of the module: it proves the fixed call pattern produces
//      different numbers from the pre-fix one.
//   2. Under a GENUINE REVERT of src/GameInputMgr.js (the pre-COR-8 single-slot
//      class), this file must still print FAIL lines rather than die. The earlier
//      version of this suite did NOT: it threw
//      `TypeError: Cannot read properties of undefined (reading 'size')` on
//      mgr._remoteBySender before the first assertion and printed nothing. Every
//      private-field read now goes through sizeOf() (missing field → -1, which
//      fails the ===0 comparisons) and every new method call through callIf()
//      (missing method → undefined, no throw), and each section is wrapped so a
//      throw becomes one FAIL line and the rest of the suite still runs.
//
// EACH ASSERTION IS TAGGED:
//   [evidence] — fails under a targeted inversion of the mechanism it names.
//   [contract] — was ALSO true before the fix. Kept because it pins behaviour the
//                fix must not break (single-player input, back-compat), NOT
//                offered as proof the fix works.
// A few [contract] lines DO fail under a full revert, for a structural reason
// rather than a behavioural one: sizeOf() returns -1 for a private index the
// pre-fix class never had. That is the sentinel doing its job (a FAIL line
// instead of a TypeError), not evidence — do not read those as fix coverage.
//
// Run standalone:  node scripts/test-remote-owner.mjs

// NAMESPACE import on purpose. A named import of a binding the module does not
// export is an ESM LINK error — the whole file dies with a SyntaxError before a
// single line runs. LOCAL_SENDER/REMOTE_ANON_SENDER only exist post-fix, so
// importing them by name would defeat the full-revert control described above:
// the suite has to reach its assertions and FAIL them, not fail to load.
import * as GIM from '../src/GameInputMgr.js';
import { EXTRA_PLAYER_KEYS, RETROPAD_KEYS } from '../src/ControllerMaps.js';

const { GameInputMgr, LOCAL_SENDER, REMOTE_ANON_SENDER } = GIM;

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL ${name}`); } };

// Run one block of assertions. A throw inside (e.g. a reverted module missing a
// method this suite calls directly) becomes ONE FAIL line and the suite carries
// on, instead of killing the process before anything is reported.
const section = (title, fn) => {
  console.log(title);
  try { fn(); } catch (e) {
    fail++;
    console.error(`FAIL ${title} — threw before finishing: ${e && e.message}`);
  }
};

// Read a private Map/Set's size WITHOUT assuming the field exists. A reverted
// module has no _remoteBySender / _netSenders at all; -1 makes the `=== 0`
// assertions FAIL (which is the point) instead of throwing a TypeError.
const sizeOf = (mgr, field) => {
  const v = mgr?.[field];
  return (v && typeof v.size === 'number') ? v.size : -1;
};
const desiredN = (mgr) => sizeOf(mgr, '_remoteDesired');
const sendersN = (mgr) => sizeOf(mgr, '_remoteBySender');
const netN = (mgr) => (typeof mgr?.netSenderCount === 'function' ? mgr.netSenderCount() : -1);
const localN = (mgr) => (typeof mgr?.localSenderCount === 'function' ? mgr.localSenderCount() : -1);
// Call a method that may not exist on a reverted module: returns undefined
// instead of throwing, so the assertion about its EFFECT is what fails.
const callIf = (mgr, name, ...args) => (typeof mgr?.[name] === 'function' ? mgr[name](...args) : undefined);

// The single key player 2's RetroPad "A" resolves to (players 2-4 are single-
// dispatch; player 1 double-dispatches cfg + RA stock).
const P2_A = EXTRA_PLAYER_KEYS[2].A;
const P2_B = EXTRA_PLAYER_KEYS[2].B;
const P2_START = EXTRA_PLAYER_KEYS[2].Start;
const P2_SELECT = EXTRA_PLAYER_KEYS[2].Select;

// ---------------------------------------------------------------------------
// Harness: a real GameInputMgr with NO local controllers and no physical pad,
// so the only thing that can move `desired` is the remote-sender path we test.
// ---------------------------------------------------------------------------
function makeMgr() {
  const log = [];
  const mgr = new GameInputMgr({
    controllers: [],
    isGamepadHeld: () => false,
    isControllerHoldingGamepad: () => false,
    getRouting: () => [],
    dispatch: (consoleId, type, code) => log.push({ consoleId, type, code }),
    defaultConsoleId: 'console0',
  });
  const count = (type, code = P2_A, consoleId = 'console0') =>
    log.filter((e) => e.type === type && e.code === code && e.consoleId === consoleId).length;
  // Is the emulator currently seeing this code as pressed? The last event wins —
  // this is what "the button is stuck DOWN" actually means downstream.
  const isDown = (code = P2_A, consoleId = 'console0') => {
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.code === code && e.consoleId === consoleId) return e.type === 'keydown';
    }
    return false;
  };
  return { mgr, log, count, isDown };
}

// `o.remote` marks the networked input path (main.js's onGameInput sets it).
// Omitting it is the LOCAL injector path (click-to-test lasers, TestApi).
const hold = (mgr, from, down, o = {}) => mgr.setRemoteButton({
  player: o.player ?? 2, btn: o.btn ?? 'A', down, consoleId: o.consoleId ?? 'console0', from, remote: o.remote ?? false,
});
const holdNet = (mgr, from, down, o = {}) => hold(mgr, from, down, { ...o, remote: true });

// --- Sequence 1: two senders hold the same button, they release one at a time.
// Returns the OBSERVED dispatch counts, not a verdict — the caller decides what
// "correct" is, so the fixed and inverted runs share one code path exactly.
function seqRelease({ fromA, fromB, remote = true }) {
  const { mgr, count } = makeMgr();
  hold(mgr, fromA, true, { remote });
  hold(mgr, fromB, true, { remote });
  mgr.tick();
  const downsAfterBothHold = count('keydown');
  hold(mgr, fromA, false, { remote });
  mgr.tick();
  const upsAfterFirstRelease = count('keyup');
  hold(mgr, fromB, false, { remote });
  mgr.tick();
  const upsAfterSecondRelease = count('keyup');
  return {
    downsAfterBothHold,
    upsAfterFirstRelease,
    upsAfterSecondRelease,
    desiredLeft: desiredN(mgr),
    sendersLeft: sendersN(mgr),
  };
}

// --- Sequence 2: two senders hold the same button, then each DEPARTS (peer
// leave), first the non-holder-of-record then the other.
function seqDepart({ fromA, fromB, departAll }) {
  const { mgr, count } = makeMgr();
  holdNet(mgr, fromA, true);
  holdNet(mgr, fromB, true);
  mgr.tick();
  const downsAfterBothHold = count('keydown');
  // Peer A leaves. departAll reproduces the pre-fix onPeerLeave (clearRemote()).
  if (departAll) mgr.clearRemote(); else callIf(mgr, 'clearRemoteFrom', fromA);
  mgr.tick();
  const upsAfterFirstDeparts = count('keyup');
  const desiredAfterFirstDeparts = desiredN(mgr);
  // Peer B (the remaining holder) leaves too.
  if (departAll) mgr.clearRemote(); else callIf(mgr, 'clearRemoteFrom', fromB);
  mgr.tick();
  const upsAfterSecondDeparts = count('keyup');
  return {
    downsAfterBothHold,
    upsAfterFirstDeparts,
    desiredAfterFirstDeparts,
    upsAfterSecondDeparts,
    desiredLeft: desiredN(mgr),
    sendersLeft: sendersN(mgr),
  };
}

let r1 = null, r2 = null;

section('--- T1: two senders hold the same button; one releases ---', () => {
  r1 = seqRelease({ fromA: 'peerA', fromB: 'peerB' });
  ok('T1 [contract]: one keydown for two senders holding the same code', r1.downsAfterBothHold === 1);
  ok('T1 [evidence]: sender A releasing does NOT lift the button B still holds', r1.upsAfterFirstRelease === 0);
  ok('T1 [contract]: the last holder releasing lifts it (exactly one keyup)', r1.upsAfterSecondRelease === 1);
  ok('T1 [contract]: no desired-state survives the last release', r1.desiredLeft === 0);
  ok('T1 [evidence]: no sender state survives the last release', r1.sendersLeft === 0);
});

section('--- T2: a peer LEAVES while another still holds the button ---', () => {
  r2 = seqDepart({ fromA: 'peerA', fromB: 'peerB', departAll: false });
  ok('T2 [evidence]: peer A leaving does NOT lift the button peer B still holds', r2.upsAfterFirstDeparts === 0);
  ok('T2 [evidence]: the button is still desired after A leaves', r2.desiredAfterFirstDeparts === 1);
  ok('T2 [contract]: the holder leaving DOES lift it (no latch)', r2.upsAfterSecondDeparts === 1);
  ok('T2 [contract]: no desired-state survives departure', r2.desiredLeft === 0);
  ok('T2 [evidence]: no sender state survives departure (nothing to leak)', r2.sendersLeft === 0);
});

section('--- T3: departure forgets the sender completely (memory) ---', () => {
  // A dead sender must leave NOTHING behind: a long-lived host churning through
  // hundreds of joins/leaves must not accumulate a map of ghosts. [evidence]
  // against "the reverse index is never pruned", [contract] against a full revert
  // (which held no such state at all).
  const { mgr } = makeMgr();
  for (let i = 0; i < 500; i++) {
    holdNet(mgr, `peer${i}`, true, { btn: 'B' });
    mgr.tick();
    callIf(mgr, 'clearRemoteFrom', `peer${i}`);
    mgr.tick();
  }
  ok('T3 [evidence]: 500 join/hold/leave cycles leave zero sender entries', sendersN(mgr) === 0);
  ok('T3 [evidence]: 500 join/hold/leave cycles leave zero desired entries', desiredN(mgr) === 0);
  ok('T3 [evidence]: 500 join/hold/leave cycles leave zero networked senders', netN(mgr) === 0);

  // Same for the ordinary release path (a peer that stays connected).
  const { mgr: m2 } = makeMgr();
  for (let i = 0; i < 500; i++) {
    holdNet(m2, `peer${i}`, true, { btn: 'B' });
    holdNet(m2, `peer${i}`, false, { btn: 'B' });
  }
  ok('T3 [evidence]: 500 hold/release cycles leave zero sender entries', sendersN(m2) === 0);
  ok('T3 [contract]: 500 hold/release cycles leave zero desired entries', desiredN(m2) === 0);
  ok('T3 [evidence]: 500 hold/release cycles leave zero networked senders', netN(m2) === 0);

  // Releasing a button a sender never held, and clearing a sender that never
  // existed, must not create state (or throw).
  const { mgr: m3 } = makeMgr();
  m3.setRemoteButton({ player: 2, btn: 'A', down: false, from: 'ghost', remote: true });
  callIf(m3, 'clearRemoteFrom', 'never-seen');
  callIf(m3, 'reconcileRemoteSenders', new Set());
  ok('T3 [contract]: releasing/clearing an unknown sender creates no state',
    desiredN(m3) === 0 && sendersN(m3) === 0);
});

section('--- T4: ownership is per {sender, console, player, control} ---', () => {
  const { mgr, count } = makeMgr();
  // Same sender, same button, two different consoles → independent entries.
  holdNet(mgr, 'peerA', true, { consoleId: 'console0' });
  holdNet(mgr, 'peerA', true, { consoleId: 'console1' });
  mgr.tick();
  ok('T4 [contract]: same button on two consoles = two keydowns',
    count('keydown', P2_A, 'console0') === 1 && count('keydown', P2_A, 'console1') === 1);
  holdNet(mgr, 'peerA', false, { consoleId: 'console0' });
  mgr.tick();
  ok('T4 [contract]: releasing on console0 does not lift console1',
    count('keyup', P2_A, 'console0') === 1 && count('keyup', P2_A, 'console1') === 0);

  // Same sender, same console, two different player ports → independent.
  const { mgr: m2, count: c2 } = makeMgr();
  const P3_A = EXTRA_PLAYER_KEYS[3].A;
  holdNet(m2, 'peerA', true, { player: 2 });
  holdNet(m2, 'peerA', true, { player: 3 });
  m2.tick();
  holdNet(m2, 'peerA', false, { player: 2 });
  m2.tick();
  ok('T4 [contract]: releasing port 2 does not lift port 3',
    c2('keyup', P2_A) === 1 && c2('keyup', P3_A) === 0 && c2('keydown', P3_A) === 1);
});

section('--- T5: player 1 double-dispatch: BOTH codes obey OR semantics ---', () => {
  // Player 1's "A" resolves to two codes (cfg + RA stock). Each must be owned
  // per sender independently, or the shared-slot bug just moves down a level.
  const [cfgCode, stockCode] = RETROPAD_KEYS.A;
  const { mgr, count } = makeMgr();
  holdNet(mgr, 'peerA', true, { player: 1 });
  holdNet(mgr, 'peerB', true, { player: 1 });
  mgr.tick();
  holdNet(mgr, 'peerA', false, { player: 1 });
  mgr.tick();
  ok('T5 [evidence]: neither P1 code lifts while the second sender holds',
    count('keyup', cfgCode) === 0 && count('keyup', stockCode) === 0);
  holdNet(mgr, 'peerB', false, { player: 1 });
  mgr.tick();
  ok('T5 [contract]: both P1 codes lift when the last sender releases',
    count('keyup', cfgCode) === 1 && count('keyup', stockCode) === 1);
});

section('--- T6: LOCAL controller path is unchanged (no single-player regression) ---', () => {
  // Whole block is [contract]: a regression guard for behaviour that predates
  // COR-8. It is not evidence the ownership fix works.
  const ctrl = {
    userData: {
      handedness: 'right',
      inputSource: { gamepad: { buttons: Array.from({ length: 8 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] } },
    },
  };
  const btns = ctrl.userData.inputSource.gamepad.buttons;
  const log = [];
  const mgr = new GameInputMgr({
    controllers: [ctrl],
    isGamepadHeld: () => true,
    isControllerHoldingGamepad: () => true,
    getRouting: () => [{ ctrl, consoleId: 'console0', player: 1, hand: 'holding' }],
    dispatch: (consoleId, type, code) => log.push({ consoleId, type, code }),
    defaultConsoleId: 'console0',
  });

  btns[4].pressed = true;
  mgr.tick();
  const localDowns = log.filter((e) => e.type === 'keydown');
  ok('T6 [contract]: local faceA press still dispatches keydown', localDowns.length > 0);
  const localCode = localDowns[0]?.code;

  // A remote peer joins, holds an unrelated button, then leaves.
  holdNet(mgr, 'peerA', true);
  mgr.tick();
  callIf(mgr, 'clearRemoteFrom', 'peerA');
  mgr.tick();
  ok('T6 [contract]: a peer departing does not lift the LOCAL held key',
    log.filter((e) => e.type === 'keyup' && e.code === localCode).length === 0);

  btns[4].pressed = false;
  mgr.tick();
  ok('T6 [contract]: local release still dispatches keyup',
    log.filter((e) => e.type === 'keyup' && e.code === localCode).length === 1);
  ok('T6 [contract]: flushReleases() still lifts everything', (() => {
    btns[4].pressed = true;
    mgr.tick();
    const before = log.filter((e) => e.type === 'keyup' && e.code === localCode).length;
    mgr.flushReleases();
    return log.filter((e) => e.type === 'keyup' && e.code === localCode).length === before + 1;
  })());
});

section('--- T7: clearRemote() back-compat (TestApi.releaseAll, session teardown) ---', () => {
  const { mgr, count } = makeMgr();
  holdNet(mgr, 'peerA', true);
  holdNet(mgr, 'peerB', true);
  hold(mgr, undefined, true, { btn: 'B' });   // a local click-to-test hold
  mgr.tick();
  mgr.clearRemote();
  ok('T7 [contract]: clearRemote() empties _remoteDesired immediately', desiredN(mgr) === 0);
  ok('T7 [evidence]: clearRemote() empties the sender index too', sendersN(mgr) === 0);
  ok('T7 [evidence]: clearRemote() empties the networked-sender index too', netN(mgr) === 0);
  mgr.tick();
  ok('T7 [contract]: clearRemote() → keyup on the next tick (no latch)', count('keyup') === 1);
});

// ===========================================================================
// T8 is the regression test for the defect the round-4 verifier demonstrated:
// OR semantics made a stuck remote button PERMANENT where the pre-fix single-slot
// code self-healed on the next release by anybody. Reproduces the verifier's own
// sequence: an owner that will never transition again and will never be named in
// a clearRemoteFrom call (its LEAVE was fired while amRoomHost() was false, or its
// id was retired wholesale by NetMgr's reconnect).
// ===========================================================================
section('--- T8: an ORPHANED owner must not pin the button down forever ---', () => {
  const { mgr, count, isDown } = makeMgr();
  holdNet(mgr, 'old-id', true);          // the peer that is about to be orphaned
  mgr.tick();
  holdNet(mgr, 'new-id', true);          // same button, a live peer
  mgr.tick();
  holdNet(mgr, 'new-id', false);         // the live peer lets go
  mgr.tick();
  ok('T8 [evidence]: the live peer releasing does not lift what another owner holds',
    count('keyup') === 0 && isDown());

  // Diagnostic, deliberately NOT an assertion: this documents WHY the reconcile
  // has to exist (flushReleases clears _state, the next tick re-latches from
  // _remoteDesired) without pinning down HOW an alternative fix must behave.
  mgr.flushReleases();
  mgr.tick();
  console.log(`     after flushReleases()+tick: down=${isDown()} keydowns=${count('keydown')} keyups=${count('keyup')}`);

  // The cure: reconcile against the roster the orphan is no longer in.
  const dropped = callIf(mgr, 'reconcileRemoteSenders', new Set(['new-id']));
  ok('T8 [evidence]: reconcileRemoteSenders() drops exactly the orphaned owner', dropped === 1);
  for (let i = 0; i < 200; i++) mgr.tick();
  ok('T8 [evidence]: the orphaned button is UP and stays up over 200 further frames', !isDown());
  ok('T8 [evidence]: the orphan leaves no desired/sender/networked state behind',
    desiredN(mgr) === 0 && sendersN(mgr) === 0 && netN(mgr) === 0);

  // The other cure, for the transition where the roster itself stops meaning
  // anything (socket down, host-role change) — main.js calls clearRemote() there.
  const b = makeMgr();
  holdNet(b.mgr, 'old-id', true);
  b.mgr.tick();
  b.mgr.clearRemote();
  for (let i = 0; i < 200; i++) b.mgr.tick();
  ok('T8 [evidence]: clearRemote() also frees an orphan (the disconnect path)',
    !b.isDown() && b.count('keyup') === 1 && netN(b.mgr) === 0);
});

section('--- T9: reconcileRemoteSenders() drops ONLY absent networked senders ---', () => {
  const { mgr, count } = makeMgr();
  holdNet(mgr, 'peerA', true, { btn: 'A' });        // present peer
  holdNet(mgr, 'peerB', true, { btn: 'B' });        // absent peer (the orphan)
  hold(mgr, undefined, true, { btn: 'Start' });     // LOCAL_SENDER (TestApi path)
  hold(mgr, 'local-gp:0', true, { btn: 'Select' }); // a named click-to-test laser
  mgr.tick();
  ok('T9 [evidence]: netSenderCount() counts wire senders only, not local ones', netN(mgr) === 2);

  const dropped = callIf(mgr, 'reconcileRemoteSenders', new Set(['peerA']));
  mgr.tick();
  ok('T9 [evidence]: exactly one sender is dropped', dropped === 1);
  ok('T9 [evidence]: the absent peer\'s button lifts', count('keyup', P2_B) === 1);
  ok('T9 [evidence]: the present peer\'s button stays down', count('keyup', P2_A) === 0);
  ok('T9 [evidence]: an anonymous LOCAL hold is never dropped by a roster reconcile',
    count('keyup', P2_START) === 0);
  ok('T9 [evidence]: a NAMED local hold (click-to-test laser) is never dropped either',
    count('keyup', P2_SELECT) === 0);
  ok('T9 [evidence]: only the surviving peer is still counted', netN(mgr) === 1);

  // Socket down: main.js calls clearRemote() there, but an empty/absent roster
  // must be read as "nobody is present", never as "everybody is".
  const e = makeMgr();
  holdNet(e.mgr, 'peerA', true, { btn: 'A' });
  hold(e.mgr, undefined, true, { btn: 'Start' });
  e.mgr.tick();
  ok('T9 [evidence]: an EMPTY roster drops every networked owner',
    callIf(e.mgr, 'reconcileRemoteSenders', new Set()) === 1);
  const u = makeMgr();
  holdNet(u.mgr, 'peerA', true, { btn: 'A' });
  u.mgr.tick();
  ok('T9 [evidence]: a MISSING roster argument drops every networked owner',
    callIf(u.mgr, 'reconcileRemoteSenders', undefined) === 1);
  e.mgr.tick();
  ok('T9 [evidence]: the local hold survives the empty-roster reconcile',
    e.count('keyup', P2_START) === 0 && e.count('keyup', P2_A) === 1);

  // The roster main.js builds is a Set; accept a plain Array too, since that is
  // what net.presence.peers().map(p => p.id) hands back without a wrapper.
  const a = makeMgr();
  holdNet(a.mgr, 'peerA', true, { btn: 'A' });
  holdNet(a.mgr, 'peerB', true, { btn: 'B' });
  a.mgr.tick();
  ok('T9 [evidence]: an Array roster is honoured like a Set',
    callIf(a.mgr, 'reconcileRemoteSenders', ['peerA']) === 1);
  a.mgr.tick();
  ok('T9 [evidence]: Array roster — absent lifts, present holds',
    a.count('keyup', P2_B) === 1 && a.count('keyup', P2_A) === 0);
});

// ===========================================================================
// T10 pins down the unguarded assumption the verifier flagged: NetProtocol's
// validate() does not require `from` on an INPUT message, and NetMgr passes
// `from: msg.from || null` straight through. No shipped relay produces an id-less
// INPUT (server/Hub.js has stamped `from: fromPeerId` since a58e126), so this is
// defence, not a live break — but before the fix such an input landed in
// LOCAL_SENDER, where it shared a slot with the click-to-test lasers and could
// never be reached by clearRemoteFrom(peerId).
// ===========================================================================
section('--- T10: an id-less REMOTE input gets its own bucket, not the local one ---', () => {
  ok('T10 [evidence]: the anonymous remote bucket is a distinct exported id',
    typeof REMOTE_ANON_SENDER === 'string' && REMOTE_ANON_SENDER !== LOCAL_SENDER);

  // A local hold and an id-less remote hold of the SAME button are two owners.
  const { mgr, count, isDown } = makeMgr();
  holdNet(mgr, undefined, true);          // remote, no id → REMOTE_ANON_SENDER
  hold(mgr, undefined, true);             // local injector → LOCAL_SENDER
  mgr.tick();
  hold(mgr, undefined, false);            // the LOCAL owner lets go
  mgr.tick();
  ok('T10 [evidence]: a local release does not lift an id-less REMOTE hold',
    count('keyup') === 0 && isDown());
  callIf(mgr, 'clearRemoteFrom', 'peerA');
  callIf(mgr, 'reconcileRemoteSenders', new Set(['peerA']));
  mgr.tick();
  ok('T10 [contract]: neither clearRemoteFrom(peerId) nor a roster reconcile can name it '
    + '(a roster cannot adjudicate an id it never issued)', count('keyup') === 0 && isDown());
  mgr.clearRemote();
  mgr.tick();
  // [contract], not [evidence]: this is pre-COR-8 clearRemote() behaviour and it
  // survives a full revert and every targeted inversion. It is here to pin the
  // ONE escape hatch REMOTE_ANON_SENDER has, not as proof the fix works.
  ok('T10 [contract]: clearRemote() DOES free it — so it cannot latch past a '
    + 'disconnect or a host change, which is where main.js calls it',
    count('keyup') === 1 && !isDown());

  // An id-less LEAVE is main.js's clearRemote() case, not clearRemoteFrom's. If
  // clearRemoteFrom fell back to LOCAL_SENDER the way the hold path does, an
  // id-less LEAVE would wipe the click-to-test lasers — holds that belong to the
  // person at this headset, not to any peer.
  const c = makeMgr();
  hold(c.mgr, undefined, true);            // local injector holds
  hold(c.mgr, 'local-gp:1', true, { btn: 'B' });
  c.mgr.tick();
  callIf(c.mgr, 'clearRemoteFrom', undefined);
  callIf(c.mgr, 'clearRemoteFrom', '');
  callIf(c.mgr, 'clearRemoteFrom', null);
  c.mgr.tick();
  ok('T10 [evidence]: an id-less clearRemoteFrom() does not wipe LOCAL holds',
    c.count('keyup', P2_A) === 0 && c.count('keyup', P2_B) === 0 && c.isDown());

  // ...and the mirror image: an id-less remote RELEASE must not cancel a local hold.
  const b = makeMgr();
  hold(b.mgr, undefined, true);           // local injector holds
  b.mgr.tick();
  holdNet(b.mgr, undefined, false);       // id-less remote release arrives
  b.mgr.tick();
  ok('T10 [evidence]: an id-less remote release does not cancel a LOCAL hold',
    b.count('keyup') === 0 && b.isDown());
});

section('--- T11: sender ids are compared in one normalised form ---', () => {
  // The hold path keys on the relay's `msg.from`; the clear path keys on whatever
  // LEAVE/prune reported. If those ever disagreed on TYPE the departing peer's
  // holds would never be found and WOULD latch. GameInputMgr stringifies both
  // ends; nothing exercised that until now (the round-4 verifier's invD inversion
  // — removing the String() — passed all 32 assertions).
  const { mgr, count } = makeMgr();
  mgr.setRemoteButton({ player: 2, btn: 'A', down: true, from: 12345, remote: true });
  mgr.tick();
  callIf(mgr, 'clearRemoteFrom', '12345');   // same id, reported as a string
  mgr.tick();
  ok('T11 [evidence]: a numeric hold id is cleared by the string form of that id',
    count('keyup') === 1 && sendersN(mgr) === 0);

  // And the reconcile direction: a roster carrying ids as numbers must still
  // recognise the stringified sender, or every present peer looks absent.
  const b = makeMgr();
  b.mgr.setRemoteButton({ player: 2, btn: 'A', down: true, from: '12345', remote: true });
  b.mgr.tick();
  ok('T11 [evidence]: a numeric roster entry matches a stringified sender',
    callIf(b.mgr, 'reconcileRemoteSenders', new Set([12345])) === 0);
  b.mgr.tick();
  ok('T11 [evidence]: ...so the present peer keeps its button', b.count('keyup') === 0);
});

// ===========================================================================
// T12 is the regression test for the ROUND-6 defect: the round-5 orphan cure
// reached NETWORKED owners only, so the identical permanent latch survived for a
// LOCAL one — and round 5's own main.js change (one owner per laser,
// `local-gp:<n>`) is what made it unhealable, since the other hand's release no
// longer touches it. This is the verifier's demonstrated sequence, run against the
// real module.
// ===========================================================================
section('--- T12: an ORPHANED LOCAL owner must not pin the button down forever ---', () => {
  const { mgr, count, isDown } = makeMgr();
  hold(mgr, 'local-gp:0', true);    // laser 0 presses — and its controller dies mid-press,
  mgr.tick();                       // so this selectstart never gets its selectend
  hold(mgr, 'local-gp:1', true);    // the other hand presses the SAME virtual button
  mgr.tick();
  hold(mgr, 'local-gp:1', false);   // ...and releases normally
  mgr.tick();
  ok('T12 [contract]: the other hand releasing does not lift what laser 0 still holds',
    count('keyup') === 0 && isDown());

  // Diagnostic, deliberately not an assertion — the same shape as T8's, showing
  // WHY a reconcile has to exist rather than constraining how it works.
  mgr.flushReleases();
  mgr.tick();
  console.log(`     after flushReleases()+tick: down=${isDown()} keyups=${count('keyup')}`);

  // Neither round-5 cure reaches it. The roster rule skips local senders by
  // design, and in solo play main.js never even calls it (`net` is null), which is
  // what made this unhealable rather than merely delayed.
  ok('T12 [evidence]: the ROSTER rule cannot free a local orphan — hence the local rule',
    callIf(mgr, 'reconcileRemoteSenders', new Set()) === 0 && netN(mgr) === 0 && isDown());

  ok('T12 [evidence]: reconcileLocalSenders() drops exactly the orphaned laser',
    callIf(mgr, 'reconcileLocalSenders', new Set(['local-gp:1'])) === 1);
  for (let i = 0; i < 200; i++) mgr.tick();
  ok('T12 [evidence]: the orphaned button is UP and stays up over 200 further frames', !isDown());
  ok('T12 [evidence]: the local orphan leaves no desired/sender state behind',
    desiredN(mgr) === 0 && sendersN(mgr) === 0 && localN(mgr) === 0);

  // The blunt cure still works for it too — that is what main.js's disconnect and
  // host-change paths call, and what TestApi.releaseAll() calls.
  const b = makeMgr();
  hold(b.mgr, 'local-gp:0', true);
  b.mgr.tick();
  b.mgr.clearRemote();
  for (let i = 0; i < 200; i++) b.mgr.tick();
  // [contract]: clearRemote() has always dropped every owner, so this survives
  // every targeted inversion of the round-6 rule (only a full revert reddens it,
  // via localN's -1 sentinel). It is here to pin the escape hatch, not as evidence.
  ok('T12 [contract]: clearRemote() also frees a local orphan',
    !b.isDown() && b.count('keyup') === 1 && localN(b.mgr) === 0);
});

section('--- T13: reconcileLocalSenders() drops ONLY absent NAMED local senders ---', () => {
  const { mgr, count } = makeMgr();
  holdNet(mgr, 'peerA', true, { btn: 'A' });        // networked owner — the ROOM roster's business
  hold(mgr, 'local-gp:0', true, { btn: 'B' });      // a laser still being squeezed
  hold(mgr, 'local-gp:1', true, { btn: 'Start' });  // the orphaned laser
  hold(mgr, undefined, true, { btn: 'Select' });    // LOCAL_SENDER — id-less (TestApi)
  mgr.tick();
  ok('T13 [evidence]: localSenderCount() counts local owners only, not wire ones',
    localN(mgr) === 3 && netN(mgr) === 1);

  const dropped = callIf(mgr, 'reconcileLocalSenders', new Set(['local-gp:0']));
  mgr.tick();
  ok('T13 [evidence]: exactly one sender is dropped', dropped === 1);
  ok('T13 [evidence]: the orphaned laser\'s button lifts', count('keyup', P2_START) === 1);
  ok('T13 [evidence]: the still-squeezed laser\'s button stays down', count('keyup', P2_B) === 0);
  ok('T13 [evidence]: a NETWORKED owner is never dropped by the LOCAL rule',
    count('keyup', P2_A) === 0 && netN(mgr) === 1);
  ok('T13 [evidence]: the id-less TestApi bucket is never dropped (no roster can name it)',
    count('keyup', P2_SELECT) === 0);

  // Absent/empty/missing roster means "nobody is live", never "everybody is" —
  // the same safe reading the roster rule takes.
  const e = makeMgr();
  hold(e.mgr, 'local-gp:0', true, { btn: 'A' });
  hold(e.mgr, undefined, true, { btn: 'B' });
  e.mgr.tick();
  ok('T13 [evidence]: an EMPTY roster drops every named local owner',
    callIf(e.mgr, 'reconcileLocalSenders', new Set()) === 1);
  const u = makeMgr();
  hold(u.mgr, 'local-gp:0', true, { btn: 'A' });
  u.mgr.tick();
  ok('T13 [evidence]: a MISSING roster argument drops every named local owner',
    callIf(u.mgr, 'reconcileLocalSenders', undefined) === 1);
  e.mgr.tick();
  ok('T13 [evidence]: the id-less hold survives the empty-roster local reconcile',
    e.count('keyup', P2_B) === 0 && e.count('keyup', P2_A) === 1);

  // main.js hands a Set; accept any iterable, exactly as the roster rule does.
  const a = makeMgr();
  hold(a.mgr, 'local-gp:0', true, { btn: 'A' });
  hold(a.mgr, 'local-gp:1', true, { btn: 'B' });
  a.mgr.tick();
  ok('T13 [evidence]: an Array roster is honoured like a Set',
    callIf(a.mgr, 'reconcileLocalSenders', ['local-gp:0']) === 1);
  a.mgr.tick();
  ok('T13 [evidence]: Array roster — absent lifts, present holds',
    a.count('keyup', P2_B) === 1 && a.count('keyup', P2_A) === 0);

  // An id that has EVER arrived over the wire stays under the roster rule even if
  // a local caller reuses it: the wire issued that id, so the wire retires it.
  // Pins the exclusion down behaviourally instead of leaving it to the comment.
  const h = makeMgr();
  holdNet(h.mgr, 'hybrid', true, { btn: 'A' });
  hold(h.mgr, 'hybrid', true, { btn: 'B' });
  h.mgr.tick();
  ok('T13 [evidence]: an id seen on the wire is judged by the ROSTER rule, not the local one',
    callIf(h.mgr, 'reconcileLocalSenders', new Set()) === 0
    && callIf(h.mgr, 'reconcileRemoteSenders', new Set()) === 1);
  h.mgr.tick();
  ok('T13 [evidence]: ...and dropping it there lifts BOTH of its holds',
    h.count('keyup', P2_A) === 1 && h.count('keyup', P2_B) === 1);

  // With nothing local held the rule must be a no-op, not an all-clear: this is
  // the per-frame gate main.js relies on and the reason it can run unconditionally.
  const n = makeMgr();
  holdNet(n.mgr, 'peerA', true, { btn: 'A' });
  n.mgr.tick();
  ok('T13 [evidence]: with only networked owners the local rule changes nothing',
    callIf(n.mgr, 'reconcileLocalSenders', new Set()) === 0
    && localN(n.mgr) === 0 && n.count('keyup', P2_A) === 0);
});

// ===========================================================================
// N: an inversion of the CALL PATTERN (see the header). Not a substitute for the
// full-revert control — that one is the sizeOf()/callIf()/section() machinery
// above, which turns a reverted module into FAIL lines instead of a TypeError.
// ===========================================================================
section('--- N: NEGATIVE CONTROL — the same sequences with sender identity collapsed ---', () => {
  // "Fix disabled" here is not a mock: it is the real class driven the way the
  // pre-COR-8 code drove it — no `from` and no `remote` flag (so every sender
  // collapses onto the one LOCAL_SENDER slot, which is what a sender-blind map
  // is) and clearRemote() on peer departure (the literal old onPeerLeave line).
  // If these produce the SAME numbers as T1/T2 above, the fix does nothing.
  const n1 = seqRelease({ fromA: undefined, fromB: undefined, remote: false });
  const n2 = seqDepart({ fromA: 'peerA', fromB: 'peerB', departAll: true });
  console.log(`     inverted seqRelease: upsAfterFirstRelease=${n1.upsAfterFirstRelease} (fixed: ${r1?.upsAfterFirstRelease})`);
  console.log(`     inverted seqDepart:  upsAfterFirstDeparts=${n2.upsAfterFirstDeparts} desiredAfterFirstDeparts=${n2.desiredAfterFirstDeparts} (fixed: ${r2?.upsAfterFirstDeparts}, ${r2?.desiredAfterFirstDeparts})`);

  ok('N1 [evidence]: single-owner path DOES lift the button on the first release (the bug)',
    n1.upsAfterFirstRelease === 1);
  ok('N1 [evidence]: fixed path differs from the single-owner path',
    r1 != null && r1.upsAfterFirstRelease !== n1.upsAfterFirstRelease);
  // [contract], not [evidence]: this half is a FIXTURE check — it confirms the
  // inverted call pattern really does reproduce the pre-fix blip. It calls
  // clearRemote() itself, so it is red under nothing, a full revert included. Its
  // partner line below is the half that carries the evidence.
  ok('N2 [contract]: pre-fix all-clear departure DOES lift the other peer\'s held button (the blip)',
    n2.upsAfterFirstDeparts === 1 && n2.desiredAfterFirstDeparts === 0);
  ok('N2 [evidence]: fixed departure differs from the pre-fix all-clear',
    r2 != null && r2.upsAfterFirstDeparts !== n2.upsAfterFirstDeparts);
  // The single-owner path still ends clean — it is broken in WHEN it lifts, not in
  // whether it leaks. This pins the negative control to the real defect.
  ok('N3 [contract]: the single-owner path leaks nothing either (the defect is timing, not leakage)',
    n1.desiredLeft === 0 && n2.desiredLeft === 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
