// DesktopAudio — the flat-screen build's audio plumbing. Three-free by design
// (desktop.html imports none of the three.js stack), so this is the desktop
// counterpart of [[src/SpatialAudio.js]] with the spatial half removed: one shared
// AudioContext, one mixer node, and two things hanging off it that the desktop page
// could not do before:
//
//   1. captureStream() — a MediaStream carrying the GAME AUDIO, so the host's
//      WebRTC broadcast is not silent. canvas.captureStream() is video-only, so a
//      joined client used to watch a completely mute picture.
//   2. pushSamples() — a sink for worker-execution cores (dosbox_pure,
//      mednafen_psx_hw, mupen64plus_next). Those run off the main thread and emit
//      decoded PCM as an 'audio' event instead of ever calling `new AudioContext()`,
//      and desktop.html had nothing listening: they were silent even locally.
//
// It also plays the HOST's incoming audio for a client (attachRemote). Deliberately
// through this graph rather than by unmuting the <video> element: an unmuted element
// can be paused outright by the autoplay policy, which would stop the picture too.
//
// The AudioContext-stub trick is the same one SpatialAudio documents at length:
// libretro Emscripten cores build their own graph and connect it to
// ctx.destination with no hook to redirect it, so we hand them a Proxy whose
// `destination` is OUR mixer. install() must therefore run BEFORE any core loads.
//
// The one piece of SpatialAudio it DOES share is the deinterleave loop
// (src/runtime/audioFrames.js) — a leaf module with no THREE in it, so the
// three-free promise above still holds.

import { deinterleaveInto } from '../runtime/audioFrames.js';

/**
 * Install the desktop audio graph. Returns a handle; safe to call once at module
 * scope. Every method is a no-op (returning null/false) when WebAudio is missing.
 */
export function installDesktopAudio() {
  const RealAC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  if (!RealAC) {
    return {
      captureStream: () => null, pushSamples: () => false,
      attachRemote: () => false, detachRemote: () => {}, hasRemote: () => false,
      resume: () => {}, context: () => null,
    };
  }

  let ctx = null;
  let mixer = null;        // everything local goes through here → destination (+ tap)
  let netTap = null;       // MediaStreamAudioDestinationNode for the host broadcast
  let remote = null;       // { stream, src } while playing a host's incoming audio
  let nextAudioTime = 0;   // scheduling cursor for pushSamples

  function ensure() {
    if (ctx) return ctx;
    ctx = new RealAC();
    mixer = ctx.createGain();
    mixer.connect(ctx.destination);
    return ctx;
  }

  function resume() {
    if (!ctx) return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  // Cores call `new AudioContext()`; hand them the shared one with `.destination`
  // remapped to the mixer so their output is both audible AND capturable.
  function StubAudioContext() {
    const c = ensure();
    return new Proxy(c, {
      get(t, prop) {
        if (prop === 'destination') return mixer;
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  }
  StubAudioContext.prototype = RealAC.prototype;
  window.AudioContext = StubAudioContext;
  if ('webkitAudioContext' in window) window.webkitAudioContext = StubAudioContext;

  // Autoplay policy: a context created before any gesture starts suspended.
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);

  return {
    /** MediaStream of everything the local core is playing (for the host's WebRTC
     *  broadcast), or null if WebAudio can't provide one. */
    captureStream() {
      ensure();
      if (typeof ctx.createMediaStreamDestination !== 'function') return null;
      if (!netTap) {
        try {
          netTap = ctx.createMediaStreamDestination();
          mixer.connect(netTap);
        } catch (e) {
          console.warn('[desktop-audio] capture tap failed:', e);
          netTap = null;
          return null;
        }
      }
      resume();
      return netTap.stream;
    },

    /** Feed one worker-core 'audio' event ({samples, format, channels, sampleRate}).
     *  Mirrors SpatialAudio.pushSamples, minus the per-console branch. */
    pushSamples({ samples, format = 'f32', channels = 2, sampleRate = 48000 } = {}) {
      if (!(samples instanceof ArrayBuffer) || !Number.isInteger(channels) || channels < 1) return false;
      ensure();
      const source = format === 's16' ? new Int16Array(samples) : new Float32Array(samples);
      const frames = Math.floor(source.length / channels);
      if (!frames) return false;
      const buffer = ctx.createBuffer(channels, frames, sampleRate);
      // Was a verbatim copy of SpatialAudio's nested loop, string compare in the
      // innermost iteration included (PERF-3). One shared implementation now, so
      // a fix to one sink can't miss the other.
      deinterleaveInto(buffer, source, format, channels, frames);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(mixer);
      const now = ctx.currentTime;
      // Re-anchor on underrun or an absurd lead (a paused/backgrounded core).
      if (nextAudioTime < now || nextAudioTime > now + 0.25) nextAudioTime = now + 0.02;
      node.start(nextAudioTime);
      nextAudioTime += buffer.duration;
      node.onended = () => node.disconnect();
      return true;
    },

    /** CLIENT side: play the host's incoming audio track. Straight to destination,
     *  NOT through the mixer — it must never be re-broadcast if we later host. */
    attachRemote(stream) {
      if (!stream || !(stream.getAudioTracks?.().length)) return false;
      if (remote && remote.stream === stream) return true;
      this.detachRemote();
      try {
        ensure();
        const src = ctx.createMediaStreamSource(stream);
        src.connect(ctx.destination);
        remote = { stream, src };
        resume();
        return true;
      } catch (e) {
        console.warn('[desktop-audio] remote attach failed:', e);
        remote = null;
        return false;
      }
    },

    detachRemote() {
      if (!remote) return;
      try { remote.src.disconnect(); } catch (_) {}
      remote = null;
    },

    hasRemote: () => !!remote,
    resume,
    context: () => ctx,
  };
}
