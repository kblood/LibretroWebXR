// C64Keyboard: world-space virtual keyboard panel for the VR frontend.
//
// Renders the full C64 key layout as a CanvasTexture on a Three.js
// PlaneGeometry. The controller laser points at keys and a trigger
// press fires a keydown/keyup pair into the emulator via the injected
// `sendInput` callback — same signature as EmulatorClient.sendInput().
//
// ------------------------------------------------------------------
// USAGE (orchestrator integration — do NOT call from this file)
// ------------------------------------------------------------------
//   import { C64Keyboard } from './C64Keyboard.js';
//
//   const kbd = new C64Keyboard({
//     sendInput: (type, code, key, keyCode, location) => client.sendInput(type, code, key, keyCode, location),
//     position: new THREE.Vector3(0, 1.1, -1.5),
//     rotationX: -Math.PI / 6,   // tilt toward the user (optional)
//   });
//   scene.add(kbd.object3d);
//
//   // Each XR frame, call hitTest() with the UV hit from a Raycaster
//   // intersection against kbd.object3d, and hover/tap accordingly:
//   const uv = intersect?.uv;   // THREE.Vector2 from Raycaster
//   if (uv) kbd.setHover(uv.x, 1 - uv.y);   // THREE UVs have V flipped
//   if (triggerPressed) kbd.tap(hoveredKeyId);
//
//   // Show/hide for C64 games:
//   kbd.object3d.visible = (system === 'c64' || system === 'vic20');
//
// ------------------------------------------------------------------
// INTEGRATION HOOKS for main.js / systems.js (proposed)
// ------------------------------------------------------------------
//  • After GameInputMgr.setSystem(system), if system === 'c64' or
//    system === 'vic20' set kbd.object3d.visible = true; else false.
//  • In the XR frame loop, after MenuMgr.tick(), call kbd.tick() so
//    it can age out the visual highlight without a separate timer.
//  • Feed the Raycaster UV of a controller pointing at kbd.object3d
//    into kbd.setHover(u, v) each frame.
//  • On controller selectstart (trigger): call kbd.pressHovered(ctrl).
//  • On controller selectend: call kbd.releaseHovered(ctrl).
//    Alternatively, use kbd.tap(keyId) for an immediate auto-release
//    (tap mode: keydown + 80 ms + keyup, no explicit release needed).
//
// ------------------------------------------------------------------
// WHY NO MENUMANAGER INTEGRATION
// ------------------------------------------------------------------
// MenuMgr raycasts individual child meshes. The keyboard is a single
// mesh (UV hit-test driven) so it bypasses MenuMgr entirely. The
// orchestrator should add kbd.mesh (not kbd.object3d) to its own
// Raycaster call, or add a thin wrapper that calls kbd.setHover() /
// kbd.pressHovered() when a hit is detected.
//
// ------------------------------------------------------------------
// DEPENDENCIES
// ------------------------------------------------------------------
// THREE (peer dependency — same version as the rest of the app).
// C64KeyLayout.js (sibling pure module).

import * as THREE from 'three';
import { C64_KEYS, COLS, ROWS, keyAt, keyEventFor, keyDef } from './C64KeyLayout.js';

// Physical dimensions of the panel in metres.
const PANEL_W = 1.2;  // width  (roughly 1.2 m wide, close to real C64 scale in VR)
const PANEL_H = 0.35; // height

// Canvas pixel resolution — higher = crisper text in VR.
const CANVAS_W = 1200;
const CANVAS_H = 350;

// Colours matching the existing DebugHud / MenuPanel dark aesthetic,
// but tinted C64-tan for the key caps.
const COL_BG        = '#0a0a14';    // panel background (dark navy)
const COL_KEY_BG    = '#3a3020';    // key cap fill (dark tan)
const COL_KEY_HOVER = '#6a5a30';    // key cap hovered
const COL_KEY_DOWN  = '#ffe060';    // key cap held / tap flash
const COL_KEY_TEXT  = '#ffe0a0';    // key label text
const COL_BORDER    = '#221c10';    // key border / gap
const COL_FRAME     = '#1a1408';    // panel border

// How long the tap-flash visual stays lit after a tap (ms).
const TAP_HIGHLIGHT_MS = 120;

export class C64Keyboard {
  /**
   * @param {{
   *   sendInput: (type: string, code: string, key: string,
   *               keyCode: number, location?: number) => void,
   *   position?: THREE.Vector3,
   *   rotationX?: number,
   *   rotationY?: number,
   * }} deps
   */
  constructor({ sendInput, position, rotationX = 0, rotationY = 0 } = {}) {
    if (typeof sendInput !== 'function') {
      throw new Error('C64Keyboard: sendInput callback is required');
    }
    this._sendInput = sendInput;

    // --- Canvas / texture ---------------------------------------------------
    this._canvas = this._makeCanvas();
    this._ctx    = this._canvas.getContext('2d');
    this._tex    = new THREE.CanvasTexture(this._canvas);
    this._tex.minFilter = THREE.LinearFilter;
    this._tex.magFilter = THREE.LinearFilter;

    // --- Geometry -----------------------------------------------------------
    // Black backing plane (slightly larger so the texture has a border).
    const backMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.88,
      depthTest: false,
    });
    const backGeom = new THREE.PlaneGeometry(PANEL_W + 0.02, PANEL_H + 0.02);
    this._back = new THREE.Mesh(backGeom, backMat);
    this._back.renderOrder = 990;

    // Main textured mesh — Raycaster hits this, UV [0,1]×[0,1].
    const planeMat = new THREE.MeshBasicMaterial({
      map: this._tex,
      transparent: true,
      depthTest: false,
    });
    const planeGeom = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
    this.mesh = new THREE.Mesh(planeGeom, planeMat);
    this.mesh.position.z = 0.001;
    this.mesh.renderOrder = 991;
    this.mesh.name = 'c64-keyboard-surface';
    // Tag so callers can recognise this mesh without importing this module.
    this.mesh.userData.kind = 'c64-keyboard';

    // Group: position + rotation applied here so the caller just adds object3d.
    this.object3d = new THREE.Group();
    this.object3d.name = 'c64-keyboard';
    this.object3d.add(this._back);
    this.object3d.add(this.mesh);

    if (position) this.object3d.position.copy(position);
    if (rotationX) this.object3d.rotation.x = rotationX;
    if (rotationY) this.object3d.rotation.y = rotationY;

    // --- State --------------------------------------------------------------
    // Key IDs currently pressed via press() (sustained hold).
    this._heldKeys = new Set();
    // Key ID currently highlighted by pointer hover.
    this._hoverKey = null;
    // Per-key tap-flash expiry timestamps: keyId → performance.now() deadline.
    this._tapUntil = new Map();
    // Need redraw flag.
    this._dirty = true;

    this._redraw();
  }

  // ------------------------------------------------------------------
  // PUBLIC API
  // ------------------------------------------------------------------

  /**
   * Update hover highlight from normalised UV coords (u: left→right,
   * v: top→bottom, in [0,1]). Call every XR frame with the Raycaster
   * hit UV. Pass u=-1 to clear hover.
   *
   * NOTE: Three.js Raycaster returns UV.y increasing upward; flip it:
   *   kbd.setHover(hit.uv.x, 1 - hit.uv.y)
   *
   * @param {number} u
   * @param {number} v
   * @returns {string|null} the key id under the pointer, or null
   */
  setHover(u, v) {
    const id = keyAt(u, v);
    if (id !== this._hoverKey) {
      this._hoverKey = id;
      this._dirty = true;
    }
    return id;
  }

  /** Clear hover (pointer left the panel). */
  clearHover() {
    if (this._hoverKey !== null) {
      this._hoverKey = null;
      this._dirty = true;
    }
  }

  /** The key id currently under the pointer, or null. */
  get hoveredKey() { return this._hoverKey; }

  /**
   * Sustained press: sends keydown and marks the key held.
   * Call release(keyId) to lift it.
   *
   * @param {string} keyId
   */
  press(keyId) {
    if (this._heldKeys.has(keyId)) return; // already held
    const ev = keyEventFor(keyId);
    if (!ev) return;
    this._heldKeys.add(keyId);
    this._sendInput('keydown', ev.code, ev.key, ev.keyCode, ev.location);
    this._dirty = true;
  }

  /**
   * Release a held key: sends keyup.
   *
   * @param {string} keyId
   */
  release(keyId) {
    if (!this._heldKeys.has(keyId)) return;
    const ev = keyEventFor(keyId);
    if (!ev) { this._heldKeys.delete(keyId); return; }
    this._heldKeys.delete(keyId);
    this._sendInput('keyup', ev.code, ev.key, ev.keyCode, ev.location);
    this._dirty = true;
  }

  /**
   * Tap a key: immediate keydown + scheduled keyup after TAP_HIGHLIGHT_MS.
   * Handles its own release — no need to call release() afterward.
   * Fires a brief visual highlight on the key.
   *
   * @param {string} keyId
   */
  tap(keyId) {
    const ev = keyEventFor(keyId);
    if (!ev) return;
    this._sendInput('keydown', ev.code, ev.key, ev.keyCode, ev.location);
    this._tapUntil.set(keyId, performance.now() + TAP_HIGHLIGHT_MS);
    this._dirty = true;
    setTimeout(() => {
      this._sendInput('keyup', ev.code, ev.key, ev.keyCode, ev.location);
      this._tapUntil.delete(keyId);
      this._dirty = true;
      // Force a redraw on the next tick() to clear the flash.
      // (No direct THREE render call here — tick() / a frame loop handles it.)
    }, TAP_HIGHLIGHT_MS);
  }

  /**
   * Convenience: tap the currently hovered key (if any).
   * Typical usage: call on controller selectstart event.
   *
   * @returns {string|null} the key id that was tapped, or null
   */
  tapHovered() {
    if (!this._hoverKey) return null;
    this.tap(this._hoverKey);
    return this._hoverKey;
  }

  /**
   * Convenience: sustained-press the currently hovered key.
   * Call releaseHovered() on selectend.
   */
  pressHovered() {
    if (!this._hoverKey) return null;
    this.press(this._hoverKey);
    return this._hoverKey;
  }

  /**
   * Release whatever key the pointer is currently hovering.
   * Matches a prior pressHovered() call.
   */
  releaseHovered() {
    if (!this._hoverKey) return;
    this.release(this._hoverKey);
  }

  /**
   * Release all currently held keys. Call when the keyboard is hidden
   * or the user navigates away, so no key latches in the emulator.
   */
  flushReleases() {
    for (const id of [...this._heldKeys]) {
      this.release(id);
    }
  }

  /**
   * Per-frame update: redraws the canvas texture if state changed.
   * Call once per XR frame from the render loop.
   */
  tick() {
    // Age out tap flashes.
    const now = performance.now();
    for (const [id, until] of this._tapUntil) {
      if (now >= until) { this._tapUntil.delete(id); this._dirty = true; }
    }
    if (this._dirty) { this._redraw(); this._dirty = false; }
  }

  // ------------------------------------------------------------------
  // CANVAS RENDERING
  // ------------------------------------------------------------------

  _makeCanvas() {
    // In Node (tests) document may not be available; create a minimal stub.
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width  = CANVAS_W;
      c.height = CANVAS_H;
      return c;
    }
    // Stub for environments without DOM (C64Keyboard is THREE-dependent;
    // this path is only reached in unit-test imports, not real usage).
    return { width: CANVAS_W, height: CANVAS_H, getContext: () => null };
  }

  _redraw() {
    const ctx = this._ctx;
    if (!ctx) return; // headless stub

    const cw = CANVAS_W;
    const ch = CANVAS_H;

    // Background.
    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, cw, ch);

    // Border.
    ctx.strokeStyle = COL_FRAME;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, cw - 6, ch - 6);

    const now = performance.now();

    // Draw each key.
    for (const key of C64_KEYS) {
      const w  = key.w ?? 1;
      const h  = key.h ?? 1;

      // Pixel bounds.
      const px = Math.round( key.col / COLS * cw );
      const py = Math.round( key.row / ROWS * ch );
      const pw = Math.round( w       / COLS * cw );
      const ph = Math.round( h       / ROWS * ch );

      // Gap between keys (drawn as the background colour peeking through).
      const gap = 3;
      const kx = px + gap;
      const ky = py + gap;
      const kw = pw - gap * 2;
      const kh = ph - gap * 2;
      if (kw <= 0 || kh <= 0) continue;

      // Pick fill colour.
      const tapping = this._tapUntil.has(key.id) && now < (this._tapUntil.get(key.id) ?? 0);
      const held    = this._heldKeys.has(key.id);
      const hovered = this._hoverKey === key.id;

      let fill = COL_KEY_BG;
      if (tapping || held) fill = COL_KEY_DOWN;
      else if (hovered)    fill = COL_KEY_HOVER;

      // Key cap background.
      ctx.fillStyle = fill;
      ctx.beginPath();
      this._roundRect(ctx, kx, ky, kw, kh, 4);
      ctx.fill();

      // Key border (slightly darker than fill for a raised look).
      ctx.strokeStyle = COL_BORDER;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Key label text.
      ctx.fillStyle = (tapping || held) ? '#000' : COL_KEY_TEXT;
      const label = key.label || key.id;
      const lines = label.split('\n');
      const fontSize = Math.min(kh * 0.35, kw * 0.5, 14);
      ctx.font = `bold ${Math.max(7, Math.round(fontSize))}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (lines.length === 1) {
        ctx.fillText(label, kx + kw / 2, ky + kh / 2, kw - 2);
      } else {
        // Two-line labels (e.g. "RUN\nSTP"): split vertically.
        const lineH = kh / lines.length;
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], kx + kw / 2, ky + lineH * i + lineH / 2, kw - 2);
        }
      }
    }

    this._tex.needsUpdate = true;
  }

  /** Canvas rounded-rectangle path helper (replaces ctx.roundRect for older Chrome). */
  _roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  /** Release Three.js resources. Call when removing from scene permanently. */
  dispose() {
    this.flushReleases();
    this._tex.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this._back.geometry.dispose();
    this._back.material.dispose();
  }
}
