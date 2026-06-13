// RackBudget — pure admission policy for the multi-console rack: given the
// consoles that WANT to run (each with a per-core weight) and a headset's
// performance budget, decide which run LIVE and which are PAUSED.
//
// This encodes the Phase-0 perf result (see memory rack-spike-result): light
// 8/16-bit cores are cheap and several can run at once, but total cost — not a
// flat console count — is the constraint, so we admit by cumulative *weight*
// (CORES[x].weight in systems.js) under a budget, with a hard cap on the number
// of simultaneously-live cores as a safety belt.
//
// Pure (no THREE/DOM/EmulatorClient) so it unit-tests in `npm test`
// (scripts/test-rackbudget.mjs). RackMgr binds it to live ConsoleRuntimes and
// applies the plan via pause()/resume().
//
// Policy:
//   • The FOCUSED console (the one the user is looking at / playing) is ALWAYS
//     live, even if its weight alone exceeds the budget — you must be able to
//     play what you're looking at.
//   • Remaining consoles are admitted in the given priority order (caller sorts
//     by recency/proximity) while cumulative live weight ≤ budget AND the live
//     count < maxLive.
//   • Everyone else is paused.

import { DEFAULT_RACK_BUDGET, DEFAULT_MAX_LIVE, DEFAULT_CORE_WEIGHT } from './systems.js';

/**
 * @param {Array<{id:string, weight?:number, focused?:boolean}>} consoles
 *        Consoles wanting to run, in descending priority order. `weight`
 *        defaults to 1; at most one should be `focused`.
 * @param {object} [opts]
 * @param {number} [opts.budget]  total live weight allowed (default from systems.js)
 * @param {number} [opts.maxLive] hard cap on live count (default from systems.js)
 * @returns {{ live: string[], paused: string[], liveWeight: number }}
 */
export function planLive(consoles, opts = {}) {
  const budget = opts.budget ?? DEFAULT_RACK_BUDGET;
  const maxLive = opts.maxLive ?? DEFAULT_MAX_LIVE;
  const list = Array.isArray(consoles) ? consoles : [];

  // Focused console first (always admitted), then the rest in given order. A
  // stable reorder — we don't otherwise disturb the caller's priority.
  const focused = list.filter((c) => c.focused);
  const rest = list.filter((c) => !c.focused);
  const ordered = [...focused, ...rest];

  const live = [];
  const paused = [];
  let liveWeight = 0;
  let liveCount = 0;

  for (const c of ordered) {
    const w = c.weight ?? DEFAULT_CORE_WEIGHT;
    const isFocused = !!c.focused && live.length === 0; // the single focus wins slot 1
    if (isFocused) {
      live.push(c.id);
      liveWeight += w;
      liveCount += 1;
      continue;
    }
    if (liveCount < maxLive && liveWeight + w <= budget) {
      live.push(c.id);
      liveWeight += w;
      liveCount += 1;
    } else {
      paused.push(c.id);
    }
  }

  return { live, paused, liveWeight };
}
