// LiveAvatars — a stable AvatarMgr-shaped handle that always resolves to the
// CURRENT room session's avatars (CODEX_REVIEW COR-2).
//
// THE BUG IT FIXES. Every room session builds its own NetMgr, and every NetMgr
// builds its own AvatarMgr ([[src/net/NetMgr.js]]: `this.avatars = new
// AvatarMgr(...)`). The multiplayer-sync managers — ghost cartridge, gamepad,
// light gun, mouse — are built ONCE per world build and were handed
// `net.avatars` by value at that moment. Leave nulls `net`; Join builds a new one
// with a new AvatarMgr; the ghost managers keep the dead one. From then on
// getHead()/getHand() answer for peers of a session that is over — for the new
// session's peers they return null, so a remote hold never grows a ghost and the
// local prop it hides stays hidden. main.js documented this as a known
// limitation ("a leave+widget-rejoin within one build reads a stale net") for as
// long as the widget-join path has existed.
//
// WHY A HANDLE AND NOT A REBUILD. The alternative is to re-run the whole session
// wiring on every join, which means re-registering tick callbacks and rebuilding
// managers that own scene objects — the _netSessionWired guard exists precisely
// because doing that twice double-registers everything. Late binding fixes the
// staleness without touching object lifetimes: one indirection, evaluated per
// call, against a `getNet` the module already owns.
//
// It is deliberately NOT a Proxy over the live AvatarMgr: this exposes exactly
// the two methods the ghost managers use, so a manager that starts using a third
// one fails loudly here instead of silently reaching through to a session object
// it should not be holding.

/**
 * @param {() => (object|null)} getNet  returns the live NetMgr, or null when
 *   there is no session (solo play, or between Leave and the next Join).
 * @returns {{getHead: Function, getHand: Function}} an AvatarMgr-shaped handle.
 */
export function createLiveAvatars(getNet) {
  const avatars = () => {
    // Solo play and the gap between sessions are ordinary states, not errors:
    // the managers keep ticking (a `!net` guard skips most of them) and simply
    // find nothing to attach to.
    try { return getNet?.()?.avatars ?? null; } catch (_) { return null; }
  };
  return {
    getHead: (peerId) => avatars()?.getHead?.(peerId) ?? null,
    getHand: (peerId, which) => avatars()?.getHand?.(peerId, which) ?? null,
  };
}
