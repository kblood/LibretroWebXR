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
//
// Console-aware routing (multi-console rack):
// Pass `dispatch` to route each key event to the correct console.
// Without `dispatch`, falls back to `this.client.sendInput(...)` for
// full N=1 back-compat.

import {
  RETROPAD_KEYS, mapForSystem, EXTRA_PLAYER_KEYS, EXTRA_KEY_DEFS,
} from './ControllerMaps.js';

const STICK_THRESHOLD = 0.55;

// Static metadata for the player-1 codes we dispatch. Used both to build the
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

// Full payload table = player 1 (above) + players 2-4 ([[src/ControllerMaps.js]]).
// Codes are globally unique across players (asserted by the no-overlap test), so
// one flat code→payload map and one flat pressed-state map serve all players.
const KEYS = { ...KEY_TABLE, ...EXTRA_KEY_DEFS };

// Codes a logical RetroPad button maps to for a given player. Player 1 keeps
// the resilient double-dispatch (cfg key + RA stock); players 2-4 use their
// single cfg-bound key (retroarch.cfg binds them — see RetroArchConfig.js).
function codesFor(player, btn) {
  if (!btn) return [];
  if (player <= 1) return RETROPAD_KEYS[btn] || [];
  const code = EXTRA_PLAYER_KEYS[player]?.[btn];
  return code ? [code] : [];
}

export class GameInputMgr {
  /**
   * @param {object} opts
   * @param {Array}    opts.controllers
   * @param {object}   [opts.client]                     sendInput fallback (N=1 back-compat)
   * @param {Function} [opts.isControllerHoldingGamepad]
   * @param {Function} [opts.isGamepadHeld]
   * @param {Function} [opts.getRouting]
   * @param {Function} [opts.onKeyDown]
   * @param {Function} [opts.onLogicalInput]
   * @param {Function} [opts.dispatch]   (consoleId, eventType, code, key, keyCode, location)=>void
   *   When provided, ALL key send-out goes through this. When absent, falls back to
   *   `this.client.sendInput(eventType, code, key, keyCode, location)` — exact N=1 behaviour.
   * @param {string}   [opts.defaultConsoleId='console0']
   *   Used for routing entries without a `consoleId`, and for remote-player input.
   */
  constructor({
    controllers,
    client,
    isControllerHoldingGamepad,
    isGamepadHeld,
    getRouting,
    onKeyDown,
    onLogicalInput,
    dispatch,
    defaultConsoleId = 'console0',
  }) {
    this.controllers = controllers;
    this.client = client;
    this._dispatch = dispatch || null;
    this._defaultConsoleId = defaultConsoleId;
    this.isControllerHoldingGamepad = isControllerHoldingGamepad;
    this.isGamepadHeld = isGamepadHeld;
    this.onKeyDown = onKeyDown || (() => {});
    // M1.1 (networked client): fired with { player, btn, down, consoleId } on each
    // logical RetroPad button transition of a routed controller — BEFORE keycode
    // mapping, so the host can resolve it for its own core. main.js forwards these
    // to the host peer over the room socket. null on a single-player / host peer.
    this._onLogicalInput = onLogicalInput || null;
    // Keyed by `${consoleId} ${player}\0${btn}` → { player, btn, consoleId }
    this._logicalState = new Map();
    // M1.1 (networked host): key codes a remote player currently holds, merged
    // into each tick()'s dispatch (see setRemoteButton).
    // Keyed by composite key `${consoleId} ${code}`.
    this._remoteDesired = new Map(); // compositeKey -> { consoleId, code }
    // getRouting() → [{ ctrl, consoleId, player, hand:'holding'|'free' }] : which
    // player each active controller drives this frame (main.js derives it from
    // grab + cable state). Default reproduces the original single-player behaviour:
    // when the one gamepad is held, both hands forward to player 1 on defaultConsoleId.
    this.getRouting = getRouting || (() => {
      if (!this.isGamepadHeld()) return [];
      return this.controllers.map((ctrl) => ({
        ctrl,
        consoleId: this._defaultConsoleId,
        player: 1,
        hand: this.isControllerHoldingGamepad(ctrl) ? 'holding' : 'free',
      }));
    });
    // Per-console pressed state, keyed by composite `${consoleId} ${code}` → bool.
    this._state = new Map();
    this._systemMap = mapForSystem('default');
    this._system = 'default';
  }

  // --- Composite key helpers -------------------------------------------------

  /** Build a composite Map key from a consoleId and a code string. */
  _k(consoleId, code) { return `${consoleId} ${code}`; }

  // --- Output routing --------------------------------------------------------

  /**
   * Send a single key event to the appropriate target.
   * When `_dispatch` is set, routes to the correct console.
   * When absent, falls back to `this.client.sendInput(...)` (N=1 back-compat).
   */
  _send(consoleId, eventType, code, key, keyCode, location) {
    if (this._dispatch) {
      this._dispatch(consoleId, eventType, code, key, keyCode, location);
    } else {
      this.client.sendInput(eventType, code, key, keyCode, location);
    }
  }

  // --- Public lifecycle -------------------------------------------------------

  setSystem(system) {
    this._system = system || 'default';
    this._systemMap = mapForSystem(this._system);
  }

  currentSystem() { return this._system; }
  currentMap()    { return this._systemMap; }

  tick() {
    // desired: composite key `${consoleId} ${code}` → { consoleId, code }
    const desired = new Map();
    const map = this._systemMap;
    // Logical (consoleId, player, RetroPad-button) tuples pressed this frame by
    // local controllers — gathered before keycode mapping so a networked client
    // can forward the logical transitions to the host. Keyed by
    // `${consoleId} ${player}\0${btn}`.
    const logical = new Map();

    for (const entry of this.getRouting()) {
      const { ctrl, player, hand } = entry;
      const consoleId = entry.consoleId || this._defaultConsoleId;
      const handMap = map[hand] || map.holding;
      const gp = ctrl.userData.inputSource?.gamepad;
      if (!gp || !gp.buttons || !gp.axes) continue;

      const addRetro = (btn) => {
        if (!btn) return;
        const lk = `${consoleId} ${player}\0${btn}`;
        logical.set(lk, { player, btn, consoleId });
        for (const c of codesFor(player, btn)) {
          desired.set(this._k(consoleId, c), { consoleId, code: c });
        }
      };

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

    // M1.1 client→host: emit one message per logical transition (diff vs last
    // frame). Done before code-mapping so the host owns the keycode resolution.
    if (this._onLogicalInput) {
      for (const [k, v] of logical) {
        if (!this._logicalState.has(k)) {
          this._onLogicalInput({ player: v.player, btn: v.btn, down: true, consoleId: v.consoleId });
        }
      }
      for (const [k, v] of this._logicalState) {
        if (!logical.has(k)) {
          this._onLogicalInput({ player: v.player, btn: v.btn, down: false, consoleId: v.consoleId });
        }
      }
      this._logicalState = logical;
    }

    // M1.1 host: merge remote players' held codes so the unified press/release
    // sweep below drives them into the correct console's core exactly like a
    // local press — and the keyup sweep won't lift a remote key still held.
    for (const [ck, info] of this._remoteDesired) {
      desired.set(ck, info);
    }

    // Emit keydown for newly-pressed codes (per console).
    for (const [ck, { consoleId, code }] of desired) {
      if (this._state.get(ck)) continue;
      this._state.set(ck, true);
      const m = KEYS[code];
      if (!m) continue;
      this._send(consoleId, 'keydown', m.code, m.key, m.keyCode, m.location);
      this.onKeyDown(m.code, consoleId);
    }
    // Emit keyup for codes that were pressed and no longer are (per console).
    for (const [ck, was] of this._state) {
      if (!was || desired.has(ck)) continue;
      this._state.set(ck, false);
      // Parse the composite key: consoleId is everything before the last space,
      // code is everything after.
      const spaceIdx = ck.indexOf(' ');
      const consoleId = ck.slice(0, spaceIdx);
      const code = ck.slice(spaceIdx + 1);
      const m = KEYS[code];
      if (!m) continue;
      this._send(consoleId, 'keyup', m.code, m.key, m.keyCode, m.location);
    }
  }

  // Release every currently-pressed key across ALL consoles. Called when the
  // gamepad is dropped so a held-down button doesn't latch on the emulator side.
  flushReleases() {
    for (const [ck, was] of this._state) {
      if (!was) continue;
      this._state.set(ck, false);
      const spaceIdx = ck.indexOf(' ');
      const consoleId = ck.slice(0, spaceIdx);
      const code = ck.slice(spaceIdx + 1);
      const m = KEYS[code];
      if (!m) continue;
      this._send(consoleId, 'keyup', m.code, m.key, m.keyCode, m.location);
    }
  }

  // M1.1 host side: record a remote networked player's logical button as held
  // or released. `player` is a console-port slot (1..4), `btn` a RetroPad button
  // name (A/B/X/Y/L/R/Start/Select/Up/Down/Left/Right). `consoleId` defaults to
  // `_defaultConsoleId`. The resolved code(s) join _remoteDesired and dispatch on
  // the next tick(). Safe before the first tick.
  setRemoteButton({ player, btn, down, consoleId }) {
    const cid = consoleId || this._defaultConsoleId;
    for (const c of codesFor(player, btn)) {
      const ck = this._k(cid, c);
      if (down) this._remoteDesired.set(ck, { consoleId: cid, code: c });
      else this._remoteDesired.delete(ck);
    }
  }

  // Drop all remote-held keys (e.g. the remote player disconnected). Their
  // keyups fire on the next tick() via the normal sweep, so nothing latches.
  clearRemote() { this._remoteDesired.clear(); }

  // Per-controller debug snapshot for [[src/DebugHud.js]] and the
  // gamepad mesh's animation. Returns { system, holding, free, pressedKeys }
  // where pressedKeys shows bare code strings (consoleId prefix stripped).
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
    // Strip consoleId prefix from the composite key so the returned shape is
    // identical to the pre-refactor shape: pressedKeys is an array of bare codes.
    const pressedKeys = [];
    for (const [ck, was] of this._state) {
      if (!was) continue;
      const spaceIdx = ck.indexOf(' ');
      pressedKeys.push(ck.slice(spaceIdx + 1));
    }
    return { system: this._system, holding, free, pressedKeys };
  }
}
