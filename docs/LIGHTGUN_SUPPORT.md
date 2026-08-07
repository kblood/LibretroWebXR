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
- PS2 GunCon2: `games/ps2-guncon-range/` + `scripts/make-ps2-guncon-range.mjs` build the
  CC0 "LWX GunCon Range" homebrew ELF, **registered** as "LWX GunCon Range"
  (`"lightgun": true, "core": "play"`). First PS2 authored game — built with the PS2SDK
  via the `ps2dev/ps2dev` Docker toolchain (see `docs/PS2_CORE_BUILD.md`), not a 2D
  6502/65816 target. A target box spawns at a random position on a dark field; the
  crosshair tracks the GunCon2 directly (no calibration step — GunCon2 position already
  arrives in screen-output pixel space). On-target trigger pull = green flash + score++
  + respawn; off-target = red flash + misses++; 5 misses briefly flashes game-over then
  auto-resets, no menu. Reuses the real USB LDD GunCon2 driver stack proven in
  `[[ps2-guncon2-real-driver-verified]]` (SIF RPC bridge to an IOP module) verbatim — the
  game logic only ever talks to the shared `guncon2_state_t` struct, has no idea whether
  input came from real USB hardware or the libretro core's own emulated GunCon2 device.
  `score`/`misses`/`connected` are kept in a fixed EE-RAM probe struct for headless
  verification via `retro_get_memory_data`, same technique as
  `tmp/verify-ps2-guncon2-real.mjs`.

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
(`nestopia` / `snes9x` / `genesis_plus_gx`, plus the custom-built `mednafen_psx_jit`
PSX core as of 2026-07-27 — see docs/PSX_CORE_BUILD.md's "Light-gun (GunCon) support"
section); `scripts/fetch-cores.mjs` reads it and **skips** those cores when a complete
build is present here (prints `⚠ keeping PATCHED …`), so deploy preserves them. The
marker is gitignored with the cores, so a fresh checkout (no marker, no build) just
fetches stock — nothing to protect. To intentionally pull a gun core back to stock:
`node scripts/fetch-cores.mjs --refresh-patched` (or drop its entry from
`PATCHED.json`).

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

**`genesis_plus_gx` shipped STALE for five weeks — fixed 2026-07-29.** The core *was*
relinked with the multiport patch on 2026-06-20, but only in the WSL build tree; the
artifacts were never copied into `public/cores/`. The shipped pair was the 08:49 build
(js 261 224 B) while `~/lightgun-build/genesis/RetroArch/` held the 16:15 build
(js 261 548 B). Word-diffing the two **glue** files showed the only change there is the
two added exports (`_rwebinput_set_lightgun` / `_rwebinput_clear_lightgun`) plus the
knock-on renumbering of the `wasmExports` keys after them.
`grep -c rwebinput_set_lightgun public/cores/<core>_libretro.js` is the check: 1 on a
multiport core, 0 on a stale/stock one. It read **0** for `genesis_plus_gx` even though
`PATCHED.json` already listed it, so the marker was protecting a build that did not
have the patch it claimed.

**Correction (2026-07-29): "the only change is the two exports" was true of the `.js`,
false of the `.wasm`.** The shipped `genesis_plus_gx.wasm` is not just a relink of the
same sources — it is a **newer upstream snapshot**: core v1.7.4 `f33876c` vs `162c343`,
built Jun 20 vs Jun 1 2026, +18 functions and ~+11 KB of data. So this was a core version
bump *as well as* the exports, and the earlier wording understated it. It is not
unexplained drift, though: it aligns the core with the Jun 20 nestopia/snes9x batch, and
those two show the **same signature** — wasm ~+29 KB (nestopia +29 038 B, snes9x
+29 594 B) against a js delta of exactly +324 B, the same +324 B seen here. A ~29 KB
wasm / +324 B js pair is what a multiport relink from that batch looks like; treat a
*different* shape as the thing worth investigating.

**No behaviour changed by shipping it**, because SMS/Genesis define no `lightgun2`
block, so `_twoGunPorts` is empty, `libretroGunPortFor()` returns `null` on its
empty-`twoGunPorts` guard (`systems.js:659`), and `EmulatorClient.sendLightgun()` takes the
DOM-mouse branch regardless of what the core exports — its multiport branch is gated on
`port != null && this._resolveWebgun()` (`EmulatorClient.js:396`). This is purely the
prerequisite being put in place: a Menacer/Phaser `lightgun2` block is now possible
without a rebuild. **Lesson: `PATCHED.json` records intent, not fact — verify the
artifact with the grep above, not the marker.**

**The same grep found the inverse gap: `play` and `mupen64plus_next` read 1 but were
never listed.** Both PS2 and N64 carry the multiport patch, yet neither appeared in
`PATCHED.json`'s `cores`, and `fetch-cores.mjs`'s `CUSTOM_CORES` loop skips a core only
when it is **both** listed and complete on disk — the `isProtected(core) && hasCompleteBuild`
guard in the `CUSTOM_CORES` loop (`fetch-cores.mjs:222`), where `hasCompleteBuild` requires
`.js`, `.wasm` *and* `.worker.js`
— a listed-but-partial build is deliberately repaired from source rather than protected).
An **unlisted** core is never skipped at all, so any
`fetch-cores --from <dir>` / `$LIBRETRO_CORES_DIR` run against a machine holding stock
builds would have copied over them without a word. (A bare `npm run fetch-cores`, as
`deploy.ps1:88` runs it, passes no `--from` — but `candidateDirs()`
(`fetch-cores.mjs:100-106`) *also* reads `$LIBRETRO_CORES_DIR`, so a bare run **does**
copy from that dir whenever the variable is set. That it has never fired here is a
property of this machine's current environment, not a guarantee of the command; assume
any `fetch-cores` invocation can clobber.) Both are listed now. Cost of listing: a
*legitimate* PS2/N64 rebuild copied in
via `--from` is now skipped too, so pulling one in needs `--refresh-patched` or a
temporary de-list.

**`cores` vs `patchLevels` — protection list vs fact record (2026-07-29).**
`PATCHED.json` now carries both, and they are deliberately allowed to differ. `cores` is
what `fetch-cores` must not overwrite; `patchLevels` maps each core to the patches its
build *actually* contains (`["base"]` or `["base","multiport"]`), verified by the grep,
not assumed. `mednafen_psx_jit` is the case that forced the split: it is a custom core
(`docs/PSX_CORE_BUILD.md`) so it must be protected, but its shipped artifact grepped **0**
while every doc and flag said its gun worked. It was first recorded here as `["base"]`,
on the strength of that grep — right about the number, wrong about the reason. The real
reason was worse than a base-only build (see "The PSX clobber" below): the artifact carried
**neither** patch, because a backup restore had clobbered the gun-enabled build. It is
`["base","multiport"]` as of 2026-07-29, the patched build having been restored and the
grep now reading 1. Note what the marker does while a protected core is wrong: it is
protected, complete on disk, and (then) unpatched, so a `--from` fetch skips rather than
repairs it — de-list or `--refresh-patched` when a repair has to arrive that way.

**`scripts/test-patched-cores.mjs` checks `PATCHED.json` against the artifacts, and is in
`npm test`** (also standalone: `npm run test:patched-cores`). It asserts that `cores` and
`patchLevels` cover the same cores in both directions, that every multiport-claimed core
exports both `rwebinput_set_lightgun` and `rwebinput_clear_lightgun` in its `.js` glue,
and — as a tripwire — that a core recorded as base-only exports neither. That last
assertion is meant to go red: the day a base-only core is relinked, the test fails until
someone updates `patchLevels` (and, for `mednafen_psx_jit`, decides separately whether
`SYSTEMS.psx.lightgun2.broken` can follow), so the record cannot drift back out of sync.

A hardening pass on 2026-07-29 closed five ways the first version of that script could
exit 0 while checking nothing (each reproduced against a throwaway copy of
`public/cores/`, not theorised — see its own header). Now enforced, and confirmed by
reading the script after the fix landed: **both** export names are asserted on **both**
branches, so a half-applied relink exporting only one is red; a listed core with a
`.wasm` but no `.js` **FAILS** rather than skipping (it is protected, unrepairable by any
`--from` fetch, and 404s the loader at runtime — only a core absent *entirely* is still a
skip); a falsy/non-object marker fails instead of falling through; a **missing** marker
with built cores beside it fails, because that is the state in which nothing is protected
at all; and every `patchLevels` value must be exactly `base` or `multiport`, since a typo
like `multiPort` used to route a patched core into the base-only tripwire and assert the
opposite of the truth. Read the script rather than this paragraph if the exact assertions
matter. Independently of the script: only the `.js` glue is a valid
tell — the `.wasm` minifies its export names and the `.worker.js` is pthread bootstrap,
byte-identical between patched and stock builds; both read 0 for *every* core.

### The PSX clobber — a verified, shipping gun feature silently regressed (2026-07-27 → restored 2026-07-29)

The headline lesson of this whole sweep, and worse than the stale `genesis_plus_gx` case
above, because here the feature had been **verified working and was already shipping**.
Timeline, all on 2026-07-27:

| Time | Event |
|---|---|
| 09:44 | A pre-gun-work backup of the PSX core is taken (`tmp/psx-core-backup-20260721/` — the `20260721` in the name is the build it captures, not the day it was made). |
| ~11:45 | The gun-patched core is verified **13/13** by `npm run probe:psx-guncon` — real Time Crisis calibration screen advancing on a shot (`docs/PSX_CORE_BUILD.md`). |
| 12:17 | The patched core is rebuilt in WSL; `SYSTEMS.psx.lightgun.broken` is `false`. |
| 12:36 | `public/cores/` is overwritten from the **09:44 backup**, silently reverting gun support — most likely collateral damage from rolling back a Lightrec/GL experiment. |
| +2 days | (2026-07-29) Found and restored from the WSL build dir (`scripts/cores/psx/core-build/dist`) — same 12:17 build, byte-verified against its own `.build.json` manifest. |

For two days the shipped `mednafen_psx_jit` carried **neither** the base nor the multiport
gun patch, while `SYSTEMS.psx.lightgun.broken` said `false`, `PATCHED.json` protected it,
this document described a 13/13 pass, and `npm test` was green. Nothing was lying on
purpose — every record was written when it was true, and the *artifact* moved underneath
them. The two builds pin **identical** upstream commits (RetroArch `45246ce8`, Beetle
`d6caed07`, Play--CodeGen `a5009f7d`, Play--Framework `587f2789`, emsdk 3.1.46), so this
was a straight regression, not a divergent experiment someone chose to ship.

Why nothing caught it: `public/cores/` is **gitignored**, so the overwrite produced no
`git status` entry, no diff and no review; no test compared the bytes on disk against
anything; and the probe's evidence (`tmp/psx-guncon-*.png`) is *also* gitignored and was
left over from the passing run, so it still looked right.

**The two checks that catch this**, both cheap enough to run before trusting any gun
claim about a core:

```sh
# 1. Does the shipped GLUE actually export the multiport setters?
grep -c rwebinput_set_lightgun   public/cores/mednafen_psx_jit_libretro.js
grep -c rwebinput_clear_lightgun public/cores/mednafen_psx_jit_libretro.js
# 1 on BOTH = multiport. 0 on both = stock/stale/clobbered. One of each = a
# half-applied patch, equally broken. (.js only — .wasm minifies its export
# names and .worker.js is pthread glue, so both read 0 for every core.)

# 2. Is the artifact on disk the BUILD you think it is?
sha256sum public/cores/mednafen_psx_jit_libretro.{js,wasm,worker.js}
#   compare against (a) the build dir it was copied from, and (b) the per-file
#   sha256s recorded in the adjacent mednafen_psx_jit_libretro.build.json manifest.
#   A manifest that disagrees with the binaries beside it is the tell that the
#   files were swapped from elsewhere.
```

Check 1 is now automated for every listed core by `scripts/test-patched-cores.mjs` in
`npm test`. Check 2 is not automated — a manifest/binary sha256 comparison would be the
obvious next tripwire. Full PSX-side writeup, including the rebuild recipe that must not
be lost again: `docs/PSX_CORE_BUILD.md` ("Light-gun (GunCon) support").

### PSX two-gun GunCon co-op — UN-GATED (2026-07-29)

`SYSTEMS.psx.lightgun2` (GunCon `260` on ports 0 *and* 1 — one gun per native port,
unlike the SNES Justifier's two device ids on one chained peripheral) carried
`broken: true` from commit `f98e549`. The stated blocker was the core artifact missing
the per-port `rwebinput_set_lightgun` export. That was real but **only half of it**, and
the other half would have survived any number of core rebuilds:

> PSX is this app's **only worker-execution gun system** (`CORES.mednafen_psx_hw.execution
> = 'worker'`). The multiport call site lived *exclusively* in the main-thread
> `EmulatorClient.sendLightgun` — the path the SNES Justifier rides and PSX never touches.
> `EmulatorWorkerRuntime.forwardLightgun()` had **no multiport branch at all**: it used
> `port` purely as a `gunDownByPort` trigger-edge key and pushed every aim through the
> shared canvas `mousemove`. Two GunCons really would have read one pointer — the exact
> failure the gate warned about, for app-side reasons nobody had written down.

Fixed by adding the worker twin of `EmulatorClient._resolveWebgun` (`resolveWebgun()` +
the multiport branch in `forwardLightgun`, coordinates derived from the same
`getBoundingClientRect()` the DOM path uses so both land in one coordinate space). The
worker now also reports a `gun` block in its metrics (`multiport` tri-state, the seated
`devices`, and the last aim per port tagged `multiport`/`dom`), which makes "did two guns
get two aims?" directly observable instead of inferred.

**Verified — `npm run probe:psx-twogun`, 23/23**, real core, real commercial disc (Time
Crisis), booted through the real cartridge-insert path with `twoGun: true` and **no
`window.__allowBrokenLightgun` override**, so the run takes the same flag-free path a real
boot takes. (The probe set that flag while the gate was still up; with it set the run was
bit-identical either way — it threads into *both* `_twoGunActiveFor` and
`lightgunLoadConfig`'s `allowBroken` — so it could never have caught a re-gating. It now
runs without it and asserts `isTwoGunCapable('psx') === true` outright, which is what makes
it a regression guard on the flip rather than a demo of the mechanism.) Four independent
layers, each falsifying the shared-pointer mode:

| Layer | Evidence |
|---|---|
| Seating | worker wrote `inputDevices {1:260, 2:260}` into the RA cfg + remap |
| Routing | both ports `path='multiport'`, `gun.multiport=true`, distinct coords `(77,246)` vs `(435,246)` |
| Rendering | Beetle PSX drew **two crosshairs at once in its per-port colours** — port 0 red `[247,62,32]`, port 1 blue `[56,158,223]` — on one identical background; gun 1's stayed put while gun 2 moved (`tmp/psx-twogun-cursors-apart.png`) |
| Isolation | same shot, same point, differing **only** in `port`: gun 2 → `maxDiff=0`, gun 1 → `maxDiff=287` (the same signal `probe:psx-guncon`'s single-gun 14/14 control gives). A shared pointer would have registered both. |

Single-gun `probe:psx-guncon` re-run **14/14** and `probe:lightgun` 9/9 / `probe:ps2-guncon`
15/15 after the change — the proven single-gun path (which passes no `port`) is untouched.
(That single-gun probe's gating assertion was itself replaced on 2026-07-29 after a
negative control showed the old one passed *with no gun connected at all* — see
`docs/PSX_CORE_BUILD.md`, "The probe's gating assertion was replaced". The two-gun
Isolation row above was never affected: it is a within-run, same-instant comparison
differing only in `port`, which is precisely why it is immune to that failure mode.)

**Scope — do not over-quote this.** It is core-level plus per-port isolation against a real
game, **not** a played-through 2-player co-op session: nobody has yet driven Point Blank or
Lethal Enforcers I & II through their 2P menus with two guns. The mechanism is proven; that
play-through is the remaining confidence gap.

**Second scope limit — the VR routing hop is not covered for PSX.** The probe calls
`client.sendLightgun(u, v, trigger, port)` directly with an explicit port. The hop that
decides that port *in VR* — `LightGunMgr._portForGun(gun)` → `main.js`'s `portForGun`
callback → `libretroGunPortFor(_gunSlotIndex(gun, consoleId), _twoGunPortsForConsole(…))`
→ `sendLightgun` — is never exercised on PSX by anything. So "which physical gun becomes
port 0 vs port 1" is untested here; only "port 0 and port 1 are genuinely separate once
chosen" is. The one test that does drive that hop is SNES-only and *gitignored*:
`tmp/verify-twogun-opwolf-snes9x.mjs`, which is also the sole consumer of the
`window.__gunLibretroPort(cableId)` debug hook (`src/main.js`) — that hook has exactly one
caller in the whole tree, and it is a file that is not committed. Closing this properly
means a committed probe that spawns a second gun prop and reads its resolved port, on PSX.

One gap this exposed and closed: `main.js`'s `_twoGunActiveFor()` gated on
`isTwoGunCapable()` with no `allowBroken` escape, and every caller computes `twoGun` there
*before* `lightgunLoadConfig` ever sees `allowBroken`. So a gated two-gun device was
impossible for a probe to exercise — and therefore impossible to ever un-gate. It now
honours `window.__allowBrokenLightgun` like the single-gun path does. The escape stays for
the *next* gated two-gun device; `probe:psx-twogun` itself no longer uses it (above), and
with no registered `lightgun2` carrying `broken: true` any more, the gated behaviour is
covered by the temporary `__gatedtest` fixture in `scripts/test-systems.mjs`.

### Gun-probe evidence status — audited against negative controls (2026-07-29)

The repo-wide probe audit (see `DEBUGGING.md`, "Probes must be validated against a
negative control") re-tested the gun probes by **breaking the feature in a scratch
checkout and running the unmodified probe against it**. A green check is not evidence
until it has been seen going red.

| Probe | Verdict | Break that made it red |
|---|---|---|
| `probe:psx-guncon` | **SOUND** | worker `writeConfig()` forced `inputDevices: null` — no GunCon ever seats on a libretro port, while boot, registry gate and metrics all stay green. Control **14/14** (`off=0`, `on=287`); broken **13/14 twice** (`off=458 on=218`, `off=458 on=213`), telemetry `devices: null` vs `{1:260}`, aim-sweep collapsed to `max=0`. |
| `probe:psx-twogun` | **SOUND** | two independent breaks, both **18/23** — see below. |
| `probe:lightgun` (NES) | **NOT FALSIFIED** | never negative-controlled. |
| `probe:ps2-guncon` | **NOT FALSIFIED** | never negative-controlled. |

This was a *different* break from the one already on record for `probe:psx-guncon`
(which flipped `SYSTEMS.psx.lightgun.broken` back to `true` and trips the registry
assertion). This one leaves the registry assertion **green** and isolates the browser
half — the half that had to be shown capable of failing. Note what stayed green in the
broken run: `framesProduced=1431`, `errors=0`, `maxInputs=10 >= 10`. The metrics
assertions confirm `forwardLightgun` ran while the core saw nothing — exactly the
false-confidence case the headline assertion has to catch, and it caught it.

**Do not relax `offMax === 0` to a threshold.** The strict clause, not the `*4 + 10`
margin, is what rejected the `458 vs 218` no-gun run.

`probe:psx-twogun`'s two breaks show the gating families are **complementary, and the
23/23 tally is the evidence unit — not any single row**:

| Break | Result | What went red |
|---|---|---|
| Port collapse (`webgunSet(port,…)` → `webgunSet(0,…)`) | 18/23 | All three ISOLATION rows, **numbers exactly inverted** (gun 2 `maxDiff=287`, gun 1 `0`); only one crosshair on screen (`A=[224,248,128]`, bare background, `dist=0`). SEATING and ROUTING stayed green — they are structural reads that cannot see this break. |
| Re-gated (`systems.js` `broken: false` → `true`) | 18/23 | Registry assertion, SEATING (`inputDevices={1:260}` — one gun only), both port-discriminating RENDERING checks. **ISOLATION stayed green** (`0/287`): an unseated port-1 gun also produces no game reaction, so ISOLATION alone cannot detect "second gun never connected". SEATING is what catches that. |

Because this probe sets **no** `__allowBrokenLightgun`, it genuinely regression-guards
its own un-gating — unlike the pre-2026-07-29 single-gun probe.

**Bonus finding on a flagged sub-risk.** The two `[RENDERING]` cell checks
(`dArrive[cellB] > 0`, `dVacate[cellA] > 0`) are bare frame-to-frame diffs over 1.2 s and
would normally be suspect. Both negative controls independently measured **exactly 0** in
the cells where nothing moved — direct in-run proof that the Time Crisis calibration
screen is pixel-static, so those diffs are not satisfiable by animation or elapsed-time
drift *here*. **If this probe is ever repointed at a different disc or a non-static
screen, convert them to the within-run relative form before quoting the result.** The
per-port cursor-**colour** check carries the claim on its own and went red in both breaks.

**Still uncleared.** `probe:lightgun` (NES) and `probe:ps2-guncon` gate only on
`consoleArmed === true` plus "the call does not throw". That is app-side seating and JS
liveness — **neither proves gun state reaches the core**, and neither has been run against
a negative control. Cite them as "the gun call chain doesn't crash", not as "the Zapper /
GunCon2 works". Making `sendLightgun` a no-op is the obvious break to try; if those probes
stay green under it, they need the `probe:psx-guncon` two-arm treatment.

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

**Arming-leak bug, found 2026-07-11, fixed 2026-07-11 (disarm option):**
`window.__lightgunArmed` is deliberately sticky for the rest of the session (so
switching between multiple gun games doesn't require re-grabbing each time), but
`isLightgunCapable(systemId)` is a **system**-level flag (true for every SNES game,
since Super Scope exists on the platform), not a per-ROM one. Combined,
`(meta.lightgun || window.__lightgunArmed)` in `main.js` (both the `loadCartridge` and
`__pickLocalRom` boot paths) means once armed, **any** later boot of a gun-capable-
system ROM gets a gun wired onto a controller port — including a plain non-gun game on
that system. Confirmed via a real session log (a gun boot fired right before an SNES
RPG that has no gun support) and via code reading; **ruled out as the cause of a
specific black-screen report** by forcing the exact same mis-wiring onto a known-good
SNES ROM through the real boot path — it rendered fine (`tmp/verify-beholder-repro.mjs`),
so a wrong controller/gun device alone does not blank the video output.

Fixed with an explicit **disarm** affordance rather than dropping the sticky flag
entirely (a strict per-ROM-meta-only gate would break the legitimate externally-picked-
ROM case, which has no metadata to declare `lightgun: true` in the first place):
`disarmLightGunAndReload()` (`src/main.js`) clears `window.__lightgunArmed` + its
`sessionStorage` key and, only if the **currently running** game doesn't itself declare
`meta.lightgun` (i.e. it only has the gun because of the sticky flag), live-reboots it
without the device. A game that legitimately declares its own gun keeps it connected
regardless — disarming there only stops the flag from leaking onto the *next* unrelated
load. Exposed as `window.__disarmGun()` and as a "Disarm Gun" / "Gun: Off" button on the
main in-VR/desktop menu panel (mirrors the "Voice" toggle button pattern). Verified
end-to-end against the real boot path in `tmp/verify-disarm.mjs` (15/15 assertions: leak
reproduced, fixed for undeclared games, preserved for curated gun titles, flag stays
cleared for later loads even when disarmed mid-curated-game).

`EmulatorClient` retains the de-risk debug hooks (`__forceInputDevices`,
`__forceCoreOptions`, `__forceRemapName`, `__forceCfgExtra`, `__forceExtraFiles`); the
gun integration adds `__lightGun`, `__lightGunMgr`, `__gunTargets`, `__gunFire`,
`__armGun`, `__disarmGun`, `__gunArmedState` for headless verification.

**Prefer `__testApi.gun.fire()` over `window.__gunFire`** (2026-08-07). The
legacy hook is kept working — external tooling may still call it — but it
*returns* the string `'no-gun'` when no gun exists, so a probe that only checks
"the call didn't throw" stays green with the gun missing. The facade
(`docs/TEST_AUTOMATION.md`) throws instead, takes ergonomic `{u, v}` screen
coordinates as well as `{pos, look}` world vectors, and awaits a real app frame.
Both now share `_driveGunTick()`, which unions the fired gun into the held set
rather than substituting a one-gun list, so firing gun A can no longer make the
two-gun port-binding sweep release gun B's libretro port for that tick.
