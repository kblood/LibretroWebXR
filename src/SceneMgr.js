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

    // Build a 6m × 4m × 8m room.
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

    const back = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomH), wallMat);
    back.position.set(0, roomH / 2, -roomD / 2);
    this.scene.add(back);

    const front = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomH), wallMat);
    front.position.set(0, roomH / 2, roomD / 2);
    front.rotation.y = Math.PI;
    this.scene.add(front);

    const left = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), wallMat);
    left.position.set(-roomW / 2, roomH / 2, 0);
    left.rotation.y = Math.PI / 2;
    this.scene.add(left);

    const right = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), wallMat);
    right.position.set(roomW / 2, roomH / 2, 0);
    right.rotation.y = -Math.PI / 2;
    this.scene.add(right);

    this.scene.add(new THREE.HemisphereLight(0x404055, 0x101015, 0.7));
    const key = new THREE.PointLight(0xfff0d0, 6.0, 10, 1.5);
    key.position.set(0, 2.6, -1.0);
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
  }

  addObject(obj) {
    this.scene.add(obj);
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

    if (!this.renderer.xr.isPresenting) {
      // Desktop sway so the parallax sells the 3D-ness.
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
