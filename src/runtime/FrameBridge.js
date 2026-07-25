// Default frame-request function: the global requestAnimationFrame, resolved
// dynamically at CALL time (not cached here at module-load time) so this
// naturally picks up src/XRRafShim.js's monkeypatch of window.rAF while an XR
// session is active — the shim replaces window.requestAnimationFrame itself,
// and every unqualified `requestAnimationFrame` call (this one included)
// resolves through that same global, exactly like every other rendering path
// in the app already does. Exposed as an injectable constructor option (not
// hardcoded) so this dependency is explicit and unit-testable — see
// test/runtime.test.js — rather than an implicit global reference that's easy
// to accidentally bypass in a future refactor (B6, 2026-07-25 review).
const defaultRequestFrame = (callback) => requestAnimationFrame(callback);

export class FrameBridge {
  constructor(canvas, { onPresented = null, requestFrame = defaultRequestFrame } = {}) {
    if (!canvas) throw new Error('FrameBridge requires an output canvas');
    this.canvas = canvas;
    this.onPresented = onPresented;
    this._requestFrame = requestFrame;
    this._pending = null;
    this._scheduled = false;
    this.framesPresented = 0;
    this.framesDropped = 0;

    // A 2D context is deliberately used rather than bitmaprenderer. Three's
    // CanvasTexture can upload this canvas consistently on desktop and in XR.
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!this.context) throw new Error('2D frame-bridge context unavailable');
  }

  receive(bitmap, width, height) {
    if (this._pending) {
      this._pending.close?.();
      this.framesDropped++;
    }
    this._pending = bitmap;
    this._width = width || bitmap.width;
    this._height = height || bitmap.height;
    if (!this._scheduled) {
      this._scheduled = true;
      this._requestFrame(() => this._present());
    }
  }

  _present() {
    this._scheduled = false;
    const bitmap = this._pending;
    this._pending = null;
    if (!bitmap) return;
    if (this.canvas.width !== this._width) this.canvas.width = this._width;
    if (this.canvas.height !== this._height) this.canvas.height = this._height;
    this.context.drawImage(bitmap, 0, 0, this.canvas.width, this.canvas.height);
    bitmap.close?.();
    this.framesPresented++;
    this.onPresented?.();
  }

  snapshot() {
    return { framesPresented: this.framesPresented, framesDropped: this.framesDropped };
  }

  dispose() {
    this._pending?.close?.();
    this._pending = null;
  }
}

