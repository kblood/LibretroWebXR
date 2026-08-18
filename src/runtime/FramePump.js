// FramePump: the scheduling half of the execution worker's frame delivery
// ([[src/runtime/EmulatorWorkerRuntime.js]]), split out so it can be unit-tested
// with a fake clock — the worker module itself is a `self.addEventListener`
// script with no exports, so its pump was previously unreachable from the
// logic-tier tests, which is exactly why the bug below survived.
//
// THE BUG (PERF-4(a)): the pump was a free-running `setTimeout(pump, 16)` chain
// that re-armed BEFORE it checked `paused`. Pausing a console therefore stopped
// it producing frames but did not stop it WAKING: an auto-paused rack console —
// the precise case [[src/RackBudget.js]]'s auto-pause exists to create — kept
// waking its worker thread ~62 times a second, for ever, producing nothing. On a
// battery-powered headset that is pure loss.
//
// What is deliberately NOT changed here: the pump is still a fixed-interval
// metronome rather than being driven off FRAME_ACK. The one-in-flight ACK gate
// in the worker already caps PRODUCTION at the presentation rate (an unacked
// frame is skipped, never queued), so the remaining cost of the metronome is
// wakeups, not pixels — and making delivery ack-driven puts a permanently black
// console one lost message away, the exact failure the 500 ms stale-ack watchdog
// had to be added for. That trade needs a headset measurement first.

export class FramePump {
  /**
   * @param {object} opts
   * @param {number} opts.intervalMs  target wake interval (ms).
   * @param {() => void} opts.onTick  produce-a-frame callback; exceptions are
   *   the caller's to handle — the pump only guarantees it stays scheduled.
   * @param {Function} [opts.setTimeout]   injectable for tests.
   * @param {Function} [opts.clearTimeout] injectable for tests.
   */
  constructor({ intervalMs = 16, onTick, setTimeout: st, clearTimeout: ct } = {}) {
    this.intervalMs = intervalMs > 0 ? intervalMs : 16;
    this.onTick = onTick;
    this._setTimeout = st || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = ct || ((h) => clearTimeout(h));
    this._timer = null;
    this._paused = false;
    this._started = false;
  }

  /** Is a wake currently scheduled? (The property the paused-console fix is about.) */
  get running() { return this._timer !== null; }

  get paused() { return this._paused; }

  /**
   * Begin pumping. Fires ONE tick synchronously — the historical behaviour, and
   * what gets a first frame on screen without waiting an interval — then keeps
   * re-arming. Idempotent: a second start() never leaves two chains running.
   */
  start(intervalMs = this.intervalMs) {
    this.intervalMs = intervalMs > 0 ? intervalMs : this.intervalMs;
    this._clear();
    this._started = true;
    if (this._paused) return;   // resume() will arm it
    this._tick();
  }

  /** Stop for good (teardown). setPaused(false) will NOT restart it. */
  stop() {
    this._clear();
    this._started = false;
    this._paused = false;
  }

  /**
   * Pause/resume the wakeups themselves.
   *
   * Resume re-arms with a TIMEOUT rather than ticking immediately, and that is
   * on purpose: transferToImageBitmap() clears the canvas it transfers, so
   * capturing in the same turn as the core's resumeMainLoop() — before the core
   * has drawn anything — would ship a blank frame and flash the TV black. One
   * interval later the core has produced a real frame, which is exactly the
   * cadence the old always-running pump happened to give.
   */
  setPaused(next) {
    const want = !!next;
    if (this._paused === want) return;
    this._paused = want;
    if (want) this._clear();
    else if (this._started) this._schedule();
  }

  _clear() {
    if (this._timer !== null) this._clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule() {
    this._clear();
    this._timer = this._setTimeout(() => { this._timer = null; this._tick(); }, this.intervalMs);
  }

  _tick() {
    // Re-arm FIRST so a throwing onTick cannot kill the pump (the worker's
    // capture posts its own error event and expects the next frame to still
    // come), but only while we are still meant to be running.
    if (this._started && !this._paused) this._schedule();
    if (this._paused) return;   // a pause that landed between wake and fire
    this.onTick?.();
  }
}
