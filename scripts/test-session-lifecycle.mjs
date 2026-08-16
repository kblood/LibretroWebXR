// COR-2 — leave/rejoin must not leave managers pointing at a dead room session,
// and must not leave that session's state latched on for ever.
//
// TWO DEFECTS, ONE LIFECYCLE:
//   1. Every session builds a new NetMgr with a NEW AvatarMgr, but the ghost
//      managers are built once per world build and were handed `net.avatars` BY
//      VALUE. After a leave+rejoin they asked the dead session where the new
//      session's peers were, got null for every one, and never spawned a ghost.
//      Fixed by [[src/net/LiveAvatars.js]] — a handle that resolves through the
//      current `net` on every call.
//   2. Those managers HIDE the local prop while a peer holds it, and unhide it
//      inside sync(). Leave detaches the tick callbacks, so sync() never runs
//      again: a peer holding your gamepad when you hit Leave left your gamepad
//      invisible for the rest of the build. Fixed by [[src/net/SessionScope.js]]
//      — cleanups registered at wire time and run on every Leave.
//
// Both are driven through the REAL GhostGamepadMgr, not a model of it: the
// hidden-prop latch is inside that class, and a test that re-implements the
// lifecycle proves only that the test agrees with itself. Each fix has a NEGATIVE
// CONTROL that re-runs the same scenario the old way and requires the old,
// broken outcome.
//
// Run: node scripts/test-session-lifecycle.mjs   (also in `npm test`)

import * as THREE from 'three';

// GhostGamepadMgr builds a real gamepad mesh, and that mesh bakes its button
// labels into a 2D canvas (src/Gamepad.js makeLabel). Node has no DOM, so this
// is the smallest possible stand-in: nothing here is asserted on — the labels
// are decoration — it exists purely so the real manager can run headless.
globalThis.document = globalThis.document || {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => new Proxy({}, { get: () => () => {} }),
  }),
};

const { createLiveAvatars } = await import('../src/net/LiveAvatars.js');
const { createSessionScope } = await import('../src/net/SessionScope.js');
const { GhostGamepadMgr } = await import('../src/GhostGamepadMgr.js');
const { GhostCartMgr } = await import('../src/GhostCartMgr.js');
const { GhostLightGunMgr } = await import('../src/GhostLightGunMgr.js');
const { GhostMouseMgr } = await import('../src/GhostMouseMgr.js');

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (name, fn) => {
  console.log(`--- ${name} ---`);
  try { fn(); } catch (e) { failed++; console.error(`  FAIL: section "${name}" threw — ${e.message}`); }
};

// A room session: what NetMgr gives the rest of the app, reduced to the part
// these managers touch. Each one owns its OWN avatar objects, which is the whole
// point — session 2's 'bob' is not reachable from session 1's registry.
function fakeSession(peers) {
  const heads = new Map();
  const hands = new Map();
  for (const id of peers) {
    heads.set(id, new THREE.Object3D());
    hands.set(`${id}:left`, new THREE.Object3D());
    hands.set(`${id}:right`, new THREE.Object3D());
  }
  return {
    avatars: {
      getHead: (id) => heads.get(id) || null,
      getHand: (id, which) => hands.get(`${id}:${which}`) || null,
    },
    head: (id) => heads.get(id) || null,
    hand: (id, which) => hands.get(`${id}:${which}`) || null,
  };
}

const localPads = () => {
  const pad = new THREE.Object3D();
  pad.visible = true;
  return { map: new Map([['gp-1', pad]]), pad };
};

// === A. The handle resolves late, every time ===============================

section('createLiveAvatars answers from the CURRENT session', () => {
  let net = null;
  const live = createLiveAvatars(() => net);

  // Identity comparisons, not eq(): these values are THREE Object3Ds, and
  // serialising one into a failure message buries the assertion in JSON.
  ok(live.getHead('alice') === null, 'no session → null, not a throw');
  ok(live.getHand('alice', 'left') === null, 'same for hands');

  const s1 = fakeSession(['alice']);
  net = s1;
  ok(live.getHead('alice') === s1.head('alice'), "the live session's head");
  ok(live.getHand('alice', 'right') === s1.hand('alice', 'right'), 'and the right hand, by name');
  ok(live.getHead('bob') === null, 'a peer who is not here is null');

  // Leave, then rejoin: a brand-new session object with brand-new avatars.
  net = null;
  ok(live.getHead('alice') === null, 'between sessions there is nothing to answer');
  const s2 = fakeSession(['bob']);
  net = s2;
  ok(live.getHead('bob') === s2.head('bob'), 'after a rejoin it answers from the NEW registry');
  ok(live.getHead('bob') !== s1.head('bob'), 'and never from the old one');
});

section('createLiveAvatars survives a half-built or hostile session', () => {
  eq(createLiveAvatars(() => ({}))?.getHead('a'), null, 'a net with no avatars yet → null');
  eq(createLiveAvatars(() => ({ avatars: {} })).getHead('a'), null, 'avatars without getHead → null');
  eq(createLiveAvatars(() => { throw new Error('mid-teardown'); }).getHead('a'), null,
    'a getNet that throws mid-teardown does not take the render loop with it');
  eq(createLiveAvatars(null).getHead('a'), null, 'no accessor at all → null');

  // The handle is deliberately narrow: a manager that starts using a third
  // AvatarMgr method must fail here rather than silently reach into a session
  // object it has no business holding.
  eq(Object.keys(createLiveAvatars(() => null)).sort(), ['getHand', 'getHead'],
    'it exposes exactly the two methods the ghost managers use');
});

section('NEGATIVE CONTROL: a by-value capture goes stale exactly as reported', () => {
  const s1 = fakeSession(['alice']);
  const stale = s1.avatars;                 // what the managers used to be handed
  const s2 = fakeSession(['bob']);
  eq(stale.getHead('bob'), null, "the old registry cannot see the new session's peer");
  ok(s2.avatars.getHead('bob') !== null, '…though that peer is right there in the live one');
});

// === B. The full leave/rejoin lifecycle, through the real manager ===========

section('a hold survives a rejoin: ghost attaches to the NEW session', () => {
  let net = null;
  const { map, pad } = localPads();
  const mgr = new GhostGamepadMgr({ avatars: createLiveAvatars(() => net), gamepadObjs: map });
  const scope = createSessionScope();
  scope.add(() => mgr.removeAll());

  // --- session 1: alice picks up our gamepad.
  const s1 = fakeSession(['alice']);
  net = s1;
  mgr.sync([{ objId: 'gp-1', holder: 'alice', hand: 'right' }]);
  ok(mgr.isRemotelyHeld('gp-1'), 'the hold is known');
  ok(pad.visible === false, 'our local pad is hidden while she holds it');
  eq(mgr.ghostCount, 1, 'and a ghost exists');
  // Read through a local so a MISSING ghost reports as a failed assertion rather
  // than a TypeError that takes the rest of the section with it — a crash is not
  // a test result (the same rule scripts/test-voice-recovery.mjs works under).
  const g1 = mgr._ghosts.get('gp-1');
  ok(!!g1 && g1.group.parent === s1.hand('alice', 'right'),
    "attached to alice's hand in session 1");

  // --- Leave. Ticks are detached (so sync() is never called again) and the
  // session scope runs.
  net = null;
  scope.run();
  ok(pad.visible === true, 'Leave gives us our gamepad back');
  eq(mgr.ghostCount, 0, 'and takes the ghost with it');
  eq(mgr.heldBy('gp-1'), null, 'nobody holds anything any more');

  // --- Rejoin: a different room, a different peer, a NEW AvatarMgr.
  const s2 = fakeSession(['bob']);
  net = s2;
  mgr.sync([{ objId: 'gp-1', holder: 'bob', hand: 'left' }]);
  eq(mgr.ghostCount, 1, 'the new session spawns its ghost');
  const g2 = mgr._ghosts.get('gp-1');
  ok(!!g2 && g2.group.parent === s2.hand('bob', 'left'),
    "attached to bob's hand in session 2 — the assertion the stale capture fails");
  ok(pad.visible === false, 'and our pad is hidden again, correctly');
});

section('NEGATIVE CONTROL: with avatars captured by value, the rejoin is silent', () => {
  const s1 = fakeSession(['alice']);
  const { map, pad } = localPads();
  // Exactly what main.js used to do: `new GhostGamepadMgr({ avatars: net.avatars })`.
  const mgr = new GhostGamepadMgr({ avatars: s1.avatars, gamepadObjs: map });
  mgr.sync([{ objId: 'gp-1', holder: 'alice', hand: 'right' }]);
  eq(mgr.ghostCount, 1, 'session 1 works — which is why this was never noticed');
  mgr.removeAll();

  const s2 = fakeSession(['bob']);
  mgr.sync([{ objId: 'gp-1', holder: 'bob', hand: 'left' }]);
  ok(mgr.isRemotelyHeld('gp-1'), 'the hold IS known after the rejoin…');
  eq(mgr.ghostCount, 0, '…but no ghost is ever created: the old registry has no bob');
  ok(pad.visible === false, 'so the pad is hidden by a holder nobody can see — the reported symptom');
  ok(s2.head('bob') !== null, 'sanity: bob really does have an avatar in the live session');
});

section('NEGATIVE CONTROL: leaving without the cleanup strands the pad hidden', () => {
  let net = null;
  const { map, pad } = localPads();
  const mgr = new GhostGamepadMgr({ avatars: createLiveAvatars(() => net), gamepadObjs: map });

  net = fakeSession(['alice']);
  mgr.sync([{ objId: 'gp-1', holder: 'alice', hand: 'right' }]);
  ok(pad.visible === false, 'hidden while held');

  // Leave WITHOUT running the scope. The ticks are detached, so nothing calls
  // sync() again — this models the post-Leave world exactly.
  net = null;
  ok(pad.visible === false, 'the pad is still hidden after Leave…');
  ok(mgr.isRemotelyHeld('gp-1'), '…still believed held by a peer from a room we have left');
  // …and it stays that way for the rest of the build: there is no other caller.
  eq(mgr.hiddenCount, 1, 'nothing in the system will ever unhide it');
});

section('the cleanup is idempotent and safe with nothing held', () => {
  let net = null;
  const { map, pad } = localPads();
  const mgr = new GhostGamepadMgr({ avatars: createLiveAvatars(() => net), gamepadObjs: map });
  const scope = createSessionScope();
  scope.add(() => mgr.removeAll());

  scope.run();
  ok(pad.visible === true, 'Leave from a session where nothing was held changes nothing');
  net = fakeSession(['alice']);
  mgr.sync([{ objId: 'gp-1', holder: 'alice', hand: 'right' }]);
  scope.run();
  scope.run();
  scope.run();
  ok(pad.visible === true, 'and running it three times is the same as running it once');
  eq(mgr.ghostCount, 0, 'no ghosts left');
});

// === C. The scope's own guarantees =========================================

section('one broken cleanup cannot strand the others', () => {
  const errors = [];
  const scope = createSessionScope({ onError: (e, i) => errors.push(`${i}:${e.message}`) });
  const ran = [];
  scope.add(() => ran.push('a'));
  scope.add(() => { throw new Error('manager in a bad state'); });
  scope.add(() => ran.push('c'));

  const completed = scope.run();
  eq(ran, ['a', 'c'], 'the cleanup AFTER the throwing one still ran');
  eq(completed, 2, 'and run() reports how many completed');
  eq(errors, ['1:manager in a bad state'], 'the failure is reported, not swallowed');

  // Repeatable: Leave happens more than once per build.
  ran.length = 0;
  scope.run();
  eq(ran, ['a', 'c'], 'a second Leave runs them again');
});

section('the scope ignores what is not a cleanup', () => {
  const scope = createSessionScope();
  eq(scope.add(null), false, 'null is refused');
  eq(scope.add('removeAll'), false, 'and so is a string');
  eq(scope.size(), 0, 'neither is registered');
  eq(scope.run(), 0, 'so running an empty scope does nothing at all');
});

section('every manager main.js registers a cleanup for actually has one', () => {
  // main.js's wiring calls removeAll() on these four. A manager that loses the
  // method would leave its props hidden after Leave with nothing to catch it —
  // the cleanup is registered as a closure, so the failure would be at runtime,
  // on Leave, in a headset.
  for (const [name, cls] of [
    ['GhostCartMgr', GhostCartMgr],
    ['GhostGamepadMgr', GhostGamepadMgr],
    ['GhostLightGunMgr', GhostLightGunMgr],
    ['GhostMouseMgr', GhostMouseMgr],
  ]) {
    ok(typeof cls.prototype.removeAll === 'function', `${name}.removeAll() exists`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
