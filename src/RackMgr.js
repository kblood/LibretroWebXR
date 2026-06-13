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
  constructor({ budget, maxLive, logger } = {}) {
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
  }

  /** Enable/disable the perf budget. Disabled = keep every loaded console live. */
  setBudgetEnabled(on) { this._budgetEnabled = on !== false; return this._budgetEnabled; }
  isBudgetEnabled() { return this._budgetEnabled; }

  add(runtime) { this._runtimes.set(runtime.id, runtime); return runtime; }
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
