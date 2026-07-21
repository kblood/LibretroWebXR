export class FrameBridge {
  constructor(canvas, { onPresented = null } = {}) {
    if (!canvas) throw new Error('FrameBridge requires an output canvas');
    this.canvas = canvas;
    this.onPresented = onPresented;
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
      requestAnimationFrame(() => this._present());
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

