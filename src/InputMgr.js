// Keyboard → emulator key events.
//
// SNES default keybinds, matching webretro's defaults in base.js:
//   Arrow keys = D-pad, Enter = Start, Space = Select,
//   H = A, G = B, Y = X, T = Y, E = L, P = R
//
// In webretro's worker, fakeKey() takes { code, key }. We pass DOM
// KeyboardEvent.code/key through unchanged — RetroArch's web input driver
// maps from these.

import { EXTRA_PLAYER_KEYS } from './ControllerMaps.js';

// Player-1 keyboard codes (webretro cfg defaults). Exported so the test suite
// can assert players 2-4 ([[src/ControllerMaps.js]] EXTRA_PLAYER_KEYS) never
// collide with them.
export const DEFAULT_BIND_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Enter', 'Space',
  'KeyH', 'KeyG', 'KeyY', 'KeyT',
  'KeyE', 'KeyP', 'KeyR', 'KeyO',
]);

// Forward set = player 1 + the local-multiplayer players 2-4 keyboard codes.
// retroarch.cfg binds those P2-4 keys ([[src/RetroArchConfig.js]]), so once we
// forward a trusted keypress the core drives the right player. This is the
// same-keyboard couch-co-op path; VR controllers route through GameInputMgr.
const FORWARD_CODES = new Set(DEFAULT_BIND_CODES);
for (const p of [2, 3, 4]) {
  for (const code of Object.values(EXTRA_PLAYER_KEYS[p])) FORWARD_CODES.add(code);
}

export class InputMgr {
  constructor(client) {
    this.client = client;
    this._onDown = (e) => this._handle(e, 'keydown');
    this._onUp = (e) => this._handle(e, 'keyup');
  }

  attach(target = window) {
    target.addEventListener('keydown', this._onDown);
    target.addEventListener('keyup', this._onUp);
    this._target = target;
  }

  detach() {
    if (!this._target) return;
    this._target.removeEventListener('keydown', this._onDown);
    this._target.removeEventListener('keyup', this._onUp);
    this._target = null;
  }

  _handle(e, eventType) {
    // Only forward real user keystrokes. Our own synthetic events from
    // GameInputMgr → EmulatorClient.sendInput share the same window target,
    // and re-forwarding them here would loop infinitely.
    if (!e.isTrusted) return;
    if (!FORWARD_CODES.has(e.code)) return;
    // Stop arrow keys / space from scrolling the page (and P3's F-keys from
    // triggering browser reload/fullscreen/devtools).
    e.preventDefault();
    if (e.repeat) return;
    this.client.sendInput(eventType, e.code, e.key, e.keyCode, e.location);
  }
}
