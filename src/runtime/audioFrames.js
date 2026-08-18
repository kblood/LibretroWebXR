// Deinterleave one batch of PCM from a worker-execution core into an AudioBuffer.
//
// Worker cores (PSX/N64/DOS) can't reach the page's AudioContext, so they post
// INTERLEAVED samples ([[src/runtime/EmulatorWorkerRuntime.js]]'s pushAudio) and
// the page thread splits them per channel. Both sinks did that with the same
// nested loop and a `format === 's16'` string compare INSIDE the inner
// iteration — ~96,000 string compares a second at 48 kHz stereo/60 Hz, on the XR
// render thread ([[src/SpatialAudio.js]] and [[src/desktop/DesktopAudio.js]],
// which were verbatim copies of each other). Hoisting the branch out and walking
// the source with a stride instead of a multiply costs nothing and removes both.
//
// It lives here, next to the worker that produces the samples, because the two
// callers must not import each other: SpatialAudio pulls in THREE, and the
// desktop build deliberately does not.
//
// This is the honest scope of PERF-3. The rest of that finding — moving the
// deinterleave into the worker so the interleave/deinterleave round trip
// disappears — was measured at roughly 0.01-0.02 ms per 72 Hz frame for the ONE
// worker console the rack budget can ever have live, and it would change the
// worker↔page audio message shape. Not worth risking silent worker-core audio
// for; see the counters on each audio branch for the drift that IS worth
// watching.

/**
 * @param {{getChannelData(ch:number):Float32Array}} buffer  destination AudioBuffer.
 * @param {Float32Array|Int16Array} source  interleaved samples.
 * @param {'f32'|'s16'} format
 * @param {number} channels
 * @param {number} frameCount  samples per channel (source.length / channels).
 */
export function deinterleaveInto(buffer, source, format, channels, frameCount) {
  const s16 = format === 's16';
  // Mono is not interleaved at all: copy (or scale) straight across.
  if (channels === 1) {
    const out = buffer.getChannelData(0);
    if (s16) for (let f = 0; f < frameCount; f++) out[f] = source[f] / 32768;
    else out.set(source.subarray(0, frameCount));
    return;
  }
  for (let ch = 0; ch < channels; ch++) {
    const out = buffer.getChannelData(ch);
    // `i` strides by `channels` instead of recomputing f * channels + ch.
    if (s16) for (let f = 0, i = ch; f < frameCount; f++, i += channels) out[f] = source[i] / 32768;
    else for (let f = 0, i = ch; f < frameCount; f++, i += channels) out[f] = source[i];
  }
}
