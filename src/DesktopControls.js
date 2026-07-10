// DesktopControls — mouse-look + WASD + click interaction for the FLAT-SCREEN
// (non-VR) build, so the in-VR features (Move/Change/Add edit modes, grabbing
// props, inserting cartridges, the wall menu) are all usable on a normal PC.
//
// It drives the camera/rig directly and feeds the EXISTING managers through the
// synthetic "desktop controller" ([[src/SceneMgr.js]] `desktopController`): the
// mouse's buttons dispatch the same `select*`/`squeeze*` events an XR controller
// would, and the controller tracks the camera so GrabMgr/MenuMgr ray from where
// you're looking. No manager logic changes.
//
// Everything is gated on `!renderer.xr.isPresenting`, so entering a headset
// leaves the desktop listeners completely inert (the XR controllers take over).
//
// Key split that makes this safe: gameplay keys (arrows, Enter, Space, H/G/Y/T/
// E/P/R/O) are forwarded to the core by [[src/InputMgr.js]]; movement uses W/A/
// S/D and duck uses C, which that forward-set deliberately excludes — so
// walking/ducking never reach the emulator.

import * as THREE from 'three';

const LOOK_SENS = 0.0022;          // radians per pixel of mouse motion
const MOVE_SPEED = 2.0;            // m/s walking
const PITCH_LIMIT = THREE.MathUtils.degToRad(85);
const WALL_MARGIN = 0.5;           // keep the rig this far from the walls
const DUCK_OFFSET = 0.5;           // m the rig drops while KeyC is held
const DUCK_LERP_SPEED = 8;         // 1/s — smoothed so the drop isn't a snap

export class DesktopControls {
  constructor({ renderer, camera, playerRig, controller, domElement, scene }) {
    this.renderer = renderer;
    this.camera = camera;
    this.playerRig = playerRig;
    this.controller = controller;
    this.dom = domElement;
    this.scene = scene;

    this.yaw = 0;
    this.pitch = 0;
    this._initialized = false;
    this.locked = false;
    this.grabbed = false;            // right-click grab is a toggle
    this.keys = new Set();

    // Scratch vectors (avoid per-frame allocation).
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._dir = new THREE.Vector3();

    this._bind();
  }

  // Derive starting yaw/pitch from wherever the camera is currently aimed, so
  // taking control doesn't snap the view. forward = (-cosP·sinY, sinP, -cosP·cosY).
  _initFromCamera() {
    this.camera.getWorldDirection(this._dir);
    this.pitch = Math.asin(THREE.MathUtils.clamp(this._dir.y, -1, 1));
    this.yaw = Math.atan2(-this._dir.x, -this._dir.z);
    this._initialized = true;
  }

  _bind() {
    // Click the canvas to capture the mouse (enter look mode). Esc releases it
    // (browser default). The first, not-yet-locked click only requests lock;
    // interaction clicks are gated on `this.locked` in _onMouseDown.
    this.dom.addEventListener('click', () => {
      if (this.renderer.xr.isPresenting) return;
      if (!this.locked) this.dom.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.locked && !this._initialized) this._initFromCamera();
      if (this.locked) this.scene.desktopActive = true; // stop the auto-sway
      // Toggle the crosshair / hint overlay (see index.html).
      document.body.classList.toggle('pointer-locked', this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.renderer.xr.isPresenting) return;
      this.yaw -= e.movementX * LOOK_SENS;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT);
    });

    document.addEventListener('mousedown', (e) => this._onMouseDown(e));
    document.addEventListener('mouseup', (e) => this._onMouseUp(e));
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (this.renderer.xr.isPresenting) return;
      const k = e.code;
      if (k === 'KeyW' || k === 'KeyA' || k === 'KeyS' || k === 'KeyD' || k === 'KeyC') this.keys.add(k);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
  }

  _onMouseDown(e) {
    if (!this.locked || this.renderer.xr.isPresenting) return;
    if (e.button === 0) this._dispatch('selectstart');       // left = menu/select
    else if (e.button === 2) this._toggleGrab();             // right = grab/drop toggle
  }

  _onMouseUp(e) {
    if (this.renderer.xr.isPresenting) return;
    if (e.button === 0) this._dispatch('selectend');
  }

  // Grab is a toggle so you can carry a prop while walking (a momentary hold is
  // awkward with WASD). Odd right-clicks squeeze, even ones release.
  _toggleGrab() {
    this.grabbed = !this.grabbed;
    this._dispatch(this.grabbed ? 'squeezestart' : 'squeezeend');
  }

  // Dispatch a synthetic XR-controller event after refreshing the controller's
  // world pose so GrabMgr's `ctrl.attach(target)` reads where we're aiming.
  _dispatch(type) {
    this._syncController();
    this.controller.updateMatrixWorld(true);
    this.controller.dispatchEvent({ type });
  }

  // Copy the camera's local transform onto the synthetic controller so its world
  // ray equals the camera forward (and a grabbed object parents in front of view).
  _syncController() {
    this.controller.position.copy(this.camera.position);
    this.controller.quaternion.copy(this.camera.quaternion);
  }

  _applyCameraRotation() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  // Per-frame: apply look rotation, walk with WASD, duck with C, keep the
  // controller synced.
  tick(dtMs) {
    if (this.renderer.xr.isPresenting) return;
    if (!this._initialized && this.locked) this._initFromCamera();
    if (this._initialized) this._applyCameraRotation();

    const dt = Math.min(dtMs || 16, 50) / 1000;

    if (this.keys.size) {
      // forward on the XZ plane from yaw: (-sinY, 0, -cosY); right = (-fwd.z,0,fwd.x).
      this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this._right.set(-this._fwd.z, 0, this._fwd.x);
      const step = MOVE_SPEED * dt;
      if (this.keys.has('KeyW')) this.playerRig.position.addScaledVector(this._fwd, step);
      if (this.keys.has('KeyS')) this.playerRig.position.addScaledVector(this._fwd, -step);
      if (this.keys.has('KeyD')) this.playerRig.position.addScaledVector(this._right, step);
      if (this.keys.has('KeyA')) this.playerRig.position.addScaledVector(this._right, -step);
      this._clampToRoom();
    }

    // Duck: smoothed so releasing C eases back to standing instead of
    // snapping (checked every frame, not gated on `keys.size`, so standing
    // back up still animates on the frame C is released).
    const duckTarget = this.keys.has('KeyC') ? -DUCK_OFFSET : 0;
    this.playerRig.position.y += (duckTarget - this.playerRig.position.y) * Math.min(1, DUCK_LERP_SPEED * dt);

    this._syncController();
  }

  _clampToRoom() {
    const dims = this.scene._roomDims;
    if (!dims) return;
    const hx = dims.w / 2 - WALL_MARGIN;
    const hz = dims.d / 2 - WALL_MARGIN;
    this.playerRig.position.x = THREE.MathUtils.clamp(this.playerRig.position.x, -hx, hx);
    this.playerRig.position.z = THREE.MathUtils.clamp(this.playerRig.position.z, -hz, hz);
  }

  // --- headless / debug hooks (pointer lock + real mouse can't be synthesized
  // in the test harness, so expose thin programmatic equivalents) ---
  debugApi() {
    return {
      // Aim the view (radians). Also marks initialized so tick applies it.
      look: (yaw, pitch) => {
        this.yaw = yaw;
        this.pitch = THREE.MathUtils.clamp(pitch ?? 0, -PITCH_LIMIT, PITCH_LIMIT);
        this._initialized = true;
        this._applyCameraRotation();
        this.scene.desktopActive = true;
        this._syncController();
        this.controller.updateMatrixWorld(true);
      },
      // Walk `meters` along the current forward (or strafe with axis 'right').
      move: (meters, axis = 'forward') => {
        this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        this._right.set(-this._fwd.z, 0, this._fwd.x);
        const v = axis === 'right' ? this._right : this._fwd;
        this.playerRig.position.addScaledVector(v, meters);
        this._clampToRoom();
        this.playerRig.updateMatrixWorld(true);
      },
      leftClick: () => { this._dispatch('selectstart'); this._dispatch('selectend'); },
      rightClick: () => this._toggleGrab(),
      duck: (on) => { if (on) this.keys.add('KeyC'); else this.keys.delete('KeyC'); },
      state: () => ({
        yaw: this.yaw, pitch: this.pitch, locked: this.locked, grabbed: this.grabbed,
        rig: this.playerRig.position.toArray(),
      }),
    };
  }
}
