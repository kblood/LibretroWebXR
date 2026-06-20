# Light-gun support (NES Zapper, Super Scope, Light Phaser, GunCon…)

Status: **G1 COMPLETE** (NES, 2026-06-20) — the full VR gun loop works end-to-end in
the browser: pick up a grabbable light-gun prop, aim it at the TV, pull the trigger,
and the in-game light-gun registers the hit. Built on the proven core fix (patched
`rwebinput`, `docs/patches/rwebinput-lightgun.diff`). Verified headlessly through the
real scene + load paths (screenshots: aim→blue, fire→green, Zapper crosshair tracks).
Remaining: SMS core-switch handling, fceumm boot crash, 2-gun co-op, headset
validation, deploy reproducibility of the patched cores. Started 2026-06-20.

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

**Co-op caveat:** `rwebinput` has a single mouse, so the patch feeds the *same*
position to every port that queries LIGHTGUN. Two guns on the **same** console (e.g.
2-player Duck Hunt) would share one aim point — needs per-port pointer state in
`rwebinput` (future patch). Two guns on **different** consoles are fine (separate
clients/canvases/mice).

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

**Follow-ups:** SMS needs a default-core switch (picodrive → genesis_plus_gx) in the
load path and its Light Phaser sits on port 0 (conflicts with the pad); 2-gun co-op
needs per-port pointer state in `rwebinput`; headset validation pending.

`EmulatorClient` retains the de-risk debug hooks (`__forceInputDevices`,
`__forceCoreOptions`, `__forceRemapName`, `__forceCfgExtra`, `__forceExtraFiles`); the
gun integration adds `__lightGun`, `__lightGunMgr`, `__gunTargets`, `__gunFire`,
`__armGun`, `__gunArmedState` for headless verification.
