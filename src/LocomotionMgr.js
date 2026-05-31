// LocomotionMgr: thumbstick-driven smooth move + snap turn.
//
// While the gamepad is held BOTH thumbsticks become d-pad input for the
// emulator (see [[src/GameInputMgr.js]] — SNES-class games need a stick
// per hand). So if the gamepad is held, locomotion is disabled entirely;
// otherwise the standard rule applies — only controllers that aren't
// currently holding anything steer locomotion.
//
// Movement is head-relative on the XZ plane (no flying). Snap-turn rotates
// the player rig AROUND the head's world position (cookbook §11.7) so the
// player doesn't visibly slide sideways during a turn.
//
// Cookbook references: C:/Modding/CastleMaster/docs/webxr/webxr-threejs-tips.md
// §2.2 (reading thumbstick), §5 (locomotion comfort defaults), §11.7
// (rotate around camera, not rig origin), §11.8 (read head pose from XR
// camera matrixWorld).

import * as THREE from 'three';

const MOVE_SPEED   = 1.6;     // m/s when stick is full deflection
const DEAD_ZONE    = 0.15;
const SNAP_DEG     = 30;
const SNAP_DZ      = 0.7;     // higher threshold on the turn stick to avoid accidental snaps
const SNAP_DEBOUNCE_MS = 250;

export class LocomotionMgr {
  constructor({ renderer, playerRig, camera, controllers, isHandFree, isGamepadHeld }) {
    this.renderer = renderer;
    this.playerRig = playerRig;
    this.camera = camera;
    this.controllers = controllers;
    this.isHandFree = isHandFree || (() => true);
    this.isGamepadHeld = isGamepadHeld || (() => false);
    this._lastSnapAt = 0;
    // Re-used scratch vectors so the per-frame allocation overhead is zero
    // (cookbook §3.2 — Quest GC pauses are visible).
    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._headPos = new THREE.Vector3();
    this._headQuat = new THREE.Quaternion();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  tick(dtMs) {
    if (!this.renderer.xr.isPresenting) return;
    if (this.isGamepadHeld()) return;
    const dt = Math.min(dtMs, 50) / 1000; // clamp for hitch protection

    this._readHeadPose(this._headPos, this._headQuat);
    // Forward = -Z under the head quaternion, projected onto XZ plane.
    this._fwd.set(0, 0, -1).applyQuaternion(this._headQuat);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    // right = forward × up. Three.js right-handed: for fwd=(0,0,-1), up=(0,1,0),
    // right=(1,0,0). I had this inverted before, which strafed the wrong way.
    this._right.set(-this._fwd.z, 0, this._fwd.x);

    for (let i = 0; i < this.controllers.length; i++) {
      const ctrl = this.controllers[i];
      if (!this.isHandFree(ctrl)) continue;
      const gp = ctrl.userData.inputSource?.gamepad;
      if (!gp || !gp.axes || gp.axes.length < 4) continue;

      // xr-standard layout: axes[2] = thumbstick X, axes[3] = thumbstick Y.
      const x = gp.axes[2] || 0;
      const y = gp.axes[3] || 0;
      const hand = ctrl.userData.handedness;
      // Only steer when handedness is known. Quest can briefly report 'none'
      // after wake-from-sleep (cookbook §2.3) — falling back to "index 0 =
      // left" is explicitly NOT guaranteed and was swapping moves/turns.
      if (hand !== 'left' && hand !== 'right') continue;

      if (hand === 'left') {
        // Movement (forward/back + strafe).
        if (Math.abs(x) > DEAD_ZONE || Math.abs(y) > DEAD_ZONE) {
          const ax = Math.abs(x) > DEAD_ZONE ? x : 0;
          const ay = Math.abs(y) > DEAD_ZONE ? y : 0;
          // xr-standard: pushing stick forward gives axes[3] = -1, so -ay
          // resolves to +1 forward and we move along +_fwd.
          this._tmpV.copy(this._fwd).multiplyScalar(-ay * MOVE_SPEED * dt);
          this._tmpV.addScaledVector(this._right, ax * MOVE_SPEED * dt);
          this.playerRig.position.add(this._tmpV);
        }
      } else {
        // Snap turn (right hand).
        if (Math.abs(x) > SNAP_DZ) {
          const now = performance.now();
          if (now - this._lastSnapAt > SNAP_DEBOUNCE_MS) {
            const sign = Math.sign(x);
            this._snapTurn(-sign * THREE.MathUtils.degToRad(SNAP_DEG));
            this._lastSnapAt = now;
          }
        }
      }
    }
  }

  _snapTurn(angle) {
    // Rotate the rig around the head's world position so the head doesn't
    // visibly orbit the rig origin (cookbook §11.7).
    const camWorld = this._tmpV;
    this._readHeadPose(camWorld, this._tmpQ);
    const rigWorld = new THREE.Vector3();
    this.playerRig.getWorldPosition(rigWorld);
    const ox = camWorld.x - rigWorld.x;
    const oz = camWorld.z - rigWorld.z;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const nx = ox * cos - oz * sin;
    const nz = ox * sin + oz * cos;
    this.playerRig.position.x += ox - nx;
    this.playerRig.position.z += oz - nz;
    this.playerRig.rotation.y += angle;
  }

  _readHeadPose(outPos, outQuat) {
    // Read the head pose off the LEFT-EYE camera, not the ArrayCamera
    // wrapper. WebXRManager updates each eye's matrixWorld from XR pose data
    // every frame; the ArrayCamera's combined matrixWorld is set via copy
    // but in some three.js versions lags or stays at the rig-only transform,
    // which causes "forward" to ignore where the user is actually looking.
    // The eye is offset from head centre by IPD/2 ≈ 3 cm — negligible for
    // movement-direction math. Cookbook §11.8 explains the indirection.
    const xrCam = this.renderer.xr.getCamera?.();
    let src;
    if (xrCam && xrCam.cameras && xrCam.cameras.length > 0) {
      src = xrCam.cameras[0];
    } else {
      src = this.camera;
    }
    outPos.setFromMatrixPosition(src.matrixWorld);
    const m = new THREE.Matrix4().extractRotation(src.matrixWorld);
    outQuat.setFromRotationMatrix(m);
  }
}
