# Handoff

Single orientation doc for picking this project up cold. Last updated 2026-06-09
when `feat/edit-modes-and-desktop-controls` was merged to `main` and **deployed
live** — the edit modes, desktop controls, and local multiplayer below are now the
running build (real-VR smoke test still pending). Built on the **three in-VR edit
modes (Move / Change / Add)** restructure — on top of
local multiplayer (couch co-op), Phase E.3 (create props/portals in-VR), E.2
(in-VR look editing), E.1 (move props + export) + its gamepad fix + first deploy,
Phase R (R.1 JSON collection layer, R.2 RomResolver, R.3 rooms as JSON), the CC0
test-game library, and the classic-core render fix (all below). Phase R is
complete.

**In-VR editor — three modes (done).** The old flat E.1/E.2/E.3 menu is now a
**Play / Move / Change / Add** selector (`RoomEditor` carries a `_mode` enum, not
a boolean). **Move** = grab a prop to reposition (E.1). **Change** = grip-SELECT a
prop then cycle its options — poster art, **shelf collection (live rebuild)** — plus
the global Wallpaper/Floor/Lighting/All-Posters cycles (E.2). **Add** = a furniture
catalogue: Shelf, **Bookcase / Cupboard / Table** (new decorative props in
`src/Furniture.js`), Console, Poster, Portal (E.3). This **closes the previously
deferred "assign collections to shelves"** — Change mode does it via
`EnvEditor.cycleShelfCollection` (pure) + a `rebuildShelf` helper that swaps the
shelf object live (`GrabMgr.removeGrabbable`, `SceneMgr.removeObject`,
`RoomEditor.removePlaced`). All edits ride out through Export Room (verified: unit
tests + headless probe — furniture spawns/serialize, shelf cycle manifest→snes
rebuild + export round-trip). **Deployed live 2026-06-09; the real-VR smoke test of
the modes is still pending** (menu is raycast-only; can't be exercised headlessly,
same as E.1/E.2/E.3).

**Local multiplayer is done** (route a controller's input to the player
of the console port it's plugged into — `src/CableMgr.js`, per-player
`GameInputMgr` dispatch, P1..P4 console ports; *local couch co-op, distinct from
the networked Phase M in `docs/MULTIPLAYER.md`*). Tests + headless + screenshot
green; **deployed live 2026-06-09, but VR controller routing still needs a
real-headset smoke test** (headless has no XR gamepads). **Next roadmap step:
real-VR verify the edit modes + multiplayer routing on a Quest, then start Phase M
(networked multiplayer).** The deferred collections-to-shelves is now done (Change
mode, above).

**Desktop (non-VR) play & edit is done.** `src/DesktopControls.js` makes the flat
screen fully interactive: **click to capture the mouse, mouse-look + WASD to walk,
left-click = select/menu, right-click = grab/drop (toggle), Esc = release.** It
drives the *existing* GrabMgr/MenuMgr by feeding a **synthetic third "controller"**
(`SceneMgr.desktopController`, added to `scene.controllers` so the managers auto-wire
it) that tracks the camera and dispatches the same `select*`/`squeeze*` events an XR
controller would — so no manager logic changed, and it's fully inert in a headset
(`renderer.xr.isPresenting` gate). Gameplay was already keyboard-driven (`InputMgr`
forwards arrows/Enter/Space/H/G/Y/T/E/P/R/O); **WASD is safe because it's not in that
forward-set.** Crosshair + control hint live in `index.html`. Verified headless
(movement + room-clamp + synthetic grab/release of a prop) + screenshot.

**Live build:** https://dionysus.dk/webxr/libretrowebxr2/ (this repo, **current
`main` @ e5b9f9f, deployed 2026-06-09** — edit modes, desktop controls, and local
multiplayer are all live; COOP/COEP verified). The original
https://dionysus.dk/webxr/libretrowebxr/ is the older prototype and is left
untouched — `libretrowebxr2` is a deliberate separate folder. User confirmed E.1
works in VR; the gamepad-pickup regression below is fixed + redeployed.

## What this is

**LibretroWebXR** — a browser-based WebXR libretro frontend. Retro console
emulators (via libretro cores compiled to WASM) run inside a 3D room you can
enter in VR (standalone Quest browser or PCVR) or explore on a flat screen.
North star: an open, web-native **EmuVR** — build your own room, curate game
collections, share rooms as data, eventually play together.

- **Repo:** https://github.com/kblood/LibretroWebXR (public, MIT)
- **Local working copy:** `C:\LLM\LibretroWebXR` ← all work happens here
- **Old scratch workspace:** `C:\LLM\Projects\ClaudeTest\LibretroWebXR`
  (historical/reference only — see `PROVENANCE.md`; do not develop there)
- **Deploy:** live at `https://dionysus.dk/webxr/libretrowebxr2/` (GCloud Apache).
  `npm run deploy` → `scripts/deploy.ps1` (**gitignored, local-only — holds the
  SSH host/user/key path**; the published template is `scripts/deploy.example.ps1`).
  See "Deploying" below. The older `/webxr/libretrowebxr/` is the prior prototype,
  left as-is.

## Current state (works today)

The app is a **working prototype**, not greenfield. Already functional:
3D room, grabbable cartridges on shelves, insert into console → boots on the
in-world CRT TV, ~13 systems, keyboard/gamepad/WebXR-controller input with
per-core RetroPad mapping, save states (memory cards), spatial audio, in-VR
menus. See `docs/ROADMAP.md` "Current state" for the module list.

**Phase R.1 (done)** added a declarative collection layer over that scene
without rewriting it. **Phase R.2 (done)** added `src/RomResolver.js` — games
resolve their ROM bytes from url / local folder (File System Access API, handle
persisted in IndexedDB) / file picker / OPFS cache, wired behind
`loadCartridge()`. **Phase R.3 (done)** made the whole world declarative: a
`*.room.json` (`src/RoomLoader.js` parses, `src/RoomBuilder.js` builds) drives
the existing Shelf/Console/Cartridge/Gamepad factories, applies surfaces +
lighting (`SceneMgr.applyEnvironment`), and places posters/models/portals.
`?room=URL` loads a full room (drag-drop too); portals walk you between rooms.
With no `?room` the built-in `defaultRoom()` reproduces the old two-shelf layout
exactly.

**Phase E.1 + E.2 + E.3 (done)** are the in-VR room editor: E.1 grabs/moves/rotates
the room's props and exports the edited `*.room.json`; **E.2** (`src/EnvEditor.js`,
pure cycling) adds **Wallpaper / Floor / Lighting / Posters** menu buttons that
re-paint live (`SceneMgr.applyEnvironment`, `RoomBuilder.applyPosterTexture`) and
mutate `currentRoom`; **E.3** (`src/PropCreator.js`, pure minting) adds **Add
Shelf / Add Console / Add Poster / Add Portal** buttons that spawn a brand-new
prop in front of the player, build it through the same single-prop
`RoomBuilder.buildProp`/`buildPortal` path, append the descriptor to
`currentRoom`, and register it as an editable grabbable via
`RoomEditor.registerPlaced` — so E.1 move + E.2 look-editing + Export Room all
apply to it immediately (a new portal also joins the live proximity-nav list).
All three ride out through Export Room. *Assigning collections to shelves in-VR is
still deferred* (needs a live shelf+cartridge rebuild + `GrabMgr.removeGrabbable`).
**Next: the deferred collections-to-shelves.**

**Local multiplayer — couch co-op (done 2026-06-03).** Up to 4 local players on
one console, routed by **which port a controller is plugged into**. This is
*local* same-machine co-op and is **distinct from networked Phase M** in
`docs/MULTIPLAYER.md` (presence/voice/game-sync over WebRTC — still future).
- `src/CableMgr.js` (pure, unit-tested) is the registry: gamepad ↔ port ↔ player
  (port 0 = player 1, …). `src/Console.js` renders a labelled `P1..P4` port row;
  `portsForSystem(system)` in `src/systems.js` enables exactly the ports the
  hardware accepts (NES/SNES/MD = 4, most = 2, handhelds = 1).
- **Plugging is a grab-drop**, reusing the cartridge-insert pattern: release a
  gamepad near a free port → it snaps + plugs (`GrabMgr._handleGamepadRelease`);
  grabbing a plugged gamepad unplugs it. The default gamepad auto-plugs into
  port 0 (player 1, single-player unchanged); E.3's **Add Gamepad** auto-plugs the
  new one into the next free port (one tap → player 2).
- **Input routing:** `GameInputMgr` now dispatches **per-gamepad, per-player** via
  an injected `getRouting()` (main.js `computeRouting`): one held gamepad → both
  hands forward to its player (the original two-hands-one-player feel); two held →
  each hand drives its own. Player 1 keeps the resilient double-dispatch; players
  2-4 use `EXTRA_PLAYER_KEYS` (single cfg-bound key each) from
  `src/ControllerMaps.js`, which `src/RetroArchConfig.js` binds in `retroarch.cfg`.
- **Keyboard couch co-op (secondary):** `src/InputMgr.js` also forwards the P2-4
  keyboard codes, so same-keyboard players work on desktop. (P3 uses F-keys, which
  are `preventDefault`-ed — F5 won't reload while playing. VR is unaffected: it
  routes through `GameInputMgr`, not `InputMgr`.)
- **Invariant added:** a `npm test` assertion proves no key code collides across
  players 1-4 (this caught a real shipped bug: P4-Down was `KeyZ`, which is P1's
  stock B — now `Numpad2`/`keypad2`).
- **Verification status:** `npm test` + headless probe (`__cable`, auto-plug) +
  screenshot all green. **VR controller routing itself needs a real-headset smoke
  test** (headless has no XR gamepads), same caveat as E.1/E.2/E.3. Not yet
  redeployed — the live build is E.3.
- **Deferred follow-ons:** physical USB-gamepad routing (`navigator.getGamepads()`),
  per-button mesh animation + a DebugHud for gamepads 2-4 (extra pads play but only
  the primary animates), and an in-VR way to retarget a port.

**CC0 test-game library (done 2026-06-02).** The default `manifest.json` now ships
our own source-built CC0 games so the frontend has playable content on every
system — no commercial ROMs. **11 of 12 wired systems** have a working,
screenshot-verified game: C64 (×2), VIC-20, NES, GB, GBA, Genesis, SMS, GG, PC
Engine, SNES, Virtual Boy. Each builds from source via `npm run make-<sys>` (game
source in `games/<sys>/`, build scripts in `scripts/make-*.mjs`); per-system
toolchain + authoring notes in `docs/research/` (one file per system + a synthesis
`README.md`). **Only gap: Atari 2600** — game is built (`games/atari-dodger`) but
held out of the manifest because its only core (Stella) has no module build (see
the core invariant below and `docs/research/README.md` "Known issue").

**Classic-core render fix (done 2026-06-02).** Booting each game in-app revealed
that every libretro core marked `style:'classic'` in `src/systems.js` rendered
**black** (loaded+mapped the ROM but never started video). These were old ~210 KB
WebEmu auto-init builds. Replaced snes9x/nestopia/genesis_plus_gx/mgba/mednafen_vb
with modern ~261 KB buildbot MODULARIZE builds and set `style:'module'`. This is
why SNES/NES/Genesis now work on their default cores and the old fceumm/picodrive
"pins" were dropped.

## Get running (Windows / PowerShell)

```powershell
cd C:\LLM\LibretroWebXR
npm install
npm run fetch-cores     # copies cores into public/cores/ (gitignored). Auto-finds
                        # them in the old scratch workspace; else see the script.
npm run dev             # http://localhost:5173  (Vite sets COOP/COEP)
npm test                # 121 pure-logic assertions (…/RoomSerializer/EnvEditor/PropCreator)
npm run debug           # headless-Chrome health check (see DEBUGGING.md)
```

`npm run debug -- --url=http://localhost:5173/ --screenshot=tmp\out.png` then
Read the PNG is the fastest way to *see* the scene. Verdict OK / exit 0 = healthy.
Headless Chrome has no XR runtime, so it always logs "VR NOT SUPPORTED" — that's
expected; real VR needs the Quest/headset on the HTTPS deploy.

**Headless gotcha:** under headless Chrome, `buildCartridgeWorld()` stalls at
`await buildMemoryCards()` (IndexedDB `open` hangs), so `__locomotion/__gameInput/
__menu/__room` never get set and grab/input tick callbacks never register. The
scene still renders (so `npm run debug` is fine for render/error smoke tests), and
real browsers complete it normally. To probe editor/grab state headlessly use
`window.__editor` / `window.__grab` (both exposed *before* that await on purpose).
See the deferred "harden buildMemoryCards" item below.

## Deploying

```powershell
npm run deploy                 # build + deploy to /webxr/libretrowebxr2/
pwsh scripts/deploy.ps1 -DryRun -SkipBuild   # see remote actions, touch nothing
```

- `scripts/deploy.ps1` is **gitignored** (it bakes in the GCloud SSH host/user/key
  path, matching the sibling projects IWSDK/Boligsøgning). Only the credential-free
  `scripts/deploy.example.ps1` is published — copy it to `scripts/deploy.ps1` and
  fill in details (or set `DEPLOY_*` env vars) on a new machine. **Never commit the
  real one.** (History was scrubbed once already — see PROJECT_HISTORY/git log.)
- Flow: `fetch-cores` → `vite build` → per-item `scp` of `dist/` into a staging dir
  → atomic `mv` to live (keeps a `.old` until success). `public/.htaccess` is
  uploaded explicitly (a bare `scp dist/*` skips the dotfile).
- **New-folder COOP/COEP gotcha:** the `.htaccess` headers only apply if Apache has
  `AllowOverride FileInfo` for that dir. Each new folder needs its own
  `/etc/apache2/conf-available/<name>.conf` (template: `deploy/libretrowebxr2.conf`)
  installed as root + `a2enconf <name>` + `systemctl reload apache2`. Already done
  for `libretrowebxr2`. Verify after deploy:
  `curl -sI https://dionysus.dk/webxr/<name>/ | grep -i cross-origin`.

## Hard invariants (don't break these)

- **The gamepad is grabbable in BOTH play and edit mode.** It's a room prop (so
  `RoomEditor` marks it `editable`), but the modal grab filter must still let it be
  picked up in play mode or games can't be played — this was the E.1 regression.
  `GrabMgr._isCandidate` special-cases `kind:'gamepad'`; `_release` reconciles its
  held-state in either mode. Don't collapse the gamepad back into the editable-only
  set. Cartridges/cards stay play-only; furniture stays edit-only.

- **COOP/COEP everywhere.** `crossOriginIsolated` must be `true` or
  `SharedArrayBuffer` vanishes and the threaded cores won't start. Enforced in
  `vite.config.js` (dev) and `deploy/` + `public/.htaccess` (prod).
- **Emulator canvas must be `id="canvas"`.** RetroArch's web input driver
  hardcodes `querySelector('#canvas')`; any other id null-derefs. See
  `DEBUGGING.md`.
- **Ship no ROMs, bundle no cores.** Cores are fetched at runtime
  (`public/cores/` is gitignored); only free/homebrew/PD/CC ROMs ever ship.
  Several cores are non-commercial (snes9x, genesis_plus_gx, picodrive). See
  `docs/LICENSING.md` and `THIRD_PARTY_LICENSES.md`.
- **Core runs on the main thread** via an injected `<script>` / dynamic
  `import()`, NOT in a Web Worker (webretro's worker path is buggy — see
  `DEBUGGING.md` "Architectural lesson"). `XRRafShim` keeps its rAF loop alive
  during a WebXR session.
- **Use `style:'module'` (MODULARIZE) cores, not `style:'classic'`.** The legacy
  classic-script path renders **black** (loads the ROM, never starts video). Every
  shipping core must be a modern buildbot MODULARIZE build (`export default` +
  `import.meta`, ~261 KB). Get them from
  `buildbot.libretro.com/nightly/emscripten/RetroArch.7z`. `stella2014` is the only
  remaining `classic` core (no Stella module build exists), so Atari 2600 can't
  render yet. Don't let `npm run fetch-cores` restore an old classic core over a
  module one. See `docs/research/README.md` "Known issue".
- **`LICENSE` must stay pure MIT text** (no appended notes) or GitHub stops
  detecting it as MIT. Scope note lives in `THIRD_PARTY_LICENSES.md`.

## Architecture map (where things live)

```
src/
  main.js            Bootstrap + wiring. Resolves the world (dropped file /
                     ?room= / ?collection= / default), loads collections, calls
                     RoomBuilder, then owns grab/input/menus, cartridge-insert →
                     load, save-state memory cards, portal navigation, drag-drop.
  RoomLoader.js      ★R.3 PURE parse of *.room.json → canonical descriptor
                     (parseRoom / defaultRoom / normalizeProp / normalizePortal /
                     roomCollectionRefs). No THREE → unit-tested.
  RoomBuilder.js     ★R.3 buildRoom({scene,room,collections}) drives the
                     Shelf/Console/Cartridge/Gamepad factories from the
                     descriptor; builds posters/models/portals; returns the
                     handles main.js wires. Shelf games via collection +
                     filter/slice/half. ★E.1 also stamps userData.roomProp on
                     every movable object + returns placed:[{prop,object}].
                     ★E.2 exports applyPosterTexture() (builtin:/URL) for live
                     poster re-skinning. ★E.3 extracts buildProp(prop,{scene,
                     collections}) (single prop → {object,kind,cartridges?}) +
                     exports buildPortal; buildRoom's loop delegates to buildProp.
  RoomSerializer.js  ★E.1 PURE inverse of RoomLoader.parseRoom:
                     serializeRoom(room, transforms)→clean room@1 object (live
                     pos/rot by id over the descriptor's non-spatial fields).
                     No THREE → unit-tested; round-trips with parseRoom.
  RoomEditor.js      ★E.1 In-VR Edit mode: registers placed props as editable
                     grabbables (inert until editing), free/grid snap setting,
                     serialize() harvests live transforms, export() →
                     download + clipboard. Owns no scene geometry. ★E.3 adds
                     setEditMode(on) + registerPlaced(prop,object) so a
                     runtime-created prop joins the editable/placed set.
  EnvEditor.js       ★E.2 PURE env-option cycling (cycleSurface/cycleTimeOfDay/
                     cyclePosterTexture over fixed palettes). Mutates the room
                     descriptor in place; main.js's Wallpaper/Floor/Lighting/
                     Posters menu buttons re-apply live + export. Unit-tested.
  PropCreator.js     ★E.3 PURE prop/portal minting (createProp/createPortal +
                     uniqueId + addProp/addPortal). Returns a normalized entry
                     shaped like a parsed one (round-trips via RoomSerializer).
                     CREATABLE_PROP_TYPES = shelf/console/gamepad/poster. No
                     THREE → unit-tested; main.js's Add-* buttons build + place it.
  systems.js         ★R.1 SYSTEMS (system-first) + CORES (core-first) registry.
                     Single source of truth: cores, exts, folder aliases,
                     thumbnail repos, licenses. coreForFile / systemForFile /
                     systemForName. ★MP portsForSystem(system) + MAX_PORTS.
  CableMgr.js        ★MP PURE local-multiplayer registry: gamepad ↔ console port
                     ↔ player (port N → player N+1). plug/unplug/playerOf/
                     firstFreePort. No THREE → unit-tested. GrabMgr plugs on
                     drop, GameInputMgr reads playerOf via main.js getRouting.
  Collection.js      ★R.1 Load/normalize manifest.json (cartridges[]) AND
                     *.collection.json (games[]); auto-fill core + boxart.
  ArtResolver.js     ★R.1 libretro-thumbnails candidate chain (filename → title
                     → tag-stripped) + RetroArch char sanitization. Pure.
  RomResolver.js     ★R.2 resolve(meta)→ArrayBuffer from url / local (File System
                     Access folder, handle persisted in IndexedDB) / pick / opfs
                     (sha1 content-addressed cache). Pure helpers unit-tested.
  EmulatorClient.js  Main-thread proxy that loads the core + drives it; events
                     ready/error; serializeState/unserializeState.
  SceneMgr.js        Three.js scene, room geometry, WebXR session, TV mesh,
                     render loop. setScreenSource() swaps TV texture source.
                     ★R.3 applyEnvironment() repapers walls/floor/ceiling +
                     relights from a room's environment; applyTv() toggles CRT.
  Cartridge/Shelf/Console/Gamepad/MemoryCard.js  Grabbable 3D prop factories.
                     ★MP Console.js renders a P1..P4 port row + seat anchors;
                     setPorts(n) shows the active count.
  GrabMgr / LocomotionMgr / GameInputMgr / InputMgr / ControllerMaps  Input + VR.
                     ★E.1 GrabMgr gained an isEditMode/onEditRelease seam: edit
                     mode targets only props, play mode only carts/gamepad/cards.
                     ★MP GrabMgr plugs/unplugs a gamepad into a console port on
                     drop/grab (cable); GameInputMgr dispatches per-gamepad,
                     per-player via getRouting(); ControllerMaps adds P2-4 key
                     tables; InputMgr forwards P2-4 keyboard codes too.
  MenuMgr / MenuPanel / ControlsPanel / DebugHud  In-VR UI.
  SaveState.js       IndexedDB save-state store (per slot).
  CrtShader / SpatialAudio / Placeholder / XRRafShim  Effects + shims.
scripts/
  debug.js           Puppeteer health harness. `--rom=<path>` injects a ROM via the
                     real file-picker path; `--core=<name>` forces a core (?core=);
                     `--boot[=<system>]` boots a collection game through the real
                     RomResolver/loadCartridge path (url source) + core start;
                     `--probe-file=<path>` evaluates a JS file in the page + logs
                     its JSON return before the screenshot (poke window.__* hooks).
  fetch-cores.mjs    Populate public/cores/ from a local source (scratch workspace).
  make-c64-demo.mjs  Generate the CC0 C64 BASIC demo .prg.
  lib/cbm-basic.mjs  Shared Commodore BASIC v2 tokenizer (C64 + VIC-20).
  make-*.mjs         One per CC0 game (make-nes-pong, make-gb-snake, make-genesis-demo,
                     make-sms-arcade, make-pce-pong, make-snes-demo, make-gba-paint,
                     make-vb-demo, make-c64-snake, make-vic20-demo). Each rebuilds a
                     ROM in games/<sys>/ → public/roms/freeware/. npm run make-games
                     runs the zero-install (pure-Node CBM) trio.
  test-collection.mjs  npm test — pure-logic assertions for the R.1 layer.
games/               Source for our CC0 games (committed), one dir per system. SDK
                     boilerplate frozen from each toolchain's template; only the game
                     logic is authored. See docs/research/ for per-system recipes.
public/roms/
  manifest.json      Default collection — now ships our CC0 games (11 systems) + a
                     few homebrew pointers.
  *.collection.json  Example collection schema (snes-demo).
  *.room.json        ★R.3 Example rooms (bedroom + arcade, cross-linked by
                     portals). Load via ?room=roms/bedroom.room.json.
  freeware/          Shippable ROMs: all lwx-*.* (our CC0 games) ship; rest are pointers.
docs/                ROADMAP, EMUVR_RESEARCH, ROOM_AND_COLLECTIONS, MULTIPLAYER,
                     LICENSING, PROJECT_HISTORY, HANDOFF (this file),
                     research/ (per-system game-authoring notes + synthesis README).
```
★R.1/★R.2/★R.3 = added in Phase R.1/R.2/R.3; ★E.1/★E.2 = added in Phase E.1/E.2.

## Data model (the project's core idea)

Everything is portable JSON that references content by location, never embeds
ROMs. Full spec: `docs/ROOM_AND_COLLECTIONS.md`. In short:

- **Collection** (`*.collection.json`, `games[]`) = a game library: per game a
  `{ file/rom, system, core?, title, color?, boxart? }`. Core + boxart are
  auto-filled if omitted. Superset of the legacy `manifest.json` (`cartridges[]`).
- **Room** (`*.room.json`) = the 3D scene + how collections lay out in it
  (surfaces, shelves, console, posters, **portals** to other rooms). *Loaded by
  RoomLoader/RoomBuilder since R.3.*
- A game entry consumed by `Cartridge.js` keeps fields: `file, system, core,
  title, color, boxart`, plus R.1 extras `boxartList, license, credits, rom`.
- Load at runtime: **`?room=URL`** loads a full room; **`?collection=URL`** drops
  a bare collection into the built-in `defaultRoom()`; **drag-drop** a
  `.room.json`/`.collection.json` onto the page. Default is `roms/manifest.json`.
  (`?room` is no longer an alias for `?collection` — R.3 split them.)

## Roadmap position

`docs/ROADMAP.md` is authoritative. Phases:
- **Phase 0** ✅ clean repo published (MIT, licensing docs, EmuVR research).
- **Phase R — Rooms & Collections as JSON** ✅ complete
  - **R.1 ✅ done** — data layer (systems / ArtResolver / Collection; main.js
    refactored; tests; debug harness boxart-404 reclassification).
  - **R.2 ✅ done** — `src/RomResolver.js`: url / local (File System Access API,
    persisted dir handle in IndexedDB) / pick / opfs (sha1 content-addressed
    cache). Delivers the user goal of referencing **web folders OR local folders
    on PCs/headsets**. Wired behind `loadCartridge()`; "ROM folder…" header
    button grants the local library where the FSA API exists.
  - **R.3 ✅ done** — `src/RoomLoader.js` (pure parse) + `src/RoomBuilder.js`
    (build) drive the factories from a `*.room.json`; `SceneMgr.applyEnvironment`
    applies surfaces/lighting. `?room=URL`, drag-drop, and portals all work;
    examples `bedroom`/`arcade`. Default layout unchanged.
- **Phase E — in-VR room editor** (write back `*.room.json`)
  - **E.1 ✅ done** — Edit-mode toggle; grab/move/rotate the room's props;
    free/grid snap setting; `RoomSerializer` (pure inverse of RoomLoader) +
    `RoomEditor` serialize the live scene and export the `*.room.json`
    (download + clipboard; "Export Room" header button + in-VR menu item).
  - **E.2 ✅ done** — in-VR environment editing: `src/EnvEditor.js` (pure
    cycling) + Wallpaper/Floor/Lighting/Posters menu buttons re-paint live
    (`SceneMgr.applyEnvironment`, `RoomBuilder.applyPosterTexture`) and export
    via RoomSerializer. *Assign collections to shelves deferred* (live shelf
    rebuild + `GrabMgr.removeGrabbable`).
  - **E.3 ✅ done** — `src/PropCreator.js` (pure mint) + Add Shelf/Console/
    Poster/Portal menu buttons spawn a prop in front of the player, build it via
    the extracted `RoomBuilder.buildProp`/`buildPortal`, append it to
    `currentRoom`, and register it editable via `RoomEditor.registerPlaced`
    (a new portal also joins the live nav list). *Collections-to-shelves still
    deferred* (live shelf rebuild + `GrabMgr.removeGrabbable`).
- **Phase M ← NEXT** — multiplayer (`docs/MULTIPLAYER.md`): M0 presence/avatars/voice,
  M1 host-authoritative game sync, M2 rollback, M3 crossplay.
- **Phase C** — open prop package schema, community gallery, BIOS-needing
  systems (PSX/N64), PWA.

## Deferred follow-ups (not blocking Phase E)

- **Verify File System Access on the Quest browser** with a real headset — the
  "ROM folder…" button self-hides where `showDirectoryPicker` is absent, and
  `pick` + `opfs` are the guaranteed fallbacks, but Quest support is unverified.
- **In-VR** library grant + room/collection drop are still flat-screen only
  (desktop drag-drop + the grant button work; no in-VR equivalent yet).
- **sha1 verification** of fetched/local bytes is not enforced (the field is
  only used as the OPFS cache key today).
- **R.3 specifics:** `tv` prop only toggles the CRT shader (no TV reposition);
  portal targets are room URLs (no local-id registry); no "you don't own this"
  affordance on cartridges whose ROM can't resolve. See `docs/ROADMAP.md`.
- **E.2: assign collections to shelves in-VR.** Env (look) editing is done;
  reassigning a shelf's collection live needs a shelf+cartridge rebuild and a
  `GrabMgr.removeGrabbable` the grab/insert lifecycle doesn't have yet. The
  descriptor + serializer already support it — only the live rebuild is missing.
- **Harden `buildMemoryCards()` / input init.** It awaits IndexedDB (`listStates`)
  during `buildCartridgeWorld()`, which *hangs* in headless Chrome — so everything
  after the await (`__locomotion/__gameInput/__menu/__room` exposure, grab/input
  tick registration) never runs in `npm run debug`. Real browsers are fine, but
  the init shouldn't be able to wedge on one IndexedDB call: wrap it in a
  timeout/try-catch and/or move it off the critical path so input always wires up.
  (`window.__editor`/`__grab` are deliberately exposed *before* the await as a
  headless probe workaround — that's a patch, not the fix.)

## Immediate next actions (Phase E is done + deployed)

Phase E (in-VR editor) is complete — including the formerly-deferred
collections-to-shelves (Change mode) — and `main` is **deployed live as of
2026-06-09** (COOP/COEP verified). Sensible next steps, in rough priority order:

1. **Real-VR smoke test on a Quest** (the one thing that can't be done headlessly,
   deferred repeatedly): exercise the Play/Move/Change/Add edit-mode menus
   (raycast-only) and confirm **local multiplayer controller routing by console
   port** (headless has no XR gamepads). If anything is off, fix → `npm run deploy`.
2. **Start Phase M (networked multiplayer)** — see `docs/MULTIPLAYER.md`; M0 is
   presence/avatars/voice + room-object sync. Build on the now-verified editor +
   input foundation.
3. **Polish (Phase C):** the prod bundle is one ~702 kB chunk (186 kB gzipped) —
   a `manualChunks`/dynamic-import pass would help Quest load time if it bites.

E.3 specifics worth knowing for whoever extends it:
- `window.__add.{shelf,console,gamepad,poster,portal}()` drive prop creation
  headlessly (exposed *before* the `buildMemoryCards` stall, like
  `__editor`/`__grab`); the Add-* **menu buttons** are raycast-only so aren't
  reachable in `npm run debug`. A probe that calls `__add.*()` then reads
  `__editor.serialize()` proves the new prop is captured for Export Room.
- A new prop spawns ~1.4 m in front of the player at a per-type height
  (`SPAWN_Y` in main.js) and force-enables Edit mode so it's immediately movable.
- A new **portal** aims at an example room that isn't the current one
  (`KNOWN_ROOMS`) so walk-through is verifiable; the *in-VR* way to retarget a
  portal (vs editing the exported JSON) is still open — a local-id/known-room
  picker would pair well with the R.3 portal work.
- Keep `npm test` + `npm run debug` green and screenshot-verify any UI change.

## Gotchas already hit (so you don't re-hit them)

- Box-art 404s against libretro-thumbnails are **expected** (homebrew coverage
  is sparse); the harness reclassifies them as "expected probes". Don't treat
  them as failures.
- Many "freeware" homebrew ROMs have **no explicit redistribution license** —
  those manifest entries are *pointers* (download yourself). Our own `lwx-*.*`
  CC0 games ARE committed and ship. See `public/roms/README.md`.
- **Always screenshot-verify a new game/core in-app** — a core can build/load a
  ROM and still render black (it's how the classic-core bug was found). Build-only
  checks miss it. `npm run debug -- --rom=<path> --core=<name> --screenshot=...`
  then Read the PNG and look at the CRT pixels (the header says "running" even when
  black).
- `gh` CLI wasn't logged in but git push worked (Windows credential store).
  `gh` was bridged via `git credential fill → gh auth login --with-token`.
- Don't batch a failing shell command with dependent tool calls — a non-zero
  exit cancels the rest of the batch. Run git/verification steps sequentially.
- Authoring CC0 games: write logic against the SDK library, freeze the SDK's
  boot/header template, build, then screenshot-verify. Toolchains were installed
  non-interactively (zip/pacman-package extraction, not GUI installers) — devkitARM
  came from devkitPro pacman packages, VUEngine from 7z-extracting its installer.

## Memory

Persistent memory notes: `canonical-repo-moved` (`C:\LLM\LibretroWebXR` is canonical,
old path historical); `test-game-authoring-goal` (the CC0 test-game effort, its
status, the classic-core fix, and installed-toolchain locations);
`libretrowebxr-deploy` (deploy method); and `libretrowebxr-concurrent-dev` (this
repo gets concurrent edits/WIP from other agent sessions — re-check git state
before assuming the roadmap position, and never commit files you didn't change).
