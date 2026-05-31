// Reroute the libretro core's audio through a THREE.PositionalAudio so it
// falls off with distance and pans relative to the TV mesh.
//
// Libretro Emscripten cores (and SDL2/OpenAL ports in general) instantiate
// their own AudioContext, build a ScriptProcessorNode or AudioWorkletNode
// chain, and connect it directly to ctx.destination. There's no public hook
// to redirect that output.
//
// Trick: before the core loads, we replace window.AudioContext with a stub
// that returns a Proxy around a single shared context (the one owned by our
// THREE.AudioListener). The proxy delegates everything to the real context
// except .destination, which it remaps to a GainNode we control. That
// GainNode is then fed into PositionalAudio.setNodeSource, so the core's
// output ends up: scriptNode → spatialSink → panner → listener.destination.
//
// This must run AFTER SceneMgr creates its AudioListener but BEFORE any
// core script is fetched.

import * as THREE from 'three';

export function installSpatialAudio({ listener, sourceObject, refDistance = 1.6, rolloffFactor = 1.4, maxDistance = 18 }) {
  const ctx = listener.context;
  const spatialSink = ctx.createGain();

  const proxiedCtx = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'destination') return spatialSink;
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  // Replace the global so the core's `new AudioContext()` reuses ours.
  // Keep the prototype so `instanceof AudioContext` still holds.
  const RealAC = window.AudioContext || window.webkitAudioContext;
  function StubAudioContext() { return proxiedCtx; }
  StubAudioContext.prototype = RealAC.prototype;
  window.AudioContext = StubAudioContext;
  if ('webkitAudioContext' in window) window.webkitAudioContext = StubAudioContext;

  const positional = new THREE.PositionalAudio(listener);
  positional.setRefDistance(refDistance);
  positional.setRolloffFactor(rolloffFactor);
  positional.setDistanceModel('inverse');
  positional.setMaxDistance(maxDistance);
  sourceObject.add(positional);
  positional.setNodeSource(spatialSink);

  // AudioContext starts suspended until a user gesture. Clicking Enter VR,
  // grabbing a controller trigger, or any DOM click satisfies that.
  const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);

  return { positional, spatialSink, context: ctx };
}
