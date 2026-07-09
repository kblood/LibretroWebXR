# Light-gun support (NES Zapper, Super Scope, Light Phaser, GunCon…)

Status: **Feature-complete across NES/SNES/Genesis/SMS, deployed** (last landed
2026-06-22). The full VR gun loop works end-to-end in the browser: pick up a
grabbable light-gun prop — now a first-class, cord-connected, net-synced
peripheral like the gamepad (commit `14fd173`) — aim it at the TV, pull the
trigger, and the in-game light-gun registers the hit. Built on the proven core
fix (patched `rwebinput`, `docs/patches/rwebinput-lightgun.diff`). Covers NES
Zapper, SNES Super Scope, SNES Justifier (2-gun co-op), Genesis Menacer, and SMS
Light Phaser — including simultaneous two-gun co-op (own port per gun) and
live core-switch reboot without a page reload. Verified headlessly through the
real scene + load paths and with real ROMs (see `docs/LIGHTGUN_SUPPORT.md`
verification scripts + `docs/HEADSET_LIGHTGUN_VALIDATION.md`). **Remaining:**
real-headset validation (aim feel, two-gun co-op on hardware) — see
`docs/HEADSET_LIGHTGUN_VALIDATION.md` for the plan.

---

## ✅ RESOLVED (2026-06-21): the NES Zapper works — the bug was GAME-SIDE, not the core

An earlier correction here claimed the patched nestopia core's photodiode light bit was
"stuck" (a core bug). **That was a misdiagnosis.** Reading the core's own source
(`NstInpZapper.cpp`, the ground truth) and re-testing exhaustively shows the **patched
nestopia core is correct** — the photodiode samples the pixel under the muzzle exactly
as real hardware does. The failure was in the **test ROM (and my authored game)**, two
game-side mistakes that compounded:

1. **vblank-only polling.** Both my ROM and the `nes-zapper-test` diagnostic spin-read
   `$4017` only in a short burst right after `ppu_wait_nmi` — i.e. during **vblank**,
   when the CRT beam is *not* drawing the picture. The photodiode only senses light
   during the brief window the beam scans the muzzle's pixel, so a vblank-only poll
   **never overlaps the visible scanout** and always reads "no light." A game MUST
   spin-read `$4017` **across the whole visible frame** (`POLL_READS=1500`, ~1.2 visible
   frames of read loop) so one read coincides with the beam crossing the target.
2. **inverted polarity.** The hit logic read D3 with the wrong sense. Real-HW polarity is
   **D3 = 0 → light detected** (on a bright pixel), **D3 = 1 → no light**. The fixed
   latch is `if (!(z & 0x08)) light = 1;`.

Both are fixed in `games/nes-gallery/main.c` (see the long comment at the top of that
file). This also means the broader light-gun feature works for any **correctly written**
Zapper ROM (Duck Hunt etc.) — nothing in the core or the `rwebinput` patch needs changing.

**Verified end-to-end (2026-06-21):**
- `tmp/verify-gallery.mjs` — jsnes logic, **7/7**: boot, title, trigger-start, target
  render, timeout→miss→game-over, restart (polarity-independent; jsnes Zapper polarity is
  inverted vs nestopia, so this proves LOGIC only).
- `tmp/verify-gallery-nestopia.mjs` — the **real shipped nestopia core**, driven through
  `EmulatorClient.sendLightgun()` (the VR gun prop's entry point), **5/5 on BOTH boot
  paths**: `BOOT=pick` (direct ROM + `__lightgunArmed`) and `BOOT=shelf` (the real
  manifest entry — `__loadCartridge` with `lightgun:true` arms the Zapper). On-target
  fire moves the SCORE counter only (Δscore≈1412, Δmiss=0); a dark-field shot moves the
  MISS counter only (Δscore=0) — i.e. **no false hits**, the polarity proof. (A 16px
  target near a screen edge can need an aim correction, like a real player — the harness
  retries a few nudged shots; a polarity bug would make *every* on-target shot miss.)

**Authored game status — SHIPPING (two guns).**
- NES Zapper: `games/nes-gallery/` + `scripts/make-nes-gallery.mjs` build the CC0 Zapper
  shooting gallery (`lwx-nes-gallery.nes`), **registered** as "LWX Zap Gallery"
  (`"lightgun": true, "core": "nestopia"`). The `probe-light.mjs` "stuck light" finding
  was an artifact of probing with the **buggy vblank-only test ROM**, not the core.
- SNES Super Scope: `games/snes-scope/` + `scripts/make-snes-scope.mjs` build the CC0
  Super Scope shooting gallery (`lwx-snes-scope.sfc`), **registered** as "LWX Scope Range"
  (`"lightgun": true, "core": "snes9x"`). This is the clean POSITION-based gun game — snes9x
  hands the ROM a stable latched coord (OPHCT/OPVCT), no beam-timing. Built with PVSnesLib's
  built-in `detectSuperScope()` / `scope_*` API + a shoot-the-centre calibration that
  cancels the core's +40 H offset. Verified 5/5 on the real snes9x core via
  `tmp/verify-scope-snes9x.mjs` (on-target → green flash, dark → red flash), both boot paths.
- NES Zapper, Operation-Wolf-style: `games/nes-opwolf/` + `scripts/make-nes-opwolf.mjs`
  build the CC0 "LWX Frontline Fury (NES)" on-rails wave shooter (`lwx-nes-opwolf.nes`),
  **registered** as "LWX Frontline Fury (NES)" (`"lightgun": true, "core": "nestopia"`).
  Design reference-port (not a code port) of our own `games/snes-opwolf/opwolf.c`, reworked
  for the Zapper's light-sense-only protocol (see the long header comment in
  `games/nes-opwolf/main.c`): the nestopia Zapper gives the ROM **no X/Y**, only a
  light-sensed bit and a trigger bit, so — same constraint `nes-gallery` already works
  within, and why real Duck Hunt needs a multi-frame flash-index scheme (out of scope
  here) — at most ONE object on screen can ever be "shootable" at a time. Several
  soldiers march toward the front line at once, but only the frontmost alive one renders
  in the bright sprite palette (senses light); the rest render in a dim palette that stays
  below the light threshold. Reload maps onto "trigger pulled while nothing is lit" — the
  Zapper-protocol-native equivalent of Operation Wolf's off-screen reload. 2-player reuses
  `nes-gallery`'s proven SHARE (alternating turns, one Zapper, hand off at stage-clear) /
  DUEL (P1 = port-1 pad A, P2 = the Zapper, both resolved against the same shared light
  read, `hit_claimed`-guarded so one light-sense event can't credit both players) pattern —
  true simultaneous two-Zapper aim is still not possible on NES (nestopia only ever reads
  the gun from port index 1). Verified 12/12 headless (jsnes, `tmp/verify-nes-opwolf.mjs`,
  polarity-independent: boot/title, mode-select via HUD signature, breach-driven game over,
  restart) and on the real nestopia core (`tmp/verify-nes-opwolf-nestopia.mjs`), both boot
  paths. **Found and fixed during verification:** the Zapper spin-read's scratch byte was
  declared as a *local* inside the 1500-iteration poll loop instead of a global static
  (unlike `nes-gallery`'s proven `static u8 z;`); cc65's default codegen makes local access
  far more expensive than a global's, and multiplied by 1500 reads/frame that alone blew
  the NTSC per-frame cycle budget several times over, making the whole game — including
  edge-triggered pad input like the SHARE/DUEL mode-select — silently run in slow motion.
  Moving `z` to a global fixed it; worth remembering for any future NES game that spin-reads
  a port in a tight loop. **Also found and fixed:** the bottom HUD row (HP/STAGE/MAG,
  originally row 27) never visibly updated on the real core, even though `kill_active()`/
  `reload()`/breaches correctly mutate the underlying values every time (confirmed via the
  green/red flash always firing correctly) — only the FIRST `NT_UPD_HORZ` chunk in a
  `set_vram_update()` buffer reliably reaches VRAM once a SECOND chunk in the same buffer
  targets a different nametable page (i.e. a different address high byte); row 1 (score,
  page `0x20`) and row 27 (HP/STAGE/MAG, page `0x23`) are different pages, so every chunk
  after the score chunk was silently dropped. `nes-gallery`'s own 2-chunk HUD never
  exercised this because both of its chunks target the same row/page. Fixed by moving HP/
  STAGE/MAG from row 27 to row 2 (still clear of enemy sprites, which spawn at row 3+) so
  every dynamic HUD chunk in the buffer shares page `0x20` with the score chunk — worth
  remembering for any future NES game whose HUD spans more than one on-screen row via a
  single `set_vram_update()` buffer.

## ✅ Proof the fix works (patched nestopia)

Built nestopia from master with `docs/patches/rwebinput-lightgun.diff` applied, ran
the Zapper test ROM headlessly and screenshotted the emulator canvas
(`tmp/derisk-shot.mjs`):
- Aim `sendLightgun(0.25,0.25)` → crosshair renders at **top-left**, backdrop **blue**
  (light sensed over the white box).
- Aim `sendLightgun(0.75,0.75)` → crosshair tracks to **bottom-right**.
- Aim centre + trigger → crosshair centred on the box, backdrop **green** = light +
  trigger (the ROM's "hit" state).

So the patched frontend feeds canvas-relative gun position + buttons to the in-game
light-gun. The earlier "flat" headless readings were a **harness bug** (the centroid
metric was swamped by the recoloured backdrop, and the single-pixel sampler was
unreliable) — the canvas screenshots are ground truth. Verify with screenshots, not
the centroid/single-pixel metrics.

## What the user wants

Gun games like Duck Hunt: aim a VR controller at a TV in the room and shoot.
EmuVR does this; we want the same in the browser.

## G0 de-risk findings (what works, what doesn't)

Built a CC0 NES "Zapper test" ROM (`games/nes-zapper-test/`, white box on black;
backdrop recolours from the `$4017` Zapper light/trigger bits) and drove it
headlessly. Reliable, multi-pronged results:

**Works:**
- Synthetic mouse events reach the core's emscripten DOM handlers.
- **Absolute mouse position reaches RetroArch's MENU** — with `menu_mouse_enable`,
  the RGUI menu pointer tracks our synthetic `mousemove` and clicks register.
- Keyboard input works (existing `sendInput` path; F1 opens the menu).
- The Zapper device **connects** on port 2 — but only via a per-core **remap file**,
  NOT the main cfg (this build ignores `input_libretro_device_p2` at boot). With the
  remap, the core's crosshair renders. The Zapper device id is **262** (from the
  verbose-log `SET_CONTROLLER_INFO`, not the subclass values one would guess).

**Does NOT work (the blocker):**
- The in-game light-gun **position is pinned at screen-centre**. The crosshair
  centroid never moves from centre regardless of absolute mouse position, movement
  deltas, or read-mode (`lightgun` / `mouse` / `pointer`). The test ROM's `$4017`
  reads no light/trigger.
- Root cause: RetroArch's **emscripten input driver (`rwebinput`) feeds the menu
  pointer but does NOT feed mouse position/buttons to an in-game light-gun (or mouse)
  device port.** It's a driver gap, not a config we're missing and not a core-choice
  problem.

Verified across **both** NES cores (nestopia + fceumm), all device ids, all read
modes, mouse + touch events, and mouse-grab on/off. Two independent indicators (the
test ROM's backdrop and the core's own crosshair) agree.

## Why EmuVR works and we don't (same cores!)

EmuVR's light-gun cores are the **same ones we already have**:

| System | Core | Gun |
|---|---|---|
| NES | `fceumm` | Zapper |
| SNES | `snes9x` | Super Scope |
| Master System / Genesis / Sega CD | `genesis_plus_gx` | Light Phaser / Menacer / Justifier |
| Arcade | `mame2003_plus`, `fbneo` | various |
| PlayStation | `swanstation` | GunCon |
| Dreamcast | `flycast` | light gun |

EmuVR's "Light Gun" toggle just flips the controller-port device to the gun for a
game folder — exactly what our remap file already does. EmuVR works because it runs
**native RetroArch on Windows**, whose input drivers (winraw/dinput) DO feed absolute
mouse position into the in-game light-gun device. We run those same cores compiled to
**WebAssembly under emscripten**, where `rwebinput` is the gap. So the differentiator
is the **runtime, not the core**.

Sources: EmuVR wiki *Light Guns*; Road to VR *EmuVR Light Gun update*; libretro/
RetroArch lightgun docs.

## The fix: rebuild the cores with light-gun input wired into `rwebinput`

The prebuilt cores we ship come from the libretro emscripten buildbot. The frontend
input driver (`rwebinput`) is statically linked into each core's `.wasm`, so the fix
is to **rebuild each core against a RetroArch emscripten frontend whose `rwebinput`
reports mouse abs position + buttons to game-port lightgun/mouse devices.**

Two possibilities the rebuild resolves:
1. **Current RetroArch master already supports it** → rebuilding from master fixes it,
   no patch. (The prebuilt cores may simply be old.)
2. **It still doesn't** → patch `input/drivers/rwebinput.c` (and the lightgun mapping
   in `input/input_driver.c`) so a game light-gun reads the canvas-relative pointer.

The lead build (fceumm) determines which, and produces the patch if needed. The patch
diff is saved to `docs/patches/` for reuse + review.

**RESOLVED 2026-06-20 — it's possibility #2 (patch required).** A clean
nestopia core built from current master (git `b0fd87d`, correct module shape) was
swapped into `public/cores/` and run through the harness: the crosshair stayed pinned
at centre (64,65 of 128) and the Zapper test ROM's `$4017` backdrop never changed
across all three read modes (`lightgun`/`mouse`/`pointer`). So master `rwebinput`
still does not feed game-port light-gun position — a source patch is mandatory. The
fceumm lead build produces it.

### Build recipe (per core)

Same WSL2 + emsdk 3.1.46 toolchain as [AMIGA_CORE_BUILD.md](AMIGA_CORE_BUILD.md).
Each core builds in its own folder so they can run in parallel (32 cores / 21 GB free).

```bash
source ~/emsdk/emsdk_env.sh                       # emcc 3.1.46
mkdir -p ~/lightgun-build/<core> && cd ~/lightgun-build/<core>
git clone --depth 1 https://github.com/libretro/<core-repo>.git
git clone --depth 1 https://github.com/libretro/RetroArch.git
# (lead core patches RetroArch/input/drivers/rwebinput.c here, if needed)

# 1. core -> LLVM bitcode
cd ~/lightgun-build/<core>/<core-repo>
emmake make -f Makefile platform=emscripten -j8       # -> <core>_libretro_emscripten.bc

# 2. link against the patched RetroArch emscripten frontend
cp <core>_libretro_emscripten.bc ../RetroArch/libretro_emscripten.bc
cd ../RetroArch
emmake make -f Makefile.emscripten LIBRETRO=<core> HAVE_THREADS=0 -j8   # -> <core>_libretro.js + .wasm

# 3. stage for the project (cores are gitignored — never committed; rehosted by deploy)
cp <core>_libretro.js <core>_libretro.wasm /mnt/c/LLM/LibretroWebXR/tmp/lightgun-cores/
```

Core repos: `libretro/libretro-fceumm`, `libretro/nestopia`,
`libretro/Genesis-Plus-GX`, `libretro/snes9x`.

### Verifying a rebuilt core

Drop the new `<core>_libretro.*` into `public/cores/`, then run the headless harness
against a local dev server (the de-risk hooks are in `EmulatorClient` /
`__pickLocalRom`):
- `tmp/derisk-sendgun.mjs` — crosshair centroid must **track** `sendLightgun(u,v)`.
- `tmp/derisk-modes.mjs` — the Zapper test ROM backdrop must go blue (light) →
  green (light+trigger) → red (trigger on dark).

A core passes when the crosshair moves with the gun and the ROM's `$4017` reflects
light + trigger.

## Core rebuild results (2026-06-20)

All built from upstream master with the patch, in their own warm WSL2 trees
(`~/lightgun-build/<core>/`), staged to `tmp/lightgun-cores/`, and runtime-verified
headlessly. Patched cores are live in `public/cores/` (prod backed up as `.bak`;
cores are gitignored).

| Core | System / gun | Result |
|---|---|---|
| `nestopia` | NES Zapper | ✅ **fully proven** — aim tracks, light + trigger register (screenshots) |
| `genesis_plus_gx` | SMS Light Phaser / Genesis Menacer-Justifier | ✅ patched, boots clean, renders |
| `snes9x` | SNES Super Scope | ✅ patched, boots clean, renders |
| `fceumm` | NES Zapper (alt) | ⚠️ **deferred** — see below |

**fceumm deferred.** A fresh master fceumm build crashes at boot
(`callMain threw: table index is out of bounds`, a wasm indirect-call fault). Proven
**not** the patch: the *unpatched* master fceumm crashes identically, and the patched
object adds zero function-table entries. It's a pre-existing regression in fceumm
linked against current RetroArch master (rev `2393571`) under emscripten 3.1.46 —
crashes the same against an older (May-18) frontend too, so it's fceumm-core-specific,
not a frontend revision or a missing linker flag. **nestopia covers NES light-gun**
(Duck Hunt etc.), so fceumm is redundant for the gun feature; the working prebuilt
buildbot fceumm stays in `public/cores/` for non-gun NES use. To revive fceumm later:
bisect RetroArch master `86128a2a`..`2393571` for the fceumm boot regression (deepened
history is local in `~/lightgun-build/fceumm/RetroArch`), or load the staged
`tmp/lightgun-cores/fceumm_libretro.assertions.*` build to get the exact faulting
symbol.

### Deploy / reproducibility note

The patched cores in `public/cores/` are **local builds** and are gitignored.
`npm run deploy` runs `npm run fetch-cores` first, which used to **overwrite** them with
stock (no-lightgun) cores and silently break gun games in production.

**Now guarded.** A local marker `public/cores/PATCHED.json` lists the patched cores
(`nestopia` / `snes9x` / `genesis_plus_gx`); `scripts/fetch-cores.mjs` reads it and
**skips** those cores when a build is present here (prints `⚠ keeping PATCHED …`), so
deploy preserves them. The marker is gitignored with the cores, so a fresh checkout
(no marker, no build) just fetches stock — nothing to protect. To intentionally pull a
gun core back to stock: `node scripts/fetch-cores.mjs --refresh-patched` (or drop its
entry from `PATCHED.json`).

To rebuild the patched cores from scratch (e.g. on a new machine): apply
`docs/patches/rwebinput-lightgun.diff` and relink via the recipe above — the warm WSL2
build trees (`~/lightgun-build/<core>/`) make it a one-command relink — then recreate
`PATCHED.json`. A future improvement is hosting the patched `*_libretro.{js,wasm}` where
deploy fetches them so no local build is needed.

### Per-system gun device ids (for systems.js metadata) — VERIFIED FROM SOURCE

Read from each core's libretro source (2026-06-20). `RETRO_DEVICE_SUBCLASS(base,id)`
expands to `((id+1)<<8)|base`; `RETRO_DEVICE_LIGHTGUN=4`, `RETRO_DEVICE_POINTER=6`.

| System | Core | Device (source const) | id | Port (0-based) | Read-path core option |
|---|---|---|---|---|---|
| NES | nestopia | `ZAPPER = SUBCLASS(POINTER,0)` | **262** | **1** (player 2 — hardcoded: core polls `input_state_cb(1,…)`) | `nestopia_zapper_device="lightgun"` **(required)** |
| SNES | snes9x | `LIGHTGUN_SUPER_SCOPE = (1<<8)|LIGHTGUN` | **260** | 1 (player 2) | none — reads native `RETRO_DEVICE_LIGHTGUN`; opt. `snes9x_superscope_crosshair="enabled"` |
| SMS | genesis_plus_gx | `PHASER = SUBCLASS(LIGHTGUN,0)` | **260** | 0 (player 1) | none — native `RETRO_DEVICE_LIGHTGUN` |
| Genesis | genesis_plus_gx | `MENACER = SUBCLASS(LIGHTGUN,1)` | **516** | 1 (player 2) | none — native `RETRO_DEVICE_LIGHTGUN` |

Also (source): snes9x Justifier=516 / Justifier2=772 / MACS Rifle=1028; genesis
Justifiers=772. All read SCREEN_X/Y + TRIGGER/AUX/OFFSCREEN, which the patch feeds.

**Co-op caveat — RESOLVED (2026-06-21):** the stock `rwebinput` has a single mouse,
so two guns on the **same** console would share one aim point. The **multiport patch**
(`docs/patches/rwebinput-lightgun-multiport.diff`) fixes this: it adds a per-PORT
pointer slot + the exported setter `rwebinput_set_lightgun(port,x,y,buttons)`, so the
frontend drives each gun's port independently. nestopia + snes9x are relinked with it.

### SNES Konami Justifier two-gun co-op — VERIFIED ON THE REAL CORE (2026-06-21)

Topology finding (read from `snes9x/libretro/libretro.cpp` + `controls.cpp`): although
the *physical* Justifier daisy-chains both guns on SNES port 2, **snes9x reads the two
guns from TWO DISTINCT libretro ports** at the `input_state_cb` boundary. The JUSTIFIER
device (516) seats on libretro **port 1** and is read via `input_state_cb(1, LIGHTGUN, …)`
→ `justifier.x[0]/y[0]` (gun A); JUSTIFIER_2 (772) seats on **port 2**, and the JUSTIFIER
poll — seeing `snes_devices[port+1]==772` — reads `input_state_cb(2, LIGHTGUN, …)` →
`justifier.x[1]/y[1]` (gun B). There is **no single-port strobe disambiguation at the
frontend boundary**, so the existing **per-PORT** multiport patch is exactly right — no
patch extension and **no snes9x rebuild** were needed. The `systems.js` `lightgun2`
config already maps gun A→port 1 (device 516) and gun B→port 2 (device 772).

Verified end-to-end on the **real patched snes9x core** (`tmp/verify-twogun-opwolf-snes9x.mjs`,
**9/9**): booting `lwx-snes-opwolf.sfc` with the Justifier (twoGun), the core's own
per-gun crosshairs (BLUE = justifier1/gun A from port 1, MAGENTA = justifier2/gun B from
port 2 — drawn straight from `justifier.x[0]/x[1]`) land at the two commanded aim points,
**swap** correctly when the aims swap (each follows its OWN port), and are **isolated**
(moving gun B leaves gun A put). Single-gun regressions still pass: Super Scope 5/5
(`verify-scope-snes9x`), NES gallery 5/5 (`verify-gallery-nestopia`), per-port mechanism
7/7 (`verify-twogun`), single-gun opwolf 5/5 (`verify-opwolf-snes9x`), `npm test` all green.

**Frontend wiring (in-app two guns):** `loadCartridge`/`__pickLocalRom` call
`lightgunLoadConfig(system, { twoGun })` when the game is `twoGun`-flagged on a
two-gun-capable system, seating both gun devices; `main.js` records the seated ports in
`_twoGunPorts` and `_assignGunPorts()` stamps `userData.gunPort` on each registered gun
in order (boot gun → port 1; a 2nd gun spawned via the Add menu / `addProp('lightgun')`
→ port 2). `LightGunMgr.portForGun` reads `userData.gunPort`, so each gun drives its own
per-port slot via `EmulatorClient.sendLightgun(u,v,t, port)`. Guns with no two-gun
context have no `gunPort` → the legacy single-gun DOM-mouse path, **100% unchanged**.

**Remaining (not blocking the multiport feature):** the `games/snes-opwolf` ROM's OWN raw
Justifier reader (`jf_*` in `opwolf.c`) still resolves one gun per frame (its OPHCT/OPVCT
read is gated by the SELECT strobe), so its *in-game* crosshairs/hit-scoring don't yet
show both guns simultaneously even though the core delivers both positions correctly. That
is a game-ROM fix in `opwolf.c`, independent of the frontend/core path proven above. Two
guns on **different** consoles remain fine (separate clients/canvases/mice).

## App-side work — G1, DONE (2026-06-20)

The full VR gun loop is wired and headless-verified through the real scene + load
paths (not test fakes). Pieces:

- **VR gun prop** — `src/LightGun.js` `createLightGun()`: a grabbable orange/grey
  pistol (barrel along local −Z) with `getAimRay()`, trigger/muzzle-flash feedback,
  and a cord anchor. Instantiated in `main.js` scene init, added to `GrabMgr` as a
  grabbable, rests on the desk left of the console.
- **Aim → input** — `src/LightGunMgr.js`: each frame, for every controller holding
  the gun, raycast the barrel ray against the rack TV screen meshes, convert the hit
  to canvas `u,v` (replicating the CRT shader's barrel `curve()` + the texture
  `flipY`; pure `surfaceUvToCanvasUv()` is unit-tested), and call the source console's
  `EmulatorClient.sendLightgun(u, v, trigger)`. Off-screen / wrong-console hit →
  `sendLightgun(-1,-1,trigger)` = a reload shot. Registered as a tick callback.
- **Per-system device metadata** — `systems.js` `SYSTEMS[*].lightgun` +
  `lightgunForSystem` / `isLightgunCapable` / `lightgunLoadConfig`; the gun core may
  differ from the cart core (SMS → genesis_plus_gx). `loadCartridge` / `__pickLocalRom`
  apply the gun core + per-port device + core options + remap when armed.
- **Device connect** — `EmulatorClient` writes the per-core remap `.rmp`
  (`input_libretro_device_pN`) + gun mouse binds; the patched core reads the canvas
  pointer. The device attaches only at a fresh core boot.
- **Arm on grab** — picking up the gun fires `GrabMgr.onObjectGrabbed` →
  `armLightGunAndReload()`. Because a libretro peripheral attaches only at boot and the
  **primary console owns `#canvas`** (its runtime can't be hot-swapped — see
  `swapConsoleCore`), arming bridges the SAME game across a **page reload** with the
  gun flagged on (`PENDING_KEY` meta `lightgun:true` + a persisted session flag
  `LIGHTGUN_ARM_KEY`), exactly like a cross-system swap. `resumePendingLoad` re-boots
  it with the Zapper connected. Arming on intent (grab) — not always — keeps port 2 a
  normal pad for 2-player games until the gun is actually picked up.

**Known characteristic:** the arm reload restarts the page (and would end an active
immersive XR session on a headset), same as the existing cross-system swap. A future
improvement could give the primary console a live core reboot (fresh runtime + re-point
tv0, à la `swapConsoleCore`) to arm without a page reload.

**SMS core switch + port policy (handled).** SMS detects as `picodrive` but its Light
Phaser is provided by `genesis_plus_gx`, so the gun config switches the boot core — now
correct in BOTH load paths (`loadCartridge` always used the gun core; `__pickLocalRom`
was fixed to boot `CORES[gun.core]` instead of the detected cart core). The Phaser sits
on controller **port 0 (player 1)**, where a gamepad normally lives. Deliberate policy:
a light gun occupies a controller port and **supersedes the pad on that port while
armed** (matching real hardware — the gun plugs into a controller socket); the arm
status says so (`…on player 1 (replaces that gamepad)`). NES/SNES/MD guns sit on port 1
(player 2), so their pads are untouched. Breadth verified end-to-end on SNES (Super
Scope — crosshair renders), Genesis (Menacer) and SMS (Light Phaser).

**Telemetry.** `LightGunMgr` takes an optional `log(name, fields)` sink and emits
`lightgun-aim` (throttled ~4 Hz + on hit/miss flip) and `lightgun-fire` (trigger rising
edge); `main.js` emits `lightgun-grab` and `lightgun-arm-reload`. These ship to the
remote log so a headset session is diagnosable without seeing the screen — see
`docs/HEADSET_LIGHTGUN_VALIDATION.md` for the full Quest validation plan.

**Follow-ups:** live primary-console reboot to arm without the page reload (the only way
to keep an immersive XR session alive — blocked on de-singletonizing the primary
`client`/`#canvas`, since a libretro core permanently holds the GL context on its
canvas); 2-gun co-op needs per-port pointer state in `rwebinput`; headset validation
pending (checklist ready).

`EmulatorClient` retains the de-risk debug hooks (`__forceInputDevices`,
`__forceCoreOptions`, `__forceRemapName`, `__forceCfgExtra`, `__forceExtraFiles`); the
gun integration adds `__lightGun`, `__lightGunMgr`, `__gunTargets`, `__gunFire`,
`__armGun`, `__gunArmedState` for headless verification.
