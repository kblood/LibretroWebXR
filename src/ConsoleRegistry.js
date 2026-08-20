// The rack's shared registries: which console objects exist, what each one is
// running, and whether each console / TV is powered on.
//
// Extracted VERBATIM from src/main.js (the P2 #12 / §3.1 extraction plan, step
// 0 — the PREREQUISITE hoist). Nothing here is new logic; the maps and the two
// predicates below are the same ones main.js declared inline, moved.
//
// WHY THIS MODULE EXISTS SEPARATELY, rather than riding along inside PowerMgr or
// PeripheralCords. These four things are the most widely-shared state in the
// file — `consoleObjs` has 28 references file-wide, `registerMovableProp` 11,
// `_consoleSystems` 10 — and they are *general*: the cords need them, the power
// switches need them, boot needs them, the rack save/restore needs them. If they
// had travelled inside the first specific module that happened to touch them,
// every later extraction would have to import a module named after somebody
// else's feature to reach a general registry. So they come out first, on their
// own, and both PowerMgr and the cord blocks consume this.
//
// WHY `getGrabMgr` IS A GETTER AND NOT A VALUE: main.js's `grabMgr` is null at
// module eval and assigned later (in buildCartridgeWorld), so a value captured
// at construction would be permanently null and registerMovableProp would
// silently register nothing. The getter is what preserves the original
// late-bound `if (!obj || !grabMgr) return;` behaviour exactly, and the single
// `const grabMgr = getGrabMgr();` at the top of registerMovableProp is the ONLY
// line in this file that was not moved across verbatim.

export function createConsoleRegistry({ getGrabMgr }) {
  // Per-console / per-TV power state for the in-world on/off switches. Absent or
  // true = on; false = powered off (core paused + its TV blanked to the idle
  // screen). routeVideo() is the single place that honours these.
  const consolePowered = new Map();  // consoleId -> bool
  const tvPowered = new Map();       // tvId -> bool
  const isConsoleOn = (id) => consolePowered.get(id) !== false;
  const isTvOn = (id) => tvPowered.get(id) !== false;

  const consoleObjs = new Map();                     // consoleId -> physical Console Object3D

  // `currentConsoleSystems` tracks what each console is running (set by loadCartridge).
  const _consoleSystems = new Map(); // consoleId -> system string (set on each boot)

  // Item 6 — make a rack prop (TV cabinet / console) repositionable: register it
  // as an editable grabbable so it is inert during play but movable in the editor's
  // Move mode (released props keep their dropped pose, grid-snapped if grid is on).
  function registerMovableProp(obj, kind) {
    const grabMgr = getGrabMgr();
    if (!obj || !grabMgr) return;
    if (!obj.userData.kind) obj.userData.kind = kind;
    obj.userData.editable = true;
    grabMgr.addGrabbable(obj);
  }

  return { consolePowered, tvPowered, isConsoleOn, isTvOn, consoleObjs, _consoleSystems, registerMovableProp };
}
