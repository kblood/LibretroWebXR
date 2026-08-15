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

// COR-8: the owner id used for setRemoteButton() calls that have no networked
// peer behind them — the click-to-test laser in main.js and TestApi.input. It is
// a real sender like any peer id, so a local hold and a remote hold of the same
// button OR together instead of cancelling each other.
export const LOCAL_SENDER = 'local';

// COR-8 round 5 (2026-08-15): the bucket for an input that came OFF THE WIRE
// (`remote: true`) but carried no usable sender id. Before this such an input
// fell into LOCAL_SENDER, where clearRemoteFrom(peerId) could never reach it AND
// where it shared a slot with the click-to-test lasers — so a laser release could
// lift a remote hold and vice versa. It gets its own bucket instead.
// NetProtocol.validate() does not require `from` on INPUT, and nothing in
// GameInputMgr can make it; this is the fail-safe for that unguarded assumption.
// No shipped relay produces it today — the server has stamped `from` on every
// relayed INPUT since a58e126 (`from: fromPeerId` in server/Hub.js) — so this
// path is defence, not a live code path. The literal ':' makes it impossible to
// collide with a server-minted peer id (randomUUID() → hex + dashes only).
export const REMOTE_ANON_SENDER = 'remote:anon';

// Normalise a sender id to the string form both the hold and the clear path key
// on. Peer ids arrive as whatever the relay stamped (`msg.from`) on one side and
// whatever LEAVE/prune reported (`msg.id`) on the other; if those two ever
// disagreed on type the departing peer's holds would never be found and WOULD
// latch. Stringifying both ends removes that class of bug outright.
//
// `remote` says whether the caller is the networked input path (main.js's
// onGameInput) or a local injector (the click-to-test lasers, TestApi). It only
// matters when there is no id: a local injector legitimately has none, a remote
// one must never be mistaken for it.
function _senderId(from, remote = false) {
  if (from === null || from === undefined || from === '') {
    return remote ? REMOTE_ANON_SENDER : LOCAL_SENDER;
  }
  return String(from);
}

// Membership test over whatever shape the caller already has for the live roster:
// a Set (fast path) or any iterable of ids (Array, generator). Absent/empty means
// "nobody is present", not "everybody is" — the safe reading, since an owner we
// cannot vouch for is exactly what pins a button down.
function _hasId(liveIds, sender) {
  if (!liveIds) return false;
  if (typeof liveIds.has === 'function' && liveIds.has(sender)) return true;
  // Miss on the fast path (or not a Set): scan, comparing in the SAME normalised
  // form _senderId() produced, so a roster carrying ids as numbers still matches
  // a stringified sender. Only reached when a sender is about to be dropped, and
  // the roster is a handful of peers.
  if (typeof liveIds[Symbol.iterator] === 'function') {
    for (const id of liveIds) if (_senderId(id) === sender) return true;
  }
  return false;
}

// W3C standard gamepad layout. This gives a real USB/Bluetooth PlayStation-
// style pad the full RetroPad surface, unlike the intentionally compact
// two-hand Quest mapping.
const STANDARD_GAMEPAD_BUTTONS = {
  0: 'B', 1: 'A', 2: 'Y', 3: 'X',
  4: 'L', 5: 'R', 6: 'L2', 7: 'R2',
  8: 'Select', 9: 'Start',
  12: 'Up', 13: 'Down', 14: 'Left', 15: 'Right',
};

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
    //
    // COR-8 (2026-08-15): each entry now carries the SET OF SENDERS holding it,
    // not just the code. Before this the map was keyed by console/player/code
    // alone, so ownership was single-slot: if two permitted senders held the
    // same logical button (two peers on the same port, or a peer plus the local
    // click-to-test path), whichever released FIRST deleted the shared entry and
    // the still-holding sender — which only ever sends transitions — never
    // reasserted it. The button silently went up under the other player's
    // finger. Reduce with OR semantics instead: DOWN iff at least one sender
    // holds it.
    this._remoteDesired = new Map(); // compositeKey -> { consoleId, code, owners:Set<sender> }
    // Reverse index sender -> Set<compositeKey> so a departing peer can be
    // forgotten in O(keys it held) instead of a scan of every entry. Both maps
    // delete their entry as soon as it empties.
    //
    // COR-8 round 5 (2026-08-15): the previous version of this comment claimed a
    // departing sender "leaves NOTHING behind". That was only true for a sender
    // that either released its own key or was handed to clearRemoteFrom(). An
    // ORPHAN — an owner that will never send another transition and will never be
    // named in a clear call — was pinned here forever, and because the entry it
    // owned is OR-reduced, no other sender's release and not even flushReleases()
    // could lift the key (flushReleases only clears _state; the next tick()
    // re-latches it from _remoteDesired). That is a permanent stuck emulator
    // button where the pre-fix single-slot code self-healed on the next release by
    // anybody.
    //
    // COR-8 round 6 (2026-08-15): round 5 cured that for NETWORKED owners only,
    // and this comment then claimed "nothing accumulates" — which was false for a
    // LOCAL owner, doubly so because round 5 also made every click-to-test laser
    // its OWN sender (main.js: `local-gp:<n>`), so one hand's release can no
    // longer lift the other hand's orphaned hold either. reconcileLocalSenders()
    // is the matching rule. The honest statement, scope stated per rule: an entry
    // dies when its last owner lets go, and a sender is forgotten by ANY of
    //   * its own release of its last key,
    //   * clearRemoteFrom(id)             — a LEAVE/prune named it,
    //   * reconcileRemoteSenders(liveIds) — a NETWORKED owner is no longer in the
    //     room roster; skips local senders and REMOTE_ANON_SENDER,
    //   * reconcileLocalSenders(liveIds)  — a NAMED LOCAL owner's input source is
    //     gone; skips networked senders and LOCAL_SENDER,
    //   * clearRemote()                   — every owner, no questions asked.
    // TWO owners are outside BOTH reconcile rules, and for the same reason: they
    // are the id-less buckets. LOCAL_SENDER (an injector that supplied no id —
    // TestApi) and REMOTE_ANON_SENDER (a wire input that carried no `from`). No
    // roster can vouch for or against an id that was never issued, so both are
    // cleared wholesale instead, by clearRemote() — which TestApi.releaseAll()
    // calls, and which main.js calls on disconnect (disconnectFromRoom) and on
    // every host-role change (_applyHostRole). Every NAMED owner is reconciled
    // every frame: main.js runs the local rule unconditionally (solo included) and
    // the roster rule on every frame we are in a room.
    this._remoteBySender = new Map();
    // The subset of _remoteBySender's keys that arrived over the wire
    // (setRemoteButton({ remote: true })). Only these are subject to ROOM-roster
    // reconciliation: a local click-to-test laser has no peer id and must never be
    // dropped because it is "not in the roster" — reconcileLocalSenders() judges
    // those against a roster of live LOCAL input sources instead.
    // Always a subset of _remoteBySender's keys: the two are populated together
    // and every deletion goes through _forgetSender(), which drops both. That
    // invariant is what lets localSenderCount() be a plain subtraction instead of
    // a third index to keep in lockstep.
    this._netSenders = new Set();
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

    // Prefer an actual standards-mapped pad whenever one is connected. XR
    // controller gamepads normally use "xr-standard" and are excluded. A
    // real pad always drives player 1 on the default console — there is no
    // hand-holding concept to route it by.
    const pads = globalThis.navigator?.getGamepads?.() || [];
    const physical = Array.from(pads).find((pad) => pad?.connected && pad.mapping === 'standard' && pad.buttons?.length >= 10);
    if (physical) {
      const consoleId = this._defaultConsoleId;
      const addPhysicalRetro = (btn) => {
        if (!btn) return;
        const lk = `${consoleId} 1\0${btn}`;
        logical.set(lk, { player: 1, btn, consoleId });
        for (const c of codesFor(1, btn)) {
          desired.set(this._k(consoleId, c), { consoleId, code: c });
        }
      };
      for (const [index, button] of Object.entries(STANDARD_GAMEPAD_BUTTONS)) {
        if (physical.buttons[index]?.pressed) addPhysicalRetro(button);
      }
      const px = physical.axes?.[0] || 0;
      const py = physical.axes?.[1] || 0;
      if (py <= -STICK_THRESHOLD) addPhysicalRetro('Up');
      if (py >=  STICK_THRESHOLD) addPhysicalRetro('Down');
      if (px <= -STICK_THRESHOLD) addPhysicalRetro('Left');
      if (px >=  STICK_THRESHOLD) addPhysicalRetro('Right');
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
    // COR-8: an entry's mere PRESENCE is already the OR over its owners — the
    // entry is deleted the moment its last owner releases — so the hot path is
    // unchanged: one Map walk, no per-frame allocation, no per-owner scan. The
    // extra `owners` field on the value is simply ignored by the sweep below,
    // which destructures { consoleId, code }.
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
  //
  // COR-8: `from` is the SENDER that owns this hold — NetMgr._applyGameInput
  // stamps it from the relay's `msg.from` (the server sets it in Hub.input()).
  // Ownership is the tuple {sender, console, player, control}; a release only
  // withdraws THAT sender's claim, so a second sender holding the same button
  // keeps it down. Call sites with no peer behind them (the click-to-test
  // laser, TestApi) fall back to LOCAL_SENDER, which is just one more owner.
  //
  // COR-8 round 5: `remote` marks the networked path (main.js's onGameInput).
  // It does two things: an id-less wire input lands in REMOTE_ANON_SENDER instead
  // of contaminating the local bucket, and the sender is registered as
  // roster-reconcilable (see reconcileRemoteSenders). Local injectors leave it
  // false, which is why their holds survive a roster reconcile.
  setRemoteButton({ player, btn, down, consoleId, from, remote = false }) {
    const cid = consoleId || this._defaultConsoleId;
    const sender = _senderId(from, remote);
    for (const c of codesFor(player, btn)) {
      const ck = this._k(cid, c);
      if (down) {
        let entry = this._remoteDesired.get(ck);
        if (!entry) {
          entry = { consoleId: cid, code: c, owners: new Set() };
          this._remoteDesired.set(ck, entry);
        }
        entry.owners.add(sender);
        let held = this._remoteBySender.get(sender);
        if (!held) { held = new Set(); this._remoteBySender.set(sender, held); }
        held.add(ck);
        if (remote) this._netSenders.add(sender);
      } else {
        this._releaseOwned(sender, ck);
        const held = this._remoteBySender.get(sender);
        if (held) {
          held.delete(ck);
          if (held.size === 0) this._forgetSender(sender);
        }
      }
    }
  }

  /** Drop a sender from BOTH indexes. The one place that owns that invariant. */
  _forgetSender(sender) {
    this._remoteBySender.delete(sender);
    this._netSenders.delete(sender);
  }

  // Withdraw ONE sender's claim on one composite key. The key survives while any
  // other sender still holds it (OR semantics); when the last owner lets go the
  // entry is deleted so the next tick()'s sweep emits the keyup. Does not touch
  // the reverse index — callers own that, since they iterate it.
  _releaseOwned(sender, ck) {
    const entry = this._remoteDesired.get(ck);
    if (!entry) return;
    entry.owners.delete(sender);
    if (entry.owners.size === 0) this._remoteDesired.delete(ck);
  }

  // COR-8: drop only ONE sender's held keys — the peer that just left. Keys any
  // remaining sender still holds stay down (no multi-peer input blip); keys that
  // sender was the last owner of release on the next tick() via the normal
  // sweep, so nothing latches. The sender is forgotten entirely.
  //
  // COR-8 round 5: an id-less call is a no-op, deliberately NOT the LOCAL_SENDER
  // fallback the hold path uses. A LEAVE that arrived without an id is not a
  // reason to wipe the click-to-test lasers' holds — those belong to the person
  // at this headset, not to any peer. main.js calls clearRemote() for that case.
  clearRemoteFrom(from) {
    if (from === null || from === undefined || from === '') return;
    const sender = _senderId(from);
    const held = this._remoteBySender.get(sender);
    if (!held) return;
    for (const ck of held) this._releaseOwned(sender, ck);
    this._forgetSender(sender);
  }

  /** How many NETWORKED senders currently hold at least one key. */
  netSenderCount() { return this._netSenders.size; }

  /**
   * How many LOCAL senders currently hold at least one key — every owner that is
   * not a networked one, LOCAL_SENDER included. O(1): _netSenders is a subset of
   * _remoteBySender's keys (see the field comment), so this is a subtraction, not
   * a scan. main.js reads it once per frame as the gate on the local reconcile.
   */
  localSenderCount() { return this._remoteBySender.size - this._netSenders.size; }

  /**
   * COR-8 round 5 (2026-08-15): drop every networked owner that is no longer in
   * the room roster. This is the cure for the ORPHANED owner — a peer whose
   * departure never reached clearRemoteFrom() — which otherwise pins its keys
   * DOWN for the rest of the session (see the _remoteBySender comment above).
   * The orphan is reachable: main.js gates onPeerLeave on amRoomHost(), which is
   * false while net.connected is false, so every peer-leave fired during our own
   * socket drop is discarded, and NetMgr._scheduleReconnect() then wipes presence
   * with no onPeerLeave at all because the server mints a NEW peer id per
   * connection (server/room-server.mjs `const peerId = randomUUID()`). A
   * room-server restart or a shared Wi-Fi blip drops host and clients together and
   * reproduces it. Roster reconciliation does not care HOW the id went away.
   *
   * `liveIds` is a Set (the fast path, and what main.js builds from
   * net.presence.peers()) or any iterable of ids. Senders it does not contain
   * lose their claims; the keys they were the last owner of lift on the next
   * tick() via the normal sweep, exactly like an ordinary release.
   *
   * NOT reconciled here: local senders (the click-to-test lasers, TestApi) — they
   * have no peer id, so "absent from the ROOM roster" says nothing about them;
   * reconcileLocalSenders() is their rule — and REMOTE_ANON_SENDER, because a
   * roster cannot adjudicate an id it never issued.
   * Dropping anon here would mean that if a relay ever stopped stamping `from`,
   * ALL remote input would silently become a no-op, which is a worse failure than
   * the bounded hold it replaces: anon is still cleared by clearRemote(), which
   * main.js calls on disconnect and on every host-role change.
   *
   * Allocates nothing. O(networked senders) — 0 in the overwhelmingly common
   * case — plus an O(roster) scan only for a sender that is about to be dropped
   * (see _hasId). The per-frame tick() hot path is not touched at all.
   * @returns {number} how many senders were dropped.
   */
  reconcileRemoteSenders(liveIds) {
    if (this._netSenders.size === 0) return 0;
    let dropped = 0;
    // Deleting the current entry while iterating a Set is well-defined in JS
    // (already-visited entries are done, unvisited ones are still reached), and
    // clearRemoteFrom() only ever deletes the entry it was handed.
    for (const sender of this._netSenders) {
      if (sender === REMOTE_ANON_SENDER) continue;
      if (_hasId(liveIds, sender)) continue;
      this.clearRemoteFrom(sender);
      dropped++;
    }
    return dropped;
  }

  /**
   * COR-8 round 6 (2026-08-15): the LOCAL mirror of reconcileRemoteSenders().
   *
   * Round 5 cured the orphaned owner for peers only, and in the same round main.js
   * gave every click-to-test laser its OWN sender id (`local-gp:<n>`) so two hands
   * could hold one virtual button. Those two changes together recreate the exact
   * permanent latch this whole fix exists to remove, one layer down: a
   * `selectstart` whose `selectend` never arrives (the controller is lost
   * mid-press) leaves an owner that will never transition again, no other hand's
   * release can lift it (OR semantics), flushReleases() cannot either (it clears
   * _state; the next tick() re-latches from _remoteDesired), and the roster rule
   * above deliberately skips it. In solo play no roster rule runs at all. So:
   * an owner that no longer exists may not hold a key, local or networked.
   *
   * `liveIds` is the set of local input owners a real, still-live source is
   * holding right now — main.js builds it from the laser-hold records whose
   * XRInputSource is still the one the press started on. Same shape rules as the
   * roster version: Set fast path, any iterable accepted, absent/empty means
   * "nobody", never "everybody".
   *
   * NOT reconciled here:
   *   * networked senders — an id the wire issued is the ROOM roster's business,
   *     not a local source list's. A sender that ever arrived with `remote: true`
   *     stays under reconcileRemoteSenders() even if a local caller reuses its id.
   *   * LOCAL_SENDER — the bucket for an injector that supplied NO id (TestApi).
   *     No list of named sources can vouch for or against an anonymous one, and
   *     dropping it here would make TestApi.input holds evaporate a frame after
   *     they are set. clearRemote() is its cure (TestApi.releaseAll calls it).
   *
   * Allocates nothing, and returns immediately in the common case where the only
   * owners are networked ones (or there are none at all).
   * @returns {number} how many senders were dropped.
   */
  reconcileLocalSenders(liveIds) {
    if (this._remoteBySender.size === this._netSenders.size) return 0;
    let dropped = 0;
    // Deleting the CURRENT entry while iterating a Map's keys is well-defined in
    // JS (visited entries are done, unvisited ones are still reached), and
    // clearRemoteFrom() only ever deletes the entry it was handed.
    for (const sender of this._remoteBySender.keys()) {
      if (sender === LOCAL_SENDER) continue;
      if (this._netSenders.has(sender)) continue;
      if (_hasId(liveIds, sender)) continue;
      this.clearRemoteFrom(sender);
      dropped++;
    }
    return dropped;
  }

  // Drop ALL remote-held keys regardless of sender (session teardown, TestApi's
  // releaseAll, and — COR-8 round 5 — main.js's disconnect and host-role change,
  // the two transitions after which the roster we reconcile against is
  // meaningless). Their keyups fire on the next tick() via the normal sweep, so
  // nothing latches. Prefer clearRemoteFrom() for a single peer's departure.
  clearRemote() {
    this._remoteDesired.clear();
    this._remoteBySender.clear();
    this._netSenders.clear();
  }

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
