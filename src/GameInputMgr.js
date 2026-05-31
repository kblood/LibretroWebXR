// GameInputMgr: per-frame poll of every Quest controller's
// inputSource.gamepad, mapping to libretro RetroPad keys via
// [[src/ControllerMaps.js]].
//
// **Both hands forward input** when ANY controller holds the gamepad
// mesh. The hand currently holding gets the "holding" map; the other
// gets the "free" map. This is the only way SNES-class games are
// playable in VR — pressing B + Y + moving the d-pad simultaneously
// requires more fingers than one hand has.
//
// Each logical RetroPad button is double-dispatched (cfg key + RA stock
// key) so behaviour doesn't depend on whether retroarch.cfg loaded.
//
// onKeyDown callback fires when a key transitions to pressed — main.js
// uses it to pulse the console LED so the user can see input is reaching
// the emulator without leaving the headset.

import { RETROPAD_KEYS, mapForSystem } from './ControllerMaps.js';

const STICK_THRESHOLD = 0.55;

// Static metadata for the codes we ever dispatch. Used both to build the
// KeyboardEvent payloads and as a closed set for the released-key sweep.
const KEY_TABLE = {
  ArrowUp:    { code: 'ArrowUp',    key: 'ArrowUp',    keyCode: 38 },
  ArrowDown:  { code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40 },
  ArrowLeft:  { code: 'ArrowLeft',  key: 'ArrowLeft',  keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  Enter:      { code: 'Enter',      key: 'Enter',      keyCode: 13 },
  Space:      { code: 'Space',      key: ' ',          keyCode: 32 },
  ShiftRight: { code: 'ShiftRight', key: 'Shift',      keyCode: 16, location: 2 },
  KeyH:       { code: 'KeyH',       key: 'h',          keyCode: 72 },
  KeyG:       { code: 'KeyG',       key: 'g',          keyCode: 71 },
  KeyX:       { code: 'KeyX',       key: 'x',          keyCode: 88 },
  KeyZ:       { code: 'KeyZ',       key: 'z',          keyCode: 90 },
  KeyY:       { code: 'KeyY',       key: 'y',          keyCode: 89 },
  KeyT:       { code: 'KeyT',       key: 't',          keyCode: 84 },
  KeyS:       { code: 'KeyS',       key: 's',          keyCode: 83 },
  KeyA:       { code: 'KeyA',       key: 'a',          keyCode: 65 },
  KeyE:       { code: 'KeyE',       key: 'e',          keyCode: 69 },
  KeyQ:       { code: 'KeyQ',       key: 'q',          keyCode: 81 },
  KeyP:       { code: 'KeyP',       key: 'p',          keyCode: 80 },
  KeyW:       { code: 'KeyW',       key: 'w',          keyCode: 87 },
  KeyR:       { code: 'KeyR',       key: 'r',          keyCode: 82 },
  KeyO:       { code: 'KeyO',       key: 'o',          keyCode: 79 },
};

export class GameInputMgr {
  constructor({ controllers, client, isControllerHoldingGamepad, isGamepadHeld, onKeyDown }) {
    this.controllers = controllers;
    this.client = client;
    this.isControllerHoldingGamepad = isControllerHoldingGamepad;
    this.isGamepadHeld = isGamepadHeld;
    this.onKeyDown = onKeyDown || (() => {});
    this._state = new Map(); // code -> boolean (currently pressed)
    this._systemMap = mapForSystem('default');
    this._system = 'default';
  }

  setSystem(system) {
    this._system = system || 'default';
    this._systemMap = mapForSystem(this._system);
  }

  currentSystem() { return this._system; }
  currentMap()    { return this._systemMap; }

  tick() {
    const desired = new Set();
    const addRetro = (btn) => {
      const codes = RETROPAD_KEYS[btn];
      if (!codes) return;
      for (const c of codes) desired.add(c);
    };

    if (this.isGamepadHeld()) {
      const map = this._systemMap;
      for (const ctrl of this.controllers) {
        const handMap = this.isControllerHoldingGamepad(ctrl) ? map.holding : map.free;
        const gp = ctrl.userData.inputSource?.gamepad;
        if (!gp || !gp.buttons || !gp.axes) continue;

        if (gp.buttons[0]?.pressed) addRetro(handMap.trigger);
        if (gp.buttons[3]?.pressed) addRetro(handMap.stickClick);
        if (gp.buttons[4]?.pressed) addRetro(handMap.faceA);
        if (gp.buttons[5]?.pressed) addRetro(handMap.faceB);

        const sx = gp.axes[2] || 0;
        const sy = gp.axes[3] || 0;
        if (sy <= -STICK_THRESHOLD) addRetro('Up');
        if (sy >=  STICK_THRESHOLD) addRetro('Down');
        if (sx <= -STICK_THRESHOLD) addRetro('Left');
        if (sx >=  STICK_THRESHOLD) addRetro('Right');
      }
    }

    // Emit keydown for newly-pressed codes.
    for (const code of desired) {
      if (this._state.get(code)) continue;
      this._state.set(code, true);
      const m = KEY_TABLE[code];
      if (!m) continue;
      this.client.sendInput('keydown', m.code, m.key, m.keyCode, m.location);
      this.onKeyDown(m.code);
    }
    // Emit keyup for codes that were pressed and no longer are.
    for (const [code, was] of this._state) {
      if (!was || desired.has(code)) continue;
      this._state.set(code, false);
      const m = KEY_TABLE[code];
      if (!m) continue;
      this.client.sendInput('keyup', m.code, m.key, m.keyCode, m.location);
    }
  }

  // Release every currently-pressed key. Called when the gamepad is
  // dropped so a held-down button doesn't latch on the emulator side.
  flushReleases() {
    for (const [code, was] of this._state) {
      if (!was) continue;
      this._state.set(code, false);
      const m = KEY_TABLE[code];
      if (!m) continue;
      this.client.sendInput('keyup', m.code, m.key, m.keyCode, m.location);
    }
  }

  // Per-controller debug snapshot for [[src/DebugHud.js]] and the
  // gamepad mesh's animation. Returns { holdingHand, freeHand } where
  // each is { handedness, buttons[], axes[], pressedKeys[], handMap } or
  // null. handMap lets the HUD label each button with the action it
  // currently fires (e.g. "B (jump)").
  getDebugState() {
    if (!this.isGamepadHeld()) return null;
    const map = this._systemMap;
    const snap = (ctrl) => {
      const gp = ctrl.userData.inputSource?.gamepad;
      const buttons = [];
      const axes = [];
      if (gp?.buttons) for (let i = 0; i < gp.buttons.length; i++) {
        const b = gp.buttons[i];
        buttons.push({ pressed: !!b?.pressed, value: typeof b?.value === 'number' ? b.value : 0 });
      }
      if (gp?.axes) for (let i = 0; i < gp.axes.length; i++) axes.push(gp.axes[i] ?? 0);
      return { handedness: ctrl.userData.handedness || '?', buttons, axes };
    };
    let holding = null;
    let free = null;
    for (const ctrl of this.controllers) {
      const s = snap(ctrl);
      if (this.isControllerHoldingGamepad(ctrl)) {
        s.handMap = map.holding;
        holding = s;
      } else {
        s.handMap = map.free;
        free = s;
      }
    }
    const pressedKeys = [];
    for (const [code, was] of this._state) if (was) pressedKeys.push(code);
    return { system: this._system, holding, free, pressedKeys };
  }
}
