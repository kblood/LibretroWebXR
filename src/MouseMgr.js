// MouseMgr — per-frame in-world mouse driving. For each held mouse prop it tracks
// the prop's world position frame-to-frame, converts the motion into RELATIVE
// libretro mouse deltas, reads the holding controller's buttons, and calls the
// plugged console's EmulatorClient.sendMouse(dx, dy, buttons, port). Mirrors
// [[src/LightGunMgr.js]] but feeds RELATIVE motion (not an absolute aim point),
// so there is no raycast — just a per-prop "where was it last frame" tracker.
//
// It also owns the DESKTOP path: when not in VR, the computer mouse drives one
// mouse via Pointer Lock (relative movementX/Y). attachDesktop(getEl, opts) wires
// pointerlock on a target element and routes movementX/Y + buttons to the first
// desktop-bound mouse's console. This is decoupled from the scene/cable via
// injected accessors so the same code serves single- and multi-console paths and
// is unit-testable. main.js supplies the accessors.
//
// The world-motion → libretro-pixel conversion is the subtle part and lives in
// the pure, exported worldDeltaToMouse() so it can be unit-tested without a scene.

import * as THREE from 'three';

// How many libretro mouse pixels one metre of in-world hand travel maps to. The
// Amiga pointer crosses its ~720px screen in roughly a 0.5 m hand sweep at this
// gain, which feels natural in VR without being twitchy. Pure scalar; tune freely.
const DEFAULT_GAIN = 1400;
// Clamp any single-frame delta so a teleport / tracking glitch can't fling the
// pointer across the screen. Libretro mice expect small per-frame deltas.
const MAX_STEP = 120;

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

export class MouseMgr {
  /**
   * @param {object} opts
   * @param {Function} opts.getActiveMice   () => [{ mouse, controller }]  held mice + the XR controller holding each
   * @param {Function} opts.clientForMouse  (mouse) => EmulatorClient|null  the console the mouse is plugged into
   * @param {Function} [opts.portForMouse]  (mouse) => number|null  the libretro mouse PORT (two-mouse co-op); null → single-mouse DOM path
   * @param {number}   [opts.gain]          world-metres → libretro-pixels gain
   * @param {Function} [opts.log]           telemetry sink log(name, fields)
   */
  constructor({ getActiveMice, clientForMouse, portForMouse = null, gain = DEFAULT_GAIN, log = null }) {
    this._getActiveMice = getActiveMice;
    this._clientForMouse = clientForMouse;
    this._portForMouse = typeof portForMouse === 'function' ? portForMouse : null;
    this._gain = gain;
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
   * @param {boolean}  [o.autoLock] request lock on click (default true)
   */
  attachDesktop({ getEl, getClient, getPort = () => null, autoLock = true } = {}) {
    if (this._desktopBound || typeof document === 'undefined') return;
    this._desktopBound = true;
    const el = getEl?.();
    if (!el) return;
    let buttons = 0;
    const send = (dx, dy) => {
      if (document.pointerLockElement == null) return; // only while locked
      const client = getClient?.();
      if (!client) return;
      client.sendMouse(dx, dy, buttons, getPort?.() ?? null);
    };
    if (autoLock) {
      el.addEventListener('click', () => {
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
}
