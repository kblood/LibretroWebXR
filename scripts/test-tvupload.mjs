// PERF-1 (CODEX_REVIEW): a TV must upload its source canvas to the GPU only when
// the producer has actually drawn a new frame. Before this, SceneMgr flipped
// needsUpdate on every active TV on every XR frame — 72-90 uploads a second per
// screen, for a picture that changes 50-60 times a second at best and NEVER when
// the console is paused (which, on a rack, most of them are).
//
// Pure logic: THREE runs headless here, and TV needs no DOM — the "canvas" is any
// object identity, since nothing in this path reads pixels.
//
// WHAT WOULD MAKE THIS TEST WORTHLESS, and what is done about it:
//   • Asserting only that skips happen. A gate that skips EVERYTHING passes that
//     and freezes every screen in the room. So every skip assertion is paired
//     with the frame that must still upload (the first one, the one after the
//     mark moves, the one after a re-route).
//   • Asserting through the counters alone. They are bookkeeping we added; the
//     load-bearing state is texture.needsUpdate, which is what THREE actually
//     reads. Assertions go through the texture, and the counters are checked
//     against it rather than instead of it.
//   • Negative controls re-run the same scenario with the gating neutralised and
//     require the old, wasteful outcome.
//
// Run: node scripts/test-tvupload.mjs   (also in `npm test`, via run-tests.mjs)

import { TV, frameMarkOf, PAUSED_MARK } from '../src/TV.js';

let passed = 0;
let failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (name, fn) => {
  console.log(`--- ${name} ---`);
  try { fn(); } catch (e) { failed++; console.error(`  FAIL: section "${name}" threw — ${e.message}`); }
};

// A canvas stand-in. TV only ever holds the reference and hands it to
// THREE.CanvasTexture, which stores it as .image without touching it.
const canvasLike = (id) => ({ id, width: 320, height: 240 });

// Drive one render frame the way SceneMgr._render does, and report what THREE
// would actually see.
//
// NOT `texture.needsUpdate`: that property is WRITE-ONLY on THREE's Texture (a
// setter with no getter — reading it yields undefined, which is falsy, so a test
// written against it reports "never uploaded" for every case including the
// unchanged one, and would have "passed" a gate that uploads nothing). The real
// observable, and the one the renderer compares against its uploaded copy, is
// `texture.version`, which the setter increments. So an upload is a version bump.
const renderFrame = (tv) => {
  const before = tv.texture ? tv.texture.version : -1;
  const requested = tv.markNeedsUpdate();
  const uploaded = tv.texture ? tv.texture.version > before : false;
  return { requested, uploaded };
};
const uploadsOver = (tv, n) => {
  let count = 0;
  for (let i = 0; i < n; i++) if (renderFrame(tv).uploaded) count++;
  return count;
};

// === A. The mark policy ====================================================

section('frameMarkOf reports what each kind of producer can be known to do', () => {
  eq(frameMarkOf(null), null, 'no client at all → unknown');
  eq(frameMarkOf({ paused: true }), PAUSED_MARK, 'a paused client cannot produce a new frame');
  eq(frameMarkOf({ paused: false }), null, "a running core we can't observe → unknown, not a guess");
  eq(frameMarkOf({ paused: false, frameBridge: { framesPresented: 0 } }), 0,
    'a worker-hosted core that has presented nothing yet marks 0, not "falsy so unknown"');
  eq(frameMarkOf({ paused: false, frameBridge: { framesPresented: 41 } }), 41, 'and its counter otherwise');
  eq(frameMarkOf({ paused: true, frameBridge: { framesPresented: 41 } }), PAUSED_MARK,
    'paused wins over the counter — the last frame is already on the GPU');
  // The distinction the whole design rests on: "unknown" must never be a value
  // that could compare equal to itself frame after frame.
  ok(frameMarkOf({ paused: false }) == null, 'unknown is null/undefined, never a constant like 0 or ""');
});

// === B. Gating: uploads follow the mark, not the frame rate =================

section('a TV with no frame signal uploads every frame (unchanged behaviour)', () => {
  const tv = new TV({ id: 'tv0', source: canvasLike('c0') });
  eq(uploadsOver(tv, 10), 10, 'ten render frames, ten uploads');
  eq(tv.uploadStats(), { id: 'tv0', uploads: 10, skipped: 0 }, 'and the counters agree with the texture');
});

section('a paused console uploads once, then nothing', () => {
  const tv = new TV({ id: 'tv0', source: canvasLike('c0') });
  const client = { paused: true };
  tv.setFrameSignal(() => frameMarkOf(client));

  ok(renderFrame(tv).uploaded, 'the first frame still uploads — the GPU may not have this picture yet');
  eq(uploadsOver(tv, 60), 0, 'the next sixty do not: a paused picture cannot change');
  eq(tv.uploadStats().skipped, 60, 'and every one of them is counted as a skip');

  // Un-pausing must bring the screen straight back. This is the assertion that
  // stops "skip everything" from passing.
  client.paused = false;
  client.frameBridge = { framesPresented: 1 };
  ok(renderFrame(tv).uploaded, 'resuming uploads again on the very next frame');
});

section('a running console uploads once per PRODUCED frame, not once per rendered frame', () => {
  const tv = new TV({ id: 'tv0', source: canvasLike('c0') });
  const client = { paused: false, frameBridge: { framesPresented: 0 } };
  tv.setFrameSignal(() => frameMarkOf(client));

  // 90 Hz headset, 60 Hz console: two rendered frames out of three carry nothing
  // new. Model it exactly — a new emulator frame every third render frame.
  let uploads = 0;
  for (let i = 0; i < 90; i++) {
    if (i % 3 === 0) client.frameBridge.framesPresented++;
    if (renderFrame(tv).uploaded) uploads++;
  }
  eq(uploads, 30, 'one upload per produced frame');
  eq(tv.uploadStats().skipped, 60, 'the other sixty are skipped');
  eq(tv.uploadStats().uploads, uploads, "the counter matches the texture's own version history");
});

section('NEGATIVE CONTROL: without the gate the same run uploads on every frame', () => {
  const tv = new TV({ id: 'tv0', source: canvasLike('c0') });
  const client = { paused: false, frameBridge: { framesPresented: 0 } };
  tv.setFrameSignal(() => frameMarkOf(client));
  // Restore the pre-PERF-1 body at the one point that changed.
  tv.markNeedsUpdate = function () { this.texture.needsUpdate = true; return true; };

  let uploads = 0;
  for (let i = 0; i < 90; i++) {
    if (i % 3 === 0) client.frameBridge.framesPresented++;
    if (renderFrame(tv).uploaded) uploads++;
  }
  eq(uploads, 90, 'ninety render frames, ninety uploads — three times the work for the same picture');
});

// === C. The ways this could freeze a screen ================================

section('a re-route always uploads, even if the new source is at a mark we have seen', () => {
  const tv = new TV({ id: 'tv0', source: canvasLike('c0') });
  const a = { paused: false, frameBridge: { framesPresented: 7 } };
  const b = { paused: false, frameBridge: { framesPresented: 7 } };   // same number, different console
  tv.setFrameSignal(() => frameMarkOf(a));
  ok(renderFrame(tv).uploaded, 'console A is on screen');
  eq(uploadsOver(tv, 5), 0, 'and idles there');

  // Patch console B onto this TV. Its counter happens to read 7 too; if the mark
  // were compared across producers the screen would stay frozen on A's picture.
  tv.setSource(canvasLike('c1'));
  tv.setFrameSignal(() => frameMarkOf(b));
  ok(renderFrame(tv).uploaded, "the new console's first frame reaches the GPU");
});

section('clearing the signal returns to unconditional uploads', () => {
  const tv = new TV({ id: 'tv0', source: canvasLike('c0') });
  const client = { paused: true };
  tv.setFrameSignal(() => frameMarkOf(client));
  renderFrame(tv);
  eq(uploadsOver(tv, 5), 0, 'gated while paused');
  tv.setFrameSignal(null);
  eq(uploadsOver(tv, 5), 5, 'and unconditional once the signal is dropped (the idle-screen path)');
});

section('a signal that throws degrades to uploading, and does not take the render loop down', () => {
  const tv = new TV({ id: 'tv0', source: canvasLike('c0') });
  tv.setFrameSignal(() => { throw new Error('runtime torn down mid-frame'); });
  let threw = false;
  let uploads = 0;
  try { for (let i = 0; i < 5; i++) if (renderFrame(tv).uploaded) uploads++; } catch (_) { threw = true; }
  ok(!threw, 'markNeedsUpdate swallows it (one broken TV must not blank the whole room)');
  eq(uploads, 5, 'and falls back to the safe behaviour: upload every frame');
});

section('setActive(false) still wins over everything', () => {
  const tv = new TV({ id: 'tv0', source: canvasLike('c0') });
  const client = { paused: false, frameBridge: { framesPresented: 0 } };
  tv.setFrameSignal(() => frameMarkOf(client));
  tv.setActive(false);
  client.frameBridge.framesPresented++;
  eq(uploadsOver(tv, 5), 0, 'an inactive TV uploads nothing however busy its producer is');
  tv.setActive(true);
  ok(renderFrame(tv).uploaded, 'and picks straight back up when reactivated');
});

section('a video source is left entirely alone (VideoTexture self-updates)', () => {
  const tv = new TV({ id: 'tv0', source: canvasLike('c0') });
  const client = { paused: true };
  tv.setFrameSignal(() => frameMarkOf(client));
  tv.setVideo({ id: 'host-video' });        // a watching client's host feed
  eq(uploadsOver(tv, 5), 0, 'markNeedsUpdate touches nothing on a video screen');
  ok(tv.sourceCanvas === null, 'sanity: it really is on the video path');
  ok(tv._frameSignal === null, "and the previous console's signal is gone with it");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
