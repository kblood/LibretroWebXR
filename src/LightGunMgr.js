// LightGunMgr — per-frame light-gun aiming. For each held gun it raycasts the
// barrel ray ([[src/LightGun.js]] getAimRay) against the rack's TV screen meshes
// ([[src/TV.js]] .mesh), converts the hit to the source console's canvas u,v, and
// calls that console's EmulatorClient.sendLightgun(u, v, trigger). No hit (or a
// hit on a TV showing a different console) is an off-screen shot — a reload.
//
// The UV conversion is the subtle part and lives in the pure, exported
// surfaceUvToCanvasUv() so it can be unit-tested without a scene:
//   • The CRT material ([[src/CrtShader.js]]) displays the game pixel at
//     texture-coord curve(vUv) on the surface point vUv, so the pixel the user
//     sees where the ray lands is curve(rayHitUv) — we apply the SAME curve().
//   • The TV's CanvasTexture has flipY=true, and PlaneGeometry UVs put v=0 at the
//     bottom while EmulatorClient.sendLightgun() expects v=0 at the TOP of the
//     canvas — so the v axis is flipped: canvasV = 1 - curve(vUv).y. U is direct.
//
// The manager is decoupled from SceneMgr/RackMgr/GrabMgr via injected accessors
// so the same code serves the single-console and multi-console paths and is
// testable. main.js supplies the accessors.

import * as THREE from 'three';

const DEFAULT_CURVATURE = 0.18; // must match CrtShader's uCurvature default
const AIM_LOG_INTERVAL = 0.25;  // seconds — throttle aim telemetry to ~4 Hz

/**
 * Replicate the CRT shader's barrel `curve()` and convert a screen-surface UV
 * (from a raycast against the TV plane; origin bottom-left, v up) to the
 * console canvas u,v that EmulatorClient.sendLightgun() expects (origin
 * top-left, v down). Pure — exported for unit tests.
 * @returns {{u:number, v:number}}
 */
export function surfaceUvToCanvasUv(su, sv, curvature = DEFAULT_CURVATURE) {
  // curve(): uv = uv*2-1; offset = abs(uv.yx)/vec2(5,4)*curv; uv += uv*offset^2;
  // uv = uv*0.5+0.5  (see CrtShader.js FRAG)
  let x = su * 2 - 1;
  let y = sv * 2 - 1;
  const offX = (Math.abs(y) / 5) * curvature; // offset.x uses uv.y
  const offY = (Math.abs(x) / 4) * curvature; // offset.y uses uv.x
  x = x + x * offX * offX;
  y = y + y * offY * offY;
  const tu = x * 0.5 + 0.5;
  const tv = y * 0.5 + 0.5;
  return { u: tu, v: 1 - tv };
}

export class LightGunMgr {
  /**
   * @param {object} opts
   * @param {Function} opts.getActiveGuns   () => [{ gun, controller }]  held guns + the XR controller holding each
   * @param {Function} opts.getScreenTargets () => [{ tvId, mesh }]      the rack's TV screen meshes to raycast
   * @param {Function} opts.consoleIdForTV  (tvId) => consoleId|null     which console feeds a TV (Patchbay.sourceOf)
   * @param {Function} opts.clientForGun    (gun) => EmulatorClient|null  the console the gun is plugged into
   * @param {Function} opts.consoleIdForGun (gun) => consoleId|null       the console the gun is plugged into
   * @param {Function} [opts.portForGun]    (gun) => number|null          the controller PORT (0-based) this gun drives.
   *        Required for two-gun co-op: gun A → port X, gun B → port Y feed two
   *        independent aim points into the patched multiport core. When it
   *        returns null/absent, sendLightgun() is called without a port → the
   *        single-gun DOM-mouse path (unchanged). Single-gun games can leave it
   *        unset and still work via that fallback.
   * @param {number}   [opts.curvature]     CRT curvature (defaults to the shader's)
   */
  constructor({ getActiveGuns, getScreenTargets, consoleIdForTV, clientForGun, consoleIdForGun, portForGun = null, curvature = DEFAULT_CURVATURE, log = null }) {
    this._getActiveGuns = getActiveGuns;
    this._getScreenTargets = getScreenTargets;
    this._consoleIdForTV = consoleIdForTV;
    this._clientForGun = clientForGun;
    this._consoleIdForGun = consoleIdForGun;
    this._portForGun = typeof portForGun === 'function' ? portForGun : null;
    this._curvature = curvature;
    // Optional telemetry sink: log(name, fields). Used to diagnose headset aim
    // without seeing the screen (see docs/HEADSET_LIGHTGUN_VALIDATION.md). Aim is
    // throttled; fire is per rising-edge. No-op when null (default).
    this._log = typeof log === 'function' ? log : null;
    this._aimAccum = 0;             // seconds since the last throttled aim log
    this._lastOnScreen = new WeakMap();
    this._raycaster = new THREE.Raycaster();
    this._ray = new THREE.Ray();
    // Per-gun previous trigger state, to flash on the rising edge.
    this._wasTriggered = new WeakMap();
  }

  /** Per-frame update. dt in seconds (for muzzle-flash decay). */
  tick(dt = 0.016) {
    const guns = this._getActiveGuns?.() || [];
    this._aimAccum += dt;
    const aimDue = this._aimAccum >= AIM_LOG_INTERVAL;
    if (!guns.length) return;
    const targets = this._getScreenTargets?.() || [];
    const meshes = targets.map((t) => t.mesh);

    for (const { gun, controller } of guns) {
      const ud = gun?.userData;
      if (!ud?.getAimRay) continue;

      const trigger = !!controller?.userData?.inputSource?.gamepad?.buttons?.[0]?.pressed;
      const client = this._clientForGun?.(gun) || null;
      const myConsole = this._consoleIdForGun?.(gun) ?? null;
      // Per-gun controller port for two-gun co-op (gun A→portX, gun B→portY drive
      // independent aim points via the patched multiport core). null/undefined →
      // sendLightgun without a port = single-gun DOM-mouse path (unchanged).
      const gunPort = this._portForGun ? this._portForGun(gun) : null;

      // Raycast the barrel ray against the TV screens.
      ud.getAimRay(this._ray);
      this._raycaster.set(this._ray.origin, this._ray.direction);
      let hit = null;
      if (meshes.length) {
        const hits = this._raycaster.intersectObjects(meshes, false);
        if (hits.length) hit = hits[0];
      }

      let onScreen = false, aimU = -1, aimV = -1, aimTv = null, aimConsole = null;
      if (hit && hit.uv) {
        // Only a hit on a TV showing THIS gun's console counts as on-screen.
        const tvId = targets.find((t) => t.mesh === hit.object)?.tvId ?? null;
        const srcConsole = tvId != null ? this._consoleIdForTV?.(tvId) : null;
        if (myConsole == null || srcConsole == null || srcConsole === myConsole) {
          const { u, v } = surfaceUvToCanvasUv(hit.uv.x, hit.uv.y, this._curvature);
          client?.sendLightgun(u, v, trigger, gunPort);
          onScreen = true; aimU = u; aimV = v; aimTv = tvId; aimConsole = srcConsole;
        }
      }
      if (!onScreen) {
        // Off-screen: out-of-range coords so a held trigger reads as a reload.
        client?.sendLightgun(-1, -1, trigger, gunPort);
      }

      // Telemetry: fire on every trigger rising edge; aim throttled OR whenever
      // the on/off-screen state flips (so a miss/hit transition is always logged).
      const wasTrig = !!this._wasTriggered.get(gun);
      if (this._log) {
        const flipped = this._lastOnScreen.get(gun) !== onScreen;
        if (trigger && !wasTrig) this._log('lightgun-fire', { consoleId: aimConsole ?? myConsole, tvId: aimTv, onScreen, u: round3(aimU), v: round3(aimV) });
        if (aimDue || flipped) this._log('lightgun-aim', { consoleId: aimConsole ?? myConsole, tvId: aimTv, onScreen, u: round3(aimU), v: round3(aimV) });
        this._lastOnScreen.set(gun, onScreen);
      }

      // Prop feedback: trigger depress + muzzle flash on the rising edge.
      ud.setTriggered?.(trigger);
      if (trigger && !wasTrig) ud.fireFlash?.();
      this._wasTriggered.set(gun, trigger);
      ud.tick?.(dt);
    }
    if (aimDue) this._aimAccum = 0;
  }
}

function round3(n) { return Math.round(n * 1000) / 1000; }
