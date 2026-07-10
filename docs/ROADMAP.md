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
  for MODULARIZE cores), rendering onto a CRT/TV mesh (`EmulatorClient`).
- A VR room: grabbable **cartridges** on shelves and **bookcases** (up to 15
  carts), a **console**, a **gamepad**, a **memory card**, with grab + locomotion
  (`Cartridge`, `Shelf`, `Console`, `Gamepad`, `MemoryCard`, `Furniture`,
  `GrabMgr`, `LocomotionMgr`).
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
  ships Quest console/error logs to `https://dionysus.dk/logs?session=<room>`.
- **Room persistence** (`RoomPersistence`): room survives cross-core reload;
  auto-saves to localStorage on Export; Import Room button.
- **Poster image picker + fit/scale** (`ImageLibrary`, `PosterFit`): grant an
  on-Quest images folder; contain/cover/stretch + zoom per poster; in-VR 3×3
  thumbnail gallery.
- **Placement preview + snapping** (`Placement`): new props clamp to room bounds
  and snap to floor or nearest wall; ghost preview in Move mode.
- **17 systems** wired (SNES, NES, GB/GBC/GBA, Genesis/SMS/GG/SG-1000/Sega 32X,
  Virtual Boy, PC Engine, Atari 2600, C64, VIC-20, Amiga) via the `CORES` map /
  `systems.js`; DOS (VirtualXT) is registered but currently blocked — see
  **Mouse peripheral + new systems** and **DOS / VirtualXT** below.
- COOP/COEP for SharedArrayBuffer (`vite.config.js`, `deploy/`), and a puppeteer
  health-check harness (`scripts/debug.js`, `DEBUGGING.md`).
- Test suite: grows every phase (`npm test`; see `package.json` for the current
  script list — one `test-*.mjs` per pure module).

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
  buffer + optional NDJSON append.
- `deploy/log-proxy.conf`: Apache reverse-proxy snippet for `/log` + `/logs` +
  `/logs.json`. Note: `/logs.json` rule must appear before `/logs` (ProxyPass
  matches on whole segments — see HANDOFF.md Gotchas).
- Read headset logs at **`https://dionysus.dk/logs?session=<room>`**.

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
  `9240235` end-to-end headless probe).
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
- **Remaining:** real-headset validation (aim feel, two-gun co-op timing) —
  everything else is headless- and real-core-verified.

## Mouse peripheral + new systems (Amiga, SG-1000, Sega 32X)  ✅ shipped
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

## DOS / VirtualXT  ⚠ registered, blocked
A `virtualxt` core entry + `dos` system exist in `systems.js` (MPL-2.0,
floppy/keyboard-capable), and `docs/DOS_CORE_BUILD.md` documents the build
recipe — but the core currently **boot-traps under emscripten** and is not
shippable yet. This is a parked spike, not a regression: `fetch-cores` doesn't
fail on it (the core simply isn't fetched), so it costs nothing to leave
registered for whenever the upstream issue is fixed or worked around.

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
- BIOS-needing systems (PSX/N64) via fetched cores; user-supplied BIOS UX.
  **Feasibility assessed 2026-06-15 (`docs/research/psx-n64-feasibility.md`):**
  the no-JIT wasm runtime (same wall as Amiga/Amiberry) makes **PSX marginal —
  gate on a `pcsx_rearmed` perf spike, HLE BIOS default** — and **N64 not viable**
  on a standalone Quest 3 (slideshow; skip unless wanted as a non-playable demo).
- PWA install; per-headset storage UX; performance passes on Quest.

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
