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
//
// PERF-1 (CODEX_REVIEW, 2026-08-15): that upload used to happen unconditionally,
// every XR frame, for every TV — including TVs showing a PAUSED console, where
// the picture is byte-identical to the one already on the GPU. A headset renders
// at 72-90 Hz while a console produces 50-60, so even a running core has frames
// where nothing new exists to upload. setFrameSignal() lets the owner supply the
// producer's frame mark: uploads happen only when that mark CHANGES. A TV with
// no signal keeps the old behaviour and uploads every frame — that is the honest
// default for a producer we cannot interrogate (a WebGL core drawing straight
// into its own canvas, or the animated idle screen), and it means this
// optimisation can never blank a screen it does not understand.

import * as THREE from 'three';
import { createCrtMaterial } from './CrtShader.js';

/** The frame mark of a console that cannot produce a new picture right now. */
export const PAUSED_MARK = 'paused';

/**
 * The standard frame mark for a libretro client (PERF-1). main.js's routeVideo()
 * wraps this in a closure per TV; it lives here, next to the only thing that
 * consumes a mark, so the POLICY is testable without main.js — which is 7k lines
 * of browser-only application and therefore not testable at all.
 *
 * Returns:
 *   PAUSED_MARK — paused or powered-off: the picture cannot change.
 *   a number    — the worker path's presented-frame counter.
 *   null        — "I don't know": a core drawing straight into its own canvas,
 *                 or no client. The caller must upload every frame for these.
 *                 Never guess a mark for a producer you cannot observe; a wrong
 *                 "unchanged" freezes a live screen, a wrong "changed" costs one
 *                 texture upload.
 */
export function frameMarkOf(client) {
  if (!client) return null;
  if (client.paused) return PAUSED_MARK;
  const presented = client.frameBridge?.framesPresented;
  return typeof presented === 'number' ? presented : null;
}

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
    // Set instead of sourceCanvas while a remote host's <video> is on this
    // screen (see setVideo); the pair is mutually exclusive.
    this.sourceVideo = null;
    this._active = true;
    // PERF-1 upload gating. No signal until the owner supplies one, so a TV
    // built and never wired behaves exactly as it did before.
    this._frameSignal = null;
    this._lastFrameMark = null;
    this.uploads = 0;
    this.uploadsSkipped = 0;

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

    // Video-in jack: a yellow RCA-style socket on the lower-left of the cabinet
    // front. A console's video cord plug ([[src/Plug.js]]) seats here to feed
    // this TV (the Patchbay video edge). videoIn is the world-space anchor the
    // cord/snap system reads; the mesh is just its visible marker.
    const jack = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 0.03, 12),
      new THREE.MeshStandardMaterial({ color: 0xccaa22, roughness: 0.5, metalness: 0.4 }),
    );
    jack.rotation.x = Math.PI / 2;             // face forward (+Z)
    jack.position.set(-width / 2 + 0.12, -height / 2 + 0.12, 0.02);
    group.add(jack);
    const videoIn = new THREE.Object3D();
    videoIn.position.set(jack.position.x, jack.position.y, 0.05);
    group.add(videoIn);
    this.videoIn = videoIn;
    this.videoInMesh = jack;

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
    this.sourceVideo = null;
    // A different producer's marks mean nothing to the old one's: the first
    // frame off a newly-routed canvas must always upload, or a repatch could
    // leave the previous console's picture frozen on this screen.
    this._lastFrameMark = null;
    const tex = this._makeTexture(canvas);
    this.material.uniforms.tDiffuse.value = tex;
    if (this.texture) this.texture.dispose();
    this.texture = tex;
  }

  /** Paint a remote host's <video> (WebRTC track) instead of a canvas.
   * Idempotent per element (like setSource): routeVideo() re-asserts a watching
   * client's host feed on every local re-route, so without this dedupe each
   * power-toggle / console-spawn / repatch would build and leak a fresh
   * VideoTexture for the same stream. */
  setVideo(videoEl) {
    if (!videoEl || videoEl === this.sourceVideo) return;
    this.sourceVideo = videoEl;
    const tex = new THREE.VideoTexture(videoEl);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.material.uniforms.tDiffuse.value = tex;
    if (this.texture) this.texture.dispose();
    this.texture = tex;
    this.sourceCanvas = null;
    // A VideoTexture uploads itself; any canvas frame signal on this screen
    // belongs to a producer we are no longer showing.
    this._frameSignal = null;
    this._lastFrameMark = null;
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

  /**
   * Supply the producer's frame mark for this TV's current source (PERF-1).
   * `fn()` returns any value that CHANGES when a new frame has been drawn and
   * stays equal when it has not — a presented-frame counter, or a frozen
   * sentinel while the console is paused. Returning null/undefined means "I
   * don't know", which uploads every frame, exactly as before.
   *
   * Pass no function to go back to that unconditional behaviour. Either way the
   * next markNeedsUpdate() uploads once: the mark we last uploaded belongs to a
   * bookkeeping scheme that is being replaced, so it cannot be trusted to say
   * "the GPU already has this".
   */
  setFrameSignal(fn) {
    this._frameSignal = typeof fn === 'function' ? fn : null;
    this._lastFrameMark = null;
  }

  /** Called once per frame by the render loop: re-upload the source frame.
   * Only canvas sources need manual upload — a VideoTexture self-updates.
   * Returns true when an upload was actually requested (the render loop counts
   * these, so "the fix is working" is a number and not a belief). */
  markNeedsUpdate() {
    if (!this._active || !this.texture || !this.sourceCanvas) return false;
    if (this._frameSignal) {
      let mark;
      // A signal reads through to a runtime that can be torn down under us; a
      // throw here would kill the whole render loop for every other TV, so a
      // broken signal degrades to the unconditional upload instead.
      try { mark = this._frameSignal(); } catch (_) { mark = null; }
      if (mark != null) {
        if (mark === this._lastFrameMark) { this.uploadsSkipped++; return false; }
        this._lastFrameMark = mark;
      }
    }
    this.texture.needsUpdate = true;
    this.uploads++;
    return true;
  }

  /** Uploaded/skipped counters for this screen (probe + headset-log hook). */
  uploadStats() { return { id: this.id, uploads: this.uploads, skipped: this.uploadsSkipped }; }

  dispose() {
    try { this.texture?.dispose?.(); } catch (_) {}
    try { this.material?.dispose?.(); } catch (_) {}
    try { this.mesh?.geometry?.dispose?.(); } catch (_) {}
    try { this.group?.parent?.remove?.(this.group); } catch (_) {}
  }
}
