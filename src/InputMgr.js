// Keyboard → emulator key events (DESKTOP / flat-screen path).
//
// This is the SOLE keyboard→core path on desktop: the core does not read the
// keyboard natively, it only ever sees the synthetic sendInput events we emit
// here ([[src/EmulatorClient.js]]). Historically a physical key was forwarded
// AS-IS — pressing KeyH delivered KeyH (the core's A). That hardcoded the
// SNES/webretro defaults into the physical keys.
//
// Now we TRANSLATE through a [[src/Bindings.js]] map: a physical key looks up the
// logical RetroPad button it's bound to, and we dispatch that button's CANONICAL
// code(s) from [[src/ControllerMaps.js]] RETROPAD_KEYS — never the physical key.
// So binding KeyJ → A makes a physical KeyJ press emit KeyH/KeyX (A's codes),
// not KeyJ. With the default bindings every physical key maps back to the same
// canonical code it used to forward, so a fresh user notices zero change.
//
// Players 2-4 couch-co-op forwarding is preserved: the Bindings map manages all
// configured players, and each P2-4 default key still translates to its own
// EXTRA_PLAYER_KEYS code (see [[src/ControllerMaps.js]]).
//
// PC gamepad input is the sibling path in [[src/DesktopGamepad.js]] (polled, not
// event-driven); both share the same Bindings instance and KEY_PAYLOADS.

import { Bindings, KEY_PAYLOADS } from './Bindings.js';

// Player-1 keyboard codes (webretro cfg defaults). Exported so the test suite
// can assert players 2-4 ([[src/ControllerMaps.js]] EXTRA_PLAYER_KEYS) never
// collide with them. Kept here (not derived from Bindings) so existing importers
// of DEFAULT_BIND_CODES are unchanged.
export const DEFAULT_BIND_CODES = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Enter', 'Space',
  'KeyH', 'KeyG', 'KeyY', 'KeyT',
  'KeyE', 'KeyP', 'KeyR', 'KeyO',
]);

export class InputMgr {
  // bindings: a Bindings instance ([[src/Bindings.js]]). Optional — if omitted, a
  // default-only Bindings is created, which reproduces the historical mapping
  // exactly. Sharing the SAME instance with DesktopGamepad + the bindings UI lets
  // a rebind take effect immediately on the next keypress with no re-attach.
  constructor(client, { bindings } = {}) {
    this.client = client;
    this.bindings = bindings || new Bindings();
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
    // Only forward real user keystrokes. Our own synthetic events from this
    // class / GameInputMgr / DesktopGamepad → EmulatorClient.sendInput share the
    // same window target, and re-forwarding them here would loop infinitely.
    if (!e.isTrusted) return;
    // Translate physical code → logical button → canonical core code(s).
    const hits = this.bindings.lookupKey(e.code);
    if (!hits.length) return;
    // Bound keys go to the emulator, never the browser — preventDefault ALL of
    // them (matching the historical forward path). This is what stops arrows/
    // space from scrolling AND P3's F-key binds from hijacking the browser
    // (reload/fullscreen/devtools). Unbound keys already returned above.
    e.preventDefault();
    if (e.repeat) return;
    // Dispatch every canonical code for every button this key is bound to. The
    // payloads carry the key/keyCode/location the cores expect (KEY_PAYLOADS,
    // [[src/Bindings.js]]); fall back to the bare code if a payload is missing.
    for (const hit of hits) {
      for (const code of hit.codes) {
        const p = KEY_PAYLOADS[code];
        this.client.sendInput(eventType, code, p?.key ?? code, p?.keyCode, p?.location);
      }
    }
  }
}
