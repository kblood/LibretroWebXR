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

  function makeBranch(sourceObject, consoleId) {
    const sink = ctx.createGain();
    const positional = new THREE.PositionalAudio(listener);
    positional.setRefDistance(refDistance);
    positional.setRolloffFactor(rolloffFactor);
    positional.setDistanceModel('inverse');
    positional.setMaxDistance(maxDistance);
    (sourceObject || listener).add(positional);
    positional.setNodeSource(sink);
    const branch = { consoleId, sink, positional, sourceObject };
    branches.push(branch);
    if (consoleId != null) byConsole.set(consoleId, branch);
    // New branch starts audible only if it's the focused console (or none set).
    sink.gain.value = (focusedId == null || consoleId === focusedId) ? 1 : 0;
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
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);

  return {
    // Label the NEXT core's audio branch (call right before booting it).
    expect(consoleId, sourceObject) { pending = { consoleId, sourceObject }; },
    // Make only `consoleId` audible; mute the rest. null → unmute all.
    setFocus(consoleId) {
      focusedId = consoleId;
      for (const b of branches) {
        b.sink.gain.value = (consoleId == null || b.consoleId === consoleId) ? 1 : 0;
      }
    },
    focusedId: () => focusedId,
    branches,
    context: ctx,
  };
}
