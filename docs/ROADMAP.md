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
- A VR room: grabbable **cartridges** on a **shelf**, a **console**, a
  **gamepad**, a **memory card**, with grab + locomotion (`Cartridge`, `Shelf`,
  `Console`, `Gamepad`, `MemoryCard`, `GrabMgr`, `LocomotionMgr`).
- Input across keyboard / gamepad / WebXR controllers with per-core, two-hand
  RetroPad mapping (`InputMgr`, `GameInputMgr`, `ControllerMaps`,
  `ControlsPanel`).
- Save states (`SaveState`), spatial audio (`SpatialAudio`), in-VR menus
  (`MenuMgr`, `MenuPanel`), a debug HUD, and a `?core=` override.
- ~13 systems wired (SNES, NES, Atari 2600, Genesis/SMS/GG, GBA, Virtual Boy,
  PC Engine, C64, VIC-20) via the `CORES` map.
- COOP/COEP for SharedArrayBuffer (`vite.config.js`, `deploy/`), and a puppeteer
  health-check harness (`scripts/debug.js`, `DEBUGGING.md`).

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
- Wired behind `main.js`'s `loadCartridge()` seam (replaced the old
  `romUrl()`+`fetch`). A "ROM folder…" header button (shown only where the FSA
  API exists) grants the local library.
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

## Phase E — In-VR room editor  ✅ done (one deferred clause)
Place/rotate props, swap wallpaper/floor/posters, assign collections to shelves,
add **portals** to other rooms — all writing back to `*.room.json`. Export/share
a room. This is the open, declarative replacement for EmuVR's closed WIGUx mod.
E.1 (move + export), E.2 (look editing) and E.3 (create props/portals) are all
done; only *assign collections to shelves in-VR* remains (deferred — needs
`GrabMgr.removeGrabbable` + a live shelf rebuild).

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
- Tests: `npm test` now 121 assertions (PropCreator id/mint/append + created
  prop/portal serialize round-trip). `npm run debug --probe-file=…` verifies
  adding poster+shelf+portal grows props/portals/placed/grabbables, auto-enters
  Edit mode, and the new ids appear in `editor.serialize()` — i.e. Export Room
  captures them. Screenshot-verified the spawned props render.
- **Still deferred** (from E.2): *assign collections to shelves* in-VR — needs a
  live shelf+cartridge rebuild and `GrabMgr.removeGrabbable` the grab/insert
  lifecycle doesn't have yet. The descriptor + serializer already support it.

## Phase M — Multiplayer (see `docs/MULTIPLAYER.md`)
- **M0:** shared room presence — avatars + voice + room-object sync (works for
  all cores). Signaling/matchmaking server + TURN.
- **M1:** host-authoritative game sync (input + video stream) for 2-player.
- **M2:** rollback game sync for deterministic cores (adapt netplayjs +
  `SaveState`).
- **M3:** multiple simultaneous games, mid-session join, VR↔desktop crossplay.

## Phase C — Content & polish
- Documented open prop package schema (model + `prop.json`) — vs EmuVR's
  Discord-gated UGC kit.
- Community gallery of room/collection URLs.
- BIOS-needing systems (PSX/N64) via fetched cores; user-supplied BIOS UX.
- PWA install; per-headset storage UX; performance passes on Quest.

## Cross-cutting principles
- **Ship no ROMs, bundle no cores** (`docs/LICENSING.md`).
- **Rooms/collections are portable JSON**, content referenced by location.
- **Don't rewrite the working core** — add declarative layers over existing
  factories.
- **Quest + desktop parity** is a release gate, not an afterthought.
