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
// Aim heartbeat throttle. This was 0.25s (~4 Hz), which while a gun is HELD floods
// the remote log with hundreds of aim entries and pushes the rare-but-vital boot /
// lightgun-boot / fire events out of the server's retained window — i.e. the spam
// buried exactly the events needed to diagnose a gun boot. The meaningful signal is
// carried by hit/miss FLIPS (always logged) and FIREs (per trigger edge); the
// periodic heartbeat only needs to confirm "still aiming", so 5s is ample and keeps
// the log readable. See docs/LIGHTGUN_SUPPORT.md telemetry notes.
const AIM_LOG_INTERVAL = 5.0;   // seconds — slow heartbeat; flips + fires carry signal

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
   * @param {Function} opts.clientForGun    (gun) => EmulatorClient|null  the console the gun is plugged into.
   *        Receives sendLightgun() per tick, plus clearLightgun(port) when this
   *        gun's (console, port) binding changes or the gun leaves the active
   *        set — clearLightgun is optional on the client (see _releaseGunPort).
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
    // Multiport port-release bookkeeping: gun -> { client, key, port } for every
    // gun currently driving a libretro PORT through the multiport path. The
    // patched cores latch `lightgun[port].active = true` on the first per-port
    // write and that port then IGNORES the shared DOM mouse until something
    // calls client.clearLightgun(port) — so when a gun stops driving a port, it
    // has to be handed back explicitly or it freezes at its last aim with its
    // last trigger bit held (see EmulatorClient.clearLightgun).
    //
    // This manager is the right place to notice that because it is the only
    // thing that knows, every frame, the AUTHORITATIVE set of (console, port)
    // bindings actually being driven: getActiveGuns() is the held guns and
    // portForGun()/consoleIdForGun() resolve each one's live cable seat. So the
    // release is EVENT-driven (the binding changed / the gun left the set), not
    // inferred from how sendLightgun happened to be called — a gun that simply
    // holds still keeps sending the same port forever, so no call-pattern
    // heuristic can tell "stopped driving" from "unchanged".
    //
    // A Map (not a WeakMap) because the sweep has to ENUMERATE it; entries are
    // removed the moment a gun stops driving a port, so it holds at most one
    // entry per gun currently in a two-gun co-op seat.
    this._gunPortBindings = new Map();
  }

  /** Per-frame update. dt in seconds (for muzzle-flash decay). */
  tick(dt = 0.016) {
    const guns = this._getActiveGuns?.() || [];
    this._aimAccum += dt;
    const aimDue = this._aimAccum >= AIM_LOG_INTERVAL;
    // Guns that drove a port this tick. Only allocated when something was
    // latched before this tick began — with nothing latched there is nothing to
    // release, and a null set tells the sweep to skip entirely (every binding it
    // could see would have been created by THIS tick, i.e. is live by
    // definition).
    const drivenThisTick = this._gunPortBindings.size ? new Set() : null;

    // PASS 1 — resolve every gun's live seat (client + console + port) and
    // settle ALL multiport port bindings for the tick. Deliberately a separate
    // pass: every release for this tick therefore lands BEFORE any aim in it, so
    // two guns swapping each other's jacks in one frame can't have gun B's
    // release of the port gun A just took wipe A's freshly-written aim.
    const seats = [];
    for (const { gun, controller } of guns) {
      const ud = gun?.userData;
      if (!ud?.getAimRay) continue;
      const client = this._clientForGun?.(gun) || null;
      const myConsole = this._consoleIdForGun?.(gun) ?? null;
      // Per-gun controller port for two-gun co-op (gun A→portX, gun B→portY drive
      // independent aim points via the patched multiport core). null/undefined →
      // sendLightgun without a port = single-gun DOM-mouse path (unchanged).
      const gunPort = this._portForGun ? this._portForGun(gun) : null;
      this._noteGunPortBinding(gun, client, myConsole, gunPort, drivenThisTick);
      seats.push({ gun, controller, ud, client, myConsole, gunPort });
    }
    // Any gun that held a port but did NOT drive one this tick (dropped, or it
    // has no aim ray) hands its port back.
    this._sweepGunPortBindings(drivenThisTick);

    if (!guns.length) return;
    const targets = this._getScreenTargets?.() || [];
    const meshes = targets.map((t) => t.mesh);

    // PASS 2 — aim.
    for (const { gun, controller, ud, client, myConsole, gunPort } of seats) {
      const trigger = !!controller?.userData?.inputSource?.gamepad?.buttons?.[0]?.pressed;

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

  /**
   * Record the (console, port) this gun drives this tick, releasing the port it
   * drove before if that binding changed. `key` folds console + port together so
   * a gun moved between consoles onto the same port number still counts as a
   * change — and so the comparison never depends on client OBJECT identity,
   * which is not stable: on a non-host multiplayer peer main.js's _gunClientFor
   * builds a fresh forwarding shim on every call.
   * @private
   */
  _noteGunPortBinding(gun, client, consoleId, port, drivenThisTick) {
    const prev = this._gunPortBindings.get(gun);
    // No client or no port = this gun is on the shared DOM-mouse path (or is
    // unplugged) and has nothing latched of its own.
    const key = client && port != null ? `${consoleId ?? '?'}:${port}` : null;
    if (prev && prev.key !== key) this._releaseGunPort(prev);
    if (key == null) {
      if (prev) this._gunPortBindings.delete(gun);
      return;
    }
    // Refresh the client on an unchanged binding: after a console reboot the
    // same (console, port) is served by a NEW client instance, and the release
    // has to reach the live one.
    if (prev && prev.key === key) prev.client = client;
    else this._gunPortBindings.set(gun, { client, key, port });
    drivenThisTick?.add(gun);
  }

  /** Release every recorded port whose gun did not drive it this tick. @private */
  _sweepGunPortBindings(drivenThisTick) {
    if (!drivenThisTick || !this._gunPortBindings.size) return;
    for (const [gun, rec] of [...this._gunPortBindings]) {
      if (drivenThisTick.has(gun)) continue;
      this._gunPortBindings.delete(gun);
      this._releaseGunPort(rec);
    }
  }

  /** @private */
  _releaseGunPort(rec) {
    // Optional on the client: a delegate without clearLightgun is one that never
    // had the multiport setter either, so nothing was ever latched.
    try { rec?.client?.clearLightgun?.(rec.port); } catch (_) { /* client gone */ }
  }
}

function round3(n) { return Math.round(n * 1000) / 1000; }
