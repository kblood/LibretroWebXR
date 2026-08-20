# Roadmap

LibretroWebXR is a **browser-based, WebXR libretro frontend** that runs retro
emulators inside a 3D room, on desktop browsers and standalone Quest, with no
install. The north star is an **open, web-native EmuVR**: build your own room,
curate game collections, share rooms as data, and eventually play together.

See `docs/EMUVR_RESEARCH.md` for what we're modelling on,
`docs/ROOM_AND_COLLECTIONS.md` for the room/collection JSON system,
`docs/MULTIPLAYER.md` for the netcode plan, and `docs/LICENSING.md` for the
"fetch cores, ship no ROMs" policy.

## Current state (inherited prototype — already working)

This is **not** a greenfield plan; a working app was carried over (see
`PROVENANCE.md`). It already has:

- Three.js + WebXR scene with an enclosed 3D room (`SceneMgr`, `CrtShader`).
- libretro cores driven directly (main-thread `<script>` + dynamic `import()`
  for MODULARIZE cores), rendering onto a CRT/TV mesh (`EmulatorClient`). The
  four heavy cores added since (PSX, PS2, N64, DOS) carry `execution: 'worker'`
  and run in a dedicated execution worker instead —
  `src/runtime/EmulatorWorkerRuntime.js` + `RuntimeEmulatorClient`; see **DOS**
  and **Phase C** below, and `docs/HANDOFF.md`'s "PSX / PS2 / N64 core status".
- A VR room: grabbable **cartridges** on shelves and **bookcases** (up to 15
  carts), a **console**, a **gamepad**, a **memory card**, with grab + locomotion
  (`Cartridge`, `Shelf`, `Console`, `Gamepad`, `MemoryCard`, `Furniture`,
  `GrabMgr`, `LocomotionMgr`).
- **Distance-grab highlight (2026-07-12):** `GrabMgr` now outlines whatever a
  controller (or the desktop mouse-look ray) is aiming at with a yellow
  wireframe box, before the grip is even squeezed — the existing aim-ray
  hover detection (which already recoloured the laser) now also fits a
  reusable per-controller box to the hovered object's live world bounds each
  frame, and hides it on grab/aim-away. Works for every grabbable kind
  (cartridges, gamepad, light gun, mouse, patch-cord plugs, editable props)
  with no per-prop registration. Headless-verified end-to-end against the
  real aim/grab/release code path: `tmp/verify-grab-highlight.mjs` (13/13).
- Input across keyboard / gamepad / WebXR controllers with per-core, two-hand
  RetroPad mapping (`InputMgr`, `GameInputMgr`, `ControllerMaps`,
  `ControlsPanel`).
- Save states (`SaveState`), spatial audio (`SpatialAudio`), in-VR menus
  (`MenuMgr`, `MenuPanel`), a debug HUD, and a `?core=` override.
- **C64/VIC-20 virtual keyboard** (`C64Keyboard`, `C64KeyLayout`): world-space
  point-to-type panel, auto-shown for C64/VIC-20, manually toggleable.
- **In-world Now Playing / input debug panel** (`NowPlayingPanel`): current
  system/core/ROM + live input pulse diagnostic.
- **Remote logging** (`Logger`, `server/log-server.mjs`, `deploy/log-proxy.conf`):
  ships Quest console/error logs to
  `https://dionysus.dk/logs?session=<room>&token=<yours>` — **reads are
  token-gated in production**, `POST /log` is not (see below).
- **Room persistence** (`RoomPersistence`): room survives cross-core reload;
  auto-saves to localStorage on Export; Import Room button.
- **Poster image picker + fit/scale** (`ImageLibrary`, `PosterFit`): grant an
  on-Quest images folder; contain/cover/stretch + zoom per poster; in-VR 3×3
  thumbnail gallery.
- **Placement preview + snapping** (`Placement`): new props clamp to room bounds
  and snap to floor or nearest wall; ghost preview in Move mode.
- **20 systems** wired (SNES, NES, GB/GBC/GBA, Genesis/SMS/GG/SG-1000/Sega 32X,
  Virtual Boy, PC Engine, Atari 2600, C64, VIC-20, Amiga, **DOS**, **PS2**,
  **PSX**, **N64**) via the `CORES` map / `systems.js`. DOS ships on **DOSBox
  Pure** and is on the default shelf (see **DOS** below); **PSX was un-gated
  2026-08-07** and only **N64** still carries `experimental: true` in
  `systems.js` (hidden from the default shelf unless `?experimental=1`) — see
  **Mouse peripheral + new systems** below and `docs/HANDOFF.md`'s
  "PSX / PS2 / N64 core status" for the core-level detail.
- COOP/COEP for SharedArrayBuffer (`vite.config.js`, `deploy/`), and a puppeteer
  health-check harness (`scripts/debug.js`, `DEBUGGING.md`).
- Test suite: grows every phase. `npm test` is `node scripts/run-tests.mjs`,
  which **discovers** every `scripts/test-*.mjs` that is not a server suite —
  writing one is all it takes to be in CI, and `package.json` no longer carries
  a list to append to (it used to, as an `&&` chain, and four green suites sat
  outside it for months). See `CLAUDE.md` → Tests.

So the foundation EmuVR took years to build (room + emulator-on-a-TV + grabbable
games) largely exists. The roadmap is about **making it open, declarative, and
multiplayer** — EmuVR's strengths — while keeping our advantages (browser,
Quest-native, shareable-as-data).

## Phase 0 — Publish the clean repo  ✅ (this commit)
Clean re-home, MIT license, licensing docs, EmuVR research, this roadmap, a
core-fetch script, and free test ROMs. Initialize git; push to a host.

## Phase R — Rooms & Collections as JSON  ← in progress
Turn today's imperative scene-building into a declarative layer (no rewrite).

### R.1 — Data layer  ✅ done
- `src/systems.js` — system-first registry (label, default/allowed cores, exts,
  folder aliases, thumbnail repo, core license). Refactor of the `CORES` map;
  `main.js` now imports from here instead of defining cores inline.
- `src/ArtResolver.js` — libretro-thumbnails candidate chain (filename → title →
  tag-stripped), with RetroArch's forbidden-char sanitization.
- `src/Collection.js` — loads/normalizes both the legacy `manifest.json`
  (`cartridges[]`) and the new `*.collection.json` (`games[]`); auto-fills core
  from the system default and box-art candidates. `Cartridge.js` now tries the
  candidate list, falling through on 404 to a text label.
- `main.js` loads via `loadCollection`, supports `?collection=URL` (alias
  `?room=URL`), and resolves ROM URLs (absolute / rooted / roms-relative).
- Tests: `npm test` (`scripts/test-collection.mjs`, 24 pure-logic assertions);
  `npm run debug` verdict OK with boxart 404s reclassified as expected probes.
- Example: `public/roms/snes-demo.collection.json`.

### R.2 — ROM sources  ✅ done
- `src/RomResolver.js` — `resolve(meta) → Promise<ArrayBuffer>` across four
  sources: **url** (fetch / roms-relative), **local** (File System Access API —
  a folder the user grants once, directory handle persisted in IndexedDB, games
  matched by basename a few levels deep), **pick** (one-off `<input type=file>`),
  **opfs** (Origin-Private File System cache). Delivers the user goal: reference
  **web folders** *or* **local folders on PCs/headsets**.
- OPFS caching is purely content-addressed (only entries with a declared `sha1`
  are cached/served), so a hit can never be stale — filename-only entries (our
  relative CC0 games, which rebuild in place) are never cached.
- **sha1 is enforced, not just a cache key (2026-07-10).** `verifyRomIntegrity`
  hashes freshly-fetched `url`/`local`/`pick` bytes and rejects a mismatch
  against a declared `rom.sha1`, folded into `resolve()`'s source-fallback
  loop; `opfs` hits skip re-hashing (already correct by construction). A
  no-op for entries with no declared sha1 — every shipping CC0 ROM is
  unaffected.
- Wired behind `main.js`'s `loadCartridge()` seam (replaced the old
  `romUrl()`+`fetch`). A "ROM folder…" header button (shown only where the FSA
  API exists) grants the local library — now with an in-VR menu equivalent too
  (see R.3/E.3 below).
- **"You don't own this ROM" pre-flight badge (2026-07-10).**
  `isUnresolvableHere(meta)` flags a local-only cart (`sources` restricted to
  `opfs`/`pick`, no `url` fallback) whose bytes aren't in THIS browser's OPFS
  cache — the common case being a multiplayer peer looking at a cart another
  peer loaded from their own local folder/pick. `Cartridge.js` composites a
  badge onto the label instead of only failing reactively at load time.
  Real-headless-browser verified: a synthetic uncached local-only ROM flags
  true, a normal shipped `url`-sourced cart stays false.
- Tests: `npm test` now 45 assertions (RomResolver pure helpers +
  fetch-injected `resolve()` url path). `npm run debug --boot=<system>` boots a
  collection game through the real resolver/core-start path; verdict OK with NES
  rendering verified in-app.

### R.3 — Room loader  ✅ done
- `src/RoomLoader.js` — **pure** parse/normalize of a `*.room.json` into a
  canonical descriptor (`parseRoom`, `defaultRoom`, `normalizeProp/Portal`,
  `roomCollectionRefs`). No THREE, so `npm test` covers it (mirrors the
  Collection.js-parses / builder-builds split).
- `src/RoomBuilder.js` — **imperative**: `buildRoom({scene, room, collections})`
  drives the existing `createShelf/Console/Cartridge/Gamepad` factories from the
  descriptor, builds posters/models/portals inline, and returns the handles
  (`consoleObj, gamepadObj, cartridges, portals`) main.js keeps wiring. Shelf
  games come from a named collection + optional `filter`/`slice`/`half`.
- `SceneMgr.applyEnvironment(env)` repapers floor/ceiling/walls (flat colour,
  `builtin:` palette, or texture URL with tiling; per-wall `wallpaper_*`
  overrides) and relights (`timeOfDay` preset + `lamps[]`). `applyTv(prop)`
  toggles the CRT shader (`crt`|`flat`).
- `main.js` now builds every world through RoomLoader/RoomBuilder. **`?room=URL`
  loads a full room** (split from `?collection=`, which still drops a bare
  collection into the built-in `defaultRoom()` layout); **drag-drop** a
  `.room.json`/`.collection.json` onto the page (stashed → reload). **Portals**
  navigate to the target room on walk-in (proximity → `?room=` reload).
  No-`?room` default reproduces the historical two-shelf layout exactly.
- Tests: `npm test` now 70 assertions (room parsing). `npm run debug` verdict OK
  for default + `?room=roms/bedroom.room.json` + `?room=roms/arcade.room.json`;
  GB game boots in-room, screenshot-verified.
- Examples: `public/roms/bedroom.room.json` + `arcade.room.json` (cross-linked
  by portals).

### R.3 follow-ups (deferred)
- `tv` prop only toggles the CRT shader today; repositioning the TV mesh (and
  the separate stand) from `pos/rot` is not wired.
- Portal target is treated as a room URL; local room **ids** (a gallery/registry)
  aren't resolved yet.
- A shared room with `owned`/`local` games shows empty slots only insofar as
  RomResolver can't fetch them at play time — there's no pre-flight "you don't
  own this" affordance on the cartridge yet.

## Phase E — In-VR room editor  ✅ done (+ 2026-06-13 follow-ups below)
Place/rotate props, swap wallpaper/floor/posters, assign collections to shelves,
add **portals** to other rooms — all writing back to `*.room.json`. Export/share
a room. This is the open, declarative replacement for EmuVR's closed WIGUx mod.
E.1 (move + export), E.2 (look editing) and E.3 (create props/portals) are all
done, and the formerly-deferred *assign collections to shelves in-VR* is now
done too (see **Edit modes** below). See also the Phase E quality work below.

### Edit modes — Move / Change / Add  ✅ done (2026-06-03)
The flat E.1/E.2/E.3 menu was reorganized into a **Play / Move / Change / Add**
mode selector (`RoomEditor._mode` enum + per-mode menu sub-panels; MenuMgr skips
buttons in hidden panels).
- **Move** — grab a prop to reposition it (E.1).
- **Change** — grip-SELECT a prop (`GrabMgr` routes grip→select in this mode),
  then *Cycle Selected* advances its primary property: poster art
  (`cyclePosterTexture`) or **shelf collection** (`cycleShelfCollection` +
  `rebuildShelf`, a live swap using `GrabMgr.removeGrabbable` /
  `SceneMgr.removeObject` / `RoomEditor.removePlaced`). Global Wallpaper / Floor /
  Lighting / All-Posters cycles live here too (E.2). **This closes the previously
  deferred "assign collections to shelves".**
- **Add** — a furniture catalogue: Shelf, **Bookcase / Cupboard / Table** (new
  decorative props in `src/Furniture.js`), Console, Poster, Portal (E.3).
- Verified: `npm test` (cycleShelfCollection + furniture types + loader round-trip)
  and a headless probe (furniture spawns/serialize; shelf cycle manifest→snes
  rebuild swaps the object and round-trips through Export). Real-VR smoke test of
  the modes + redeploy still pending (menu is raycast-only).

### E.1 — Move props + export  ✅ done
- In-VR **Edit mode** (a Menu toggle): the room's props (shelves, console,
  gamepad, posters, portals) become grabbable; releasing one leaves it where
  dropped instead of snapping home / inserting. A **Snap** menu toggle switches
  free placement ↔ grid (0.1 m / 15°). Portal walk-through navigation is
  suspended while editing.
- `src/RoomSerializer.js` — **pure** inverse of `RoomLoader.parseRoom`:
  `serializeRoom(room, transforms)` re-emits a clean room@1 object, refreshing
  each prop/portal's pos/rot from a live-transform map by id and preserving every
  non-spatial field. Round-trips with `parseRoom` (the descriptor carries
  collection/half/texture/shader/target; the live objects carry pos/rot).
- `src/RoomEditor.js` — **imperative**: registers `RoomBuilder`'s new
  `placed:[{prop,object}]` handles as editable grabbables (inert until edit
  mode via a `GrabMgr` candidate filter), harvests live transforms, and
  **exports** the room (file download + clipboard). An "Export Room" header
  button mirrors the in-VR item.
- `RoomBuilder` now stamps `userData.roomProp` on every movable object and
  returns `placed`; `GrabMgr` gained an `isEditMode`/`onEditRelease` seam (no
  play-mode behavior change — edit targets only props, play targets only
  cartridges/gamepad/cards).
- Tests: `npm test` now 81 assertions (RoomSerializer round-trip + live-transform
  override). `npm run debug` verdict OK; live `window.__editor.serialize()`
  verified to reproduce the loaded room.

### E.2 — In-VR environment editing  ✅ done (collections-to-shelves deferred)
- `src/EnvEditor.js` — **pure** option-cycling over fixed palettes
  (`cycleSurface`/`cycleTimeOfDay`/`cyclePosterTexture`, `nextInCycle`,
  `ensureEnvironment`). Mutates the room descriptor in place and returns the new
  value; no THREE/DOM, so `npm test` covers it. Mirrors the pure/imperative
  split of RoomSerializer/RoomEditor.
- `RoomBuilder.applyPosterTexture(material, texture)` extracted from `buildPoster`
  so the editor can swap a poster's `builtin:`/URL look live without duplicating
  the resolve logic.
- `main.js` adds **Wallpaper / Floor / Lighting / Posters** menu buttons that
  cycle a palette, mutate `currentRoom`, and re-apply immediately
  (`SceneMgr.applyEnvironment` for surfaces/lighting, `applyPosterTexture` per
  poster). Edits ride back out through **Export Room** (RoomSerializer already
  echoes `environment` + each prop's `texture`).
- Tests: `npm test` now 99 assertions (EnvEditor cycling + end-to-end
  edit→serialize capture). `npm run debug --probe-file=…` on
  `bedroom.room.json` screenshot-verifies the live repaint (blue→green walls,
  wood→dark floor, evening→day) and the `editor.serialize()` round-trip.
- **Deferred to an E.2 follow-up:** *assign collections to shelves* in-VR. Doing
  it live needs a shelf+cartridge rebuild (and a `GrabMgr.removeGrabbable`) that
  the current grab/insert lifecycle isn't structured for — out of scope for a
  no-rewrite increment. The other three clauses (wallpaper/floor/posters) are done.

### E.3 — Create props in-VR  ✅ done (collections-to-shelves still deferred)
- `src/PropCreator.js` — **pure** descriptor minting: `createProp` /
  `createPortal` return a normalized prop/portal (shaped exactly like one parsed
  by `RoomLoader`, so it round-trips through `RoomSerializer` on export) with a
  collision-free `uniqueId`; `addProp` / `addPortal` append to the descriptor.
  `CREATABLE_PROP_TYPES` = shelf/console/gamepad/poster (tv has no object, model
  needs an asset URL). No THREE/DOM → `npm test` covers it.
- `RoomBuilder` extracted a single-prop **`buildProp(prop, {scene,collections})`**
  (and exported **`buildPortal`**) so one new prop builds through the exact same
  factory path as the loaded room; `buildRoom`'s switch now delegates to it.
- `RoomEditor` gained `setEditMode(on)` + **`registerPlaced(prop,object)`** — the
  seam that makes a runtime-created prop an editable grabbable and adds it to the
  placed set, so E.1 move + E.2 look-editing + Export Room all apply to it
  immediately.
- `main.js` adds **Add Shelf / Add Console / Add Poster / Add Portal** menu
  buttons. Each spawns the prop ~1.4 m in front of the player (facing them),
  builds it, pushes the descriptor into `currentRoom`, registers it, force-enables
  Edit mode, and (for a shelf) registers its cartridges as play-mode grabbables.
  A new portal aims at an example room that isn't the current one and is appended
  to the live proximity-nav list so walk-through works. `window.__add.*` drives it
  headlessly (exposed before the `buildMemoryCards` stall, like `__editor`).
  **Portal retargeting in-VR done (2026-07-10):** select the portal in Change
  mode, then Cycle Selected (`EnvEditor.cyclePortalTarget`, same
  advance-through-an-ordered-list shape as `cycleShelfCollection`) cycles
  `prop.target` through `KNOWN_ROOMS` and keeps the live `activePortals`
  proximity-nav record in sync. Portal descriptors have no `.type` field
  (`normalizePortal` doesn't set one — only `room.props[]` entries do), so
  Cycle Selected keys this branch off `object.userData.kind === 'portal'`.
  **Also done (2026-07-10): in-VR "Grant ROM Folder" / "Grant Images Folder"
  main-menu buttons** (same `pickLibraryDirectory()`/`pickImagesDirectory()`
  flows as the desktop header buttons, fired from a raycast trigger) **and a
  "Load Collection" Add-panel button** that cycles through known collections
  not yet referenced by the room (`roms/homebrew.collection.json`,
  `roms/snes-demo.collection.json`) and spawns a shelf for the chosen one —
  the in-VR equivalent of drag-dropping a `*.collection.json` onto the page,
  without free-text URL entry (VR avoids that throughout this codebase).
- Tests: `npm test` now 121 assertions (PropCreator id/mint/append + created
  prop/portal serialize round-trip). `npm run debug --probe-file=…` verifies
  adding poster+shelf+portal grows props/portals/placed/grabbables, auto-enters
  Edit mode, and the new ids appear in `editor.serialize()` — i.e. Export Room
  captures them. Screenshot-verified the spawned props render.
- **Still deferred** (from E.2): *assign collections to shelves* in-VR — needs a
  live shelf+cartridge rebuild and `GrabMgr.removeGrabbable` the grab/insert
  lifecycle doesn't have yet. The descriptor + serializer already support it.

### Phase E quality / follow-up work  ✅ done (2026-06-13)

#### Placement preview + wall/floor snapping  ✅ done
New `src/Placement.js` (pure, unit-tested — 71 assertions): room-bounds model,
`clampToRoom`, and `snapToSurface` — floor props (shelf/bookcase/console/table/
cupboard/gamepad) rest at a per-kind height; wall props (poster) snap to the
nearest inward-facing wall plane. `SceneMgr.getRoomBounds()` exposes the inner
extents. `GrabMgr.tick` shows a translucent ghost at the snapped drop point in
Move mode. "Surface Snap" button (default on) coexists with the grid-snap toggle
(surface snap first, then grid rounding). New props no longer spawn outside walls
or floating mid-air.

#### Room persistence  ✅ done
`src/RoomPersistence.js` (pure save/load helpers): the live room is stashed before
the cross-core `location.reload()` and restored on resume, so booting a
different-core ROM no longer wipes room edits. Every Export also snapshots to
`localStorage`; auto-loaded on cold boot (`?room=default` clears/bypasses as an
escape hatch). **Import Room** header button (counterpart to Export) reuses the
drag-drop load path.

#### Configurable posters + shelf/bookcase ROM collections  ✅ done
Poster builtin palette expanded 6 → 12 styles. "Set Poster Image…" header button
sets a custom local-file (object URL) or pasted URL on the selected poster,
persisted via `prop.texture` (round-trips through `RoomSerializer`). Add
Shelf / Add Bookcase now cycle available collections so a new prop holds the chosen
ROMs. Change-mode Cycle Selected re-assigns live (`rebuildBookcase` mirrors
`rebuildShelf`). Bookcases build up to 15 grabbable carts across 3 rows.
Follow-up: picked images are blob: URLs (don't survive reload — store
folder-relative filename + re-resolve instead).

#### On-Quest image picker + poster fit/scale  ✅ done
`src/ImageLibrary.js`: grant an images folder via File System Access API (handle
persisted in IndexedDB); works in a Quest XR session. `src/PosterFit.js` (pure,
unit-tested): contain / cover / stretch + scale (zoom) factor → `THREE`
repeat/offset. In-VR Change panel gains a 3×3 thumbnail gallery, Fit cycle, and
Scale+/Scale−. `EnvEditor.cycleFitMode`/`stepScale` (pure, tested). Poster
descriptor gains `fit`/`scale` fields (default contain/1), round-tripping via
`RoomSerializer`. +61 tests (1225 total).
Follow-up: blob: URLs lost on reload (later fixed, see HANDOFF.md);
shelf/bookcase cover image **done 2026-07-10** — `src/CoverPlaque.js`, a
canvas-texture plaque naming the shelf/bookcase's collection.

#### C64 virtual keyboard  ✅ done
`src/C64KeyLayout.js` (pure, Node-importable): full C64 layout + per-key
`KeyboardEvent` mapping + UV hit-test. `src/C64Keyboard.js`: world-space
CanvasTexture panel with hover/tap/hold highlight; dispatches via injected
`sendInput` callback. Wired below the TV: auto-shows for c64/vic20 on boot
(hides + flushes held keys otherwise); "Keyboard" menu item + header button
toggle manually for any system. Dedicated raycaster per controller; trigger taps
the hovered key — gated so it never clashes with the menu raycast. Uncertain VICE
mappings (CTRL/RUN-STOP/RESTORE/C=/£/up-arrow/=) isolated in `C64KeyLayout.js`
for headset tuning. +682 test assertions for the module alone.

#### Load-ROM fix (incl. SNES)  ✅ done
The header "Load ROM" handler previously booted the core but never set
`currentMeta`/`system`/ports/Now-Playing panel. Now wires all state and, on
success, mints a cartridge and places it on the least-full shelf (creating a new
shelf when all are full) via `Shelf.addCartridgeToShelf`, registered grabbable.
Verified headless with a SNES `.sfc`. Follow-up: local-file carts not persisted
to the room descriptor.

#### Gamepad port-plug fix  ✅ done
A gamepad release now always tries plug-into-port before the edit-mode prop-
reposition path. The old ordering (`isEditMode && editable`) swallowed the release
when `RoomEditor` marked the gamepad editable — controllers couldn't be wired to a
console port in edit mode. Grab invariant (gamepad pickable in both modes) preserved.

#### In-world Now Playing / input debug panel  ✅ done
`src/NowPlayingPanel.js`: world-space panel showing current system/core/ROM title
and a live "● input" pulse on each RetroPad key transition. Primary diagnostic for
the "can't control console" report. Wired via `GameInputMgr.onKeyDown` +
`loadCartridge`.

## Local multiplayer — couch co-op  ✅ done (2026-06-03)
Up to 4 *local* players on one console, routed by which port a controller is
plugged into. **Distinct from networked Phase M below** (this is same-machine
co-op; no server). `src/CableMgr.js` (pure, unit-tested) maps gamepad ↔ port ↔
player; `src/Console.js` renders the P1..P4 port row and `portsForSystem()`
enables the count the hardware accepts; plugging is a grab-drop (reusing the
cartridge-insert snap in `GrabMgr`); `GameInputMgr` dispatches per-gamepad,
per-player (P1 double-dispatch + P2-4 `EXTRA_PLAYER_KEYS`, bound in
`RetroArchConfig`); `InputMgr` also forwards P2-4 keyboard keys for same-keyboard
desktop co-op. A `npm test` assertion guarantees no key code collides across
players. **VR controller routing still needs a real-headset smoke test; not yet
redeployed.** Follow-ons: physical USB-gamepad routing, per-pad mesh animation +
DebugHud for players 2-4, in-VR port retargeting.

> **Four Score gap — ✅ closed (2026-06-30).** Routing P2-4 keys via
> `EXTRA_PLAYER_KEYS` was necessary but not sufficient on the NES: a real NES
> only has two controller ports, so a 4-player ROM reads P3/P4 over the **Four
> Score** multitap serial protocol. Fixed by putting the NES ports into the
> Four Score *device* (`retro_set_controller_port_device`, wired in
> `RetroArchConfig.js`/`main.js`), since there is no `fceumm_4player` core
> option. **NES Bomberman** (an authored 4-player CC0 ROM with a Four Score
> auto-detect + power-ups) is the verified test case (commits `ad17131`,
> `61b5826`, merged `5a060fc`); headset confirmation still pending. Same
> mechanism would apply to any genuinely-4-port console (SNES multitap, etc.).

## Phase M — Multiplayer, networked (see `docs/MULTIPLAYER.md`)  ← in progress

### Remote logging system  ✅ done (2026-06-13)
Prerequisite for diagnosing headset-only bugs without a USB cable:
- `src/Logger.js`: hooks `console` + `window` error/`unhandledrejection`, buffers
  structured JSON entries (`level/ts/session/nick`), POSTs batches with backoff +
  keepalive. Auto-enables on `dionysus.dk` or via `?log=<url>`. Pure
  `formatEntry`/`buildBatch` helpers are unit-tested (+38 assertions).
- `server/log-server.mjs` (mounted by `room-server.mjs`, port 8788): POST `/log`,
  GET `/logs` (auto-refreshing HTML viewer), GET `/logs.json`. Per-session ring
  buffer + NDJSON append (file logging is **always on**, not optional — this
  bullet said otherwise for a year and it was never what the code did).
- `deploy/log-proxy.conf`: Apache reverse-proxy snippet for `/log` + `/logs` +
  `/logs.json`. Note: `/logs.json` rule must appear before `/logs` (ProxyPass
  matches on whole segments — see HANDOFF.md Gotchas).
- Read headset logs at
  **`https://dionysus.dk/logs?session=<room>&token=<yours>`**.

**Hardened 2026-08-17** (both 2026-08-13 whole-repo reviews had this as their
second finding — it shares a process with multiplayer, so a bug here takes
netplay down):
- **Reads are token-gated in production** (`LOG_TOKEN`, generated on the box into
  `/etc/default/libretrowebxr-room`, pulled in by the systemd unit's
  `EnvironmentFile=-…`). The gate already existed in code; the deployment simply
  never switched it on. Ungated, `GET /logs.json?tail=0` enumerated every session
  and handed out room names, nicks and private-library ROM filenames. **`POST
  /log` is not gated and never will be**, so the Quest carries no secret.
- Entries are escaped on the way out (stored XSS) and validated on ingest, and
  the viewer handler is wrapped — a malformed POST used to be a one-request kill
  switch on the room server.
- Every per-axis cap now has an **aggregate** budget over it, because per-axis
  caps multiply: `MAX_STORE_BYTES` (64 MiB accounted, counting per-JSON-node heap
  cost, not just characters) for the in-memory store, and
  `MAX_LOG_FILES`/`MAX_LOG_DIR_BYTES` (200 files / 512 MiB, oldest evicted and
  unlinked first) for the log directory. Before: ~52 GB of retainable heap and
  unbounded disk, from unauthenticated POSTs rotating `sessionId`.
- Recipe and rationale: `docs/HANDOFF.md` → "Reading headset logs (the token)";
  every knob has a row in `server/README.md` (`scripts/test-room-limits.mjs`
  fails the run if one doesn't).

### Input pipeline instrumentation  ✅ done (2026-06-13)
`main.js` emits Logger `'input'` events on every keydown and throttled
`'input-state'` events (gamepad held? XR gamepad count? controller count?
system map?) on change. Together these let a "can't control the console" report
be diagnosed entirely from the log viewer. **The controls bug is instrumented, NOT
confirmed fixed — headset test pending.**

### In-app multiplayer join/leave UI + roster  ✅ done (2026-06-13)
Rooms were joinable only via `?session=`. Added:
- Header widget: room name / nick / color + Join/Leave buttons + live "room — N
  players (nicks)" status. Uses `NetMgr.connect()/disconnect()` for runtime join
  (no reload) — room layout + loaded game survive.
- In-VR "Multiplayer" menu panel: status, Join, Leave, Copy room name.
- `src/net/SessionUtils.js` (pure): `sanitiseRoom` / `randomRoomSuffix`. +21 tests.
- Solo play is unchanged when never joining.
- Known follow-up: held-cart ghosts only wire on the `?session=` path, not a
  post-build button join (`GhostCartMgr` is built during `buildCartridgeWorld`).

### Headless dummy multiplayer player  ✅ done (2026-06-13)
`scripts/dummy-player.mjs`: joins a room over the presence WebSocket and logs
everything it observes (peer join/leave, poses, STATE/TV-sync, voice/video SIGNAL,
remote INPUT, held-object). CLI: `--session/--url/--nick/--color/--move`.
`npm run dummy-player -- --session=<room> --move`. Live-verified against
`wss://dionysus.dk/ws/`. Useful as a lightweight observer while a headset plays.

- **M0:** shared room presence — avatars + voice + room-object sync (works for
  all cores). Signaling/matchmaking server + TURN.
  - **M0.1 ✅ done** — pure wire protocol + peer registry (`src/net/NetProtocol.js`,
    `src/net/PresenceState.js`); unit-tested in `scripts/test-net.mjs`.
  - **M0.2 ✅ done** — avatars (`src/net/Avatar.js` head+hands+nameplate,
    `src/net/AvatarMgr.js` reconciles the peer list into scene objects).
  - **M0.3 ✅ done + DEPLOYED** — WebSocket transport: pure `server/Hub.js` +
    thin `server/room-server.mjs` (`ws`) relay; `src/net/NetMgr.js` browser
    client, opt-in via `?session=<room>`. Verified by `server/smoke.mjs`
    (two-client relay) and `scripts/smoke-presence.mjs` (real Chrome sees a peer
    + renders its avatar). **Live on dionysus.dk (2026-06-09):** systemd unit
    `libretrowebxr-room` (port 8787) + Apache `/ws/` proxy; the production smoke
    against `wss://dionysus.dk/ws/` passes. Templates: `deploy/libretrowebxr-room.{service,conf}`.
  - **M0.4 ✅ done + DEPLOYED** — spatial voice: WebRTC mesh (`src/net/VoiceMgr.js`)
    signaled over the same WS (`SIGNAL` messages, directed relay in `server/Hub.js`);
    each remote mic → `THREE.PositionalAudio` on that peer's avatar head; a
    header "🎤 Voice" button enables/mutes. Verified by `scripts/smoke-voice.mjs`
    (two headless Chrome + fake mics reach ice=connected with the remote track
    attached) locally AND live against `wss://dionysus.dk/ws/`. STUN-only —
    **TURN is a follow-on** (needed for peers behind symmetric NAT; same-LAN /
    most NATs work on STUN).
  - **M0.5 ✅ done + DEPLOYED** — room-object sync: a generic shared key→value
    `STATE` channel (`src/net/NetProtocol.js` `makeState`, pure registry
    `src/net/RoomObjects.js`) persisted per-room in `server/Hub.js`
    (last-writer-wins) and **snapshotted to late joiners** on connect. First
    consumer: the **TV / loaded game** — when any peer boots a cartridge,
    everyone's TV converges on it (a peer with nothing running, or on the same
    core, boots it seamlessly; one mid-game on a *different* core is told, not
    yanked into a reload). Reflected loads run with `echo:false` so they can't
    bounce a stale value back. Verified by `scripts/test-net.mjs` (now 85; STATE
    builder/validate, `RoomObjects` apply/dedup/clear, `Hub.setState` +
    snapshot + empty-room reset) and `scripts/smoke-object-sync.mjs` (two+late
    Chrome peers: live propagation, last-writer-wins, snapshot convergence,
    clear), locally AND live against `wss://dionysus.dk/ws/`.
  - **M0.6 ✅ done + DEPLOYED** — held-object sync: grabbing a cartridge
    broadcasts `hold:<file>` = `{holder,hand}` on the same `STATE` channel
    (`GrabMgr` `onCartridgeGrabbed`/`onCartridgeReleased`); remote peers hide
    their own copy and show a **ghost cartridge in the holder's avatar hand**
    (`src/GhostCartMgr.js`, reconciled each frame from pure
    `src/net/HoldState.js`; `AvatarMgr.getHand`). `hold:` keys are owner-scoped —
    `server/Hub.js` clears a leaving peer's holds (replayed to the room) so a cart
    can't stay stuck in a departed hand; persistent `tv` state is untouched.
    Verified by `scripts/test-net.mjs` (now 93; `parseHolds` filtering +
    disconnect-clears) and `scripts/smoke-held.mjs` (ghost appears/hides, release,
    late-join snapshot, holder-disconnect cleanup — 14/14) locally AND live
    against `wss://dionysus.dk/ws/`. Desktop holders attach the ghost to the head
    (no tracked hand); file-keyed identity aliases if two shelves host the same
    file (acceptable pre-authority).
  - **M0 hardening (2026-06-13):** **TURN now config-wired** —
    `NetProtocol.buildIceServers` (pure, unit-tested) composes STUN + an optional
    TURN relay, threaded through `NetMgr` into the voice + video meshes, supplied
    via `?turn=…&turnUser=…&turnCred=…`; `deploy/coturn.conf.example` ships
    (coturn server provisioning + a live symmetric-NAT test still pending).
    **In-VR voice affordance done** — a "Voice" item in the main menu mirrors the
    desktop 🎤 button (enable/mute via the same NetMgr path; Quest mid-XR mic grant
    is the open real-headset question). **Still pending:** a real two-headset smoke
    test (needs hardware). With presence + voice + TV + held-object sync all live,
    M0 is functionally complete.
- **M1 — ✅ done + DEPLOYED (2026-06-13):** host-authoritative game sync (input +
  video stream) for 2-player. Built like M0: transport spine first, then
  consumers. All three slices below are live; the M1.1/M1.2 smokes pass against
  `wss://dionysus.dk/ws/`.
  - **M1.0 ✅ done + DEPLOYED** — remote-input transport: a directed `INPUT`
    message (`src/net/NetProtocol.js` `makeInput`) relayed client→host over the
    room socket (`server/Hub.js` `input()`, sender-id stamped, mirrors `signal`);
    `NetMgr.sendGameInput` / `onGameInput` + a debug recv ring. Carries one
    logical RetroPad button transition (`{player,btn,down}`) so the host can
    resolve it per-player and feed its core (non-deterministic-core friendly).
    Verified by `scripts/test-net.mjs` (now 106) and `scripts/smoke-gameinput.mjs`
    (host/client/bystander: directed delivery, id-stamping, no broadcast leak)
    locally AND live against `wss://dionysus.dk/ws/`.
  - **M1.1 ✅ done + DEPLOYED** — wired end-to-end. The host is resolved from shared state:
    whoever owns the `tv` key (booted the room's game) is the host
    (`NetProtocol.hostInputTarget` pure decision; `NetMgr.hostId/isHost/
    forwardGameInput`). A non-host's `GameInputMgr` now emits each *logical*
    RetroPad transition (`onLogicalInput`, pre-keycode) which main.js forwards to
    the host; the host injects via `GameInputMgr.setRemoteButton` (resolves
    `codesFor(player,btn)` and merges them into the per-frame keydown/keyup sweep,
    so a still-held remote key isn't lifted and local + remote coexist with no
    crosstalk). The client still drives its own core locally until M1.2 video.
    Verified by `scripts/test-multiplayer.mjs` (now 24: logical emit, host inject,
    no-kill, release, coexist) + `scripts/test-net.mjs` (`hostInputTarget`) and
    `scripts/smoke-gamesync.mjs` (host auto-resolved from `tv` state; forwarded to
    the right peer; no self-send; no broadcast leak). *Headless can't drive real
    XR gamepads, so the controller→logical capture + host injection dispatch are
    unit-tested, not in the smoke — same caveat as the edit-mode menus.*
  - **M1.2 ✅ done + DEPLOYED** — host video stream over WebRTC. `src/net/VideoMgr.js` (a
    sibling of `VoiceMgr`) is a host→client subsystem: the host (tv-state owner)
    captures `#canvas` via `captureStream()` and adds it send-only to a peer
    connection per other peer (host is the sole offerer → no glare); each client
    receives the track, wraps it in a `<video>`, and `SceneMgr.setScreenVideo()`
    paints it onto the CRT as a `THREE.VideoTexture` (reverting to the local
    canvas when the stream ends). Its signaling rides the **same SIGNAL relay** on
    `channel:'video'` (`NetProtocol.makeSignal`), so it never collides with the
    voice mesh — NetMgr routes by the tag; the Hub relays it opaquely. A host
    handover (new `tv` owner) tears down and rebuilds. Wired in main.js: booting a
    game starts the broadcast; `onHostVideo`/`onHostVideoEnded` swap the TV.
    Verified by `scripts/smoke-video.mjs` (host fans out to 2 clients, both
    receive; voice smoke still green — no regression) + `scripts/test-net.mjs`
    (the `channel` tag). *VideoMgr is WebRTC-heavy so it's smoke-tested, not
    unit-tested — same split as VoiceMgr.* **Follow-up ✅ done (2026-06-13):** a
    watching client now PAUSES its own core while showing the host's frames
    (`EmulatorClient.pause()/resume()` toggle the core's emscripten main loop via
    `Module.pauseMainLoop/resumeMainLoop`; main.js drives it from
    `onHostVideo`/`onHostVideoEnded`, and a local boot resumes first so a new host
    always runs). No point emulating something it isn't authoritative for and isn't
    displaying — saves Quest CPU/battery. Verified by `scripts/smoke-video.mjs`
    (now 16: two clients pause while watching, one resumes after becoming host).
  - **Widget-join full-sync fix ✅ done (2026-06-22)** — joining via the header
    Join button (not just booting with `?session=` already in the URL) now
    wires *every* MP subsystem (voice, held-cart ghosts, gamepad/gun/mouse
    sync), not just presence. This was a real "nothing synced" root cause for
    anyone who joined mid-session rather than on initial load. Also fixed a
    TDZ bug that was silently breaking all MP auto-join. Landed alongside NES
    Four Score support (see the callout above) and secondary-console gun aim —
    three agents in parallel worktrees, merged + deployed together.
  - **Peripheral sync (gamepads/guns/mice) ✅ done** — `src/net/GamepadSync.js`
    / `GunSync.js` / `MouseSync.js` extend the same generic `STATE` channel
    (`RoomObjects`) so every peer agrees which physical peripheral drives which
    console/port/player — essential for guests to see the right controls, and
    for guns/mice specifically (see **Light guns** and **Mouse peripheral**
    below).
  - **Desktop (flat-screen) netplay build ✅ done (2026-07-01)** — `desktop.html`
    + `src/desktop/` is a second, VR-free entry point for players without a
    headset: no three.js/avatars/head-tracking, but the same room server, wire
    protocol, and host-authoritative video-stream netplay (`DesktopNet.js`
    reuses `PresenceState`/`RoomObjects`/`VideoMgr`/`NetProtocol` verbatim from
    `src/net/`). Verified with a **real-GPU** two-browser Puppeteer harness
    (`scripts/verify-desktop-netplay.mjs`, `npm run verify-desktop-netplay`) —
    headless software-GL can't exercise real `canvas.captureStream()` pixels,
    so this always launches headed Chrome windows; confirms the host's canvas
    renders real frames and the client's `<video>` receives and plays a live
    (not frozen) WebRTC stream. 8/8 passing.
  - **M1.4 — one room, one game: server-elected host + display-only clients.
    ✅ done + DEPLOYED (2026-08-03 → 2026-08-07, `b4a62bb`..`097cc92`).**
    A real two-computer playtest found each machine running its *own* game in
    the same room — the M1.1/M1.2 rule "host = whoever owns the `tv` key" meant
    a joiner (who may not even own the ROM) stole the role, and `applyRemoteTv`
    then booted locally on both. **That rule is dead.** Full design:
    `docs/MULTIPLAYER.md` "Host election and the shared room (M1.4)"; the
    session-by-session narrative is in `docs/HANDOFF.md`'s Phase M1 list.
    - **Server-elected host by seniority** (`server/Hub.js`, `HELLO.host` +
      `MSG.HOST`). Migration happens only when the host actually LEAVES, and is
      deferred 15 s (`HOST_RECLAIM_MS`) so a host reloading its own page
      reclaims by session id instead of transiently promoting a client.
      `tv`/`room`/`shelf:*` are **host-owned keys** the Hub refuses from anyone
      else. `src/net/HostElection.js` is a client-side fallback for an older
      room server.
    - **A non-host is display-only:** every boot route is gated on
      `amRoomHost()`, it paints the host's WebRTC feed, and it **inherits the
      host's room + shelf** instead of building its own. Client actions travel
      instead of executing locally (`insert` / `insert-nack`, `peripheral`), and
      game **audio** now rides the same peer connection
      (`SpatialAudio.captureStream`, `src/desktop/DesktopAudio.js`).
    - **M1.4a — "runs zero cores" enforced at the runtime layer**, not just at
      the boot gates: a latched `mayRunLocalCore()` → `RackMgr.allowRun` →
      every `ConsoleRuntime.setCanRun`, so the perf budget, a power switch or a
      live reboot can't quietly resume a watcher. This is now a hard invariant
      (see `docs/HANDOFF.md` "Hard invariants").
    - **M1.4b — an XR-presenting client can actually adopt the host's room**
      after leaving VR (`e959e7c`); the deferral path used to claim its
      one-shot stamp before the XR check and could never succeed.
    - **M1.4c — the room server is a SEPARATE deploy, and production was two
      months stale.** `npm run deploy` only ever published `dist/`, so the live
      systemd unit was still running the **2026-06-09** `Hub.js` — no host
      election, no host-owned keys, no `wire()` — meaning **no MP milestone
      from M1.0 on had ever actually been live**. Added `deploy.ps1 -Room` /
      **`npm run deploy-room`** (plus `npm run deploy-app` for a seconds-long
      code-only refresh instead of a ~1 h 3.9 GB full deploy).
    - **M1.4d — the host's header "Load ROM" picker never republished**, so
      watchers froze on the previous game and `tv` went stale (misinforming
      late joiners and misdirecting migration). Fixed by moving the
      `setObjectState('tv', …)` + `startVideoBroadcast()` pair **inside**
      `bootOnPrimary` (`597a1dd`), so every present and future primary-boot
      path republishes for free.
    - **Verified against PRODUCTION, app *and* room server (2026-08-07):**
      `smoke-host-picker` 28/28, `smoke-shared-game` 45/45,
      `smoke-display-only` 54/54, `demo-automation-api` 49/49 — run against
      `https://dionysus.dk/webxr/libretrowebxr2/` + `wss://dionysus.dk/ws/`,
      not localhost. `smoke-room-inherit` 27/27, `smoke-xr-room-adopt` 10/10
      and `verify-desktop-netplay` 17/17 were live-verified at M1.4c. Every new
      assertion was negative-controlled.
    - **Also landed alongside:** `window.__testApi` (`src/TestApi.js`) + the
      Puppeteer harness `scripts/lib/mp-harness.mjs` — the *one* supported
      automation surface, replacing the habit of adding another `window.__foo`
      hook. Read `docs/TEST_AUTOMATION.md` before writing a new MP test.
    - **Still open:** a physical two-headset pass (no hardware), and the
      **disc-swap panel's** republish behaviour — it doesn't go through
      `bootOnPrimary`, so the M1.4d fix does *not* cover it and it's a
      plausible third instance of the same class.
- **M2:** rollback game sync for deterministic cores (adapt netplayjs +
  `SaveState`). **⚠ Feasibility spike DONE (2026-06-13):
  `docs/research/M2-rollback-feasibility.md`.** Confirmed: a genuine rewrite, not
  a slice. Our RetroArch-wrapped cores can't frame-step (they drive their own
  free-running `emscripten_set_main_loop`; we can pause/resume the loop but not
  single-step `retro_run`) and only snapshot asynchronously (RA task system →
  VFS, ~hundreds of ms). True rollback needs **bare-libretro cores** compiled to
  wasm (sync `retro_serialize`/`retro_unserialize` + a JS-owned frame loop —
  proven by `matthewbauer/retrojs`; RetroArch's own netplay/run-ahead prove the
  runtime), est. ~3–6 weeks for a 2-player NES PoC. **Recommendation:** keep **M1
  host-authoritative streaming as the shipped default for all games**; do a
  bare-core spike on **`fceumm` (NES) only** as an opt-in PoC before deciding on
  full M2; do not convert the whole core library.
- **M3:** multiple simultaneous games, mid-session join, VR↔desktop crossplay.

## Phase RACK — Multi-console patchable AV rack  ✅ shipped (2026-06-13 → 06-30)
EmuVR-style: spawn more than one console/TV in the same room and patch cords
between them, instead of being locked to a single fixed console. Built in
gated phases so a real perf ceiling (multiple wasm cores running at once on
Quest) was de-risked before committing to the UI.
- **Phase 0 — de-risk spike:** `?rack=N` boots N live module cores side by side
  headlessly, proving multi-instance + input isolation before any UI
  (`src/RackSpike.js`; memory `rack-spike-result`). Quest perf ceiling
  (how many concurrent cores a Quest 3 can actually run) is read from
  `rack-perf` log entries, not assumed.
- **Phase 1 — pure graph:** `src/Patchbay.js`, a pure cord/jack graph (no
  THREE/DOM), wires the existing single console through it as N=1 — the
  no-rewrite seam every later phase builds on.
- **Phase 2 — weighted runtime:** `src/ConsoleRuntime.js` (the per-console unit
  Phase 2+ multiplies) + `src/RackMgr.js` (owns N runtimes) + `src/RackBudget.js`
  (an admission policy — each core declares a relative `weight` in `systems.js`;
  RackBudget refuses to spin up a console that would blow the perf budget).
  `ConsoleRuntime.dispose()` pauses + detaches rather than truly freeing, so
  RackBudget can reclaim/recreate cheaply.
- **Phase 4 — EmuVR-style patch cords:** `src/Cord.js` (visual cable curve) +
  `src/Plug.js` (a grabbable plug end, `plugKind`: `'video'` | `'controller'` |
  `'keyboard'`) + `src/Snap.js` (nearest-jack snap-on-release). Console→TV video
  cords, gamepad→console controller cords, and the keyboard-device cord (see
  **Keyboard device** below) all repatch by grab-and-drop onto any console's
  front-face jacks (`Console.js` `portJacks`) — this is what closed the
  previously-parked "controller cords" item (see Parked, above).
- **Phase 5 — persistence + power:** `src/RackPersistence.js` persists spawned
  consoles/TVs (position + power state) and cord patches across the
  cross-core `location.reload()` boot (`33b1ae9`); power/reset switches on
  consoles and TVs (`18f8ddb`); **live cross-core swap on a secondary
  console** — loading a different-core game on console #2 no longer reloads
  the whole page (`b6282ec`); cords now follow a prop when it's moved, and any
  console (not just the primary) can load a game (`ee2d441`).
- **Rack feedback round ✅ done (2026-06-14 feedback → fixed by 2026-06-30):**
  a real Quest 3 session surfaced 7 issues (`docs/handoff-2026-06-14-rack-feedback.md`)
  — ROM-boot telemetry, per-console (not global) input routing, room-aware
  placement so spawned consoles/TVs/posters land against a wall instead of
  through it, a grabbable controller-cord plug, movable consoles/TVs, and a
  hide-walls toggle. All 7 items landed (`3f7b73e`, `9857c9f`,
  `9240235` end-to-end headless probe). ⚠ **The "headless probe" in
  `9240235` had no assertions** — `probe-feedback.mjs` computed `ok` /
  `insideRoom` / `atWall` booleans and threw them away, exiting 0
  regardless; with 3 of the 7 capabilities removed it printed
  `ok: false, atWall: false` and still exited 0 (2026-07-29 audit). The
  seven features are genuinely correct — the rewritten probe passes 7/7 and
  goes red on three separate breaks — but nothing was machine-checked
  between 2026-06-30 and the audit, so any regression in that window would
  have gone unnoticed.
- **Status:** full patchable rack shipped + headless-verified; **real-headset
  validation of the rack UX is still open** (controller cords + cross-core
  swap in particular need hands-on confirmation). See `rack-epic-status` /
  `rack-spike-result` for the de-risk trail if picking this back up.

## Light guns  ✅ shipped (2026-06-20 → 06-22)
A grabbable **light-gun peripheral** — pick it up, aim at the TV, pull the
trigger — for every system that had one historically. Full design + status:
`docs/LIGHTGUN_SUPPORT.md`; validation plan: `docs/HEADSET_LIGHTGUN_VALIDATION.md`.
- Core-level fix: a patched `rwebinput` (`docs/patches/rwebinput-lightgun.diff`)
  feeds real light-gun *position* under emscripten, where upstream doesn't.
- Ships across **NES Zapper**, **SNES Super Scope**, **SNES Justifier**
  (2-gun co-op — hardware limit: one PPU latch, so "both guns hit the exact
  same frame" is physically impossible on real hardware too, not a bug —
  see `games/snes-opwolf/README.md`), **Genesis Menacer**, and **SMS Light
  Phaser**. Three authored CC0 test games ship with it: `games/nes-gallery`
  (Zapper), `games/snes-scope` (Super Scope), and `games/snes-opwolf`
  (Justifier 2-gun co-op).
- **First-class peripheral** (`14fd173`): the gun is a grabbable prop with a
  real cord/plug into a console's port (mirrors the gamepad, uses the Phase
  RACK cord system above) and its console/port binding is net-synced
  (`src/net/GunSync.js`) so every peer agrees who's holding which gun.
- Live core-switch reboot: arming the gun on a system that needs a different
  core reboots the primary console in place, no page reload (`0c973d8`).
- **PS1 GunCon + PSX two-gun (2026-07-29, `dbbb2f4`/`9578494`).** Single-gun
  GunCon works on the custom `mednafen_psx_jit` core, and `SYSTEMS.psx.lightgun2`
  (device 260 on ports 0 and 1) is un-gated for Point Blank / Lethal Enforcers
  I & II. The blocker was never the registry: PSX is the only *worker-execution*
  gun system and `EmulatorWorkerRuntime.forwardLightgun` had no multiport branch
  at all, so both guns shared one DOM pointer regardless of what the core
  exported. Verified `probe:psx-twogun` 23/23 against a real disc — two
  crosshairs in per-port colours, plus a falsification arm (same shot, same
  point, differing only in `port`: gun 1 `maxDiff=287`, gun 2 `maxDiff=0`).
  Scope: mechanism + per-port isolation, **not** a played-through 2P session.
- **Remaining:** real-headset validation (aim feel, two-gun co-op timing); a
  real 2P play-through on PSX; the in-VR routing hop
  (`LightGunMgr._portForGun` → `libretroGunPortFor`) has never been exercised
  for PSX; and the MP host path does not forward gun-port *binding* changes
  (known gap, documented at `_hostApplyGunWire`). Everything else is headless-
  and real-core-verified.
- **Arming-leak bug fixed (found + fixed 2026-07-11, disarm option):** the
  arming flag (`window.__lightgunArmed`) is deliberately sticky for the
  session but `isLightgunCapable` is system-level, not per-ROM — once armed,
  any later boot of a gun-capable-system ROM got a gun wired regardless of
  whether that specific title uses one. Confirmed real (a session log + code
  reading), confirmed *not* the cause of a black-screen report it looked
  linked to (direct reproduction rendered fine). Fixed with an explicit
  `disarmLightGunAndReload()` / `window.__disarmGun()` / "Disarm Gun" menu
  button that clears the sticky flag and drops the device from the current
  game only if that game didn't declare its own `lightgun` meta. Detail:
  `docs/LIGHTGUN_SUPPORT.md`.

## Mouse peripheral + new systems (Amiga, SNES, C64, SG-1000, Sega 32X)  ✅ shipped
A grabbable **mouse peripheral** (`src/Mouse.js`/`src/MouseMgr.js`), built to
unlock Amiga point-and-click games and reusable later by DOS. Mirrors the
light-gun architecture (cord/plug into a console port, net-synced binding via
`src/net/MouseSync.js`). Full design + status: `docs/MOUSE_SUPPORT.md`.
- **Amiga (PUAE)** joined the system list with a real Kickstart boot — not just
  the AROS fallback: `systems.js`'s `systemFiles` mechanism (a general,
  reusable "provision a user-owned firmware file into the core's system dir
  before boot" hook — see `docs/LICENSING.md`) wires `kick34005.A500` /
  `kick40068.A1200` so **The Settlers** boots the real game (`6089ebe`).
- Single-mouse → one console port verified end-to-end (buttons + relative
  motion) through the stock `puae` core, no core rebuild needed. **Two
  independent mice (2-player split-pointer)** needs a multiport `rwebinput`
  patch that doesn't exist yet for `puae` — the code is future-proofed for it
  (`amiga.mouse2` descriptor, `EmulatorClient.sendMouse(...,port)` already
  takes a port) but it's a parked, separate core-rebuild effort.
- **SG-1000** and **Sega 32X** also joined the system list (via `gearsystem`
  and `picodrive` respectively) as part of the same content-aware core-loading
  pass that added Amiga.
- **Desktop pointer-lock bug fixed (2026-07-11, `a778b44`; deployed
  2026-08-07).** `MouseMgr.attachDesktop()`'s click listener called
  `requestPointerLock()` on any canvas click regardless of system/wiring —
  fixed with a `getWired()` gate + `releaseDesktopLock()` on a non-mouse boot.
  Same-shaped arming-leak bug as the light gun's (`window.__mouseArmed` sticky
  + `isMouseCapable` system-level, not per-ROM) is confirmed real and **fixed**
  the same way (`disarmMouseAndReload()` / `window.__disarmMouse()` / "Disarm
  Mouse" menu button) — see `docs/MOUSE_SUPPORT.md` follow-up #5.
- **SNES Mouse + C64 (1351) Mouse added (2026-07-11).** User asked whether
  other systems with real mouse hardware could be supported (named SNES, NES,
  C64). Checked each system's actual libretro core, not just hardware history:
  **SNES** (`snes9x`, Mario Paint's real peripheral) and **C64** (`vice_x64`,
  the 1351/GEOS mouse) both shipped, headless-verified against real content
  (`tmp/verify-snes-mouse.mjs` 6/6, `tmp/verify-c64-mouse.mjs` 5/5). C64 needed
  `mouseLoadConfig()` generalized to merge per-descriptor `coreOptions` (VICE
  picks its mouse device entirely via `vice_joyport`/`vice_joyport_type`
  core options, not a port-device assignment like every other system here —
  see `docs/MOUSE_SUPPORT.md` for the full architecture note and the wrong-
  guess-then-corrected-via-real-source story). **NES/Famicom Mouse turned out
  not feasible** — neither NES core we ship (`nestopia`, `fceumm`) implements
  the real Famicom Mouse (HVC-031); they only have unrelated same-port
  peripherals (Subor keyboard/mouse combo, Bandai Oeka Kids tablet). Sega Mega
  Mouse (Genesis) looks real and supportable (`genesis_plus_gx` has a mouse-
  invert option) but wasn't part of the ask and hasn't been verified — flagged
  as a follow-up, not shipped. Neither SNES nor C64 mouse has been proven with
  content that actually *reads* the mouse yet (no such CC0 ROM in the
  collection) — verified structurally only, same caveat as Amiga before its
  own follow-up authoring work.

## DOS  ✅ shipped on DOSBox Pure (2026-08-01/02)
DOS is a real, working, **on-the-default-shelf** system. Full build + debugging
writeup: `docs/DOS_CORE_BUILD.md` (its "Current real status" section at the top
supersedes everything below it about VirtualXT).
- **`dosbox_pure` is `SYSTEMS.dos.defaultCore`** and ships in `public/cores/`
  (`dosbox_pure_libretro.{js,wasm,worker.js}`, GPLv2, built from scratch in
  WSL2 — pthreads + GLES3, `execution: 'worker'`,
  `contentIo: 'transfer-memfs'`). Verified live on the deploy.
- **The black screen was a generic Emscripten bug, not a DOSBox one.** Three
  layered causes; the actual root cause was `EM_TIMING_SETIMMEDIATE`: inside a
  Worker, Emscripten's polyfill `postMessage`s `{target:"setimmediate"}`
  *outward* to whoever created the worker, expecting stock shell.html JS to
  relay it back. This app hosts the whole runtime in its own custom worker
  (`src/runtime/EmulatorWorkerRuntime.js`), so the loop stopped ticking forever
  after the first resume while the frame pump kept presenting a stale black
  buffer — "steady frame count, zero video, zero errors". Fixed at the
  RetroArch source level (`platform_emscripten.c`, `EM_TIMING_SETTIMEOUT`
  under `#if defined(HAVE_THREADS)`); **that patch lives only in the shared WSL2
  checkout and must be re-applied for any future `HAVE_THREADS=1` rebuild.**
  Two real prior bugs (worker-protocol foreign-message handling,
  `dosbox_pure_voodoo_perf` HW-render bypass) were necessary but not sufficient.
- **`dos` deliberately does NOT carry `experimental: true`** (2026-08-01) — both
  original grounds were discharged, not assumed: the worker cart-insert gap
  (P0-2) is shut for the whole worker topology
  (`npm run probe:worker-cartridge-insert`, 12/12), and it's verified booting
  the real 256 MB DOS-TOOLS release disk, not just a synthetic FreeDOS floppy.
  Dropping the flag is what lets a `dos` cartridge survive `parseCollection` and
  appear on the shelf without `?experimental=1`. `CORES.dosbox_pure` keeps its
  own `experimental` marker, but nothing filters on it.
- **Desktop controls + mouse (2026-08-02, `de7fb78`).** Raw keyboard capture,
  mouse capture and a system picker on `desktop.html`; `SYSTEMS.dos.mouse`
  descriptor; `vhd`/`ima` extensions. This also fixed a **worker-execution
  `sendMouse` silent no-op that was missing everywhere**, not just on desktop.
- **DOS Tools Disk published** — `npm run publish-dos-tools` uploads the
  `C:\LLM\DOS` disk images to `dionysus.dk/webxr/dos-tools/`; it's on the shelf
  and verified on both the VR and desktop paths.
- `virtualxt` (MPL-2.0) stays registered as a secondary `dos` core, but
  `virtualxt_libretro.wasm` is still absent from `public/cores/` and 404s live.
  That's harmless — `fetch-cores` treats a missing buildbot core as a warning,
  not a hard error — and it's a parked spike, not a blocker, now that DOSBox
  Pure works. **Remaining:** no real commercial DOS *game* has been run yet, and
  the in-VR keyboard/mouse feel is headset-unverified like the rest.

## Comfort/UX fixes — duck + real power-off  ✅ shipped (2026-07-10)
User feedback on the just-deployed build: "you need a way to duck or set
your height" and "turning off a console only seems to pause it."
- **Duck.** Neither `LocomotionMgr.js` nor `DesktopControls.js` ever touched
  `playerRig.position.y`. Added a smoothed `-0.5m` hold-to-duck: `KeyC` on
  desktop, either controller's free-hand thumbstick-click in VR (physical
  crouch already worked in VR via headset pose — this covers desktop and
  seated/limited-space VR play). Full detail: `docs/HANDOFF.md`'s "third
  pass" entry.
- **Power off was really just pause.** `setConsolePower()` only paused the
  core — off→on resumed exactly where suspended (not a cold boot), and a
  solo console's audio was never actually muted (focus-mute only engages
  with 2+ TVs). Fixed: off→on now resets the core (real power switches don't
  preserve state), and `SpatialAudio.setPower()` force-mutes regardless of
  focus. Full detail: `docs/HANDOFF.md`.
- Headless-verified (`tmp/verify-duck-locomotion.mjs` — plain Node, no
  browser; `tmp/verify-power-and-duck.mjs` — Puppeteer against a real booted
  core); not yet headset-tested for VR duck feel.

## Phase C — Content & polish
- **Bundle chunking ✅ done (2026-06-13)** — `vite.config.js` `manualChunks`
  splits three.js into its own cache-stable vendor chunk (app ~134 kB / 42 kB gz
  + `three` ~597 kB / 152 kB gz, was one ~702 kB chunk). Helps Quest load time +
  caching across app-only deploys. Further: dynamic-import editor/net paths.
- Documented open prop package schema (model + `prop.json`) — vs EmuVR's
  Discord-gated UGC kit.
- Community gallery of room/collection URLs.
- ~~BIOS-needing systems (PSX/N64) via fetched cores; user-supplied BIOS UX.~~
  **✅ no longer a feasibility question — superseded 2026-07-17..07-29.** PSX
  (Beetle PSX HW + Lightrec), PS2 (Play!) and N64 (mupen64plus_next) are all
  real, from-scratch-built, headless-verified worker cores on `main`, and all
  three have been verified playing **real commercial games**; PSX additionally
  boots 4 real discs on a real Sony BIOS (`npm run probe:psx-realbios`).
  `src/FirmwareStore.js` is the user-supplied-BIOS UX (IndexedDB, never
  shipped). The old assessment
  (`docs/research/psx-n64-feasibility.md`, 2026-06-15 — "PSX marginal, N64 not
  viable") **was wrong about both** once a Wasm-JIT path was actually built
  rather than only researched; it's kept for history. **PSX is off the
  `experimental` gate as of 2026-08-07** (see below); **N64 remains gated** on
  its own grounds. What's actually left is the core-level list in "Open tasks"
  below (PSX Lightrec JIT, PSX hardware-GL, N64 JIT `ci_table` wiring) — see
  `docs/HANDOFF.md`'s "PSX / PS2 / N64 core status" and
  `docs/research/psx-ps2-n64-review-2026-07-24.md`.
- **PSX un-gated (2026-08-07).** `experimental: true` removed from `SYSTEMS.psx`
  (and from `CORES.mednafen_psx_hw`) after re-verifying every blocker the flag
  cited **live on the day**, not from prior status text — full record in the
  comment above `SYSTEMS.psx` in `src/systems.js`. Evidence: **P0-2**
  `probe:worker-cartridge-insert` 18/18 (PSX/N64/DOS through the real
  `handleCartridgeInserted`); **P0-3** `probe:mode-switch` 11/11; **P0-4**
  `probe:worker-audio-saveram` 8/8 with the primary console's audio branch
  actually fed; **P0-5** `probe:psx-testdisc` green — the memory card is read
  back through the real `client.readSaveRam(1)` path with a valid save block
  mid-session *and* after a soft reset (the review's PARTIAL verdict was the
  N64 EEPROM arm, which is why N64 stays gated); **P0-6** fixed by C1 streaming
  and re-verified by `probe:psx-timecrisis` 30/30 on the real 663MB/34-file
  disc, both the file-picker and the URL-fetched insert path. Plus
  `probe:psx-realbios` 45/45 (four real commercial discs on a real Sony BIOS,
  distinct pictures), `probe:psx-guncon` 14/14, `probe:psx-twogun` 23/23, and a
  green `npm test`. Still rough, and recorded as such rather than hidden:
  `jit.compiled=0` (CPU interpreted; ~55fps desktop), software renderer, **Quest
  3 fps never measured**, many discs need a real BIOS (the app says so), and 2P
  gun co-op is proven per-port but never played through a game's 2P menus.
  Blast radius is small: no PSX cart ships in `public/roms/manifest.json`, so
  this changes nothing for a first-run visitor — what it fixes is PSX carts
  declared in a collection JSON (e.g. a user's own
  `roms/local.collection.json`) being silently dropped from their shelf.
  Caveat worth keeping: two PSX probes first read RED against a working tree
  dirty with another session's in-flight `src/main.js` edits, and both went
  green re-run from a clean `git worktree` at the same commit — don't trust a
  probe run made while `git status` is dirty.
- PWA install; per-headset storage UX; performance passes on Quest.

## Open tasks (2026-08-07)

Current work list, highest value first. Everything above this section is
shipped; this is what is actually left. See `docs/HANDOFF.md` for context on
the artifact-integrity items.

> **Where the 2026-08 review work is tracked.** Two independent whole-repo
> reviews landed on 2026-08-13 (`CLAUDE_REVIEW.md`, `CODEX_REVIEW.md`) and a
> remediation pass ran on 2026-08-17. **Their status blocks, not this file, are
> the record of which finding is closed, still open, or rejected-for-this-project
> — read the dated block at the top of each before acting on anything in them.**
> Two findings are settled REJECTIONS and must not be re-litigated: the
> private-ROM deploy (SEC-1 / §4.7 — deliberate, see `README.md` and
> `CLAUDE.md`) and §5.5's host-watcher optimization (§10 says it reintroduces the
> bug the watcher was written to fix). This has already been re-argued twice.

**The multiplayer work is done and live.** The M1.4 shared-room rewrite
(server-elected host, display-only clients, host-owned room/shelf, seniority
migration, and the M1.4d Load-ROM republish fix) is shipped, deployed — **app
*and* room server** — and re-verified against production, so nothing on this
list is blocked on multiplayer any more. See **Phase M / M1.4** above.

**Ship what's built**
1. ~~**Deploy** the long tail of committed-but-undeployed work.~~ ✅ **DONE
   (2026-08-07, `097cc92`).** Verified live rather than assumed: the deployed
   `index.html` references exactly the local `dist/` asset bundles, and every
   deployed core `.js` glue is **md5-identical to the local `public/cores/`
   artifact** and carries the `rwebinput_set_lightgun` export (checked
   `nestopia`, `snes9x`, `genesis_plus_gx`, `mednafen_psx_jit`, `play`,
   `mupen64plus_next`, `dosbox_pure`). Note the two separate deploy targets:
   `npm run deploy-app` for code, **`npm run deploy-room` for the room
   server** — the latter is not in `dist/` and was two months stale in
   production until 2026-08-03 (M1.4c).
2. **Real-headset validation.** The single biggest gap across the whole
   project: the rack, the keyboard prop, light guns and two-gun co-op are all
   headless-verified only. `docs/HEADSET_LIGHTGUN_VALIDATION.md` is the
   checklist (rewritten 2026-07-29 — the old one told testers *not* to report
   aim-sharing, which is now exactly the bug to report).

**PSX / gun follow-ups**
3. **Real 2P play-through** of Point Blank and Lethal Enforcers I & II. The
   two-gun evidence is mechanism + per-port isolation, not gameplay — nobody
   has driven either title through its 2P menus.
4. **Exercise the in-VR routing hop for PSX.** `LightGunMgr._portForGun` →
   `libretroGunPortFor` → `sendLightgun` has never run for PSX; the probe
   drives `window.__client.sendLightgun` directly and bypasses it entirely.
5. **MP host gun-port binding changes** (known gap at `_hostApplyGunWire`).
   The `gun` channel carries aim samples, not binding events, so a remote
   peer's port stays latched on the host's core until teardown. Needs a
   two-ended protocol change.
6. **Policenauts multi-disc swap test.** The C6 disc-swap UI has only ever
   seen synthetic panel probes; Policenauts is a real 2-disc `.m3u` already
   verified booting.
7. **Genesis Menacer / SMS Light Phaser two-gun.** `genesis_plus_gx` now
   genuinely carries the multiport patch, so a `lightgun2` block is possible
   with no rebuild — the prerequisite that was missing for five weeks.

**Core-level, still open**
8. **PSX Lightrec JIT** — `jit.compiled=0` on every probe. Real leads exist
   (map-lookup timing); see the Lightrec/GL investigation notes.
9. **PSX hardware-GL renderer** — the `rhi_lib_gl.c` vs `glsm.c` shim gap.
10. **N64 Phase D** (the JIT's COP0/interrupt verification and broader
    differential coverage before any `ci_table` wiring). This was previously
    listed as "owned by a *different* concurrent session; check before
    touching" — **that session is dormant, so treat it as unowned and pickable.**
    Verified 2026-08-07: the `n64-jit-plan-shadow-check` branch's last commit is
    **2026-07-22**, its worktree (`C:/LLM/n64-jit-plan-shadow-check-wt`) still
    holds two uncommitted `scripts/cores/n64-jit-spike/vr4300_jit_bridge.*`
    edits, and `n64-jit-plan` itself is now **0 commits ahead of / 60 behind
    `main`**. Re-check `git log` before starting anyway
    ([[libretrowebxr-concurrent-dev]]), but don't defer to a phantom owner.
    Reminder from `docs/HANDOFF.md`: the Play!-CodeGen `CONDITION_GE`/`AE` fix
    this phase depends on exists **only in the WSL2 vendored checkout** and must
    be re-applied (or properly forked/pinned) for any N64 JIT rebuild.
11. **Atari 2600** — `stella2014` is the last "classic"-style core and renders
    0 draw calls; fix is shipping a `module`-style Stella build.
12. ~~**DOS / VirtualXT** — no working core.~~ ✅ **DONE (2026-08-01/02).** DOS
    ships on **DOSBox Pure**, is off the `experimental` gate and on the default
    shelf — see the **DOS** section above and `docs/DOS_CORE_BUILD.md`. Left
    over: no real commercial DOS *game* has been run yet, and `virtualxt`
    remains a parked, core-less secondary registration.

**Test/tooling hygiene**
13. ~~**Audit remaining probe assertions against negative controls.**~~ ✅
    **DONE (2026-07-29, `5158335`).** All **17** probes were audited by building
    a negative control for each — breaking the feature the probe names, then
    checking it goes red. **Only 2 did; seven had no assertions at all** and
    exited 0 unconditionally. The worst offenders were the ones cited as
    evidence in docs and commit messages (`probe:psx-timecrisis` scored 30/30
    with `sendInput()` a no-op; `probe:psx-realbios` passed all 44 with the
    firmware never threaded to the core). 15 were rewritten to within-run
    *relative* checks and each validated **both** green on the real repo and red
    on a control; two were deliberately left un-gated rather than ship
    unvalidated checks. See `DEBUGGING.md`'s new section. **Standing rule: a
    check is not evidence until you have seen it go red.**
14. ~~**Register 7 orphaned probe scripts** in `package.json`.~~ ✅ **DONE
    (2026-08-07).** All seven are now `probe:autopause`, `probe:feedback`,
    `probe:focus`, `probe:multitv`, `probe:persist`, `probe:pong-boot`,
    `probe:repatch`. Every one was run once on registration to check it hadn't
    bitrotted while unreachable — none had: 10/10, 7/7, 9/9, 10/10,
    ALL-PASSED, 5/5, 9/9 respectively. `probe:autopause` and `probe:multitv`
    spawn their own vite (ports 5217/5196); the other five want a dev server
    already up — `probe:pong-boot` on **5176**, the rest on 5173 (pass a URL as
    argv[2] to point elsewhere).
15. **`probe:psx-twogun` flakiness** back-to-back with another PSX probe (one
    observed 11/23 with the core never starting; passes cleanly on a re-run).
16. ~~**`window.__gunFire` hazard**~~ ✅ **DONE (2026-08-07).** The hazard was
    the one-gun list itself, so it was fixed at the source rather than routed
    around: `main.js`'s new `_driveGunTick()` **unions** the fired gun into the
    genuinely-held set instead of replacing it, so the binding sweep no longer
    sees the other guns as "stopped driving". Both `window.__gunFire` (kept —
    external tooling may still call it) and `__testApi.gun.fire()` go through
    it. All four in-repo call sites (`probe:lightgun`, `probe:ps2-guncon`,
    `probe:ps2-cue-support`, `probe:ps2-timecrisis2`) now use
    `__testApi.gun.fire()`, which also **strengthened** them: the legacy hook
    returned the string `'no-gun'` when there was no gun, so their "does not
    throw" checks were green with the gun absent; the facade throws instead.
    `probe:lightgun` re-verified 9/9 after the migration.

**Vacuous-assertion audit, round 2 (2026-08-07)**

Item 13's audit covered the 17 probes in commit `5158335`. A second, static
(read-only) pass over 23 of the scripts it did *not* touch — the oldest tier of
`scripts/smoke-*.mjs` and `scripts/test-*.mjs` — found more of the same class.
Ten sites were fixed and are listed here only so the same ground isn't re-walked:
`test-logger`'s ring-buffer block (it performed the `shift()` **itself**, so it
was green with Logger's eviction deleted — now driven through `Logger._push()`
and validated red, 2/2 → 0/2, plus a new front-eviction check), `test-c64`'s
`keyAt` unoccupied-cell check (accepted `null` **or** any string, i.e. keyAt's
entire return domain — validated red against a greedy hit-test), `test-c64`'s
`ev?.location === undefined`, `test-gameinput`'s `undefined === undefined` code
comparison, two `test-routing` optional-chain comparisons, `smoke-gameinput`'s
`[].every()` anti-spoof check, `smoke-held`'s `>= 1` under an "exactly one"
label, and eight `ok(true, …)` literals across the smoke family.

**Round 3 (2026-08-17).** Items 17, 18 and most of 20 below were closed as part
of the CODEX_REVIEW TST-2 pass; each is struck through with what actually
changed. 19 and the `test-routing` half of 20 are still open.

17. ~~**`probe-media` shelf assertions (5 checks).**~~ ✅ **DONE (2026-08-17).**
    The thresholds were measured against an `allGrabbables` set that already
    contained the carts the probe itself injected at steps 1-5, so they were
    satisfied by its own side effects and stayed green with shelf minting
    completely broken. The probe now snapshots the pre-existing shelf
    (`shelfBefore`) **before** step 1 and asserts the floppy/cartridge counts
    against that set only, and the four "grab dispatch" / "insert axis" checks
    that were byte-identical re-reads of `userData.kind`/`pinAxis` from earlier
    sections were replaced rather than repeated. The `count === 0 ||` escape
    hatches are gone.
18. ~~**`probe-local-rom` Part 4.**~~ ✅ **DONE (2026-08-17).** Part 4 claimed to
    prove that special characters in a filename don't corrupt OPFS keys, but
    `RomResolver`'s key is `sha1-<hex>` and `meta.file` is not an input to it —
    no filename-escaping bug could ever turn it red. It now asserts the property
    that actually holds, against the real OPFS directory: enumerate
    `navigator.storage.getDirectory()`, require an entry named exactly
    `sha1-<hex>`, and require that **no** entry name carries any fragment of the
    filename — which goes red the moment someone "improves" the key by mixing
    the filename in. The dead `window.__romFetchLog` scaffolding at `:177-178`
    was removed (a repo-wide grep found those two reads were its only mentions;
    nothing has ever written it), leaving the Node-side `page.on('request')`
    delta as the single, real fetch check.
19. **Negative-only "nothing happened" checks** — mostly closed (2026-08-21).
    Four of the six sites now carry a positive companion arm in the same run, and
    each arm was mutation-checked (sever the mechanism; the arm fails while the
    original zero still passes green):
    - `test-multiplayer` block 2 — the same rig, controller and already-pressed
      button must dispatch the moment the pad is held.
    - `test-multiplayer`'s "a still-held remote key is not lifted by the local
      sweep" — a new block where that same sweep lifts a LOCAL key on the very
      tick it leaves the remote one down. With the sweep severed the original
      check still passed, which is exactly the failure this item describes.
    - `smoke-gameinput:84` — the bystander is proved connected, seeing both
      peers, and its own input reaches the host. The obvious arm (send an input
      AT it) is impossible by design: RELAY-4 refuses any INPUT not addressed to
      the host, so that zero is now enforced at two layers.
    - `smoke-mp-sync`'s "WIRE is not persisted" — the same `objectEntries()`
      call must see the `room` key that IS supposed to persist (line 98 proves
      `objectState()` works, but that is a different method).
    **Still open:** the "no `roms/<file>` network request" checks in
    `probe-local-rom:246` / `probe-local-rom-persist:231`. Both are opt-in probes
    needing fetched cores; neither has a positive arm.
20. **Config-pinning masquerading as behaviour** — mostly closed
    (2026-08-17). `test-rackbudget` no longer reads the two constants out of the
    module it imported them from: it drives `planLive()` with **no opts** and
    asserts the behaviour the defaults must produce (2+2 admitted and no more; a
    4th weight-1 core paused by the live-COUNT cap, not the weight budget), then
    pins the constants only *after* that proved they are live. `test-session`
    now takes eight draws from `randomRoomSuffix()` and demands at least two
    distinct values — a constant-returning implementation, the one failure that
    matters, used to pass. `test-controller-portswitch` gained the cardinality
    guards its set-wide `.every()`/`!.some()` blocks needed (`[].every(p)` is
    true, so a `computeRouting()` returning `[]` scored 4/4 with the feature
    dead). **Still open:** `test-routing:175-180` still contributes zero
    assertions if `r` is empty.

**Multiplayer / worker-core loose ends (small, post-M1.4)**
21. ~~**Disc-swap panel republish.**~~ ✅ **DONE (`dbb9594`, "Three shared-room
    fixes: spawn seats, honest isLive(), disc index in `tv`").** It *was* the
    third instance of that bug class: the disc-swap panel does not go through
    `bootOnPrimary`, "a swap does not re-boot, so nothing else on this path
    would have republished `tv` — which is exactly why the disc index used to be
    invisible to every other peer". `stepDisc()` now calls `publishDiscState()`
    (`src/main.js:8236`), which merges the disc fields onto the room's existing
    `tv` value via `src/net/TvState.js`'s `mergeDiscIntoTv` behind the same host
    gate `publishTvAndBroadcast` uses. Pinned by `scripts/test-tvstate.mjs`
    (logic tier, in the CI gate) and `scripts/smoke-mp-state.mjs`.
22. **P0-5 — native SaveRAM persistence is PARTIAL.** The last open P0 from
    `docs/research/psx-ps2-n64-review-2026-07-24.md`: `autosave_interval` is
    wired and `flushSaveRam`/`readSaveRam` do live reads, but end-to-end
    persistence across a reload is unconfirmed and one flush-timing limitation
    is known/accepted. Needs content with a recognized save type to settle.

## Parked (user-deferred, low priority)
- ✅ **Controller cords + spawnable screens — done**, superseded by the
  patchable AV rack: every gamepad/gun/keyboard has a real grabbable cord +
  plug (`src/Plug.js`, `src/Cord.js`), and consoles/TVs are spawnable
  (`Add Console`) with their own patch cords. See **Phase RACK** above.

## Cross-cutting principles
- **Ship no ROMs, bundle no cores** (`docs/LICENSING.md`).
- **Rooms/collections are portable JSON**, content referenced by location.
- **Don't rewrite the working core** — add declarative layers over existing
  factories.
- **Quest + desktop parity** is a release gate, not an afterthought.
