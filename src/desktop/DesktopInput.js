// DesktopInput — keyboard + physical-gamepad → logical RetroPad buttons for the
// FLAT-SCREEN desktop build. It is deliberately role-agnostic: it captures the
// local player's intent as a stream of logical button transitions
// (onButton(btn, down)) and lets the caller decide what to do with them —
//   • host / solo: drive the local core as player 1 (dispatchToCore)
//   • joined client: forward as player 2 over the room socket
// so the same capture works regardless of whether you're hosting or joined.
//
// Translate-don't-passthrough: a captured logical button is dispatched to the
// core via its CANONICAL codes ([[src/Bindings.js]] canonicalCodes — the same
// rule the VR [[src/GameInputMgr.js]] uses), NOT the physical key the user hit.
// That keeps player 1 and player 2 on the keycodes retroarch.cfg binds, so a
// remote player 2's input lands on console port 2 (see [[src/RetroArchConfig.js]]).

import { canonicalCodes, KEY_PAYLOADS } from '../Bindings.js';
import { EXTRA_KEY_DEFS } from '../ControllerMaps.js';

// Union payload table: player-1 codes (KEY_PAYLOADS) + players 2-4 codes
// (EXTRA_KEY_DEFS). sendInput needs {key, keyCode, location} alongside the code.
const ALL_PAYLOADS = { ...KEY_PAYLOADS, ...EXTRA_KEY_DEFS };

// Physical keyboard → logical RetroPad button for the local desktop player.
// Arrows = D-pad; a SNES-style face cluster (Z=B, X=A, A=Y, S=X); Q/W = L/R;
// Enter = Start; Shift = Select. WASD is intentionally NOT a movement layer here
// (this is a flat emulator page, not the VR room), so A/S double as face buttons.
const KEYMAP = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  KeyX: 'A', KeyZ: 'B', KeyS: 'X', KeyA: 'Y',
  KeyQ: 'L', KeyW: 'R',
  Enter: 'Start', ShiftRight: 'Select', ShiftLeft: 'Select',
};

// Keys we never swallow, even in raw-keyboard mode: browser chrome the user
// needs to keep working (reload, devtools, fullscreen, tab switching). Ctrl/Alt/
// Meta chords are excluded wholesale in _onKey for the same reason — Ctrl+Alt+Del
// style combos are exactly what a DOS user does NOT want intercepted by a web page.
const RESERVED_KEYS = new Set([
  'F5', 'F6', 'F11', 'F12', 'Escape',
]);

// True if the event originated in a text field / contenteditable, i.e. the user
// is typing into page chrome (the nick or room box) rather than playing. Without
// this, raw-keyboard mode would make those inputs untypable — every keystroke
// would be preventDefault'd and shipped to the core instead. It also fixes the
// pre-existing mapped-mode version of the same bug: Arrow/Enter/Shift in the room
// box were being preventDefault'd out from under the caret.
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

const AXIS_THRESHOLD = 0.5;

// Standard-gamepad button index → logical RetroPad button. Layout follows the
// W3C Standard Gamepad mapping; the face cluster is laid out SNES-style (bottom
// = B, right = A, left = Y, top = X) to match the keyboard.
const PAD_BUTTONS = {
  0: 'B', 1: 'A', 2: 'Y', 3: 'X',
  4: 'L', 5: 'R', 6: 'L2', 7: 'R2',
  8: 'Select', 9: 'Start',
  12: 'Up', 13: 'Down', 14: 'Left', 15: 'Right',
};

/**
 * Dispatch one logical button transition to a core for `player` (1-4) via its
 * canonical codes. Used for local player-1 input and host-side injection of a
 * remote player's input — both feed the same EmulatorClient.sendInput path.
 */
export function dispatchToCore(client, player, btn, down) {
  if (!client) return;
  for (const code of canonicalCodes(player, btn)) {
    const p = ALL_PAYLOADS[code];
    if (!p) continue;
    client.sendInput(down ? 'keydown' : 'keyup', p.code, p.key, p.keyCode, p.location);
  }
}

export class DesktopInput {
  /**
   * @param {object} opts
   * @param {(btn:string, down:boolean)=>void} opts.onButton  logical transition sink
   * @param {(e:KeyboardEvent, down:boolean)=>void} [opts.onRawKey]  raw-key sink
   *        (only called while raw-keyboard mode is on — see setRawKeyboard)
   * @param {EventTarget} [opts.keyTarget=window]             where to bind key listeners
   */
  constructor({ onButton, onRawKey = null, keyTarget = window } = {}) {
    this.onButton = onButton || (() => {});
    this.onRawKey = onRawKey || (() => {});
    this.keyTarget = keyTarget;
    this.enabled = true;
    // Raw-keyboard mode: forward the PHYSICAL key to the core verbatim instead of
    // translating it through KEYMAP. Computer-class systems (DOS, Amiga, C64 —
    // SYSTEMS[sys].keyboard) are unusable without it: you cannot type `DIR` or
    // `C:\GAME\SETUP` when Enter means Start and A means the Y button. Console
    // systems keep the mapped path, where a fixed pad layout is the whole point.
    // Gamepads are unaffected either way — a physical controller still drives the
    // RetroPad in both modes.
    this.rawKeyboard = false;
    this._rawHeld = new Map();   // code -> {code,key,keyCode,location} held in raw mode
    // Edge-detection state: logical button -> held? (separate maps so a button
    // held on BOTH keyboard and pad doesn't double-fire / early-release).
    this._keyHeld = new Map();   // btn -> bool
    this._padHeld = new Map();   // btn -> bool
    this._down = new Set();      // currently-emitted-down logical buttons (union)

    this._onKeyDown = (e) => this._onKey(e, true);
    this._onKeyUp = (e) => this._onKey(e, false);
    this.keyTarget.addEventListener('keydown', this._onKeyDown);
    this.keyTarget.addEventListener('keyup', this._onKeyUp);
  }

  // Recompute the union of keyboard + pad held sets and emit transitions.
  _reconcile() {
    const union = new Set();
    for (const [btn, v] of this._keyHeld) if (v) union.add(btn);
    for (const [btn, v] of this._padHeld) if (v) union.add(btn);
    // Press edges
    for (const btn of union) {
      if (!this._down.has(btn)) { this._down.add(btn); this.onButton(btn, true); }
    }
    // Release edges
    for (const btn of [...this._down]) {
      if (!union.has(btn)) { this._down.delete(btn); this.onButton(btn, false); }
    }
  }

  _onKey(e, down) {
    // Never intercept while the user is typing into page chrome (nick/room box).
    if (isTypingTarget(e.target)) return;

    if (this.rawKeyboard) {
      // Leave browser chrome and modifier chords alone; everything else is the
      // emulated machine's keyboard.
      if (RESERVED_KEYS.has(e.code) || e.ctrlKey || e.altKey || e.metaKey) return;
      // Auto-repeat is noise: the core latches a key down until its keyup, so a
      // repeat stream would just re-assert a state it already holds.
      if (down && e.repeat) return;
      e.preventDefault();
      if (!this.enabled) return;
      // Keep the full payload, not just the code: releaseAll has to synthesise a
      // faithful keyup later, and a keyup with keyCode 0 is not the same event.
      if (down) this._rawHeld.set(e.code, { code: e.code, key: e.key, keyCode: e.keyCode, location: e.location });
      else this._rawHeld.delete(e.code);
      this.onRawKey(e, down);
      return;
    }

    const btn = KEYMAP[e.code];
    if (!btn) return;
    // Stop arrows/Enter/Shift from scrolling or activating page chrome while the
    // emulator has focus.
    if (down) e.preventDefault();
    if (!this.enabled) return;
    this._keyHeld.set(btn, down);
    this._reconcile();
  }

  /**
   * Turn raw-keyboard passthrough on/off (see the `rawKeyboard` field). Flipping
   * it releases whatever the OUTGOING mode was holding, so a key held across the
   * switch can't latch in a mode that will never emit its keyup.
   */
  setRawKeyboard(on) {
    const next = !!on;
    if (next === this.rawKeyboard) return;
    this.releaseAll();
    this.rawKeyboard = next;
  }

  // Per-frame physical-gamepad poll (call from the rAF tick). Cheap no-op when
  // the Gamepad API is unavailable or nothing is connected.
  pollGamepads() {
    if (!this.enabled) return;
    const pads = (typeof navigator !== 'undefined' && navigator.getGamepads)
      ? navigator.getGamepads() : null;
    if (!pads) return;
    const now = new Map(); // btn -> true
    for (const gp of pads) {
      if (!gp) continue;
      if (gp.buttons) {
        for (const [idx, btn] of Object.entries(PAD_BUTTONS)) {
          const b = gp.buttons[idx];
          if (b && (b.pressed || (b.value || 0) >= AXIS_THRESHOLD)) now.set(btn, true);
        }
      }
      if (gp.axes) {
        const [lx = 0, ly = 0] = gp.axes;
        if (ly <= -AXIS_THRESHOLD) now.set('Up', true);
        if (ly >= AXIS_THRESHOLD) now.set('Down', true);
        if (lx <= -AXIS_THRESHOLD) now.set('Left', true);
        if (lx >= AXIS_THRESHOLD) now.set('Right', true);
      }
    }
    // Replace the pad-held map with this frame's snapshot, then reconcile.
    this._padHeld = now;
    this._reconcile();
  }

  // Release everything currently held (e.g. on role change or disconnect) so a
  // held button doesn't latch. Emits keyup transitions through onButton.
  releaseAll() {
    // Raw-held physical keys have no logical-button representation, so they need
    // their own explicit keyup sweep — _reconcile below only covers KEYMAP/pad.
    if (this._rawHeld.size) {
      for (const payload of [...this._rawHeld.values()]) this.onRawKey(payload, false);
      this._rawHeld.clear();
    }
    this._keyHeld.clear();
    this._padHeld.clear();
    this._reconcile();
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.releaseAll();
  }

  dispose() {
    this.keyTarget.removeEventListener('keydown', this._onKeyDown);
    this.keyTarget.removeEventListener('keyup', this._onKeyUp);
    this.releaseAll();
  }
}
