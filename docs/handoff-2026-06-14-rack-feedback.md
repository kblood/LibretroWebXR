# Handoff — headset feedback on the patchable AV rack (2026-06-14)

Feedback from a Quest 3 session on the live build (`/webxr/libretrowebxr2/`)
after Phases 2–5 of the EmuVR rack landed (see [[rack-epic-status]] / git log
`0619f96`..`1d6afdc`). Issues are ordered by priority. Each has the reported
symptom, a root-cause hypothesis grounded in the code, and a proposed fix.

---

## P1 — Functional bugs (block normal play)

### 1. "Eye of the Beholder" (SNES) still fails to boot from the headset
**Reported:** loading the local SNES ROM still fails on the headset, same as before
the picked-ROM re-boot fix.

**Context:** commit `f21ffe5` was supposed to fix this — picked ROMs get cached in
OPFS (sha1) and the cartridge carries `rom` provenance so re-resolve uses
`opfs(sha1)` instead of a 404ing url fetch. OPFS round-trip was verified *headless*
but never confirmed on the headset.

**Likely causes to check (in order):**
- The actual boot error from the headset — read it, don't guess:
  `dionysus.dk/logs.json?session=<room>&tail=200` (the HTML log view hides event
  payloads; the JSON endpoint shows them). Look for `boot-error` with the file +
  error string. This tells us 404 vs core-load failure vs OPFS miss.
- Is it even the picked-ROM path? If the user loaded via the **file picker** the
  bytes should be cached (`cacheRom` → OPFS) and `meta.rom = {sha1, sources:['opfs','pick']}`.
  If loaded some other way (folder/url), the provenance may be missing.
- SNES specifically: snes9x is a `module` core; confirm the core file actually
  downloaded on the headset (a slow/failed core fetch reads as "couldn't load").
- OPFS availability on the Quest browser — `cacheRom` returns null if OPFS is
  unavailable, silently falling back to the (failing) url source.

**Files:** `src/RomResolver.js` (resolve/cacheRom/sha1Hex), `src/main.js` romInput
pick handler + `loadCartridge` catch (~line 2064), `src/Cartridge.js` (rom userData),
`src/GrabMgr.js` `_handleCartridgeRelease` (forwards `rom`).

---

### 2. Grabbing controller 2 still drives gamepad 1 (input routing)
**Reported:** "if you grab a controller it should be that controller that you
control, but grabbing controller two still makes me control the first gamepad."

**Root-cause hypothesis:** routing maps a held gamepad to `playerOf(cableId)`
(`src/Routing.js`), and main.js's wrapper falls back to **player 1 when the
gamepad isn't plugged**: `playerOf: (cableId) => cable.playerOf(cableId)?.player ?? 1`.
So if gamepad 2 never got a port, grabbing it silently drives player 1.

`seatGamepadInFreePort` auto-plugs an added gamepad into the next free port, but
it's clamped to `cu.activePorts` (`cable.firstFreePort(CONSOLE_ID, cu.activePorts)`).
If the current system/game exposes only **1 active port** (or no game is loaded
yet), the 2nd gamepad gets "no free port", stays unplugged, and falls through to
player 1 — exactly the reported symptom.

Secondary factor: this is also tangled with the **single-console** limitation —
all controller input goes to `console0` (the `cableAdapter` is bound to
`CONSOLE_ID` and there's one `GameInputMgr` on the primary client), so a second
console can't be driven at all yet.

**Proposed fix:**
- Make the `?? 1` fallback explicit: if a held gamepad isn't plugged, it should
  drive **no** player (don't silently steal P1), or auto-plug on grab.
- Ensure `activePorts` reflects the real system before seating (SNES = 2).
- Longer term: per-console input routing (see item 3).

**Files:** `src/Routing.js`, `src/main.js` `computeRouting` wrapper (~line 540) +
`seatGamepadInFreePort` (~line 1376), `src/GameInputMgr.js`.

---

### 3. Controller cord has no grabbable plug (can't repatch a controller)
**Reported:** the **video** cord (console→TV) has a working grabbable plug, but
the **controller** cord lacks one, so you can't pull it out and plug the
controller into another port.

**Context:** Phase 4 only added grabbable plugs (`src/Plug.js`) to the **video**
cords. Controller cords are still the old model — the gamepad *body* seats into a
port and the cord is just a visual rope (`syncCords` in main.js). Grabbing the
gamepad no longer unplugs it (intended), but there's no plug end to repatch with.

**Proposed fix:** give each controller cord a `Plug` (plugKind `'controller'`),
exactly mirroring the video plugs:
- Reuse `src/Plug.js` + `src/Snap.js`. Controller plug seats into a console's
  `portJacks[i]` (the front-face jacks already exist in `src/Console.js`).
- Extend `handlePlugReleased` (or add a sibling) to handle `plugKind === 'controller'`:
  nearest free port across **all** consoles' jacks → `cable.plugController` +
  snap + re-route input. Dropping in mid-air → `unplugController`.
- This is the natural place to make controller routing **console-aware** (one
  `GameInputMgr` per console, or route by which console the plug is in), which
  also fixes the multi-console half of item 2.

**Files:** `src/Plug.js`, `src/Snap.js`, `src/main.js` (controller cord section +
`handlePlugReleased`), `src/Console.js` (`portJacks`), `src/GrabMgr.js`.

---

## P2 — Placement (props land in walls)

### 4. "Spawn Console" places the console (and its TV) through the wall
**Reported:** adding another console adds a full console system, but there isn't
room — it goes into the wall.

**Root cause:** `spawnConsole` uses a **fixed fan-out**:
`fanX = 2.6 + (n-1) * 2.4`, TV at `[fanX, 1.5, -3.6]`, console at `[fanX, 0.74, -2.4]`.
No room-bounds clamp, so the 2nd+ console/TV walk straight through the side wall.

**Proposed fix:** place spawned consoles/TVs against the available wall space
using the existing `clampToRoom` / `snapToSurface` from `src/Placement.js`
(GrabMgr already uses these for the ghost). Or spawn at the user's gaze/reach and
let them position it (ties into item 6).

**Files:** `src/main.js` `spawnConsole` (~line 545), `src/Placement.js`.

### 5. Spawned posters also land inside the wall
**Reported:** posters spawned via the menu spawn inside the wall.

**Note:** pre-existing (not introduced by the rack work). `addProp('poster')` uses
`spawnTransform('poster')`; the wall-snap math is placing it behind the wall
plane. Likely the same fix family as item 4 (surface snap offset/sign).

**Files:** `src/main.js` `addProp` / `spawnTransform`, `src/Placement.js`
`snapToSurface` (wall case).

---

## P3 — Requested features

### 6. Make consoles and TVs movable
**Reported:** "it should be possible to move the consoles and TVs."

**Context:** TVs aren't grabbable at all; spawned consoles were deliberately
*not* registered as grabbables (to avoid grabbing them mid-play). The room
**editor** (Move mode) already moves editable props with surface snapping.

**Proposed fix:** register TVs and consoles as **editable** props (grabbable only
in Move/edit mode, like furniture), so they don't interfere with play but can be
repositioned. Each rack TV/console should expose its placement so the rack
persistence (item: `src/RackPersistence.js`) can save where they were moved to.

**Files:** `src/TV.js`, `src/Console.js`, `src/main.js` (register with
`grabMgr.addGrabbable` + `editor`), `src/RoomEditor.js`.

### 7. Option to hide the walls
**Reported:** "Maybe it should be possible to hide the walls."

**Proposed fix:** a menu toggle (like the new "Auto-pause" one) that sets
`scene._walls[*].visible = false` (and maybe ceiling). Cheap. `SceneMgr` already
holds `this._walls` keyed by side. Could also help with the placement issues
above by making mis-placed props visible while we fix them.

**Files:** `src/SceneMgr.js` (`_walls`), `src/main.js` (menu toggle, mirror the
`Auto-pause` button pattern at ~line 1994).

---

## Suggested order of work
1. **Item 1 (ROM boot)** — read the headset logs first; it's the only thing
   blocking actually playing a loaded ROM.
2. **Items 2 + 3 together** — controller plugs + console-aware input routing are
   one coherent piece and fix the "wrong gamepad" bug properly.
3. **Item 4 + 5** — room-aware placement (shared fix).
4. **Items 6 + 7** — movable consoles/TVs + hide-walls (quality-of-life, and 7 is
   a quick win).

All current work is on `main` in `C:\LLM\LibretroWebXR`, deployed at
`/webxr/libretrowebxr2/`. Headless probes for the rack live in `scripts/probe-*.mjs`.
