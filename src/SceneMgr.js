// Three.js scene + WebXR session. Renders the emulator's visible <canvas> as
// a textured plane (the "TV") inside a small dim room. Desktop browsers see
// the 3D scene rendered to a normal <canvas>; clicking "Enter VR" hands the
// WebXR session over to the headset.
//
// **Player-rig pattern.** Camera + both controllers live inside a
// `playerRig` THREE.Group. Locomotion translates / rotates the rig, not
// the camera (the XR pose overwrites the camera each frame, so direct
// camera moves would be ignored). See the WebXR cookbook at
// C:/Modding/CastleMaster/docs/webxr/webxr-threejs-tips.md §1.

import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { createCrtMaterial } from './CrtShader.js';

// Built-in surface colours a room can name as `builtin:<key>` without shipping
// a texture. Unknown keys fall back to mid-grey.
const BUILTIN_SURFACES = {
  'retro-blue':  '#26344f',
  'retro-green': '#2c4a32',
  'retro-pink':  '#4a2c3e',
  'crt-grey':    '#26262e',
  'wood':        '#5a3a22',
  'dark':        '#141418',
};

// time-of-day lighting presets (hemisphere ambient + warm key intensity/tint).
const TIME_OF_DAY = {
  day:     { hemi: 0.9,  hemiColor: 0x88aacc, key: 6.0, keyColor: 0xffffff },
  evening: { hemi: 0.5,  hemiColor: 0x6a5a6a, key: 4.0, keyColor: 0xffd9a0 },
  night:   { hemi: 0.25, hemiColor: 0x303048, key: 2.5, keyColor: 0x8899cc },
};

const isTextureUrl = (s) => typeof s === 'string' && /^(https?:|\/|\.\/|roms\/)/.test(s);

export class SceneMgr {
  constructor({ container, sourceCanvas, onControllerButton }) {
    this.container = container;
    this.sourceCanvas = sourceCanvas;
    this.onControllerButton = onControllerButton || (() => {});
    this._tickCallbacks = [];

    this._initRenderer();
    this._initScene();
    this._initAudio();
    this._initTV();
    this._initControllers();
    this._addResizeHandler();

    this.renderer.setAnimationLoop(() => this._render());
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setClearColor(0x101015);
    this.renderer.xr.enabled = true;
    // Standing-eye reference space so the XR origin is at floor=Y=0. Without
    // this, on Quest the player spawns at an arbitrary Y (sometimes inside
    // the floor). Cookbook §1: `local-floor` is the default for VR games.
    this.renderer.xr.setReferenceSpaceType('local-floor');
    // Quest sweet spot. 1.0 framebuffer + 0.7 fixed-foveation keeps the
    // periphery cheap without visible blur in the centre. Cookbook §3.1.
    this.renderer.xr.setFramebufferScaleFactor(1.0);
    this.renderer.xr.setFoveation(0.7);
    this.container.appendChild(this.renderer.domElement);
    document.body.appendChild(VRButton.createButton(this.renderer));
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a0e);
    this.scene.fog = new THREE.Fog(0x0a0a0e, 6, 18);

    // Player rig: camera + controllers all live inside this group. Locomotion
    // moves the rig. Default position puts the user near the back of the
    // room facing the TV.
    this.playerRig = new THREE.Group();
    this.playerRig.name = 'playerRig';
    this.playerRig.position.set(0, 0, 1.5);
    this.scene.add(this.playerRig);

    // Desktop fallback camera. In XR, three.js takes over with an
    // ArrayCamera derived from this one — but its parenting under the rig
    // is what makes locomotion work in XR.
    this.camera = new THREE.PerspectiveCamera(
      60,
      this.container.clientWidth / this.container.clientHeight,
      0.05,
      50,
    );
    this._cameraHome = new THREE.Vector3(0.6, 1.7, -1.1);
    this._cameraTarget = new THREE.Vector3(0, 1.4, -3.9);
    this.camera.position.copy(this._cameraHome);
    this.camera.lookAt(this._cameraTarget);
    this.playerRig.add(this.camera);

    // Build a 6m × 4m × 8m room. Each wall gets its OWN material clone so a
    // room file can repaper one wall without touching the others (per-wall
    // wallpaper_* overrides — see applyEnvironment / docs/ROOM_AND_COLLECTIONS).
    const roomW = 6, roomD = 8, roomH = 3.2;
    const wallMat   = new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.95 });
    const floorMat  = new THREE.MeshStandardMaterial({ color: 0x2a2a32, roughness: 0.85 });
    const ceilMat   = new THREE.MeshStandardMaterial({ color: 0x101015, roughness: 0.95 });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomD), floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomD), ceilMat);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = roomH;
    this.scene.add(ceiling);

    const back = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomH), wallMat.clone());
    back.position.set(0, roomH / 2, -roomD / 2);
    this.scene.add(back);

    const front = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomH), wallMat.clone());
    front.position.set(0, roomH / 2, roomD / 2);
    front.rotation.y = Math.PI;
    this.scene.add(front);

    const left = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), wallMat.clone());
    left.position.set(-roomW / 2, roomH / 2, 0);
    left.rotation.y = Math.PI / 2;
    this.scene.add(left);

    const right = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), wallMat.clone());
    right.position.set(roomW / 2, roomH / 2, 0);
    right.rotation.y = -Math.PI / 2;
    this.scene.add(right);

    // Refs so applyEnvironment() can repaper/relight after construction.
    this._roomDims = { w: roomW, d: roomD, h: roomH };
    this._floor = floor;
    this._ceiling = ceiling;
    this._walls = { back, front, left, right };
    this._lamps = []; // room-supplied point lights (cleared on re-apply)

    this._hemi = new THREE.HemisphereLight(0x404055, 0x101015, 0.7);
    this.scene.add(this._hemi);
    const key = new THREE.PointLight(0xfff0d0, 6.0, 10, 1.5);
    key.position.set(0, 2.6, -1.0);
    this._key = key;
    this.scene.add(key);
    const fill = new THREE.PointLight(0x5566aa, 1.5, 8, 1.8);
    fill.position.set(-1.2, 1.6, 1.2);
    this.scene.add(fill);
    // Two "spotlight" point lights aimed at the side shelves so the box
    // art reads at a glance. Without these the cartridges sit in the
    // room's dim corner shadows.
    const leftShelfLight = new THREE.PointLight(0xffe5b0, 2.2, 3.5, 1.6);
    leftShelfLight.position.set(-2.0, 1.9, -1.5);
    this.scene.add(leftShelfLight);
    const rightShelfLight = new THREE.PointLight(0xffe5b0, 2.2, 3.5, 1.6);
    rightShelfLight.position.set(2.0, 1.9, -1.5);
    this.scene.add(rightShelfLight);
  }

  _initAudio() {
    // Attaching the AudioListener to the camera (which lives under the
    // playerRig) means the listener's world transform follows the headset.
    // PositionalAudio sources placed elsewhere in the scene will then pan
    // and attenuate relative to head position.
    this.audioListener = new THREE.AudioListener();
    this.camera.add(this.audioListener);
  }

  _initTV() {
    const tvW = 2.2;
    const tvH = 1.65;
    const tvDepth = 0.25;

    const tvGroup = new THREE.Group();
    tvGroup.position.set(0, 1.5, -3.6);

    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(tvW + 0.2, tvH + 0.2, tvDepth),
      new THREE.MeshStandardMaterial({ color: 0x202028, roughness: 0.6 }),
    );
    cab.position.z = -tvDepth / 2 - 0.005;
    tvGroup.add(cab);

    this.screenTexture = this._makeScreenTexture(this.sourceCanvas);
    this.screenMaterial = createCrtMaterial(this.screenTexture);
    this.screenMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(tvW, tvH),
      this.screenMaterial,
    );
    tvGroup.add(this.screenMesh);

    const glow = new THREE.PointLight(0x88aaff, 0.6, 3, 1.5);
    glow.position.set(0, 0, 0.4);
    tvGroup.add(glow);

    const standH = 0.7, standW = 1.6, standD = 0.5;
    const stand = new THREE.Mesh(
      new THREE.BoxGeometry(standW, standH, standD),
      new THREE.MeshStandardMaterial({ color: 0x33333d, roughness: 0.6 }),
    );
    stand.position.set(0, standH / 2, -3.6);
    this.scene.add(stand);

    this.scene.add(tvGroup);
    this.tvGroup = tvGroup;
  }

  _makeScreenTexture(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.NearestFilter; // pixel-art friendly
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    return tex;
  }

  setScreenSource(canvas) {
    if (!canvas || canvas === this.sourceCanvas) return;
    this.sourceCanvas = canvas;
    const newTex = this._makeScreenTexture(canvas);
    if (this.screenMaterial) {
      this.screenMaterial.uniforms.tDiffuse.value = newTex;
    }
    if (this.screenTexture) this.screenTexture.dispose();
    this.screenTexture = newTex;
  }

  // M1.2: paint a remote host's game video (a <video> backed by a WebRTC track)
  // onto the CRT. A THREE.VideoTexture auto-uploads each frame in the render
  // loop. We clear sourceCanvas so a later setScreenSource(emuCanvas) — the
  // revert when the host stops — re-applies the local canvas texture.
  setScreenVideo(videoEl) {
    if (!videoEl) return;
    const tex = new THREE.VideoTexture(videoEl);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    if (this.screenMaterial) this.screenMaterial.uniforms.tDiffuse.value = tex;
    if (this.screenTexture) this.screenTexture.dispose();
    this.screenTexture = tex;
    this.sourceCanvas = null;
  }

  // --- Room environment (driven by RoomBuilder from a *.room.json) ---------

  /** Apply a room's `environment` block (surfaces + lighting). Safe on {}. */
  applyEnvironment(env) {
    if (!env || typeof env !== 'object') return;
    const s = env.surfaces || {};
    this._applySurface(this._floor.material, s.floor);
    this._applySurface(this._ceiling.material, s.ceiling);
    // `wallpaper` covers all four walls; `wallpaper_<b|f|l|r>` overrides one.
    const perWall = { back: 'wallpaper_b', front: 'wallpaper_f', left: 'wallpaper_l', right: 'wallpaper_r' };
    for (const [side, mesh] of Object.entries(this._walls)) {
      this._applySurface(mesh.material, s[perWall[side]] || s.wallpaper);
    }
    this._applyLighting(env.lighting);
  }

  _applySurface(mat, spec) {
    if (!mat || !spec) return;
    const tex = typeof spec === 'string' ? spec : spec.texture;
    const tiling = (typeof spec === 'object' && Array.isArray(spec.tiling)) ? spec.tiling : null;
    if (typeof spec === 'object' && spec.color) mat.color.set(spec.color);
    if (typeof tex === 'string' && tex.startsWith('builtin:')) {
      mat.map = null; mat.color.set(BUILTIN_SURFACES[tex.slice(8)] || '#444'); mat.needsUpdate = true; return;
    }
    if (typeof tex === 'string' && tex.startsWith('#')) {
      mat.map = null; mat.color.set(tex); mat.needsUpdate = true; return;
    }
    if (isTextureUrl(tex)) {
      new THREE.TextureLoader().load(tex, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        if (tiling) t.repeat.set(tiling[0], tiling[1]);
        mat.map = t; mat.color.set('#ffffff'); mat.needsUpdate = true;
      }, undefined, () => { /* keep base colour on load failure */ });
    }
  }

  _applyLighting(lighting) {
    // Clear previously room-supplied lamps so re-applying is idempotent.
    for (const l of this._lamps) this.scene.remove(l);
    this._lamps = [];
    if (!lighting || typeof lighting !== 'object') return;
    const tod = TIME_OF_DAY[lighting.timeOfDay];
    if (tod) {
      this._hemi.intensity = tod.hemi; this._hemi.color.setHex(tod.hemiColor);
      this._key.intensity = tod.key;   this._key.color.setHex(tod.keyColor);
    }
    for (const lamp of (Array.isArray(lighting.lamps) ? lighting.lamps : [])) {
      const p = new THREE.PointLight(new THREE.Color(lamp.color || '#ffd9a0'), lamp.intensity ?? 2.0, lamp.distance ?? 5, 1.6);
      const pos = Array.isArray(lamp.pos) ? lamp.pos : [0, 2, 0];
      p.position.set(pos[0], pos[1], pos[2]);
      this.scene.add(p);
      this._lamps.push(p);
    }
  }

  /** Apply a `tv` prop. Today: toggle the CRT shader (`crt` | `flat`). */
  applyTv(prop) {
    const u = this.screenMaterial?.uniforms;
    if (!u || !prop) return;
    if (prop.shader === 'flat') {
      u.uCurvature.value = 0; u.uScanlineIntensity.value = 0; u.uMaskIntensity.value = 0; u.uVignette.value = 0;
    } else if (prop.shader === 'crt') {
      u.uCurvature.value = 0.18; u.uScanlineIntensity.value = 0.22; u.uMaskIntensity.value = 0.15; u.uVignette.value = 0.35;
    }
  }

  _initControllers() {
    const factory = new XRControllerModelFactory();
    // Handedness map. `getController(i)` returns placeholders that get bound
    // to actual input sources after `connected` fires (cookbook §2.1). Until
    // then handedness is unknown.
    this.hands = { left: null, right: null };
    this.controllers = [];

    for (let i = 0; i < 2; i++) {
      const grip = this.renderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      this.playerRig.add(grip);

      const ctrl = this.renderer.xr.getController(i);
      const lineGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -3),
      ]);
      const lineMat = new THREE.LineBasicMaterial({ color: 0x88aaff });
      const line = new THREE.Line(lineGeom, lineMat);
      line.name = 'laser';
      ctrl.add(line);

      ctrl.userData.index = i;
      ctrl.userData.laser = line;
      ctrl.userData.laserMat = lineMat;
      ctrl.userData.handedness = null;
      ctrl.userData.inputSource = null;

      ctrl.addEventListener('connected', (e) => {
        ctrl.userData.inputSource = e.data;
        ctrl.userData.handedness = e.data.handedness;
        if (e.data.handedness === 'left') this.hands.left = ctrl;
        else if (e.data.handedness === 'right') this.hands.right = ctrl;
      });
      ctrl.addEventListener('disconnected', () => {
        const h = ctrl.userData.handedness;
        if (h && this.hands[h] === ctrl) this.hands[h] = null;
        ctrl.userData.inputSource = null;
      });

      // Forward selectstart/end (trigger) only. Grip is reserved for the
      // GrabMgr ([[src/GrabMgr.js]]) and must NEVER reach the emulator.
      ctrl.addEventListener('selectstart', () => this.onControllerButton('keydown', 'trigger', i));
      ctrl.addEventListener('selectend',   () => this.onControllerButton('keyup',   'trigger', i));

      this.playerRig.add(ctrl);
      this.controllers.push(ctrl);
    }

    // Synthetic "desktop controller": a third entry in `controllers` that
    // DesktopControls ([[src/DesktopControls.js]]) drives on a flat screen by
    // tracking the camera and dispatching select/squeeze events from the mouse.
    // It's pushed here — BEFORE GrabMgr/MenuMgr/LocomotionMgr are constructed —
    // so they auto-wire it like a real controller (ray from it, listen for its
    // events). LocomotionMgr skips it (no inputSource.gamepad); in VR it's inert
    // (DesktopControls never touches it while presenting). No laser child, so it
    // shows nothing in a headset.
    const desktop = new THREE.Group();
    desktop.name = 'desktop-controller';
    desktop.userData.index = 2;
    desktop.userData.handedness = null;
    desktop.userData.inputSource = null;
    this.playerRig.add(desktop);
    this.controllers.push(desktop);
    this.desktopController = desktop;
    this.desktopActive = false; // set true once DesktopControls takes the camera
  }

  addObject(obj) {
    this.scene.add(obj);
  }

  // Remove an object from the scene graph (e.g. the in-VR Change-mode shelf
  // rebuild swaps a shelf for one filled from a different collection).
  removeObject(obj) {
    this.scene.remove(obj);
  }

  // Register a per-frame tick callback. Used by LocomotionMgr and GrabMgr
  // for thumbstick polling and hover-target ray-casting.
  addTickCallback(fn) {
    this._tickCallbacks.push(fn);
  }

  _addResizeHandler() {
    window.addEventListener('resize', () => {
      // Cookbook §6: renderer.setSize is a no-op while presenting; skip then.
      if (this.renderer.xr.isPresenting) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
  }

  _render() {
    if (this.screenTexture) this.screenTexture.needsUpdate = true;

    if (!this.renderer.xr.isPresenting && !this.desktopActive) {
      // Desktop sway so the parallax sells the 3D-ness. Suppressed once the user
      // takes manual control via DesktopControls (mouse-look + WASD).
      const t = performance.now() * 0.0005;
      this.camera.position.set(
        this._cameraHome.x + Math.sin(t) * 0.25,
        this._cameraHome.y + Math.sin(t * 0.7) * 0.05,
        this._cameraHome.z + Math.cos(t) * 0.15,
      );
      this.camera.lookAt(this._cameraTarget);
    }

    // Run per-frame consumers (locomotion, grab hover) inside the XR
    // animation loop — cookbook §6 warns that pose data outside this
    // callback is stale.
    const dtMs = performance.now() - (this._lastTick || performance.now());
    this._lastTick = performance.now();
    for (const fn of this._tickCallbacks) {
      try { fn(dtMs); } catch (e) { console.warn('[SceneMgr tick]', e); }
    }

    this.renderer.render(this.scene, this.camera);
  }
}
