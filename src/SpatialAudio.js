// Reroute each libretro core's audio through its OWN THREE.PositionalAudio so
// every console in the rack sounds like it comes from its own TV, and only the
// console the user is attending to is audible (focus-mute) — without which N
// live cores would blast over each other.
//
// Libretro Emscripten cores (SDL2/OpenAL ports) instantiate their own
// AudioContext, build a ScriptProcessor/AudioWorklet chain, and connect it to
// ctx.destination. There's no public hook to redirect that output. Quest also
// limits how many real AudioContexts you can have, so we can't give each core a
// real context.
//
// Trick: before any core loads, replace window.AudioContext with a stub. Each
// `new AudioContext()` a core makes returns a Proxy around the SINGLE shared
// context (the AudioListener's), but with `.destination` remapped to a FRESH
// per-core GainNode → a FRESH PositionalAudio. So one real context fans out into
// N spatial branches: scriptNode → branch.sink → panner → listener.destination.
//
// The caller labels each branch by calling expect(consoleId, sourceObject)
// immediately before booting that console's core; setFocus(consoleId) then
// drives the gains (focused = audible, others = muted).
//
// Install AFTER SceneMgr creates its AudioListener, BEFORE any core is fetched.

import * as THREE from 'three';

export function installSpatialAudio({ listener, defaultSource, refDistance = 1.6, rolloffFactor = 1.4, maxDistance = 18 }) {
  const ctx = listener.context;
  const branches = [];            // { consoleId, sink, positional, sourceObject }
  const byConsole = new Map();    // consoleId -> branch
  let pending = null;             // { consoleId, sourceObject } for the next core
  let focusedId = null;
  // M1.4: the host's incoming game audio while we're a display-only client
  // ({ stream, src, sink, positional }) — see attachRemoteAudio below.
  let remoteAudio = null;
  // Consoles explicitly powered off (see [[src/main.js]] setConsolePower). A
  // single-console room never calls setFocus (updateFocus no-ops below 2 TVs),
  // so without this a powered-off solo console's audio only stops if its core
  // actually honours pauseMainLoop — this makes silence unconditional.
  const poweredOff = new Set();

  function gainFor(consoleId) {
    if (poweredOff.has(consoleId)) return 0;
    return (focusedId == null || consoleId === focusedId) ? 1 : 0;
  }
  function applyGains() {
    for (const b of branches) b.sink.gain.value = gainFor(b.consoleId);
  }

  function makeBranch(sourceObject, consoleId) {
    const sink = ctx.createGain();
    const positional = new THREE.PositionalAudio(listener);
    positional.setRefDistance(refDistance);
    positional.setRolloffFactor(rolloffFactor);
    positional.setDistanceModel('inverse');
    positional.setMaxDistance(maxDistance);
    (sourceObject || listener).add(positional);
    positional.setNodeSource(sink);
    const branch = { consoleId, sink, positional, sourceObject, nextAudioTime: 0 };
    branches.push(branch);
    if (consoleId != null) byConsole.set(consoleId, branch);
    sink.gain.value = gainFor(consoleId);
    return branch;
  }

  function makeProxy() {
    // First unlabelled core is the primary console0; later ones use whatever the
    // caller set via expect() just before booting them.
    const target = pending
      || { consoleId: branches.length === 0 ? 'console0' : `audio${branches.length}`, sourceObject: defaultSource };
    pending = null;
    const branch = makeBranch(target.sourceObject, target.consoleId);
    return new Proxy(ctx, {
      get(t, prop) {
        if (prop === 'destination') return branch.sink;
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  }

  const RealAC = window.AudioContext || window.webkitAudioContext;
  function StubAudioContext() { return makeProxy(); }
  StubAudioContext.prototype = RealAC.prototype;
  window.AudioContext = StubAudioContext;
  if ('webkitAudioContext' in window) window.webkitAudioContext = StubAudioContext;

  const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
  // Tear down the client-side host-audio graph (see attachRemoteAudio below).
  function detachRemote() {
    if (!remoteAudio) return;
    try { remoteAudio.src.disconnect(); } catch (_) {}
    try { remoteAudio.sink.disconnect(); } catch (_) {}
    try { remoteAudio.positional.parent?.remove(remoteAudio.positional); } catch (_) {}
    remoteAudio = null;
  }
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);

  return {
    // Label the NEXT core's audio branch (call right before booting it).
    expect(consoleId, sourceObject) { pending = { consoleId, sourceObject }; },
    // Directly register (or return the existing) branch for `consoleId` without
    // going through the AudioContext-stub trick above — that trick only ever
    // fires for a same-thread `new AudioContext()` call, which worker-execution
    // cores (PSX/N64 — see src/runtime/EmulatorWorkerRuntime.js's pushAudio)
    // never make: they run off the main thread and push decoded PCM straight
    // into pushSamples() instead. Without a branch pushSamples() silently
    // no-ops forever, so this is the missing half of wiring worker audio (B3,
    // 2026-07-25 review). Consumes a matching `pending` set by an `expect()`
    // call made just before booting (the established per-boot pattern every
    // call site already follows), so it labels the branch identically to the
    // AudioContext-trick path; falls back to `sourceObject`/defaultSource if
    // no matching `pending` is queued. Idempotent per console.
    ensureBranch(consoleId, sourceObject) {
      const existing = byConsole.get(consoleId);
      if (existing) return existing;
      const target = sourceObject ?? (pending?.consoleId === consoleId ? pending.sourceObject : defaultSource);
      if (pending?.consoleId === consoleId) pending = null;
      return makeBranch(target, consoleId);
    },
    // Make only `consoleId` audible; mute the rest. null → unmute all.
    setFocus(consoleId) {
      focusedId = consoleId;
      applyGains();
    },
    // Force a console's branch silent independent of focus (power switch).
    setPower(consoleId, on) {
      if (on) poweredOff.delete(consoleId); else poweredOff.add(consoleId);
      applyGains();
    },
    focusedId: () => focusedId,
    // Feed decoded PCM straight into a console's branch — for cores that run
    // off the main thread (e.g. the PSX worker runtime) and so can't rely on
    // the AudioContext-stub trick above, which only intercepts a same-thread
    // `new AudioContext()` call.
    pushSamples(consoleId, { samples, format = 'f32', channels = 2, sampleRate = 48000 } = {}) {
      const branch = byConsole.get(consoleId);
      if (!branch || !(samples instanceof ArrayBuffer) || !Number.isInteger(channels) || channels < 1) return;
      const source = format === 's16' ? new Int16Array(samples) : new Float32Array(samples);
      const frameCount = Math.floor(source.length / channels);
      if (!frameCount) return;
      const buffer = ctx.createBuffer(channels, frameCount, sampleRate);
      for (let channel = 0; channel < channels; channel++) {
        const output = buffer.getChannelData(channel);
        for (let frame = 0; frame < frameCount; frame++) {
          const sample = source[frame * channels + channel];
          output[frame] = format === 's16' ? sample / 32768 : sample;
        }
      }
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(branch.sink);
      const now = ctx.currentTime;
      if (branch.nextAudioTime < now || branch.nextAudioTime > now + 0.25) branch.nextAudioTime = now + 0.02;
      node.start(branch.nextAudioTime);
      branch.nextAudioTime += buffer.duration;
      node.onended = () => node.disconnect();
    },

    // --- M1.4 netplay audio -------------------------------------------------
    //
    // HOST side: tap a console's audio branch as a MediaStream so the host→client
    // WebRTC stream can carry the GAME SOUND. canvas.captureStream() is video
    // only, so before this a watching client saw the host's game in complete
    // silence. The tap sits after the branch's focus/power gain, i.e. a client
    // hears exactly what the host hears (a muted/unfocused console streams
    // silence, which is the honest behaviour).
    captureStream(consoleId) {
      const branch = byConsole.get(consoleId);
      if (!branch || typeof ctx.createMediaStreamDestination !== 'function') return null;
      if (!branch.netTap) {
        try {
          branch.netTap = ctx.createMediaStreamDestination();
          branch.sink.connect(branch.netTap);
        } catch (e) {
          console.warn('[audio] netplay capture failed:', e);
          branch.netTap = null;
          return null;
        }
      }
      resume();
      return branch.netTap?.stream ?? null;
    },

    // CLIENT side: play the host's incoming audio track through OUR graph,
    // positioned on the TV showing the stream. Deliberately not the <video>
    // element's own audio: an unmuted element can be paused outright by the
    // autoplay policy, which would freeze the VIDEO TEXTURE too. The AudioContext
    // is already user-gesture resumed, so this always sounds.
    attachRemoteAudio(stream, sourceObject) {
      if (!stream || !(stream.getAudioTracks?.().length)) return false;
      if (remoteAudio && remoteAudio.stream === stream) return true;
      detachRemote();
      try {
        const src = ctx.createMediaStreamSource(stream);
        const sink = ctx.createGain();
        src.connect(sink);
        const positional = new THREE.PositionalAudio(listener);
        positional.setRefDistance(refDistance);
        positional.setRolloffFactor(rolloffFactor);
        positional.setDistanceModel('inverse');
        positional.setMaxDistance(maxDistance);
        (sourceObject || defaultSource || listener).add(positional);
        positional.setNodeSource(sink);
        remoteAudio = { stream, src, sink, positional };
        resume();
        return true;
      } catch (e) {
        console.warn('[audio] remote audio attach failed:', e);
        remoteAudio = null;
        return false;
      }
    },

    detachRemoteAudio: () => detachRemote(),
    hasRemoteAudio: () => !!remoteAudio,

    branches,
    context: ctx,
  };
}
