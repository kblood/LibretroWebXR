// DesktopGamepad — physical PC gamepad → emulator, for the FLAT-SCREEN build.
//
// Polls navigator.getGamepads() each frame (hooked into the scene tick loop in
// [[src/main.js]]) and, for every gamepad button/axis the user has BOUND in the
// [[src/Bindings.js]] map, dispatches the bound RetroPad button's CANONICAL
// code(s) via [[src/EmulatorClient.js]] sendInput — the same translate-don't-
// passthrough rule as the keyboard path ([[src/InputMgr.js]]).
//
// This is the DESKTOP gamepad reader and is kept strictly separate from the VR
// [[src/GameInputMgr.js]], which polls the XR controllers' inputSource.gamepad.
// We ONLY poll while NOT presenting (renderer.xr.isPresenting === false) — the
// exact gate [[src/DesktopControls.js]] uses — so entering a headset makes this
// inert and the two gamepad readers never fight.
//
// Edge detection: a button/axis is mapped to a HELD boolean; we emit a keydown
// only on the press edge and a keyup only on the release edge, so a held button
// doesn't re-fire keydown every frame.

import { padSig } from './Bindings.js';
import { KEY_PAYLOADS } from './Bindings.js';

const AXIS_THRESHOLD = 0.5;   // past this magnitude an axis counts as pressed

export class DesktopGamepad {
  // renderer: THREE.WebGLRenderer (for the !xr.isPresenting gate)
  // client:   EmulatorClient (sendInput)
  // bindings: the SHARED Bindings instance (same one InputMgr + the UI use)
  constructor({ renderer, client, bindings }) {
    this.renderer = renderer;
    this.client = client;
    this.bindings = bindings;
    // signature -> bool  (previous-frame pressed state, for edge detection)
    this._held = new Map();
  }

  // Per-frame poll. Cheap no-op when presenting or when the Gamepad API is
  // unavailable. Bound buttons/axes that transition emit canonical key events.
  tick() {
    if (this.renderer?.xr?.isPresenting) { this._releaseAll(); return; }
    const pads = (typeof navigator !== 'undefined' && navigator.getGamepads)
      ? navigator.getGamepads() : null;
    if (!pads) return;

    // Compute the current pressed-set across every connected gamepad for each
    // bound signature, then diff against last frame.
    const now = new Map();   // sig -> pressed?
    for (const gp of pads) {
      if (!gp) continue;
      // Buttons
      if (gp.buttons) {
        for (let i = 0; i < gp.buttons.length; i++) {
          const sig = `b:${i}`;
          if (!this.bindings.byPad.has(sig)) continue;
          if (this._buttonPressed(gp.buttons[i])) now.set(sig, true);
        }
      }
      // Axes (each axis yields two directional signatures: -1 and +1)
      if (gp.axes) {
        for (let i = 0; i < gp.axes.length; i++) {
          const v = gp.axes[i] || 0;
          const negSig = `a:${i}:-1`, posSig = `a:${i}:1`;
          if (this.bindings.byPad.has(negSig) && v <= -AXIS_THRESHOLD) now.set(negSig, true);
          if (this.bindings.byPad.has(posSig) && v >= AXIS_THRESHOLD) now.set(posSig, true);
        }
      }
    }

    // Press edges (in `now`, not previously held) → keydown.
    for (const sig of now.keys()) {
      if (!this._held.get(sig)) { this._emit(sig, 'keydown'); this._held.set(sig, true); }
    }
    // Release edges (previously held, not in `now`) → keyup.
    for (const [sig, was] of this._held) {
      if (was && !now.get(sig)) { this._emit(sig, 'keyup'); this._held.set(sig, false); }
    }
  }

  _buttonPressed(btn) {
    if (btn == null) return false;
    if (typeof btn === 'object') return !!btn.pressed || (btn.value || 0) >= AXIS_THRESHOLD;
    return btn >= AXIS_THRESHOLD;
  }

  // Dispatch a bound signature's canonical core code(s) as eventType.
  _emit(sig, eventType) {
    for (const hit of this.bindings.lookupPad(sig)) {
      for (const code of hit.codes) {
        const p = KEY_PAYLOADS[code];
        this.client.sendInput(eventType, code, p?.key ?? code, p?.keyCode, p?.location);
      }
    }
  }

  // Send keyup for everything currently held (used when we go inert on entering
  // VR, so a button held at the moment of transition doesn't latch in the core).
  _releaseAll() {
    for (const [sig, was] of this._held) {
      if (was) { this._emit(sig, 'keyup'); this._held.set(sig, false); }
    }
  }

  // --- headless / debug hook ---
  // navigator.getGamepads() can't be driven with a real pad in a headless test,
  // so expose a thin entry to inject a synthetic snapshot and poll it once.
  // pads: array shaped like the Gamepad API ({ buttons:[{pressed,value}], axes:[] }).
  debugApi() {
    return {
      // Stub navigator.getGamepads to return `pads` and run one poll tick.
      pollWith: (pads) => {
        const orig = navigator.getGamepads;
        navigator.getGamepads = () => pads;
        try { this.tick(); } finally { navigator.getGamepads = orig; }
      },
      held: () => Array.from(this._held.entries()).filter(([, v]) => v).map(([k]) => k),
      // Clear edge-detection state (for deterministic tests / between sub-cases).
      clear: () => this._held.clear(),
      sig: padSig,
    };
  }
}
