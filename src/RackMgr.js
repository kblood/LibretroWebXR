// RackMgr — owns the live consoles ([[src/ConsoleRuntime.js]]) and enforces the
// performance budget ([[src/RackBudget.js]]) by pausing/resuming their cores.
//
// It deliberately does NOT construct ConsoleRuntimes (callers pass them in via
// add()), so the orchestration logic — which cores run live vs paused given the
// budget and the focused console — is pure enough to unit-test with fakes
// (scripts/test-rackmgr.mjs). main.js builds the ConsoleRuntimes (the primary
// one adopted from the existing client/#canvas) and hands them here.
//
// Wiring it to the patch graph (which console feeds which TV / which controllers
// plug in) is [[src/Patchbay.js]]'s job and happens in the caller; RackMgr only
// concerns itself with the live/paused lifecycle + input fan-out.

import { planLive } from './RackBudget.js';

export class RackMgr {
  constructor({ budget, maxLive, logger, allowRun } = {}) {
    this._runtimes = new Map();   // id -> ConsoleRuntime (or fake in tests)
    this._budgetOpts = {};
    if (budget != null) this._budgetOpts.budget = budget;
    if (maxLive != null) this._budgetOpts.maxLive = maxLive;
    this._logger = logger || null;
    this._focusedId = null;
    // When false, the perf budget never pauses anything — every loaded console
    // stays live (for machines that can run all cores at once). Toggled by the
    // user; the gaze/budget pause is a perf optimisation, not a correctness one.
    this._budgetEnabled = true;
    // M1.4 HARD gate, orthogonal to the perf budget: may this machine run ANY
    // local core at all? A display-only netplay client must run zero (see
    // docs/MULTIPLAYER.md) — it only displays the host's video feed. Without this
    // the budget was free to *undo* main.js's watcher pause, so a client that had
    // booted a game before joining silently resumed emulating its own copy behind
    // the host's picture — i.e. exactly the "each computer runs its own game" bug
    // this release fixes, re-entered through a perf path.
    this._allowRun = typeof allowRun === 'function' ? allowRun : null;
  }

  /** Enable/disable the perf budget. Disabled = keep every loaded console live. */
  setBudgetEnabled(on) { this._budgetEnabled = on !== false; return this._budgetEnabled; }
  isBudgetEnabled() { return this._budgetEnabled; }

  /** Install/replace the "may any core run here?" predicate (see constructor). */
  setAllowRun(fn) { this._allowRun = typeof fn === 'function' ? fn : null; return this; }

  /**
   * May a local core run at all right now? Fails OPEN (a throwing/absent
   * predicate must never brick solo play), but any explicit `false` suspends
   * the whole rack.
   */
  runAllowed() {
    if (!this._allowRun) return true;
    try { return this._allowRun() !== false; }
    catch (e) { console.warn('[RackMgr] allowRun threw', e); return true; }
  }

  add(runtime) {
    // Propagate the gate into the runtime itself so a DIRECT `runtime.resume()`
    // — the console power switch, a live reboot — is refused too, not just the
    // budget's resumes. add() is the one choke point every runtime passes
    // through, which is why the wiring lives here rather than at each new
    // ConsoleRuntime() site.
    runtime.setCanRun?.(() => this.runAllowed());
    this._runtimes.set(runtime.id, runtime);
    return runtime;
  }
  get(id) { return this._runtimes.get(id) || null; }
  has(id) { return this._runtimes.has(id); }
  ids() { return [...this._runtimes.keys()]; }
  runtimes() { return [...this._runtimes.values()]; }
  count() { return this._runtimes.size; }

  remove(id) {
    const r = this._runtimes.get(id);
    if (!r) return;
    try { r.dispose?.(); } catch (e) { console.warn('[RackMgr] dispose', e); }
    this._runtimes.delete(id);
    if (this._focusedId === id) this._focusedId = null;
  }

  /** Set which console the user is focused on (always kept live by the budget). */
  setFocus(id) {
    if (id === this._focusedId) return false;
    this._focusedId = id;
    return true;
  }
  focusedId() { return this._focusedId; }

  /**
   * Recompute the budget over the LOADED consoles and pause/resume to match.
   * Pause demotions first, then resume promotions, so we never transiently
   * exceed the live budget. Returns the plan.
   */
  applyBudget() {
    const loaded = this.runtimes().filter((r) => r.isLoaded?.());
    // HARD gate first (see _allowRun): when this machine may not run cores the
    // budget's job is to SUSPEND, never to resume. Covers every loaded runtime
    // AND any still-booting one, primary and secondary alike.
    if (!this.runAllowed()) {
      // Unconditional, NOT `if (isLive())`: pause() is idempotent, and a runtime
      // that has no core yet still needs the paused flag pre-asserted so a boot
      // that starts a millisecond later comes up stopped (EmulatorClient
      // re-applies `paused` after start()). isLive() deliberately answers false
      // for a coreless runtime (see ConsoleRuntime.hasCore), so gating on it here
      // would have quietly reopened that window.
      for (const r of this.runtimes()) r.pause?.();
      const paused = loaded.map((r) => r.id);
      this._logger?.event?.('rack-budget', {
        live: [], paused, liveWeight: 0, focus: this._focusedId, mode: 'suspended',
      });
      return { live: [], paused, liveWeight: 0, suspended: true };
    }
    // Gaze/budget pause only applies with MORE THAN ONE console, and only when
    // the budget is enabled. Otherwise keep everything live (resume any paused).
    if (!this._budgetEnabled || loaded.length <= 1) {
      for (const r of loaded) if (!r.isLive?.()) r.resume();
      const live = loaded.map((r) => r.id);
      this._logger?.event?.('rack-budget', {
        live, paused: [], liveWeight: null, focus: this._focusedId,
        mode: this._budgetEnabled ? 'single' : 'disabled',
      });
      return { live, paused: [], liveWeight: 0 };
    }
    const consoles = loaded.map((r) => ({
      id: r.id, weight: r.weight ?? 1, focused: r.id === this._focusedId,
    }));
    const plan = planLive(consoles, this._budgetOpts);
    const liveSet = new Set(plan.live);

    for (const r of loaded) {                       // demote first
      if (!liveSet.has(r.id) && r.isLive?.()) r.pause();
    }
    for (const r of loaded) {                       // then promote
      if (liveSet.has(r.id) && !r.isLive?.()) r.resume();
    }

    this._logger?.event?.('rack-budget', {
      live: plan.live, paused: plan.paused, liveWeight: plan.liveWeight, focus: this._focusedId,
    });
    return plan;
  }

  /**
   * Pause EVERY runtime unconditionally, ignoring the budget and whether the
   * runtime reports itself loaded. Used when this machine must run zero cores
   * (becoming a display-only netplay client). Returns the ids it stopped.
   *
   * Deliberately not `loaded`-filtered, and deliberately not isLive()-filtered
   * either: a runtime mid-boot isn't "loaded" yet but its main loop will start,
   * and a runtime with no core at all (ConsoleRuntime.hasCore() false ⇒ isLive()
   * false) still needs the paused flag set so a boot begun a moment later comes
   * up stopped. pause() is idempotent, so calling it on everything is free.
   * `stopped` reports only the runtimes that were genuinely live.
   */
  pauseAll(reason = null) {
    const stopped = [];
    for (const r of this.runtimes()) {
      const wasLive = r.isLive?.();
      r.pause?.();
      if (wasLive) stopped.push(r.id);
    }
    this._logger?.event?.('rack-pause-all', { reason, stopped, total: this._runtimes.size });
    return stopped;
  }

  /** Route a synthetic key event to one console's core (canvas-targeted). */
  sendInput(consoleId, eventType, code, key, keyCode, location) {
    this.get(consoleId)?.sendInput?.(eventType, code, key, keyCode, location);
  }

  dispose() {
    for (const r of this._runtimes.values()) {
      try { r.dispose?.(); } catch (_) {}
    }
    this._runtimes.clear();
    this._focusedId = null;
  }
}
