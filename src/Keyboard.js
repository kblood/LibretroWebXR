// Keyboard — physical, placeable keyboard device prop for the VR frontend.
//
// Renders a full keyboard layout as a CanvasTexture on the top face of a
// low slab (cream/beige plastic body). Unlike the legacy C64Keyboard floating
// panel, this is a REAL WORLD OBJECT with correct depth testing so it sits on
// a desk like an actual keyboard. A Raycaster hitting `keyboard.mesh` returns
// UV [0,1]×[0,1] which is fed into the hit-test engine to resolve key ids.
//
// ------------------------------------------------------------------
// USAGE (integration — wired by RoomBuilder / main.js later pass)
// ------------------------------------------------------------------
//   import { createKeyboardDevice } from './Keyboard.js';
//
//   const kbd = createKeyboardDevice({
//     position: new THREE.Vector3(0, 0.72, -1.5),
//     rotationY: 0,
//     layout: 'standard',  // or 'c64'
//     sendInput: (type, code, key, keyCode, location) =>
//       client.sendInput(type, code, key, keyCode, location),
//   });
//   scene.add(kbd.object3d);
//
//   // Each XR frame:
//   const uv = intersect?.uv;
//   if (uv) kbd.setHover(uv.x, 1 - uv.y);  // THREE UVs have V flipped
//   else    kbd.clearHover();
//   if (triggerPressed) kbd.tapHovered();
//   kbd.tick();
//
//   // Wire sendInput after construction (before any key events are fired):
//   kbd.setSendInput((type, code, key, keyCode, location) =>
//     client.sendInput(type, code, key, keyCode, location));
//
//   // Switch layouts at runtime:
//   kbd.setLayout('c64');
//
// ------------------------------------------------------------------
// CORD ANCHOR
// ------------------------------------------------------------------
// `kbd.cordAnchor` is a THREE.Object3D child at the back-right edge of
// the body. The cable system ([[src/Cord.js]]) reads cordAnchor's world
// position each frame to draw the cord to the console port.
// Convention mirrors src/Gamepad.js.
//
// ------------------------------------------------------------------
// DEPENDENCIES
// ------------------------------------------------------------------
// THREE (peer dependency).
// KeyboardLayout.js (sibling pure module — Node-safe).

import * as THREE from 'three';
import { getLayout } from './KeyboardLayout.js';

// Physical body dimensions (metres).
const BODY_W = 0.70;   // width  (readable but compact)
const BODY_H = 0.035;  // thickness of the slab
const BODY_D = 0.25;   // depth front-to-back

// Tilt angle of the body toward the user (degrees → radians).
const TILT_DEG  = 11;
const TILT_RAD  = TILT_DEG * (Math.PI / 180);

// Canvas resolution for the key-cap texture.
const CANVAS_W = 1400;
const CANVAS_H = 500;

// Colour palette — cream/beige plastic aesthetic.
const COL_BG        = '#d0c8b8';   // keycap field background
const COL_BODY      = '#c8bfa8';   // plastic body colour
const COL_KEY_BG    = '#e8e0d0';   // key cap fill
const COL_KEY_HOVER = '#f0d870';   // hovered key (yellow highlight)
const COL_KEY_DOWN  = '#ffcc00';   // held / tapping key
const COL_KEY_TEXT  = '#1a1812';   // label text (dark ink on cream)
const COL_BORDER    = '#a89880';   // gap between keys (shadow)

// Tap flash duration (ms).
const TAP_HIGHLIGHT_MS = 120;

// ---------------------------------------------------------------------------
// Keyboard class
// ---------------------------------------------------------------------------

export class Keyboard {
  /**
   * @param {{
   *   sendInput?  : (type: string, code: string, key: string,
   *                  keyCode: number, location?: number) => void,
   *   position?   : THREE.Vector3,
   *   rotationY?  : number,
   *   layout?     : string,
   * }} [opts]
   */
  constructor({ sendInput, position, rotationY = 0, layout = 'standard' } = {}) {
    // sendInput is optional at construction time — set later via setSendInput().
    this._sendInput = typeof sendInput === 'function' ? sendInput : () => {};

    this._layoutName = layout;
    this._layout     = getLayout(layout);

    // --- Canvas / texture ---------------------------------------------------
    this._canvas = this._makeCanvas();
    this._ctx    = this._canvas ? this._canvas.getContext('2d') : null;
    this._tex    = null;
    if (typeof THREE !== 'undefined' && this._canvas && this._ctx) {
      this._tex = new THREE.CanvasTexture(this._canvas);
      this._tex.minFilter = THREE.LinearFilter;
      this._tex.magFilter = THREE.LinearFilter;
    }

    // --- Geometry -----------------------------------------------------------
    // The tilted body slab. We apply TILT_RAD around the local X axis so
    // the front edge lifts toward the user. The key surface is the +Y face.
    this.object3d = new THREE.Group();
    this.object3d.name = 'keyboard';
    this.object3d.userData.kind = 'keyboard';

    // Body box — cream plastic.
    const bodyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COL_BODY),
      roughness: 0.7,
      metalness: 0.0,
    });
    const bodyGeom = new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D);
    const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
    // Tilt the slab: rotate around local X so the back edge lifts.
    bodyMesh.rotation.x = -TILT_RAD;
    this.object3d.add(bodyMesh);

    // Key-surface plane — sits on top of the body, inherits the tilt because
    // it's a sibling (not a child of bodyMesh). Position it at the top face
    // of the tilted body: the top face is displaced by +Y=BODY_H/2 before
    // tilt. After the tilt the centre rises by cos(tilt)*BODY_H/2 and shifts
    // back by sin(tilt)*BODY_H/2 in Z — we approximate with a small Y offset.
    const surfaceMat = new THREE.MeshStandardMaterial({
      map: this._tex || null,
      color: this._tex ? new THREE.Color('#ffffff') : new THREE.Color(COL_BG),
      roughness: 0.6,
      metalness: 0.0,
    });
    const surfaceGeom = new THREE.PlaneGeometry(BODY_W, BODY_D);
    this.mesh = new THREE.Mesh(surfaceGeom, surfaceMat);
    // Lay the plane flat (it defaults to XY; rotate so it lies in XZ).
    this.mesh.rotation.x = -Math.PI / 2 - TILT_RAD;
    // Place it at the top of the body (raised by half the body height).
    this.mesh.position.y = BODY_H / 2 * Math.cos(TILT_RAD) + 0.001;
    this.mesh.position.z = -BODY_H / 2 * Math.sin(TILT_RAD);
    this.mesh.name = 'keyboard-surface';
    this.mesh.userData.kind = 'keyboard-surface';
    this.object3d.add(this.mesh);

    // Cord anchor: back-right corner where the cable exits the body.
    // Mirrors the convention in src/Gamepad.js (cordAnchor on userData).
    this.cordAnchor = new THREE.Object3D();
    this.cordAnchor.name = 'keyboard-cord-anchor';
    // Back edge = +Z/2 of the body (after tilt), right edge = +X/2.
    // We place it in local space before tilt rotation is applied to the body.
    this.cordAnchor.position.set(BODY_W / 2, BODY_H / 2, BODY_D / 2);
    this.object3d.add(this.cordAnchor);

    // Expose on userData for the cable system (same convention as Gamepad).
    this.object3d.userData.cordAnchor = this.cordAnchor;

    // --- Placement ----------------------------------------------------------
    if (position) this.object3d.position.copy(position);
    if (rotationY) this.object3d.rotation.y = rotationY;

    // --- State --------------------------------------------------------------
    this._heldKeys = new Set();
    this._hoverKey = null;
    this._tapUntil = new Map();
    this._dirty    = true;

    this._redraw();
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  /**
   * Replace the sendInput callback after construction.
   * All subsequent key dispatches go through the new function.
   *
   * @param {(type: string, code: string, key: string,
   *           keyCode: number, location?: number) => void} fn
   */
  setSendInput(fn) {
    if (typeof fn === 'function') this._sendInput = fn;
  }

  /**
   * Switch to a different keyboard layout. Flushes all held keys first so
   * nothing latches in the emulator. Re-draws the key surface.
   *
   * @param {string} name  'standard' | 'c64'
   */
  setLayout(name) {
    if (name === this._layoutName) return;
    this.flushReleases();
    this._layoutName = name;
    this._layout     = getLayout(name);
    this._hoverKey   = null;
    this._tapUntil.clear();
    this._dirty = true;
    this._redraw();
  }

  /** The current layout name. */
  get layoutName() { return this._layoutName; }

  // --------------------------------------------------------------------------
  // PUBLIC API — mirrors C64Keyboard for drop-in substitution
  // --------------------------------------------------------------------------

  /**
   * Update hover highlight from normalised UV coordinates.
   * u: 0=left→1=right; v: 0=top→1=bottom.
   *
   * NOTE: THREE Raycaster returns UV.y increasing upward — flip it:
   *   kbd.setHover(hit.uv.x, 1 - hit.uv.y)
   *
   * @param {number} u
   * @param {number} v
   * @returns {string|null} key id under the pointer, or null
   */
  setHover(u, v) {
    const id = this._layout.keyAt(u, v);
    if (id !== this._hoverKey) {
      this._hoverKey = id;
      this._dirty = true;
    }
    return id;
  }

  /** Clear hover (pointer left the surface). */
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
   * Call release(keyId) to lift.
   *
   * @param {string} keyId
   */
  press(keyId) {
    if (this._heldKeys.has(keyId)) return;
    const ev = this._layout.keyEventFor(keyId);
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
    const ev = this._layout.keyEventFor(keyId);
    if (!ev) { this._heldKeys.delete(keyId); return; }
    this._heldKeys.delete(keyId);
    this._sendInput('keyup', ev.code, ev.key, ev.keyCode, ev.location);
    this._dirty = true;
  }

  /**
   * Tap a key: immediate keydown + auto keyup after TAP_HIGHLIGHT_MS.
   * Visual highlight fires and expires automatically. No release() needed.
   *
   * @param {string} keyId
   */
  tap(keyId) {
    const ev = this._layout.keyEventFor(keyId);
    if (!ev) return;
    // Capture the current sendInput target so a mid-tap re-plug cannot split
    // the keydown and keyup across two different consoles (FIX A).
    const send = this._sendInput;
    send('keydown', ev.code, ev.key, ev.keyCode, ev.location);
    this._tapUntil.set(keyId, (typeof performance !== 'undefined' ? performance.now() : Date.now()) + TAP_HIGHLIGHT_MS);
    this._dirty = true;
    setTimeout(() => {
      send('keyup', ev.code, ev.key, ev.keyCode, ev.location);
      this._tapUntil.delete(keyId);
      this._dirty = true;
    }, TAP_HIGHLIGHT_MS);
  }

  /**
   * Tap the currently hovered key (if any).
   * @returns {string|null} the key id tapped, or null
   */
  tapHovered() {
    if (!this._hoverKey) return null;
    this.tap(this._hoverKey);
    return this._hoverKey;
  }

  /**
   * Sustained-press the currently hovered key.
   * Call releaseHovered() on controller selectend.
   * @returns {string|null}
   */
  pressHovered() {
    if (!this._hoverKey) return null;
    this.press(this._hoverKey);
    return this._hoverKey;
  }

  /** Release whatever key the pointer is hovering. */
  releaseHovered() {
    if (!this._hoverKey) return;
    this.release(this._hoverKey);
  }

  /**
   * Release all currently held keys.
   * Call when the keyboard is hidden or ownership changes.
   */
  flushReleases() {
    for (const id of [...this._heldKeys]) {
      this.release(id);
    }
  }

  /**
   * Per-frame update: ages out tap flashes and redraws the texture if dirty.
   * Call once per XR frame from the render loop.
   */
  tick() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    for (const [id, until] of this._tapUntil) {
      if (now >= until) { this._tapUntil.delete(id); this._dirty = true; }
    }
    if (this._dirty) { this._redraw(); this._dirty = false; }
  }

  /**
   * Release THREE resources. Call when removing from the scene permanently.
   */
  dispose() {
    this.flushReleases();
    if (this._tex) this._tex.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  // --------------------------------------------------------------------------
  // Canvas rendering (browser-only; no-ops in Node)
  // --------------------------------------------------------------------------

  _makeCanvas() {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width  = CANVAS_W;
      c.height = CANVAS_H;
      return c;
    }
    // Stub for Node / unit-test imports. THREE-dependent rendering is skipped.
    return null;
  }

  _redraw() {
    const ctx = this._ctx;
    if (!ctx) return; // headless / no DOM

    const { keys, COLS, ROWS } = this._layout;
    const cw = CANVAS_W;
    const ch = CANVAS_H;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Background.
    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, cw, ch);

    // Draw each key.
    for (const key of keys) {
      const w  = key.w ?? 1;
      const h  = key.h ?? 1;

      // Pixel bounds.
      const px = Math.round(key.col / COLS * cw);
      const py = Math.round(key.row / ROWS * ch);
      const pw = Math.round(w       / COLS * cw);
      const ph = Math.round(h       / ROWS * ch);

      // Gap between keys.
      const gap = 2;
      const kx = px + gap;
      const ky = py + gap;
      const kw = pw - gap * 2;
      const kh = ph - gap * 2;
      if (kw <= 0 || kh <= 0) continue;

      const tapping = this._tapUntil.has(key.id) && now < (this._tapUntil.get(key.id) ?? 0);
      const held    = this._heldKeys.has(key.id);
      const hovered = this._hoverKey === key.id;

      let fill = COL_KEY_BG;
      if (tapping || held) fill = COL_KEY_DOWN;
      else if (hovered)    fill = COL_KEY_HOVER;

      // Key cap background.
      ctx.fillStyle = fill;
      ctx.beginPath();
      this._roundRect(ctx, kx, ky, kw, kh, 3);
      ctx.fill();

      // Key border.
      ctx.strokeStyle = COL_BORDER;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Label text.
      ctx.fillStyle = (tapping || held) ? '#000000' : COL_KEY_TEXT;
      const label = key.label || key.id;
      const lines = label.split('\n');
      const fontSize = Math.min(kh * 0.38, kw * 0.55, 13);
      ctx.font = `bold ${Math.max(6, Math.round(fontSize))}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (lines.length === 1) {
        ctx.fillText(label, kx + kw / 2, ky + kh / 2, kw - 2);
      } else {
        const lineH = kh / lines.length;
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], kx + kw / 2, ky + lineH * i + lineH / 2, kw - 2);
        }
      }
    }

    if (this._tex) this._tex.needsUpdate = true;
  }

  /** Canvas rounded-rectangle path helper. */
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
}

// ---------------------------------------------------------------------------
// Factory — primary integration point for RoomBuilder
// ---------------------------------------------------------------------------

/**
 * Create and return a Keyboard device instance.
 *
 * @param {{
 *   position?  : THREE.Vector3,
 *   rotationY? : number,
 *   layout?    : string,
 *   sendInput? : (type: string, code: string, key: string,
 *                 keyCode: number, location?: number) => void,
 * }} [opts]
 * @returns {Keyboard}
 */
export function createKeyboardDevice({
  position,
  rotationY = 0,
  layout    = 'standard',
  sendInput,
} = {}) {
  return new Keyboard({ sendInput, position, rotationY, layout });
}
