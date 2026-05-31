// Animated gradient + status text drawn into the emulator canvas before a ROM
// is loaded. Gives SceneMgr a non-blank texture to put on the TV mesh so the
// VR scene visibly shows something the moment the user enters VR.

export class Placeholder {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.message = 'Load a ROM';
    this.running = false;
    this.t0 = performance.now();
    this._tick = this._tick.bind(this);
  }

  setMessage(text) { this.message = text; }

  start() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this._tick);
  }

  stop() { this.running = false; }

  _tick(t) {
    if (!this.running) return;
    const w = this.canvas.width, h = this.canvas.height;
    const ctx = this.ctx;
    const elapsed = (t - this.t0) / 1000;

    // Slow diagonal hue sweep — works as a "tube test card" of sorts.
    const a = (Math.sin(elapsed * 0.4) + 1) * 0.5;
    const b = (Math.sin(elapsed * 0.7 + 1.2) + 1) * 0.5;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${(elapsed * 25) % 360}, 60%, ${15 + a * 10}%)`);
    g.addColorStop(1, `hsl(${(elapsed * 25 + 90) % 360}, 60%, ${15 + b * 10}%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Scanline overlay so the placeholder actually reads as a CRT.
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);

    // Centered status text.
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `${Math.round(h * 0.08)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.message, w / 2, h / 2);

    ctx.font = `${Math.round(h * 0.04)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText('LibretroWebXR', w / 2, h / 2 + Math.round(h * 0.09));

    requestAnimationFrame(this._tick);
  }
}
