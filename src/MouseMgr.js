// MouseMgr — per-frame in-world mouse driving. For each held mouse prop it tracks
// the prop's world position frame-to-frame, converts the motion into RELATIVE
// libretro mouse deltas, reads the holding controller's buttons, and calls the
// plugged console's EmulatorClient.sendMouse(dx, dy, buttons, port). Mirrors
// [[src/LightGunMgr.js]] but feeds RELATIVE motion (not an absolute aim point),
// so there is no raycast — just a per-prop "where was it last frame" tracker.
//
// TWO cursor-motion sources are summed each tick, from the SAME controller
// holding the mouse prop: (1) hand tracking (precise, but a VR hand can't lift
// perfectly vertically the way a real mouse does off a desk pad, so repositioning
// for a big cursor jump drags some drift with it) and (2) the thumbstick
// (stickToMouse / stickAxesFromController — continuous pan while deflected, for
// fast long-distance travel that doesn't fight the hand's own arc). Hand motion
// stays the precise/near-field input; the stick is the "declutch" for distance.
//
// It also owns the DESKTOP path: when not in VR, the computer mouse drives one
// mouse via Pointer Lock (relative movementX/Y). attachDesktop(getEl, opts) wires
// pointerlock on a target element and routes movementX/Y + buttons to the first
// desktop-bound mouse's console. This is decoupled from the scene/cable via
// injected accessors so the same code serves single- and multi-console paths and
// is unit-testable. main.js supplies the accessors.
//
// Both motion sources' world/axis → libretro-pixel conversions are the subtle
// part and live in the pure, exported worldDeltaToMouse() / stickToMouse() so
// they can be unit-tested without a scene.

import * as THREE from 'three';

// How many libretro mouse pixels one metre of in-world hand travel maps to. The
// Amiga pointer crosses its ~720px screen in roughly a 0.5 m hand sweep at this
// gain, which feels natural in VR without being twitchy. Pure scalar; tune freely.
const DEFAULT_GAIN = 1400;
// Clamp any single-frame delta so a teleport / tracking glitch can't fling the
// pointer across the screen. Libretro mice expect small per-frame deltas.
const MAX_STEP = 120;

// Thumbstick cursor-pan speed, in libretro pixels/second at full deflection.
// Independent of DEFAULT_GAIN (that's metres-of-hand-motion→pixels; this is
// stick-deflection→pixels/sec). Crosses a ~720px Amiga screen in <1s at full
// deflection — fast enough to feel like a "declutch", not another slow drag.
const DEFAULT_STICK_SPEED = 900;
// Axis magnitude below which the stick is treated as centred (ignores resting
// drift). Output ramps smoothly from 0 at this edge to full speed at full
// deflection — no jump at the boundary.
const DEFAULT_STICK_DEADZONE = 0.15;

/**
 * Convert a world-space motion vector (the prop's position change since last
 * frame) into integer libretro mouse deltas (dx right+, dy down+). The mouse lies
 * flat on the desk, so horizontal hand motion (world X) → dx and FORWARD/BACK hand
 * motion (world -Z, pushing the mouse away) → dy (up the screen). World Y (lifting
 * the mouse) is ignored, like lifting a real mouse off the pad. Pure — exported
 * for unit tests.
 * @returns {{dx:number, dy:number}}
 */
export function worldDeltaToMouse(dxWorld, dyWorld, dzWorld, gain = DEFAULT_GAIN, maxStep = MAX_STEP) {
  // World X right (+) → screen right (+dx). Pushing the mouse forward is world -Z;
  // forward should move the pointer UP (screen -dy), so dy = +dz*gain (since +Z is
  // pulling the mouse back/toward the user → pointer down).
  let dx = dxWorld * gain;
  let dy = dzWorld * gain;
  dx = Math.max(-maxStep, Math.min(maxStep, dx));
  dy = Math.max(-maxStep, Math.min(maxStep, dy));
  return { dx: Math.round(dx), dy: Math.round(dy) };
}

/** Ramp linearly from 0 at the deadzone edge to 1 at full deflection (±1). */
function applyDeadzone(v, dz) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * (a - dz) / (1 - dz);
}

/**
 * Convert raw thumbstick axis values into a continuous per-tick libretro mouse
 * delta — fast long-distance cursor travel that doesn't require physically
 * moving the hand (see the file-header comment for why this exists alongside
 * worldDeltaToMouse's hand-tracked motion). Same screen-space convention as
 * worldDeltaToMouse: +dx = right, +dy = down. xr-standard gives axes[3] = -1
 * for "stick pushed forward/away", mapped straight to -dy (cursor up) — no
 * sign flip needed, since that mirrors worldDeltaToMouse's own push-mouse-
 * forward(-Z)→-dy(up) convention. Pure — exported for unit tests.
 * @returns {{dx:number, dy:number}}
 */
export function stickToMouse(x, y, dt, speed = DEFAULT_STICK_SPEED, deadzone = DEFAULT_STICK_DEADZONE, maxStep = MAX_STEP) {
  let dx = applyDeadzone(x, deadzone) * speed * dt;
  let dy = applyDeadzone(y, deadzone) * speed * dt;
  dx = Math.max(-maxStep, Math.min(maxStep, dx));
  dy = Math.max(-maxStep, Math.min(maxStep, dy));
  return { dx: Math.round(dx), dy: Math.round(dy) };
}

/**
 * Derive the held-button bitmask (bit0=left, bit1=right) from an XR controller's
 * gamepad buttons. Trigger (button 0) = left; squeeze (button 1) = right — the
 * same mapping the light gun uses for its trigger. Pure — exported for tests.
 */
export function buttonsFromController(controller) {
  const btns = controller?.userData?.inputSource?.gamepad?.buttons;
  if (!btns) return 0;
  let mask = 0;
  if (btns[0]?.pressed) mask |= 1; // trigger → left
  if (btns[1]?.pressed) mask |= 2; // squeeze → right
  return mask;
}

/**
 * Read the xr-standard thumbstick axes off an XR controller's gamepad
 * (axes[2]=X, axes[3]=Y — same layout as [[src/LocomotionMgr.js]] /
 * [[src/GrabMgr.js]]). Returns {x:0, y:0} when no gamepad/axes are present.
 * Pure — exported for unit tests.
 */
export function stickAxesFromController(controller) {
  const axes = controller?.userData?.inputSource?.gamepad?.axes;
  if (!axes || axes.length < 4) return { x: 0, y: 0 };
  return { x: axes[2] || 0, y: axes[3] || 0 };
}

export class MouseMgr {
  /**
   * @param {object} opts
   * @param {Function} opts.getActiveMice   () => [{ mouse, controller }]  held mice + the XR controller holding each
   * @param {Function} opts.clientForMouse  (mouse) => EmulatorClient|null  the console the mouse is plugged into
   * @param {Function} [opts.portForMouse]  (mouse) => number|null  the libretro mouse PORT (two-mouse co-op); null → single-mouse DOM path
   * @param {number}   [opts.gain]          world-metres → libretro-pixels gain
   * @param {number}   [opts.stickSpeed]    thumbstick-pan libretro-pixels/second at full deflection
   * @param {number}   [opts.stickDeadzone] thumbstick-pan deadzone (axis magnitude, 0-1)
   * @param {Function} [opts.log]           telemetry sink log(name, fields)
   */
  constructor({ getActiveMice, clientForMouse, portForMouse = null, gain = DEFAULT_GAIN, stickSpeed = DEFAULT_STICK_SPEED, stickDeadzone = DEFAULT_STICK_DEADZONE, log = null }) {
    this._getActiveMice = getActiveMice;
    this._clientForMouse = clientForMouse;
    this._portForMouse = typeof portForMouse === 'function' ? portForMouse : null;
    this._gain = gain;
    this._stickSpeed = stickSpeed;
    this._stickDeadzone = stickDeadzone;
    this._log = typeof log === 'function' ? log : null;
    // Per-mouse last world position (to derive the frame delta).
    this._lastPos = new WeakMap();
    this._lastButtons = new WeakMap();
    this._scratch = new THREE.Vector3();
    // Desktop pointer-lock state.
    this._desktop = null; // { dx, dy, buttons } accumulator while locked
    this._desktopBound = false;
  }

  /** Per-frame update. dt unused (motion is positional) but kept for parity. */
  tick(_dt = 0.016) {
    const mice = this._getActiveMice?.() || [];
    for (const { mouse, controller } of mice) {
      const ud = mouse?.userData;
      if (!ud) continue;
      const tracker = ud.tracker || mouse;
      tracker.getWorldPosition(this._scratch);
      const cur = this._scratch;
      const prev = this._lastPos.get(mouse);
      const client = this._clientForMouse?.(mouse) || null;
      const port = this._portForMouse ? this._portForMouse(mouse) : null;
      const buttons = buttonsFromController(controller);

      let dx = 0, dy = 0;
      if (prev) {
        const m = worldDeltaToMouse(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z, this._gain);
        dx = m.dx; dy = m.dy;
      }
      // Thumbstick pan, from the SAME controller holding the mouse — summed
      // with the hand-tracked motion above for fast long-distance travel.
      // See stickToMouse's doc comment for why both sources exist.
      const { x: sx, y: sy } = stickAxesFromController(controller);
      if (sx || sy) {
        const s = stickToMouse(sx, sy, _dt, this._stickSpeed, this._stickDeadzone);
        dx += s.dx; dy += s.dy;
      }
      // Save the current position for next frame (clone — cur is reused scratch).
      this._lastPos.set(mouse, cur.clone());

      // Send when there is motion OR a button-state change (edge), so the core
      // latches/releases buttons correctly and doesn't get spammed at rest.
      const lastB = this._lastButtons.get(mouse) ?? 0;
      if (client && (dx || dy || buttons !== lastB)) {
        client.sendMouse(dx, dy, buttons, port);
      }
      this._lastButtons.set(mouse, buttons);
      ud.setButtons?.(buttons);
      ud.tick?.(_dt);

      if (this._log && buttons !== lastB) {
        this._log('mouse-button', { buttons, port });
      }
    }
  }

  /**
   * Desktop fallback: drive ONE mouse from the computer pointer via Pointer Lock.
   * On click of `getEl()`, request pointer lock; while locked, route movementX/Y
   * and button state to `getClient()`'s sendMouse on `getPort()`. Two physical
   * desktop mice are a hardware limit — only one desktop pointer exists — so this
   * binds a single mouse (the first/primary). In VR the per-mouse positional path
   * above is used instead; the two co-exist (desktop only fires while locked).
   *
   * @param {object} o
   * @param {Function} o.getEl      () => HTMLElement   the element to lock to (the app canvas)
   * @param {Function} o.getClient  () => EmulatorClient|null  the console to drive
   * @param {Function} [o.getPort]  () => number|null  libretro mouse port (usually null/0)
   * @param {Function} [o.getWired] () => boolean  true only when the seated console's
   *   CURRENT boot actually has a libretro MOUSE device wired on this mouse's port.
   *   Gates auto-lock so an ordinary click on the scene (e.g. while loading an
   *   unrelated ROM) doesn't silently capture the OS cursor for a game that has no
   *   use for it. Default () => true (back-compat for callers/tests that don't pass it).
   * @param {boolean}  [o.autoLock] request lock on click (default true)
   */
  attachDesktop({ getEl, getClient, getPort = () => null, getWired = () => true, autoLock = true } = {}) {
    if (this._desktopBound || typeof document === 'undefined') return;
    this._desktopBound = true;
    const el = getEl?.();
    if (!el) return;
    this._getWired = typeof getWired === 'function' ? getWired : () => true;
    let buttons = 0;
    const send = (dx, dy) => {
      if (document.pointerLockElement == null) return; // only while locked
      const client = getClient?.();
      if (!client) return;
      client.sendMouse(dx, dy, buttons, getPort?.() ?? null);
    };
    if (autoLock) {
      el.addEventListener('click', () => {
        if (!this._getWired()) return; // no mouse device on this boot — leave the cursor alone
        try { el.requestPointerLock?.(); } catch (_) {}
      });
    }
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement == null) return;
      send(e.movementX || 0, e.movementY || 0);
    });
    document.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement == null) return;
      const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : 0;
      buttons |= bit; send(0, 0);
    });
    document.addEventListener('mouseup', (e) => {
      if (document.pointerLockElement == null) return;
      const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : 0;
      buttons &= ~bit; send(0, 0);
    });
    // Suppress the context menu so a right-click reaches the core, not the browser.
    el.addEventListener('contextmenu', (e) => { if (document.pointerLockElement != null) e.preventDefault(); });
  }

  /**
   * Force-exit desktop pointer lock. No-op if not currently locked. Call this
   * when a newly loaded ROM no longer wants the mouse device (e.g. switching
   * from an Amiga game to an unrelated SNES game while still locked from the
   * prior boot) — otherwise the OS cursor stays captured for a game that can't
   * use it, which reads as the page having crashed.
   */
  releaseDesktopLock() {
    if (typeof document === 'undefined') return;
    if (document.pointerLockElement != null) {
      try { document.exitPointerLock?.(); } catch (_) {}
    }
  }
}
