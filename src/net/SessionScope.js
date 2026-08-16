// SessionScope — the "release it when the room session ends" registry
// (CODEX_REVIEW COR-2, which asks for a disposable RoomSession scope).
//
// This is the smallest honest version of that: a list of cleanups registered
// when the session subsystems are wired, and run on every Leave. It is NOT a
// full lifetime scope — the managers themselves are still built once per world
// build, deliberately (rebuilding them re-registers tick callbacks and re-creates
// scene objects; see main.js's _netSessionWired). What it fixes is the state
// those managers hold ON BEHALF of a session that has ended.
//
// The concrete bug: GhostGamepadMgr and friends HIDE the local prop while a peer
// holds it, and unhide it in sync(). Leave detaches the tick callbacks, so sync()
// is never called again — a peer holding your gamepad at the moment you left it
// left your gamepad invisible for the rest of the build, with nothing able to
// bring it back.
//
// TWO PROPERTIES THIS TYPE EXISTS TO GUARANTEE:
//   • run() runs EVERY cleanup even when one throws. One manager in a bad state
//     must not strand every later prop hidden — which is exactly what a bare
//     `for (const fn of list) fn()` would do.
//   • run() is repeatable. Cleanups are registered once and run on every Leave,
//     so they must be idempotent, and running them with nothing held is normal
//     (solo play, or Leave without ever having held anything).

/**
 * @param {object} [opts]
 * @param {(e: unknown, index: number) => void} [opts.onError] — reporter for a
 *   throwing cleanup. Defaults to a console warning; injectable so tests can
 *   assert that a failure is REPORTED rather than swallowed silently.
 * @returns {{add: Function, run: Function, size: Function}}
 */
export function createSessionScope({ onError } = {}) {
  const cleanups = [];
  const report = typeof onError === 'function'
    ? onError
    : (e) => console.warn('[session] cleanup failed', e);
  return {
    /** Register a cleanup. Non-functions are ignored, not thrown on. */
    add(fn) {
      if (typeof fn !== 'function') return false;
      cleanups.push(fn);
      return true;
    },
    /** Run them all, in registration order. Returns how many completed. */
    run() {
      let completed = 0;
      for (let i = 0; i < cleanups.length; i++) {
        try { cleanups[i](); completed++; } catch (e) { report(e, i); }
      }
      return completed;
    },
    size() { return cleanups.length; },
  };
}
