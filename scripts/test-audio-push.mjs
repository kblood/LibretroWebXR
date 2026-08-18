// Unit tests for the worker-core PCM deinterleave ([[src/runtime/audioFrames.js]]),
// the shared inner loop of SpatialAudio.pushSamples and DesktopAudio.pushSamples.
// Pure logic only — no WebAudio / no THREE / no DOM.
//
// Why this is worth a suite of its own: getting a deinterleave wrong does not
// throw, it just makes the PSX/N64/DOS cores sound wrong (swapped channels, half
// speed, clicks) — and there is no headless probe that would notice. Every case
// below is checked against a REFERENCE implementation of the loop this replaced,
// so "faster" can never quietly become "different". The s16 scale in particular
// must divide by 32768 in exactly one place.

import { deinterleaveInto } from '../src/runtime/audioFrames.js';

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

// A stand-in for an AudioBuffer: only getChannelData is used.
const fakeBuffer = (channels, frames) => {
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  return { data, getChannelData: (ch) => data[ch] };
};

// The loop as it was before PERF-3 — format compare inside the innermost
// iteration, index by multiply. The thing we must stay bit-identical to.
const reference = (buffer, source, format, channels, frames) => {
  for (let ch = 0; ch < channels; ch++) {
    const out = buffer.getChannelData(ch);
    for (let f = 0; f < frames; f++) {
      const v = source[f * channels + ch];
      out[f] = format === 's16' ? v / 32768 : v;
    }
  }
};

const sameAsReference = (source, format, channels, label) => {
  const frames = Math.floor(source.length / channels);
  const got = fakeBuffer(channels, frames);
  const want = fakeBuffer(channels, frames);
  deinterleaveInto(got, source, format, channels, frames);
  reference(want, source, format, channels, frames);
  for (let ch = 0; ch < channels; ch++) {
    const a = got.data[ch], b = want.data[ch];
    for (let f = 0; f < frames; f++) {
      if (a[f] !== b[f]) {
        ok(false, `${label}: channel ${ch} frame ${f} → ${a[f]}, reference says ${b[f]}`);
        return;
      }
    }
  }
  ok(true, label);
};

// ---------------------------------------------------------------------------
// 1. Channel layout — the sample a channel gets must be the one it had
// ---------------------------------------------------------------------------
console.log('--- channel layout');
{
  // L/R alternate, so a swapped or off-by-one stride is immediately visible.
  const stereo = Float32Array.from([-1, 1, -0.5, 0.5, -0.25, 0.25]);
  const buf = fakeBuffer(2, 3);
  deinterleaveInto(buf, stereo, 'f32', 2, 3);
  ok(Array.from(buf.data[0]).join() === '-1,-0.5,-0.25', 'left channel takes the even samples');
  ok(Array.from(buf.data[1]).join() === '1,0.5,0.25', 'right channel takes the odd samples');

  // Mono is not interleaved at all (the fast path) — it must still be a copy,
  // not a reference to the source.
  const mono = Float32Array.from([0.1, 0.2, 0.3]);
  const mbuf = fakeBuffer(1, 3);
  deinterleaveInto(mbuf, mono, 'f32', 1, 3);
  // Compared against the source itself, not decimal literals: both sides are
  // float32, so 0.1 is 0.10000000149… in each.
  ok(mbuf.data[0].every((v, i) => v === mono[i]), 'mono copies straight across');
  mono[0] = 9;
  ok(mbuf.data[0][0] !== 9, 'mono copied the samples, it did not alias the source');

  // More than stereo (a core could hand us quad) must still stride correctly.
  const quad = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const qbuf = fakeBuffer(4, 2);
  deinterleaveInto(qbuf, quad, 'f32', 4, 2);
  ok(Array.from(qbuf.data[2]).join() === '3,7', '4-channel stride picks the right samples');
}

// ---------------------------------------------------------------------------
// 2. s16 scaling — one division by 32768, and only on the s16 path
// ---------------------------------------------------------------------------
console.log('--- s16 scaling');
{
  const src = Int16Array.from([32767, -32768, 16384, -16384]);
  const buf = fakeBuffer(2, 2);
  deinterleaveInto(buf, src, 's16', 2, 2);
  ok(buf.data[0][0] === 32767 / 32768, 's16 positive full scale');
  ok(buf.data[1][0] === -1, 's16 negative full scale is exactly -1');
  ok(buf.data[0][1] === 0.5, 's16 half scale');
  ok(buf.data[1][1] === -0.5, 's16 negative half scale');

  const mono = Int16Array.from([32768 / 2, -8192]);
  const mbuf = fakeBuffer(1, 2);
  deinterleaveInto(mbuf, mono, 's16', 1, 2);
  ok(mbuf.data[0][0] === 0.5 && mbuf.data[0][1] === -0.25, 's16 mono is scaled too (not raw)');

  // f32 samples are already normalised — scaling them would be silence.
  const f = Float32Array.from([0.5, -0.5]);
  const fbuf = fakeBuffer(2, 1);
  deinterleaveInto(fbuf, f, 'f32', 2, 1);
  ok(fbuf.data[0][0] === 0.5 && fbuf.data[1][0] === -0.5, 'f32 samples pass through unscaled');
}

// ---------------------------------------------------------------------------
// 3. Bit-identical to the loop it replaced
// ---------------------------------------------------------------------------
console.log('--- matches the pre-PERF-3 reference loop');
{
  const rand = (n, f) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * f));
  sameAsReference(rand(1600 * 2, 0.01), 'f32', 2, 'stereo f32, one 60 Hz batch');
  sameAsReference(rand(801, 0.03), 'f32', 1, 'mono f32, odd length');
  sameAsReference(Int16Array.from({ length: 1600 * 2 }, (_, i) => ((i * 7919) % 65536) - 32768), 's16', 2,
    'stereo s16, one 60 Hz batch');
  sameAsReference(Int16Array.from({ length: 600 }, (_, i) => i - 300), 's16', 1, 'mono s16');
  sameAsReference(rand(240, 0.02), 'f32', 4, '4-channel f32');
  // A batch whose length is not a whole number of frames: the callers floor the
  // frame count, so the trailing partial frame is ignored — not read past.
  const ragged = Float32Array.from([1, 2, 3, 4, 5]);
  const rbuf = fakeBuffer(2, 2);
  deinterleaveInto(rbuf, ragged, 'f32', 2, 2);
  ok(Array.from(rbuf.data[0]).join() === '1,3' && Array.from(rbuf.data[1]).join() === '2,4',
    'a ragged batch stops at the last whole frame');
  // Empty batch: nothing written, nothing thrown.
  const ebuf = fakeBuffer(2, 0);
  deinterleaveInto(ebuf, new Float32Array(0), 'f32', 2, 0);
  ok(ebuf.data[0].length === 0, 'an empty batch is a no-op');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
