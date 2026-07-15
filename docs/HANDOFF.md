# Handoff

Single orientation doc for picking this project up cold. Last updated
2026-07-12, branch `main` (code @ `a778b44` + the gun/mouse disarm option +
one more pending commit for SNES/C64 mouse support below — check `git log`
for the actual HEAD).

**Current focus: everything below is now live — real-headset validation is
what's left.** Deployed 2026-07-10 (see "Live build" below); `a778b44` (the
desktop pointer-lock fix), the gun/mouse disarm option, and SNES/C64 mouse
support (all 2026-07-11/12) are **committed + pushed but NOT yet deployed** —
run `npm run deploy` before expecting them live. Highlights, newest first:
- **SNES Mouse + C64 (1351) Mouse support added (2026-07-12).** User asked if
  the mouse peripheral could cover systems that had real mouse hardware
  historically (named SNES, NES, C64). Checked actual libretro core support
  rather than assuming from hardware history: **SNES** (`snes9x`, real port for
  Mario Paint) and **C64** (`vice_x64`, the 1351/GEOS mouse) both shipped and
  headless-verified against real content (`tmp/verify-snes-mouse.mjs` 6/6,
  `tmp/verify-c64-mouse.mjs` 5/5, no regressions in the disarm suites or
  `npm test`). C64 required generalizing `mouseLoadConfig()` to merge
  per-descriptor `coreOptions`, since VICE selects its mouse entirely via
  `vice_joyport`/`vice_joyport_type` core options rather than a port-device
  assignment. Caught and corrected my own wrong guess mid-investigation (see
  `docs/MOUSE_SUPPORT.md`) by fetching the real vice-libretro source instead
  of trusting a `strings`-on-wasm guess or a WebSearch summary. **NES/Famicom
  Mouse is NOT feasible** — neither NES core we ship implements the real
  Famicom Mouse (HVC-031); their mouse-shaped devices are unrelated (Subor
  keyboard/mouse combo, Bandai Oeka Kids tablet). Sega Mega Mouse (Genesis)
  looks real/supportable but is unverified and out of scope — flagged as a
  follow-up only. Full detail: `docs/MOUSE_SUPPORT.md`, `docs/ROADMAP.md`
  "Mouse peripheral + new systems".
- **Gun/mouse arming-leak bug fixed with an explicit disarm option
  (2026-07-11, pushed not deployed).** Follow-up to the entry below:
  `window.__lightgunArmed`/`window.__mouseArmed` are deliberately sticky for
  the session, but capability checks are system- not per-ROM-level, so an
  armed peripheral used to leak onto any later unrelated ROM on a
  gun/mouse-capable system. Rather than a stricter meta-only gate (which would
  break externally-picked ROMs — no per-title metadata to declare
  `lightgun`/`mouse` in the first place), added `disarmLightGunAndReload()`/
  `disarmMouseAndReload()`, `window.__disarmGun()`/`window.__disarmMouse()`,
  and "Disarm Gun"/"Disarm Mouse" main-menu buttons: clears the sticky flag and
  drops the device from the CURRENT game only if that game doesn't itself
  declare it. Verified end-to-end against the real boot path:
  `tmp/verify-disarm.mjs` (gun, 15/15) and `tmp/verify-disarm-mouse.mjs`
  (mouse, 9/9). Details: `docs/LIGHTGUN_SUPPORT.md`, `docs/MOUSE_SUPPORT.md`,
  session narrative below (item 5 under "Eye of the Beholder won't load").
- **Desktop mouse pointer-lock gated on real wiring + Eye of the Beholder
  black-screen root-caused (2026-07-11, `a778b44`, pushed not deployed).** Two
  separate findings from one user report chain:
  1. A user's Quest report ("Eye of the Beholder SNES loads to a black
     screen") led first to a real-but-irrelevant bug (light-gun arming leaks
     across unrelated ROMs — see `docs/LIGHTGUN_SUPPORT.md`, since fixed,
     bullet above) and eventually to the actual cause: **the user's ROM file
     was truncated/corrupt.** Its size (575,166 bytes) isn't even a multiple of
     512, let alone a valid SNES bank-aligned size (the game is normally
     ~1.5 MB); a truncated ROM boots "successfully" at the JS/core-start layer
     (no exception, nothing to catch) and then renders nothing because
     critical banks are missing. **Lesson for future "black screen on
     headset" reports:** check the `boot-attempt`/`rom-picked` telemetry's
     `bytes` field against a known-good size for that ROM *before* assuming a
     code bug — this is now a fast, cheap first check. The production log
     server's `boot-attempt` event (logged in both `loadCartridge` and
     `loadCartridgeIntoConsole`) carries `{file, system, core, plan:{sha1,
     cacheKey, order, url}, opfs}` and is the right first stop:
     `curl https://dionysus.dk/logs.json?tail=0` (careful — no `session` filter
     returns EVERY session; `tail=0` disables the 200-entry default cap too).
  2. While chasing a related desktop-only report ("mouse movement becomes
     very different" after loading an external ROM), found and fixed a real,
     separate bug: `MouseMgr.attachDesktop()`'s click listener called
     `requestPointerLock()` on **any** canvas click, regardless of system or
     whether a mouse device was actually wired to the seated console —
     clicking near/on the canvas while loading an unrelated (non-mouse) ROM
     silently captured the OS cursor into relative/hidden-cursor motion (no
     error thrown, just a broken-feeling mouse — reads as a crash). Fixed with
     a `getWired()` gate + a `releaseDesktopLock()` call on any boot that
     doesn't want the mouse device. Full detail + the identical-shaped
     still-open bug in the gun/mouse arming flags: `docs/MOUSE_SUPPORT.md`
     "Follow-ups", `docs/LIGHTGUN_SUPPORT.md` "Known bug".
  3. Added integration tests proving a controller's cable can move between
     ports/consoles mid-session (moves, swaps, unplugs) with routing always
     following the live seat: `scripts/test-controller-portswitch.mjs` (new),
     `scripts/test-mousemgr-pointerlock.mjs` (new), extended
     `scripts/test-patchbay.mjs`. `npm test` green (0 failures).
- **"Fix everything" pass (2026-07-10, `76325d3`..`b25abdc`, deployed).**
  Four code-only gaps closed in one sweep: shelf/bookcase cover plaques
  (derive the label from the collection's own `title`); a pre-flight "you
  don't own this ROM" badge on cartridges a multiplayer peer can't resolve
  locally (`RomResolver.isUnresolvableHere`); in-VR menu equivalents for the
  ROM/Images folder grants and loading a not-yet-referenced known collection
  (`Load Collection`, cycling like the existing shelf-collection/portal-target
  pickers); and portal retargeting via Change mode's Cycle Selected
  (`EnvEditor.cyclePortalTarget`). All four are real-headless-browser verified
  (not just unit-tested) — see "Deferred follow-ups" below for what's now
  struck through. **HEADSET-UNVERIFIED**, same as the rest of the raycast-only
  menu surface.
- **NES light-gun shooter #2: "LWX Frontline Fury" (2026-07-09, `e2a0ab3`).**
  An Operation-Wolf-style on-rails wave shooter for the Zapper — soldiers
  march toward the front line, only the frontmost is ever lit (matches real
  Zapper hardware: a light/trigger bit only, no aim position). 2-player reuses
  `nes-gallery`'s SHARE/DUEL pattern. Verified 12/12 headless (jsnes) + 12/12
  on the real nestopia core, both boot paths. Deployed 2026-07-10.
- **Flat-screen desktop build (2026-06-30, `c591895`).** `desktop.html` — a
  non-VR entry point (`src/desktop/`) that runs the same emulator core in a
  plain browser tab with the existing host-authoritative netplay, so two
  people can play over the Internet without a headset. Reuses the
  three-free shared modules verbatim (EmulatorClient, systems/Collection/
  RomResolver, NetProtocol/PresenceState/RoomObjects/VideoMgr, room-server).
  **Real-GPU verified 2026-07-02** (`scripts/verify-desktop-netplay.mjs`,
  `npm run verify-desktop-netplay`, 8/8): two headed Chrome windows connect
  to the same room, the host boots a bundled NES game, and the client
  receives a genuinely live WebRTC video track (advancing `currentTime`,
  independently-verified differing frame content) — closing the gap the
  original commit flagged (headless software-GL can't exercise
  `captureStream()` pixels).
- **DOS registered on VirtualXT (2026-06-25, merged 2026-07-02).** `dos` is a
  system in `src/systems.js` running the buildbot's prebuilt VirtualXT core,
  but it's **blocked**: the buildbot binary boot-traps right after mounting
  the disk (`RuntimeError: unreachable`), a buildbot build defect, not a
  wiring bug. Parked like Atari 2600/stella2014. Full de-risk writeup:
  `docs/DOS_CORE_BUILD.md`.
- **Amiga boots a real Kickstart (2026-06-30, `6089ebe`).** `puae_kickstart:
  'Automatic'` + `systemFiles` provisions the user's own KS1.3 ROM
  (gitignored, `public/roms/local/`) into RetroArch's system dir before boot;
  falls back to the built-in AROS replacement when no ROM is on the server.
- **Mouse as a first-class connectable peripheral (2026-06-25/30,
  `c184a73`).** Amiga PUAE reads `RETRO_DEVICE_MOUSE` via synthetic DOM
  mouse events (de-risk verified); single-mouse and two-mouse (`mouse2`,
  needs a multiport core patch to be truly independent) variants registered.
  See `docs/MOUSE_SUPPORT.md`.
- **Multiplayer full-sync epic + light guns (mid-late June, several
  commits).** A real fix for "sync subsystems didn't wire on an in-app
  widget join" (only `?session=` URL joins got full MP sync before); NES
  Four Score 4-player multitap; light guns are a pluggable, networked,
  cord-attached peripheral with VR aim/fire, breadth across NES/SNES
  (incl. two-gun Justifier co-op)/Genesis/SMS, and remote-diagnosable
  telemetry (`docs/LIGHTGUN_SUPPORT.md`, `docs/HEADSET_LIGHTGUN_VALIDATION.md`).
- **Rack / multi-console (mid June).** Live cross-core swap on a secondary
  console without a page reload; power/reset switches; rack layout persists
  across the (still-needed, for the primary console) cross-core reload.

**Deployed 2026-07-10, confirmed live (two deploys today).** First deploy
published code @ `e2a0ab3` ("LWX Frontline Fury"); a second deploy the same
day published code @ `b25abdc` (the "fix everything" pass above) to
`/webxr/libretrowebxr2/` — verified by fetching the live `roms/manifest.json`
(now carrying its new `title` field) and `npm run debug` against the live URL
(verdict OK). Prior deploy was 2026-07-02 @ `a7aac29`. Everything above is
committed + pushed to `origin/main` and live.

The **controls bug** (Quest users sometimes can't control the console after a
cross-core reload), called out in the prior handoff as instrumented-but-
unconfirmed, has seen **no headset re-test since** — still open, still
diagnosable via the Logger as described below. Built on top of networked
multiplayer Phase M0 + M1 (presence/voice/TV/held-object + host-authoritative
input + host video stream — all live), the **three in-VR edit modes (Move /
Change / Add)** + desktop controls + **local multiplayer (couch co-op)**, Phase
E (E.1/E.2/E.3 in-VR editor), Phase R (JSON collection layer + RomResolver +
rooms as JSON), the CC0 test-game library, and the classic-core render fix (all
below). Phases R and E are complete.

**Networked multiplayer (Phase M) — M0 done + DEPLOYED (2026-06-09).** Open the
live build with `?session=<room>` (optionally `&nick=`, `&color=`) and everyone in
that room shares it. Architecture mirrors the project's pure/imperative split —
all wire logic is pure and unit-tested (`npm test`), the THREE/socket sides just
reflect it; each piece has a headless smoke that also runs live against
`wss://dionysus.dk/ws/`. The slices:
- **M0.1–0.3 presence** — pure protocol + peer registry (`src/net/NetProtocol.js`,
  `PresenceState.js`), avatars head+hands+nameplate (`Avatar.js`/`AvatarMgr.js`),
  and a WebSocket relay (`server/` — pure `Hub.js` + thin `room-server.mjs`) with
  the browser client `src/net/NetMgr.js` (opt-in via `?session=`). Server is
  authoritative over peer ids (anti-spoof). Smoke: `scripts/smoke-presence.mjs`.
- **M0.4 voice** — WebRTC mesh (`src/net/VoiceMgr.js`) signaled over the same WS
  (`SIGNAL` messages, directed relay in `Hub.js`); each remote mic →
  `THREE.PositionalAudio` on that peer's avatar head; desktop "🎤 Voice" button.
  STUN-only. Smoke: `scripts/smoke-voice.mjs` (two browsers + fake mics).
- **M0.5 room-object sync** — generic shared key→value `STATE` channel
  (`NetProtocol.makeState`, pure registry `src/net/RoomObjects.js`) persisted
  per-room last-writer-wins in `Hub.js` and **snapshotted to late joiners**. First
  consumer: the **TV / loaded game** — booting a cartridge converges the room's
  TVs (`applyRemoteTv` in main.js; reflected loads use `echo:false` to avoid
  rebroadcast loops). Smoke: `scripts/smoke-object-sync.mjs`.
- **M0.6 held-object sync** — grabbing a cart broadcasts `hold:<file>` =
  `{holder,hand}` (`GrabMgr` `onCartridgeGrabbed`/`onCartridgeReleased`); peers
  hide their copy and show a **ghost cart in the holder's avatar hand**
  (`src/GhostCartMgr.js`, pure rules in `src/net/HoldState.js`). `hold:` keys are
  owner-scoped: `Hub.disconnect` clears a departed peer's holds. Smoke:
  `scripts/smoke-held.mjs`.

**Room server deploy:** systemd unit `libretrowebxr-room` from
`/opt/libretrowebxr-room` (port 8787) + Apache `/ws/` reverse-proxy
(`mod_proxy_wstunnel`). Templates: `deploy/libretrowebxr-room.{service,conf}`.
After changing anything under `server/` or `src/net/NetProtocol.js`, scp those
files to `/opt/libretrowebxr-room/{server,src/net}/` and
`sudo systemctl restart libretrowebxr-room` (the static app deploys separately via
`npm run deploy`). See `server/README.md`.

**M0 hardening (2026-06-13):** **TURN is now config-wired** — `NetProtocol.
buildIceServers` composes STUN + an optional TURN relay (symmetric NAT; STUN
covers same-LAN/most NATs), threaded through `NetMgr` into both the voice + video
meshes, supplied via `?turn=…&turnUser=…&turnCred=…`; a `deploy/coturn.conf.example`
template + setup notes ship (the coturn **server provisioning + a live symmetric-NAT
test are still pending** — no TURN server stood up yet). The **in-VR voice
affordance is done** — a "Voice" item in the main menu mirrors the desktop 🎤
button (enable/mute via the same `NetMgr` path); *whether the Quest browser grants
the mic mid-XR is the open question for the real-headset smoke*. **Still pending:**
a real **two-headset** smoke test (needs hardware).

**Phase M1 (host-authoritative game sync) — ✅ DONE + DEPLOYED (2026-06-13).**
All three slices live; M1.1/M1.2 smokes pass against `wss://dionysus.dk/ws/`.
- **M1.0 ✅ done + DEPLOYED** — remote-input transport: a directed `INPUT`
  message (`NetProtocol.makeInput`) relayed client→host over the room socket
  (`Hub.input`, sender-id stamped); `NetMgr.sendGameInput`/`onGameInput` + a debug
  recv ring. Carries one logical RetroPad button (`{player,btn,down}`) so the host
  resolves it per-player and feeds its core. Smoke: `scripts/smoke-gameinput.mjs`
  (directed delivery, id-stamping, no broadcast leak), live-verified.
- **M1.1 ✅ done + DEPLOYED (2026-06-13)** — wired end-to-end. **Host = the `tv`-state
  owner** (whoever booted the room's game); the routing decision is pure
  (`NetProtocol.hostInputTarget`) with `NetMgr.hostId()/isHost()/forwardGameInput()`
  on top. **Client capture:** `GameInputMgr` now emits each *logical* RetroPad
  transition via `onLogicalInput` (pre-keycode, diffed per frame) and main.js
  forwards it to the host. **Host injection:** `onGameInput`→`GameInputMgr.
  setRemoteButton` resolves `codesFor(player,btn)` and merges the codes into the
  per-frame keydown/keyup sweep — so a still-held remote key isn't lifted, and a
  local player + a remote player coexist with no crosstalk (every player's codes
  are globally unique). The client still drives its OWN core locally (it sees its
  game until M1.2 video). Verified: `scripts/test-multiplayer.mjs` (24 — logical
  emit, host inject, no-kill, release, P1+P2 coexist) + `scripts/test-net.mjs`
  (`hostInputTarget`) + `scripts/smoke-gamesync.mjs` (host auto-resolved from `tv`
  state, forwarded to the right peer, no self-send, no broadcast leak). *Headless
  has no XR gamepads, so controller→logical capture and the host dispatch are
  unit-tested, not in the smoke — same caveat as the edit-mode menus.* **Deferred:
  on a peer disconnect mid-press its remote keys can latch on the host —
  `GameInputMgr.clearRemote()` exists but isn't yet wired to a presence-leave.**
- **M1.2 ✅ done + DEPLOYED (2026-06-13)** — host video stream. `src/net/VideoMgr.js`
  (a sibling of `VoiceMgr`) is a **host→client** WebRTC subsystem: the host (the
  `tv`-state owner) captures `#canvas` via `captureStream()` and adds it
  **send-only** to a peer connection per other peer (host is the sole offerer, so
  no glare); each client receives the track → a `<video>` → `SceneMgr.
  setScreenVideo()` paints it on the CRT as a `THREE.VideoTexture` (reverting to
  the local canvas on stream end). Signaling rides the **same SIGNAL relay** on
  `channel:'video'` (`NetProtocol.makeSignal`) so it never collides with the voice
  mesh — `NetMgr` routes by the tag, the `Hub` relays it opaquely. A host handover
  (new `tv` owner) tears down + rebuilds. main.js: booting a game calls
  `net.startVideoBroadcast()`; `onHostVideo`/`onHostVideoEnded` swap the TV.
  Verified: `scripts/smoke-video.mjs` (host fans its stream out to 2 clients, both
  receive; voice smoke still 8/8 — no regression) + `scripts/test-net.mjs` (the
  `channel` tag). *VideoMgr is WebRTC-heavy → smoke-tested not unit-tested, same
  split as VoiceMgr.* **Follow-up DONE (2026-06-13):** a watching client now
  PAUSES its own core while showing the host's frames (it isn't authoritative and
  isn't displayed → no point burning Quest CPU/battery). `EmulatorClient.pause()/
  resume()` toggle the core's emscripten main loop (`Module.pauseMainLoop/
  resumeMainLoop`, which the buildbot cores export); the desired state is
  re-applied after a (re)start so a freshly-booted watcher core doesn't briefly
  run (`_applyPauseState`). main.js: `onHostVideo`->`client.pause()`,
  `onHostVideoEnded`->`client.resume()` (host left / handover / we became host),
  and a local boot (`echo:true`) resumes first so a new host always runs. Verified:
  `scripts/smoke-video.mjs` (now 16 — two clients pause while watching, one resumes
  after taking over as host). *A paused watcher also has no game audio — fine, its
  local audio was never synced to the host's displayed frames anyway.*

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
green; **deployed live 2026-06-09.** The **routing logic** (gamepad→port→player→
keycode, incl. no-crosstalk between pads) is now covered headlessly by
`scripts/test-multiplayer.mjs` (the policy was extracted to the pure
`src/Routing.js`, which `npm test` exercises with mock controllers + a recording
client). **What still needs a real headset:** that the Quest exposes one live XR
`inputSource.gamepad` per held controller, plus the raycast menus — neither is
scriptable. **Next roadmap step: that real-VR smoke test when a headset is free,
or start Phase M (networked multiplayer) now** since the input foundation is
logic-verified. The deferred collections-to-shelves is done (Change mode, above).

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

**Live build:** https://dionysus.dk/webxr/libretrowebxr2/ (this repo, **code @
`b25abdc`, deployed 2026-07-10** — the "fix everything" pass (cover plaques,
unresolvable-ROM badge, in-VR folder grants + Load Collection, portal
retarget) on top of the same day's earlier deploy (`e2a0ab3`, "LWX Frontline
Fury"), on top of the 2026-07-02 deploy (`a7aac29`), which carried everything
in the summary above plus everything from the prior 2026-06-13 deploy: edit modes, desktop controls,
local multiplayer, networked Phase M0 + M1 (presence/voice/TV/held-object
sync, host input + video stream), remote logging, room persistence, C64
keyboard, placement snapping, configurable posters, image picker, multiplayer
join/leave UI, Now Playing panel — all live. COOP/COEP + `crossOriginIsolated`
verified; M1.1/M1.2 smokes pass live against `wss://dionysus.dk/ws/`. The
flat-screen build is also live at
**`/webxr/libretrowebxr2/desktop.html`**. **The in-headset smoke-test
checklist is live at `/webxr/libretrowebxr2/headset-test.html`** (linked from
the app header — "🧪 Headset Test"). Headset logs viewable at
**`https://dionysus.dk/logs?session=<room>`**. The original
https://dionysus.dk/webxr/libretrowebxr/ is the older prototype and is left
untouched — `libretrowebxr2` is a deliberate separate folder.

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
npm test                # 4252 pure-logic assertions (collection/room/serializer/
                        # env-editor/prop-creator/placement/logger/image-library/…)
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
  Logger.js          ★LOG Auto-enables on dionysus.dk (or ?log=<url>); hooks
                     console + window error/unhandledrejection, buffers structured
                     JSON entries, POSTs batches to /log with keepalive + backoff.
                     main.js inits it first so startup errors are captured.
                     Pure formatEntry/buildBatch helpers are unit-tested.
  NowPlayingPanel.js ★DBG World-space panel: current system/core/ROM title + a
                     live "● input" pulse on each RetroPad transition (diagnostic
                     for the "can't control console" report). Wired via
                     GameInputMgr.onKeyDown + loadCartridge.
  Placement.js       ★E New props spawn/snap correctly. Pure room-bounds model +
                     clampToRoom + snapToSurface: floor props (shelf/bookcase/
                     console/table/cupboard/gamepad) rest at a per-kind height;
                     wall props (poster) snap to the nearest inward-facing wall
                     plane. SceneMgr.getRoomBounds() exposes the inner extents.
                     GrabMgr.tick shows a ghost preview at the snapped drop point
                     in Move mode. "Surface Snap" button (default on) toggles.
                     Unit-tested (71 assertions in scripts/test-placement.mjs).
  RoomPersistence.js ★PERSIST Pure save/load helpers. The live room is now stashed
                     before the cross-core location.reload() and restored on resume
                     (no more "ROM load wipes room edits"). Every Export also
                     snapshots to localStorage; auto-loads on cold boot (?room=default
                     clears/bypasses as an escape hatch). Import Room header button
                     reuses the drag-drop load path.
  ImageLibrary.js    ★IMG Grant an images folder via File System Access API (handle
                     persisted in IndexedDB, mirroring RomResolver); lists image
                     files for the in-VR poster picker. Header "Images folder…"
                     button. Works in a Quest XR session.
  PosterFit.js       ★IMG Pure fit-mode UV: contain / cover / stretch + scale
                     factor (zoom) → THREE repeat/offset. Unit-tested. Poster
                     descriptor gains fit/scale fields (default contain/1), round-
                     tripping via RoomSerializer. applyPosterTexture honors these
                     from the poster's natural pixel size.
  C64KeyLayout.js    ★C64 Pure C64 keyboard layout + per-key KeyboardEvent mapping
                     (keyEventFor) + UV hit-test (keyAt). Node-importable, unit-
                     tested. Uncertain VICE mappings (CTRL/RUN-STOP/RESTORE/C=/
                     £/up-arrow/=) isolated here for headset tuning.
  C64Keyboard.js     ★C64 World-space CanvasTexture panel: hover/tap/hold keys with
                     visual highlight; dispatches via injected sendInput callback
                     (no coupling to main.js). Auto-shows for c64/vic20 on boot;
                     a "Keyboard" menu item + header button toggle manually.
  GrabMgr / LocomotionMgr / GameInputMgr / InputMgr / ControllerMaps  Input + VR.
                     ★E.1 GrabMgr gained an isEditMode/onEditRelease seam: edit
                     mode targets only props, play mode only carts/gamepad/cards.
                     ★MP GrabMgr plugs/unplugs a gamepad into a console port on
                     drop/grab (cable); GameInputMgr dispatches per-gamepad,
                     per-player via getRouting(); ControllerMaps adds P2-4 key
                     tables; InputMgr forwards P2-4 keyboard codes too. ★FIX
                     gamepad release now always tries plug-into-port before the
                     edit-mode prop-reposition path (the old ordering swallowed
                     the release in edit mode — controllers couldn't be wired).
  MenuMgr / MenuPanel / ControlsPanel / DebugHud  In-VR UI.
  SaveState.js       IndexedDB save-state store (per slot).
  CrtShader / SpatialAudio / Placeholder / XRRafShim  Effects + shims.
src/net/
  SessionUtils.js    ★MP Pure helpers: sanitiseRoom / randomRoomSuffix. Powers
                     the in-app join/leave UI (no more URL-param-only sessions).
                     Unit-tested (21 assertions).
scripts/
  debug.js           Puppeteer health harness. `--rom=<path>` injects a ROM via the
                     real file-picker path; `--core=<name>` forces a core (?core=);
                     `--boot[=<system>]` boots a collection game through the real
                     RomResolver/loadCartridge path (url source) + core start;
                     `--probe-file=<path>` evaluates a JS file in the page + logs
                     its JSON return before the screenshot (poke window.__* hooks).
                     ★LOG net::ERR_ABORTED on /log flush reclassified as expected
                     (logger POSTs to /log; the in-flight flush aborts on page tear-
                     down and used to flip the verdict to FAIL).
  dummy-player.mjs   ★MP Headless room observer: joins via the presence WebSocket,
                     logs peer join/leave, poses, STATE/TV-sync, voice/video SIGNAL,
                     remote INPUT, held-object. CLI: --session/--url/--nick/--color/
                     --move. `npm run dummy-player -- --session=<room> --move`.
                     Live-verified against wss://dionysus.dk/ws/.
  fetch-cores.mjs    Populate public/cores/ from a local source (scratch workspace).
  make-c64-demo.mjs  Generate the CC0 C64 BASIC demo .prg.
  lib/cbm-basic.mjs  Shared Commodore BASIC v2 tokenizer (C64 + VIC-20).
  make-*.mjs         One per CC0 game (make-nes-pong, make-nes-bomberman, make-gb-snake,
                     make-genesis-demo, make-sms-arcade, make-pce-pong, make-snes-demo,
                     make-gba-paint, make-vb-demo, make-c64-snake, make-vic20-demo). Each
                     rebuilds a ROM in games/<sys>/ → public/roms/freeware/. npm run
                     make-games runs the zero-install (pure-Node CBM) trio.
  test-collection.mjs  npm test — pure-logic assertions for the R.1 layer.
server/
  log-server.mjs     ★LOG POST /log receiver + GET /logs (auto-refreshing HTML
                     viewer) + GET /logs.json. Per-session ring buffer + optional
                     NDJSON append. Mounted by room-server.mjs (port 8788).
deploy/
  log-proxy.conf     ★LOG Apache reverse-proxy snippet for /log + /logs + /logs.json.
                     Note: ProxyPass matches on whole path segments — /logs alone
                     does NOT cover /logs.json; an explicit rule for /logs.json
                     must appear before the /logs rule.
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
★R.1/★R.2/★R.3 = added in Phase R.1/R.2/R.3; ★E.1/★E.2/★E = added in Phase E;
★MP = multiplayer; ★LOG = remote logging; ★PERSIST = room persistence;
★IMG = image picker/poster-fit; ★C64 = C64 keyboard; ★DBG = debug panel;
★FIX = bug fix.

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
- **Phase M — IN PROGRESS** — multiplayer (`docs/MULTIPLAYER.md`): **M0 ✅ done +
  DEPLOYED** (presence/avatars/voice/TV sync/held-object ghosts); **M1 ✅ done +
  DEPLOYED** (M1.0 remote-input transport, M1.1 client capture + host injection,
  M1.2 host video stream + watcher-core pause — all live + smoke-verified).
  In-app join/leave UI + roster (header widget + in-VR Multiplayer menu) done.
  **Two-headset smoke test still needed (hardware).** **M2** = rollback game sync
  (feasibility spike done: confirmed rewrite, not a slice — keep M1 streaming as
  shipped default; bare-core NES PoC as an opt-in spike first); **M3** crossplay.
- **Phase C** — bundle chunking ✅ done; open prop package schema, community
  gallery, BIOS-needing systems (PSX/N64), PWA.
- **Controller cords + spawnable screens** — user-deferred; parked at the bottom
  of `docs/ROADMAP.md`.

## Deferred follow-ups

**Note (2026-07-10):** this list had drifted — several items below were already
fixed in the code before this doc's last "refresh" but never got marked done.
Re-verified against actual source (not prior doc text) on 2026-07-10; corrected
inline. If you're picking up stale-looking doc claims again, check `git log
-S"<distinctive string>"` before trusting the doc.

- **Controls bug (open item):** Quest users sometimes can't control the console
  after a cross-core reload. The input pipeline is now **instrumented** (`logger`
  'input' + 'input-state' events in main.js) but the bug is not confirmed fixed.
  Diagnose from `https://dionysus.dk/logs?session=<room>` during a headset session:
  `held:false` → gamepad not grabbed; `held:true xr:0` → no XR gamepad visible;
  'input-state' reading but no 'input' events → dispatch issue.
- ~~Picked poster images are blob: URLs~~ **✅ already fixed (`0d8a75d`,
  2026-06-14).** `imageFile` (the source filename) round-trips through
  `RoomSerializer`/`PropSync`; on load, `src/main.js` (~line 3210, "FIX 3d")
  re-resolves it against the granted `ImageLibrary` folder and rebuilds the
  `blob:` URL. Tested: `scripts/test-imagelibrary.mjs`.
- ~~Held-cart ghosts only wire on the `?session=` path~~ **✅ already fixed
  (`4987eb5`, 2026-06-22 — "Wire MP sync subsystems on in-app widget join, not
  just ?session=").** `GhostCartMgr` construction now lives inside
  `_wireNetSession()` (`src/main.js:2588`), called from `connectToRoom()`
  (`src/main.js:385`) on both the auto-join and the header-widget join paths.
- ~~Shelf/bookcase cover image (P3)~~ **✅ done (2026-07-10, `76325d3`).**
  `src/CoverPlaque.js` mounts a small canvas-texture plaque naming the
  collection (derived from the collection's own `title`, so it round-trips
  through `RoomSerializer` for free — only `prop.collection` is persisted).
  Wired in both `RoomBuilder.js` (initial shelf/bookcase build) and
  `main.js`'s `rebuildBookcase()` (collection-cycle refresh). Screenshot- and
  headless-probe-verified on default shelves, a local-overlay bookcase, and a
  freshly `window.__add.bookcase()`-spawned one.
- ~~Local-file carts are not persisted to the room descriptor~~ **✅
  functionally fixed (`47fa5b3`, 2026-06-14 — `src/LocalRomLibrary.js`).**
  Not literally round-tripped through `*.room.json`, but ROMs loaded via
  "Load ROM" are sha1-keyed into `localStorage` (`persistLocalRom`) and
  re-minted as shelf cartridges on boot (`restoreLocalRoms`, called from
  `src/main.js:2248`) — they do survive a reload now.
- **C64/VIC-20 key mappings to verify on a real headset:** CTRL, RUN/STOP,
  RESTORE, C=, £, up-arrow, = are best-effort VICE mappings isolated in
  `C64KeyLayout.js` for tuning.
- **Two-headset multiplayer smoke test** still needs hardware.
- **TURN / coturn server** not yet provisioned (config is wired, no live relay —
  same-LAN and most NATs work on STUN).
- **Verify File System Access on the Quest browser** with a real headset — the
  "ROM folder…" button self-hides where `showDirectoryPicker` is absent, and
  `pick` + `opfs` are the guaranteed fallbacks, but Quest support is unverified.
- ~~In-VR library grant + room/collection drop are still flat-screen only~~
  **✅ done (2026-07-10, `1b984f1`).** "Grant ROM Folder" / "Grant Images
  Folder" main-menu buttons call the same `pickLibraryDirectory()`/
  `pickImagesDirectory()` flows from a raycast trigger click. Free-text URL
  entry stays out of VR (matching the existing "Set Poster Image…" `prompt()`
  precedent, which already punts to Cycle Selected in VR) — instead a "Load
  Collection" Add-panel button cycles through known collections the room
  doesn't reference yet (`roms/homebrew.collection.json`,
  `roms/snes-demo.collection.json`) and spawns a shelf for the chosen one.
  Real-headless-browser verified: folder grants resolve without hanging when
  FSA is unsupported; Load Collection loads each known collection in order
  and safely no-ops once exhausted.
- ~~sha1 verification of fetched/local bytes is not enforced~~ **✅ done
  (2026-07-10).** `RomResolver.verifyRomIntegrity(buf, meta)` hashes freshly
  fetched (`url`/`local`/`pick`) bytes and throws on mismatch against a
  declared `rom.sha1`, folded into the `resolve()` source-fallback loop
  (a mismatch is treated like any other source failure — the next declared
  source is tried). `opfs` cache hits are trusted without re-hashing (already
  content-addressed by the sha1-keyed cache filename, correct by construction).
  A no-op when no sha1 is declared, so every shipping CC0 ROM (none of which
  declare one) is unaffected — this only activates for locally-picked/cached
  ROMs or any collection that opts in by declaring `rom.sha1`. Tested in
  `scripts/test-romresolver.mjs`; `npm test` + `npm run debug` still green.
- **R.3 specifics:** `tv` prop only toggles the CRT shader (no TV reposition —
  this is intentional now, not just unfinished: the later `tvset` prop type
  from Phase RACK already covers "a movable, patchable TV"; `tv` is the
  legacy single fixed TV baked into the base room); portal targets are room
  URLs (no local-id registry, but now retargetable in-VR — see below). See
  `docs/ROADMAP.md`.
- ~~No "you don't own this" affordance on cartridges whose ROM can't
  resolve~~ **✅ done (2026-07-10, `76325d3`).**
  `RomResolver.isUnresolvableHere(meta)` gives a multiplayer peer a
  pre-flight signal — mainly for a cart another peer loaded from THEIR local
  folder/pick, which this browser has never cached in OPFS. `Cartridge.js`
  composites a "YOU DON'T HAVE THIS ROM" badge (`MediaLabel.
  drawUnavailableBadge`) onto the label when it fires, instead of only
  failing reactively at load time. Real-headless-browser verified: a
  synthetic local-only/uncached ROM flags true, a normal shipped
  `url`-sourced cart stays false (no false-positive for the common case).
- ~~Harden `buildMemoryCards()` / input init~~ **✅ already fixed (`0d8a75d`,
  2026-06-14).** `src/main.js:5108` races `listStates()` against a 2s timeout
  (`MEMORY_CARD_TIMEOUT_MS`, "FIX 2") inside a try/catch, falling back to
  `saved = []` so a stalled headless-Chrome IndexedDB open can no longer wedge
  init.
- ~~Client↔host full-sync review gaps~~ **✅ fixed (2026-07-15).** A review of
  "does a client become fully synced with the room/displays/controllers/held
  objects, both ways" found 7 gaps; the code-level ones are now fixed:
  gun/mouse/keyboard input now forwards to the host over new `'gun'`/`'mouse'`/
  `'kbd'` WIRE channels (mirrors the existing gamepad `forwardGameInput` path —
  `_gunClientFor`/`_mouseClientFor`/`_kbdSendInputFor` in `main.js`, applied
  host-side by `_hostApplyGunWire`/`_hostApplyMouseWire`/`_hostApplyKbdWire`);
  the mouse now has full hold/grab network sync (`src/GhostMouseMgr.js`,
  mirrors `GhostLightGunMgr`); the default (boot-time) console/TVs/gun/mouse/
  keyboard now get `userData.roomProp` + `_staticPropIds` seeding so Move-mode
  repositioning of them actually broadcasts (previously only the *receive*
  side worked — `_broadcastPropMove` silently no-op'd on send for all of
  these, TVs included); gun/mouse are now dual-mode grabbable (play + edit,
  like the gamepad) so Move mode can reach them at all; `RoomLoader.PROP_TYPES`
  now includes `'mouse'` (was silently dropped on room-JSON parse); a peer-
  spawned mouse's `cableId` now survives `serializePropState` (was silently
  dropped, unlike the gun's). Two findings remain **accepted, not bugs**:
  cartridge exclusive-grab-lock has no pre-authority race guard (documented
  limitation, low stakes — worst case is a brief double-grab visual glitch);
  `gun:`/`mouse:`/`prop:` STATE persisting after the setter disconnects (unlike
  `gamepad:`, which auto-clears) is *consistent* with `PropSync.js`'s
  documented "room layout is persistent shared state" policy, not an
  inconsistency — arguably gamepad's vanish-on-disconnect is the outlier, not
  gun/mouse. One residual race is mitigated but not eliminated: two peers
  joining an empty room within the same `_awaitHostRoom` grace window can both
  conclude "I'm the host" and both try to publish a `'room'` STATE key; the
  publish call now re-checks immediately beforehand and skips if another peer
  already published (`mp-room-publish-raced` telemetry event), so the loser
  no longer clobbers the winner for future late joiners — but the loser peer
  itself keeps running on its own already-built (possibly divergent) local
  room until a manual reconnect. A full fix needs server-side compare-and-swap
  (`Hub.js`'s `setState` has none); out of scope unless this proves to matter
  in practice.

## Immediate next actions (as of 2026-07-11)

`a778b44` (desktop pointer-lock fix + controller port-switch tests) and the
gun/mouse **disarm option** (this session, see below) are **committed + pushed
but NOT deployed yet** — `npm run deploy` first if you want them live (live is
still `b25abdc`, 2026-07-10). Sensible next steps, in rough priority:

0. **Deploy the pending commits.** Cheap, verified, no known regressions
   (`npm test` green; disarm feature end-to-end verified against a real dev
   server in `tmp/verify-disarm.mjs` + `tmp/verify-disarm-mouse.mjs`, 24/24
   assertions). Do this before anything else below so both fixes are actually
   live for the next session.
0.5. ✅ **done — gun/mouse arming cross-wiring "leak"** (`docs/LIGHTGUN_
   SUPPORT.md`, `docs/MOUSE_SUPPORT.md` follow-up #5): `window.__lightgunArmed`/
   `window.__mouseArmed` are deliberately sticky for the session while
   `isLightgunCapable`/`isMouseCapable` are system- not per-ROM-level, so an
   armed peripheral used to leak onto any later gun/mouse-*capable-system* ROM
   regardless of whether that title used one. Rather than dropping the sticky
   flag (which would break externally-picked ROMs that have no per-title
   metadata to declare `lightgun`/`mouse` at all), added an explicit **disarm**
   affordance: `disarmLightGunAndReload()`/`disarmMouseAndReload()`
   (`src/main.js`), `window.__disarmGun()`/`window.__disarmMouse()`, and a
   "Disarm Gun"/"Disarm Mouse" button on the main menu panel. Clears the sticky
   flag and, only if the CURRENT game doesn't itself declare the device, live-
   reboots without it — a curated gun/mouse title keeps its device regardless.
   HEADSET-UNVERIFIED (the new menu buttons render/click headless only so far).
1. **Diagnose + fix the controls bug on a real Quest.** Unchanged from the prior
   handoff — still open, still just instrumented, not reproduced or fixed since.
   The input pipeline emits Logger 'input'/'input-state' events; reproduce on a
   headset, watch `https://dionysus.dk/logs?session=<room>` from a desktop, read
   the state log to pin the failure mode. Fix → `npm run deploy`.
2. **Real-headset validation backlog** — several features have shipped logic-
   verified but headset-unverified: light-gun aim/fire in VR (checklist:
   `docs/HEADSET_LIGHTGUN_VALIDATION.md`), two-gun co-op, the mouse
   peripheral's in-VR feel/gain, C64/VIC-20 key mappings, the raycast
   edit-mode menus (Play/Move/Change/Add — now including the two new folder-
   grant buttons and Load Collection/portal-retarget), the patchable AV rack
   (controller cord repatch + cross-core swap — see the 2026-06-14 feedback
   doc), and two-headset multiplayer (avatars/voice/TV sync/roster — use
   `npm run dummy-player -- --session=<room>` as a lightweight desktop
   observer). None of these are exercisable headlessly; they need an actual
   Quest session — the site is deployed and ready for it now.
3. **DOS core** — blocked on the buildbot VirtualXT boot-trap (see the top
   summary + `docs/DOS_CORE_BUILD.md`). Building VirtualXT ourselves needs an
   Odin toolchain with no proven emscripten path; DOSBox Pure (the better
   long-term core) needs a heavy from-scratch WSL2 build, unassessed for effort.
   Not worth picking up without a specific reason to prioritize DOS.
4. **Phase M2 — research spike done.** Confirmed: genuine rewrite, not a slice.
   Recommendation: keep M1 host-authoritative streaming (now also available via
   the desktop-netplay build) as the shipped default; do a bare-core spike on
   `fceumm` (NES only) as an opt-in PoC before deciding on full M2. Read
   `docs/research/M2-rollback-feasibility.md` first.
5. **Phase C** — remaining: open prop-package schema, community gallery, BIOS
   systems (PSX/N64 — feasibility assessed 2026-06-15, N64 not viable on
   standalone Quest 3, PSX marginal), PWA install. Bundle chunking is done.

**2026-07-10 session (first pass):** deployed the pending "LWX Frontline
Fury" game (`e2a0ab3`) that was committed but not yet live; audited the
"Deferred follow-ups" list against actual code (not doc text) and found 3 of
the ~10 items were already fixed weeks earlier but never marked done;
implemented and shipped the sha1-verification item for real (was a genuine
gap).

**2026-07-10 session (second pass — "fix all the things"):** worked through
every remaining code-only, non-headset, non-infra gap: shelf/bookcase cover
plaques, the "you don't own this ROM" pre-flight badge, in-VR folder-grant +
Load Collection menu buttons, and portal retargeting via Cycle Selected — see
the top summary. All four real-headless-browser verified, not just unit-
tested; one real bug caught in the process (portal descriptors have no
`.type` field, so the first cut of the Change-mode portal branch silently
never matched — fixed by keying off `object.userData.kind` instead). Explicitly
did **not** touch: TURN/coturn server provisioning (live infra, needs separate
confirmation) or the DOS core (blocked, not worth picking up without a reason
— see item 3 above). **Deployed 2026-07-10 (`b25abdc`), confirmed live** via
the manifest fetch + `npm run debug` against the production URL.

E.3 specifics worth knowing for whoever extends it:
- `window.__add.{shelf,console,gamepad,poster,portal}()` drive prop creation
  headlessly (exposed *before* the `buildMemoryCards` stall, like
  `__editor`/`__grab`); the Add-* **menu buttons** are raycast-only so aren't
  reachable in `npm run debug`. A probe that calls `__add.*()` then reads
  `__editor.serialize()` proves the new prop is captured for Export Room.
- A new prop spawns ~1.4 m in front of the player at a per-type height
  (`SPAWN_Y` in main.js) and force-enables Edit mode so it's immediately movable.
- A new **portal** aims at an example room that isn't the current one
  (`KNOWN_ROOMS`) so walk-through is verifiable. Retargeting in-VR (vs editing
  the exported JSON) is now done: select the portal in Change mode and use
  Cycle Selected (`EnvEditor.cyclePortalTarget`, 2026-07-10) — same
  curated-cycle pattern as shelf collections, cycling through `KNOWN_ROOMS`.
- Keep `npm test` + `npm run debug` green and screenshot-verify any UI change.

**2026-07-10 session (third pass — user feedback on the just-deployed build):**
two reports: "you need a way to duck or set your height" and "turning off a
console only seems to pause it." Both fixed:
- **Duck.** Neither `LocomotionMgr.js` (VR) nor `DesktopControls.js` (desktop)
  ever touched `playerRig.position.y` — physically crouching already lowers
  the VR view (headset pose is read live off the XR camera), but there was no
  way to do it on desktop, and no comfort/seated-play option in VR. Added a
  smoothed (lerp, not snap — VR comfort) `-0.5m` hold-to-duck: `KeyC` on
  desktop, either controller's thumbstick-click (button 3) in VR when hands
  are free. Thumbstick-click is claimed for RetroPad `stickClick` input while
  the virtual gamepad prop is held (`GameInputMgr.js`), so duck only reads it
  when `isGamepadHeld()` is false — but the *release* lerp back to standing
  still runs even if the gamepad gets grabbed mid-duck, so it can't get stuck
  low. Headless-verified: VR math in plain Node (`tmp/verify-duck-locomotion.mjs`
  — LocomotionMgr has no DOM dependency, so no browser needed) and desktop via
  `window.__desktop.duck()` + real rAF frames in Puppeteer
  (`tmp/verify-power-and-duck.mjs`).
- **Power off was really just pause.** `setConsolePower()` only called
  `client.pause()/resume()` — turning off then back on resumed the exact
  suspended state, not a cold boot, and a **solo console's audio was never
  muted at all** (`SpatialAudio`'s focus-mute only engages with 2+ TVs;
  `updateFocus()` no-ops below that, so a single-console room's `focusedId`
  stays `null` forever and gain stays 1 regardless of power state — silence
  depended entirely on the specific core's build actually honouring
  `pauseMainLoop`). Fixed: off→on now also calls `client.reset()` (a real
  power switch has no battery backing a suspended state, unlike the separate
  RESET button — cold boot is the correct default; on→on when already on does
  *not* re-reset, so this doesn't fire redundantly on every ROM load), and
  `SpatialAudio` gained a `setPower(consoleId, on)` that force-zeroes a
  console's gain independent of focus, called from `setConsolePower`.
  Headless-verified against a real booted core in Puppeteer
  (`tmp/verify-power-and-duck.mjs`): gain 1→0→1, reset called exactly once on
  the off→on edge, not on redundant on→on.
- Not yet deployed as of writing this entry — `npm test` (all green, no
  regressions) and both headless verifications pass; deploy is the next step.

**2026-07-11 session — "Eye of the Beholder won't load" investigation.** A
user reported an SNES ROM black-screening on Quest. Walked through several
theories before landing on the real one, worth recording for how the
diagnosis actually went (not just the fix):
1. First theory — the light-gun arming flag (`window.__lightgunArmed`) had
   fired on this exact boot (confirmed in the session log), so it looked like
   the culprit. **The user pushed back twice** ("controllers are unlikely to
   have anything to do with the game not loading — are you sure?", then after
   more detail, pointed out external ROMs had never worked even before the
   light-gun feature existed). Both pushbacks were right to make: a
   reproduction test (`tmp/verify-beholder-repro.mjs`, forcing the identical
   mis-wiring onto a known-good SNES ROM via the real boot path) rendered
   fine — proving wrong controller/gun wiring alone does not blank the video
   output. The bug is real (see `docs/LIGHTGUN_SUPPORT.md`, since fixed — item
   5 below) but was not the cause of this report.
2. A related but separate desktop-only report ("mouse movement becomes very
   different" after loading an external ROM) led to the actual
   `MouseMgr.attachDesktop()` pointer-lock bug — fixed, see the top summary
   and `docs/MOUSE_SUPPORT.md`.
3. Back on the Quest, a second attempt with richer `boot-attempt`/`rom-picked`
   telemetry (now carrying `{bytes, plan:{sha1,cacheKey,order,url}, opfs}`)
   showed the SAME 575,166-byte file failing identically on **two different
   consoles** via **two different boot code paths** (`loadCartridge`'s raw
   pick and `loadCartridgeIntoConsole`'s full resolver), with **zero JS errors
   logged** in either case. That combination — silent "success" at the JS
   layer, reproducible across independent code paths — pointed away from the
   app and toward the file. 575,166 isn't divisible by 512 (real SNES dumps
   always are, being built from fixed-size banks) and is roughly a third of
   the ~1.5 MB the real cart is. **Root cause: a truncated/corrupt ROM file on
   the user's headset**, not an app bug. Confirmed by the user after
   re-acquiring a working dump.
4. **Takeaway for next time:** when a headset "black screen" report comes in,
   pull `boot-attempt`'s `bytes` field and sanity-check it against a known
   ROM size *before* chasing wiring/code theories — it's a 30-second check
   that would have shortened this investigation considerably. Fetching logs:
   `curl https://dionysus.dk/logs.json?tail=0 -o out.json` (all sessions, no
   truncation — large; add `?session=<id>` once you know which one), then
   filter `entries` by `sessionId` and sort by `ts`.
5. **Follow-up: fixed the real-but-irrelevant arming-leak bug from step 1.**
   The user opted for a "disarm" option over leaving it or a stricter
   meta-only gate (which would have broken externally-picked ROMs — they have
   no per-title metadata to declare `lightgun`/`mouse` in the first place).
   Added `disarmLightGunAndReload()`/`disarmMouseAndReload()`,
   `window.__disarmGun()`/`window.__disarmMouse()`, and "Disarm Gun"/"Disarm
   Mouse" main-menu buttons (`src/main.js`) — clears the sticky armed flag and
   drops the device from the *currently running* game only if that game's own
   meta doesn't declare it; a curated gun/mouse title keeps its device
   regardless, since disarming only changes what the *next* load inherits.
   Verified against the real boot path (`window.__loadCartridge`, not just
   `__pickLocalRom`) with a dedicated `npx vite` dev server on a scratch port
   (port 5173 turned out to be serving an unrelated project — check before
   assuming a "running dev server" is this repo): `tmp/verify-disarm.mjs`
   (gun, 15/15 assertions incl. reproducing the leak, the fix, and the
   curated-title preservation) and `tmp/verify-disarm-mouse.mjs` (mouse, 9/9).

## Gotchas already hit (so you don't re-hit them)

- **Remote log viewer Apache config:** ProxyPass matches on whole path segments —
  `/logs` does NOT cover `/logs.json`. The `deploy/log-proxy.conf` snippet now has
  an explicit `/logs.json` rule placed BEFORE the `/logs` rule. If you re-provision
  the proxy, keep that order.
- **Logger flush abort in the headless harness:** `scripts/debug.js` (`npm run debug`)
  reclassifies a `net::ERR_ABORTED` on a `/log` POST as an expected probe. The
  logger's keepalive flush is in-flight when the page tears down; it was flipping
  the verdict to FAIL. Don't remove that reclassification.
- **Room-server passwordless sudo:** if `sudo systemctl restart libretrowebxr-room`
  requires a password on the deploy box, the room server update step will stall.
  Add a `NOPASSWD` sudoers entry for that one command.
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
- **Don't assume a dev server on a "standard" port is THIS repo.** Other
  projects' `vite` instances can be sitting on 5173/5183/etc. on the same
  machine (found 2026-07-11: port 5173 was serving an unrelated "Greybox"
  project). Check the page `<title>` (or just `curl` the HTML) before trusting
  a Puppeteer script's target port; when in doubt, start your own
  `npx vite --port <scratch-port> --strictPort` and point scripts at that.
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
`libretrowebxr-deploy` (deploy method); `libretrowebxr-concurrent-dev` (this
repo gets concurrent edits/WIP from other agent sessions, often in sibling
worktrees under `.claude/worktrees/` or `../LibretroWebXR-wt-*` — re-check git
state before assuming the roadmap position, and never commit files you didn't
change); and `commit-push-policy` (commit when a feature lands, push once
verified, but confirm before an outward-facing `npm run deploy` — this is why
the extensive work above is pushed but not yet live). Newer, feature-specific
memories: `lightgun-derisk`/`nes-zapper-light-stuck`/`snes-justifier-twogun-limit`/
`gun-cable-peripheral` (light guns); `mouse-peripheral-amiga-dos-epic` (mouse +
the DOS de-risk); `widget-join-and-parallel-features` (the MP full-sync fix);
`lightgun-local-test-wall` (gitignored commercial gun-ROM sideload for local
testing only, never committed).
