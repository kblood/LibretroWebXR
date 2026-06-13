// TV — one CRT display in the room: a cabinet + a screen plane whose material
// is the CRT shader ([[src/CrtShader.js]]) fed by a CanvasTexture sampling a
// source <canvas> (a console's emulator output). This is the THREE-reflection
// half of the rack's video side; which console feeds which TV is decided by the
// pure patch graph ([[src/Patchbay.js]]) and applied by the caller via
// setSource().
//
// Factored out of SceneMgr's single hardcoded TV so the rack can have many TVs,
// each independently routed. SceneMgr keeps the primary TV as `_tvs[0]` (built
// through this class) so the established single-console path is unchanged — it
// is just N=1 of a list.
//
// Per-frame the owner flips the texture's needsUpdate (markNeedsUpdate) so the
// GPU re-uploads the latest emulator frame; that upload is the per-TV perf cost
// the rack budget cares about, so a TV can be told to skip uploads (setActive)
// when its source is paused or it is out of view.

import * as THREE from 'three';
import { createCrtMaterial } from './CrtShader.js';

const DEFAULTS = { width: 2.2, height: 1.65, depth: 0.25 };

export class TV {
  /**
   * @param {object} opts
   * @param {string}  [opts.id]            stable id (Patchbay TV node key)
   * @param {HTMLCanvasElement} [opts.source]  initial source canvas
   * @param {[number,number,number]} [opts.position]  world position of the TV
   * @param {number} [opts.width] [opts.height] [opts.depth]  screen dimensions
   * @param {boolean} [opts.stand]  add a console-stand box under the TV
   * @param {boolean} [opts.glow]   add a soft blue glow light (default true)
   */
  constructor({ id = 'tv0', source = null, position = [0, 1.5, -3.6],
    width = DEFAULTS.width, height = DEFAULTS.height, depth = DEFAULTS.depth,
    stand = true, glow = true } = {}) {
    this.id = id;
    this.sourceCanvas = source;
    this._active = true;

    const group = new THREE.Group();
    group.position.set(position[0], position[1], position[2]);

    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.2, height + 0.2, depth),
      new THREE.MeshStandardMaterial({ color: 0x202028, roughness: 0.6 }),
    );
    cab.position.z = -depth / 2 - 0.005;
    group.add(cab);

    this.texture = this._makeTexture(source);
    this.material = createCrtMaterial(this.texture);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), this.material);
    this.mesh.name = `tv-screen-${id}`;
    group.add(this.mesh);

    if (glow) {
      const g = new THREE.PointLight(0x88aaff, 0.6, 3, 1.5);
      g.position.set(0, 0, 0.4);
      group.add(g);
    }

    if (stand) {
      const standH = 0.7, standW = 1.6, standD = 0.5;
      const s = new THREE.Mesh(
        new THREE.BoxGeometry(standW, standH, standD),
        new THREE.MeshStandardMaterial({ color: 0x33333d, roughness: 0.6 }),
      );
      // Group origin is the screen centre at y=position[1]; drop the stand to
      // the floor (its top just under the cabinet's lower edge).
      s.position.set(0, standH / 2 - position[1], 0);
      group.add(s);
    }

    this.group = group;
  }

  _makeTexture(canvas) {
    const tex = new THREE.CanvasTexture(canvas || undefined);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.NearestFilter; // pixel-art friendly
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    return tex;
  }

  /** Point this TV at a console's output canvas (the Patchbay video edge). */
  setSource(canvas) {
    if (!canvas || canvas === this.sourceCanvas) return;
    this.sourceCanvas = canvas;
    const tex = this._makeTexture(canvas);
    this.material.uniforms.tDiffuse.value = tex;
    if (this.texture) this.texture.dispose();
    this.texture = tex;
  }

  /** Paint a remote host's <video> (WebRTC track) instead of a canvas. */
  setVideo(videoEl) {
    if (!videoEl) return;
    const tex = new THREE.VideoTexture(videoEl);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.material.uniforms.tDiffuse.value = tex;
    if (this.texture) this.texture.dispose();
    this.texture = tex;
    this.sourceCanvas = null;
  }

  /** Toggle the CRT shader look: 'crt' (default) | 'flat'. */
  applyShader(mode) {
    const u = this.material?.uniforms;
    if (!u) return;
    if (mode === 'flat') {
      u.uCurvature.value = 0; u.uScanlineIntensity.value = 0; u.uMaskIntensity.value = 0; u.uVignette.value = 0;
    } else if (mode === 'crt') {
      u.uCurvature.value = 0.18; u.uScanlineIntensity.value = 0.22; u.uMaskIntensity.value = 0.15; u.uVignette.value = 0.35;
    }
  }

  /** Enable/disable per-frame texture uploads (perf: skip paused/out-of-view). */
  setActive(on) { this._active = !!on; }
  isActive() { return this._active; }

  /** Called once per frame by the render loop: re-upload the source frame.
   * Only canvas sources need manual upload — a VideoTexture self-updates. */
  markNeedsUpdate() {
    if (this._active && this.texture && this.sourceCanvas) {
      this.texture.needsUpdate = true;
    }
  }

  dispose() {
    try { this.texture?.dispose?.(); } catch (_) {}
    try { this.material?.dispose?.(); } catch (_) {}
    try { this.mesh?.geometry?.dispose?.(); } catch (_) {}
    try { this.group?.parent?.remove?.(this.group); } catch (_) {}
  }
}
