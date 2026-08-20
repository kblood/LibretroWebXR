// COR-3: a cartridge boot is not atomic, so ROOM AUTHORITY has to be part of the
// boot transaction — not just a check at the door.
//
// THE BUG. main.js's loadCartridge() tests amRoomHost() once, on entry, and then
// awaits: a ROM fetch (a PS2 disc over a headset's Wi-Fi is seconds), a .cue
// resolution, BIOS/SaveRAM lookups, and finally the core's own start. If the
// server migrates the host away inside that window — the previous host's socket
// blipped past the reclaim window, or they hit Leave — the demoted peer:
//   • pauses its rack (the demotion handler does that much), but
//   • has no idea a boot is in flight. The only post-await checkpoints compared a
//     LOAD GENERATION, and no newer load exists, so both said "go";
//   • committed currentCore/currentMeta/console power, and then called
//     client.resume() — the RAW facade, which has no predicate, straight past the
//     M1.4 display-only gate that ConsoleRuntime.resume() applies.
// Result: a display-only watcher running its own authoritative-looking core
// behind the new host's video feed, with nothing left to re-pause it. That is
// exactly the "each computer runs its own game" divergence the gate exists to
// prevent, and it also started a video broadcast from a demoted peer.
//
// THE FIX, and what this suite pins: src/net/AuthorityEpoch.js — a counter bumped
// on every SETTLED host transition (and on Leave), captured when a boot starts and
// consulted after every await, plus routing the commit-time resume through the
// runtime's gate instead of the raw client.
//
// THE REGRESSION THAT FIX SHIPPED (2026-08-18), pinned in section B2/C below: the
// first cut treated EVERY epoch move as a loss. Leaving a room bumps too — so
// pressing Leave while a cart was still fetching abandoned that boot, and the user
// was left solo, allowed to run the core, staring at a status line stuck on
// `loading <title>…` with no game and no explanation. A Leave hands the machine
// back to US (mayRunLocalCore() is true afterwards), so the boot must FINISH
// locally, exactly as it did before COR-3. main.js therefore counts HANDOFFS —
// bumps where the room's authority passed to somebody else — alongside the epoch,
// and only a handoff (or an outright loss of the right to run a core) abandons.
//
// WHAT WOULD MAKE THIS SUITE WORTHLESS, and what is done about it:
//   • Testing the epoch alone would prove a counter counts. Section B replays the
//     real failure timeline against the real module and asserts on what the app
//     would have DONE (resume / publish tv / broadcast), with the pre-fix
//     behaviour as an explicit negative control so the scenario is shown to be
//     real rather than assumed.
//   • A simulation can drift from main.js, which is 8.6k lines of THREE + DOM and
//     cannot be imported here. Section C therefore pins the WIRING in the source:
//     where the bump sits relative to the election-pending early return, that the
//     three checkpoints exist, and that the echo-path resume goes through the
//     runtime. Those are the four things a well-meaning edit would undo.
//
// Pure logic: no THREE, no DOM, no sockets, no ports.
// Run: node scripts/test-authority-epoch.mjs   (also in `npm test`)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAuthorityEpoch } from '../src/net/AuthorityEpoch.js';

let passed = 0;
let failed = 0;
const stderr = console.error.bind(console);
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; stderr(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (name, fn) => {
  console.log(`--- ${name} ---`);
  return Promise.resolve()
    .then(fn)
    .catch((e) => { failed++; stderr(`  FAIL: section "${name}" threw — ${e.stack || e.message}`); });
};

// === A. the epoch itself ====================================================

await section('a guard holds while the authority does', () => {
  let host = true;
  const auth = createAuthorityEpoch({ isAuthoritative: () => host });
  const guard = auth.guard();
  ok(guard() === false, 'nothing happened → the boot may continue');
  ok(auth.epoch === 0, 'and capturing a guard does not itself count as a transition');

  auth.bump('demoted');
  ok(guard() === true, 'a settled role change abandons the boot that started before it');
  ok(auth.epoch === 1, 'the epoch moved exactly once');

  // Promotion → demotion → promotion inside one slow fetch lands back on the same
  // ROLE but must NOT resurrect the boot: the room had another host in between and
  // its state is no longer the one this boot was resolved against.
  const auth2 = createAuthorityEpoch({ isAuthoritative: () => true });
  const g2 = auth2.guard();
  auth2.bump('demoted');
  auth2.bump('promoted');
  ok(g2() === true, 'a round trip back to host still abandons — the epoch, not the role, is the identity');

  // …and a guard captured AFTER the transition is clean, which is what lets the
  // promotion branch replay a queued cartridge insert.
  ok(auth2.guard()() === false, 'a boot started after the transition is not tarred with it');
});

await section('the live role is part of the guard, not just the counter', () => {
  let host = true;
  const auth = createAuthorityEpoch({ isAuthoritative: () => host });
  const guard = auth.guard();
  host = false;                        // role lost without anyone bumping
  ok(guard() === true, 'a boot may not commit while we are not the authority, bump or no bump');
  host = true;
  ok(guard() === false, 'and is allowed again once the role is genuinely back');
});

await section('a throwing predicate fails CLOSED', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const auth = createAuthorityEpoch({ isAuthoritative: () => { throw new Error('net exploded'); } });
    ok(auth.guard()() === true, 'unlike runAllowed(), an unanswerable authority question refuses the boot');
  } finally { console.warn = warn; }
  // Rationale, so nobody "fixes" this into fail-open: the cost of a false refusal
  // is one un-booted cartridge (re-insert it); the cost of a false ACCEPT is two
  // live cores in one room.
});

await section('independent boots hold independent guards', () => {
  const auth = createAuthorityEpoch();
  const first = auth.guard();
  auth.bump('demoted');
  const second = auth.guard();
  ok(first() === true && second() === false,
     'the boot started before the transition is abandoned; the one started after is not');
});

await section('bump reports itself for the log, and a throwing observer cannot break a role change', () => {
  const seen = [];
  const auth = createAuthorityEpoch({ onBump: (epoch, reason) => seen.push([epoch, reason]) });
  auth.bump('promoted');
  auth.bump('leave');
  eq(seen, [[1, 'promoted'], [2, 'leave']], 'each settled transition is observable');

  const noisy = createAuthorityEpoch({ onBump: () => { throw new Error('logger down'); } });
  noisy.bump('demoted');
  ok(noisy.epoch === 1, 'a failing log call must never abort the demotion itself');
});

// === B. the failure timeline, replayed ======================================
//
// This mirrors loadCartridge()'s structure: entry gate, capture, await a ROM,
// checkpoint, await a boot, commit gate, then the echo block (resume + publish tv
// + start broadcast). It is a MODEL — section C is what keeps the model honest
// against the real function.
function runBoot({ auth, isHost, fetchRom, bootCore, guarded = true }) {
  const did = { fetched: false, booted: false, resumed: false, publishedTv: false, broadcast: false,
                abandonedAt: null, status: null, requeued: false };
  const run = async () => {
    if (!isHost()) { did.abandonedAt = 'entry'; return did; }
    did.status = 'loading';                   // setStatus(`loading ${meta.title}…`)
    const authorityLost = auth.guard();
    const abandoned = (where) => {
      if (guarded && authorityLost()) {
        did.abandonedAt = where;
        // main.js's logAbandon: an abandoned boot SAYS so and re-queues the cart.
        // Without this the status line keeps `loading …` forever and the abandon
        // is indistinguishable from a hang — the second half of the 2026-08-18
        // regression, and the half that made the first half impossible to debug.
        did.status = 'abandoned-explained';
        did.requeued = true;
        return true;
      }
      return false;
    };
    await fetchRom();
    did.fetched = true;
    if (abandoned('resolveRom')) return did;
    await bootCore();
    did.booted = true;
    if (abandoned('post-boot')) return did;
    did.resumed = true;                       // the M1.4-gated runtime resume
    did.publishedTv = true;
    did.broadcast = true;
    return did;
  };
  return run();
}

await section('an undisturbed host boot commits', async () => {
  const auth = createAuthorityEpoch({ isAuthoritative: () => true });
  const did = await runBoot({ auth, isHost: () => true, fetchRom: async () => {}, bootCore: async () => {} });
  ok(did.resumed && did.publishedTv && did.broadcast, 'the ordinary case still runs the game and tells the room');
  ok(did.abandonedAt === null, 'and nothing abandoned it');
});

await section('demotion during the ROM fetch abandons the boot', async () => {
  let host = true;
  const auth = createAuthorityEpoch({ isAuthoritative: () => host });
  const did = await runBoot({
    auth,
    isHost: () => host,
    // The server migrates the host away while the disc is still downloading.
    fetchRom: async () => { host = false; auth.bump('demoted'); },
    bootCore: async () => {},
  });
  eq(did.abandonedAt, 'resolveRom', 'it stops at the first checkpoint after the await');
  eq(did.status, 'abandoned-explained', 'the user is told why, instead of being left on "loading …"');
  ok(did.requeued, 'and the cart is queued for the replay a later promotion does');
  ok(did.booted === false, 'the core is never started on a peer that no longer hosts');
  ok(did.resumed === false, 'nothing resumes — the display-only gate is not bypassed');
  ok(did.publishedTv === false && did.broadcast === false,
     'and a demoted peer neither claims the TV nor starts streaming its canvas');
});

await section('demotion during the CORE START abandons at the commit gate', async () => {
  let host = true;
  const auth = createAuthorityEpoch({ isAuthoritative: () => host });
  const did = await runBoot({
    auth,
    isHost: () => host,
    fetchRom: async () => {},
    // Booting a core is the longest await of all — the migration lands inside it.
    bootCore: async () => { host = false; auth.bump('demoted'); },
  });
  eq(did.abandonedAt, 'post-boot', 'the commit gate catches what the earlier checkpoints could not');
  ok(did.resumed === false, 'the core it just booted stays paused (applyBudget re-asserts that in main.js)');
  ok(did.publishedTv === false, 'and none of the "this game is playing here" state is committed');
});

await section('NEGATIVE CONTROL: without the guard the same timeline commits', async () => {
  let host = true;
  const auth = createAuthorityEpoch({ isAuthoritative: () => host });
  const did = await runBoot({
    auth,
    isHost: () => host,
    fetchRom: async () => { host = false; auth.bump('demoted'); },
    bootCore: async () => {},
    guarded: false,                            // the pre-fix code path
  });
  ok(did.resumed && did.publishedTv && did.broadcast,
     'this is the shipped bug: a demoted watcher boots, resumes and broadcasts anyway');
});

await section('a momentary socket blip is NOT a demotion', async () => {
  // The most important non-regression here. A Wi-Fi hiccup on a headset does two
  // things to main.js: NetMgr._setHost(null) fires _applyHostRole with a null
  // hostId (which returns early and bumps nothing), and the reconnect's HOST
  // message fires it AGAIN with isHost true for the SAME host. If either of those
  // moved the epoch — or if the live predicate were amRoomHost(), which reads
  // false while the socket is down — picking a big ROM on a flaky link would
  // simply never boot. The latched display-only role stays false throughout,
  // because nobody ever told us somebody else hosts.
  let displayOnlyLatch = false;
  const auth = createAuthorityEpoch({ isAuthoritative: () => !displayOnlyLatch });
  const did = await runBoot({
    auth,
    isHost: () => true,
    fetchRom: async () => { /* socket drops and reconnects; no settled demotion */ },
    bootCore: async () => {},
  });
  ok(did.abandonedAt === null && did.resumed, 'the boot completes normally');
  ok(auth.epoch === 0, 'and the epoch never moved — a blip is not a transition');
});

// === B2. Leave is not a handoff =============================================
//
// main.js wraps the raw epoch in two helpers — bumpHostAuthority(reason,
// {handoff}) and captureBootAuthority() — because "the epoch moved" and "somebody
// else took the room" are different questions. This models that pair; section C
// pins that main.js really is built this way and that both boot paths use it.
function appAuthority({ mayRunLocalCore }) {
  const auth = createAuthorityEpoch({ isAuthoritative: mayRunLocalCore });
  let handoffs = 0;
  return {
    get epoch() { return auth.epoch; },
    bump(reason, { handoff = true } = {}) { if (handoff) handoffs += 1; auth.bump(reason); },
    guard() {
      const moved = auth.guard();
      const at = handoffs;
      return () => moved() && (handoffs !== at || !mayRunLocalCore());
    },
  };
}

await section('LEAVE during a slow fetch finishes the boot LOCALLY', async () => {
  // The regression, as the user hit it: host in a room, insert a PS2 disc, tap
  // Leave while it is still downloading. disconnectFromRoom() drops the
  // display-only latch and nulls `net`, so we are solo and may run a core — this
  // boot is now an ordinary local boot and has to complete.
  let solo = false;
  const auth = appAuthority({ mayRunLocalCore: () => true });
  const did = await runBoot({
    auth,
    isHost: () => true,
    fetchRom: async () => { auth.bump('leave', { handoff: false }); solo = true; },
    bootCore: async () => {},
  });
  ok(solo, 'the Leave really did land inside the fetch');
  ok(did.abandonedAt === null, 'leaving does not abandon the boot it interrupted');
  ok(did.booted && did.resumed, 'the game boots and runs on our own machine');
  ok(did.status !== 'abandoned-explained' && did.requeued === false,
     'and nothing is re-queued or apologised for — the boot simply happened');
  ok(auth.epoch === 1, 'the transition is still RECORDED — the stint ended, and the log says so');
  // The publish/broadcast flags are meaningless here: `net` is null after a Leave,
  // so main.js's `net?.setObjectState('tv', …)` / `net?.startVideoBroadcast()` are
  // no-ops. That — not the epoch bump — is what keeps a solo player from talking
  // to a room they have left, and it is why the old bump could not have been
  // preventing either of them.
});

await section('a DEMOTION still abandons, even though a Leave does not', async () => {
  // The distinction has to survive: same shape, same helper, opposite outcome.
  let mayRun = true;
  const auth = appAuthority({ mayRunLocalCore: () => mayRun });
  const did = await runBoot({
    auth,
    isHost: () => true,
    fetchRom: async () => { mayRun = false; auth.bump('demoted'); },   // handoff by default
    bootCore: async () => {},
  });
  eq(did.abandonedAt, 'resolveRom', 'the handoff abandons at the first checkpoint');
  ok(did.booted === false && did.resumed === false, 'and no core starts behind the new host');
});

await section('leave → rejoin as a WATCHER still abandons', async () => {
  // Leaving alone is safe; leaving and landing in a room somebody else hosts is
  // not, and the live "may I run a core?" half of the guard is what catches it —
  // the boot has nowhere legitimate to commit any more.
  let mayRun = true;
  const auth = appAuthority({ mayRunLocalCore: () => mayRun });
  const did = await runBoot({
    auth,
    isHost: () => true,
    fetchRom: async () => {
      auth.bump('leave', { handoff: false });
      mayRun = false; auth.bump('demoted');     // rejoined; somebody else hosts
    },
    bootCore: async () => {},
  });
  eq(did.abandonedAt, 'resolveRom', 'a non-handoff followed by a handoff is still a handoff');
});

await section('an UNLABELLED bump abandons — the default is fail-safe', () => {
  // A future transition added without thinking about handoffs must behave like a
  // demotion (abandon), never like a Leave (commit). Cheapest way to keep the new
  // {handoff:false} escape hatch from becoming the accidental default.
  const auth = appAuthority({ mayRunLocalCore: () => true });
  const guard = auth.guard();
  auth.bump('some-future-transition');
  ok(guard() === true, 'a bump that does not say otherwise counts as losing the room');
});

// === C. the app is actually wired to it =====================================
//
// main.js cannot be imported (THREE + DOM at module scope), so these read the
// source. Each one pins a specific way the fix could be undone by an edit that
// still looks reasonable in review.
// Normalised to LF: fnBody() below terminates a body on '\n}\n', and a Windows
// checkout (core.autocrlf=true, no .gitattributes) hands main.js over as CRLF,
// where that never matches. It does not throw — fnBody falls back to slice(start),
// so every body scan silently widened to the whole REST OF THE FILE and the
// section-C assertions stopped being scoped to the function they name. Same root
// cause that crashed scripts/test-boot-transaction.mjs outright.
const MAIN = readFileSync(fileURLToPath(new URL('../src/main.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
// Slice a top-level function body: from its header to the first line-start `}`.
const fnBody = (header) => {
  const start = MAIN.indexOf(header);
  if (start < 0) return '';
  const end = MAIN.indexOf('\n}\n', start);
  return end < 0 ? MAIN.slice(start) : MAIN.slice(start, end);
};

await section('main.js wires the authority epoch into the boot paths', () => {
  ok(/import \{ createAuthorityEpoch \} from '\.\/net\/AuthorityEpoch\.js'/.test(MAIN),
     'main.js imports the shared epoch rather than re-inventing a counter');

  const applyHostRole = fnBody('function _applyHostRole(');
  ok(applyHostRole.length > 0, '_applyHostRole was found');
  const pendingReturn = applyHostRole.indexOf('== null) {');
  const demotedBranch = applyHostRole.indexOf('\n  } else {');
  const bump = applyHostRole.indexOf('bumpHostAuthority(');
  ok(bump > 0, 'a host transition bumps the epoch');
  ok(pendingReturn > 0 && bump > pendingReturn,
     'the bump sits AFTER the election-pending early return — bumping on a hostId-null blip '
     + 'would abort a live host\'s legitimate boot, the opposite of the bug being fixed');
  ok(demotedBranch > 0 && bump > demotedBranch,
     'and inside the DEMOTED branch only: a Wi-Fi blip re-fires this handler with isHost true '
     + 'for the same host, so a bump in the promoted branch would abandon a live boot on every hiccup');

  ok(/bumpHostAuthority\('demoted', \{ handoff: true \}\)/.test(applyHostRole),
     'a demotion is a HANDOFF — the room went to another peer, so boots in flight are void');

  // The 2026-08-18 regression, pinned from both ends. Leaving still RECORDS the
  // end of the stint (the epoch is that stint's identity, and the log reads it
  // back), but it is explicitly not a handoff: we walk out to be solo, so the cart
  // still fetching finishes locally the way it did before COR-3.
  const disconnect = fnBody('function disconnectFromRoom(');
  ok(/bumpHostAuthority\('leave', \{ handoff: false \}\)/.test(disconnect),
     'leaving records the end of the hosting stint WITHOUT claiming somebody took the room');
  ok(!/hostAuthority\.bump\(/.test(disconnect),
     'and does not reach past the wrapper to the raw epoch — that bump abandoned the boot '
     + 'a user was waiting on, and stranded the status line on "loading …"');

  const capture = fnBody('function captureBootAuthority(');
  ok(capture.length > 0, 'captureBootAuthority was found');
  ok(/_authorityHandoffs/.test(capture) && /mayRunLocalCore\(\)/.test(capture),
     'a boot is abandoned only when the room CHANGED HANDS or we may no longer run a core — '
     + 'not merely because the epoch moved');

  const loadCartridge = fnBody('async function loadCartridge(');
  ok(loadCartridge.length > 0, 'loadCartridge was found');
  ok(/captureBootAuthority\(\)/.test(loadCartridge) && !/hostAuthority\.guard\(\)/.test(loadCartridge),
     'loadCartridge captures through the handoff-aware helper, not the raw epoch guard');
  // Three: after the ROM resolve, before the boot, and the commit gate after it.
  const checkpoints = (loadCartridge.match(/abandonReason\(\)/g) || []).length;
  ok(checkpoints >= 3,
     `loadCartridge re-checks after every await (found ${checkpoints} checkpoints, want 3)`);

  ok(/captureBootAuthority\(\)/.test(fnBody('async function loadCartridgeIntoConsole(')),
     'the secondary-console boot path captures it too');
});

await section('an abandoned boot explains itself instead of hanging on "loading …"', () => {
  // Both boot paths open with setStatus(`loading <title>…`). Every abandon is a
  // silent `return` past that, so unless the abandon repaints the line the user
  // sees a permanent "loading" and no game — which is precisely how the Leave
  // regression presented, and why it read as a hang rather than a decision.
  const loadCartridge = fnBody('async function loadCartridge(');
  const logAbandon = loadCartridge.slice(loadCartridge.indexOf('const logAbandon ='),
                                         loadCartridge.indexOf("logger?.event?.('boot-attempt'"));
  ok(logAbandon.length > 0, 'the abandon path was found');
  ok(/setStatus\(/.test(logAbandon), 'it repaints the status line rather than leaving "loading …"');
  ok(/_pendingInsertMeta = \{ \.\.\.meta \}/.test(logAbandon),
     'and re-queues the cart, because the demotion that abandoned us already consumed '
     + '_pendingInsertMeta — otherwise a later promotion has nothing to replay');
  ok(/if \(reason === 'newer-load'\) return;/.test(logAbandon),
     'except for a superseded load: the NEWER boot owns the status line, and describing '
     + 'the older game over it would be a lie');

  const intoConsole = fnBody('async function loadCartridgeIntoConsole(');
  const intoAbandon = intoConsole.slice(intoConsole.indexOf("where: 'loadCartridgeIntoConsole/pre-boot'"));
  ok(/setStatus\(/.test(intoAbandon.slice(0, intoAbandon.indexOf('return;'))),
     'the secondary-console abandon says so too');
});

await section("the echo-path resume goes through the runtime's display-only gate", () => {
  const loadCartridge = fnBody('async function loadCartridge(');
  const echo = loadCartridge.slice(loadCartridge.indexOf('if (echo) {'));
  ok(echo.length > 0, 'the echo block was found');
  ok(/rackMgr\.get\(CONSOLE_ID\)/.test(echo),
     'the commit-time resume asks the RACK for the primary runtime');
  ok(/gatedPrimary\.resume\(\)/.test(echo),
     'and resumes through it — ConsoleRuntime.resume() consults runAllowed() and re-asserts the '
     + 'pause when running is forbidden, which the raw client facade cannot do');
  ok(!/^\s*client\.resume\(\);\s*$/m.test(echo),
     'the raw, ungated client.resume() is not the unconditional path any more');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
