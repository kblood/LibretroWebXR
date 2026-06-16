# Authoring CC0/MIT test games per system — research synthesis

**Why this exists.** LibretroWebXR ships **no commercial ROMs** (see `docs/LICENSING.md`).
To deploy with playable content for testing the VR frontend on every system, the
strategy is to **author our own tiny games** and release them CC0/MIT — exactly
like the existing `scripts/make-c64-demo.mjs` already does for the C64.

This folder holds one deep-dive per system (`<system>-game-creation.md`). This
README is the cross-system synthesis: how tractable each target is for an
AI-authored game, the recommended toolchain, install footprint, and a first-wave
build plan.

## The one pattern that makes this work

Every system's verdict converged on the **same technique**:

> **Write game *logic* in C (or BASIC) against a documented library; freeze the
> hardware boilerplate (boot/video-init/ROM-header/interrupt vectors) in a
> known-good template the AI never edits; then verify the built ROM in an
> emulator — never trust the first pass.**

LLMs fail at the hardware-init/timing/header code (fabricated registers, missed
vblank waits, malformed headers). They succeed at game loops, state machines,
collision, and scoring. The template + library split removes the failure surface.
A **headless screenshot verification step** (we already have a Puppeteer harness,
`scripts/debug.js`) is the highest-value addition for catching "compiles but
renders garbage" bugs that text review misses.

## Licensing — clean across the board

For **every** toolchain researched, the compiler's license (GPL/zlib/MIT/etc.)
does **not** taint the game we compile — output is ours to release CC0/MIT. The
only watch-outs are optional *linked* helpers: skip the bundled compression
decompressors (zx0/ZX7/aPLib) which carry attribution notes, and on GB use the
GBDK link path that keeps the GPL-linking-exception intact (default).

**Fallback ready-made homebrew was rejected almost everywhere.** "Free download",
scene "PD" tags, and `retrobrews/*` "approved for this project" notes are **not**
redistribution licenses, and many titles embed ripped audio/art. Authoring our
own is the only clean-provenance path — and it's cheap. (The few genuinely-clean
exceptions, e.g. Tobu Tobu Girl MIT+CC-BY on GB, Halo 2600 PD on Atari, still
carry attribution or trademark optics; prefer our own.)

## Tractability ranking (easiest → hardest for an AI to author)

| Tier | System | Recommended toolchain | Output | Install footprint | First game |
|---|---|---|---|---|---|
| **1 — trivial / zero-install** | **C64** | pure-Node BASIC tokenizer (have it) → cc65 C for action | `.prg` | none (Node) / zip | LWX Snake (BASIC), then Catch (cc65) |
| 1 | **VIC-20** | clone the C64 tokenizer (change load addr) | `.prg` | none (Node) | Guess-My-Number port |
| **1 — flat-C, very reliable** | **GBA** | devkitARM + libtonc, **Mode 3 framebuffer** | `.gba` | devkitPro installer | Mode 3 Paint |
| 1 | **Game Boy / GBC** | **GBDK-2020** (C) | `.gb`/`.gbc` | unzip + PATH | Snake |
| **1 — C + real library** | **Sega Genesis** | **SGDK** (C) | `.md` | unzip + Java | sprite-mover |
| 1 | **SMS / Game Gear** | **devkitSMS** + SDCC (C) | `.sms`+`.gg` | SDCC + drop-in tools | one-screen arcade (both from one source) |
| 1 | **Atari 2600** | **batari Basic** (BASIC-like) | `.a26` | unzip + `install_win.bat` | "Beam Dodger" |
| **2 — template-fill C** | **NES** | **cc65 + neslib**, edit only `game.c` | `.nes` | unzip + PATH | single-screen Pong |
| 2 | **PC Engine / TG-16** | **HuC** (small-C) | `.pce` | prebuilt Win64 zip | two-joypad Pong |
| 2 | **SNES** | **PVSnesLib** (C), start from a building sample | `.sfc` | MSYS2 + release | "move the sprite" |
| **3 — hard (stereoscopy)** | **Virtual Boy** | **VUEngine** (MIT, `make`) | `.vb` | VUEngine Studio once | stereoscopic depth demo |

Notes:
- **C64 + VIC-20 need no toolchain install at all** — pure Node, deterministic,
  CI-clean. These are the immediate quick wins and already half-built.
- **GBA Mode 3** and **GB GBDK** are the most reliable *compiled* targets: flat C,
  tiny stable APIs, instant emulator validation.
- **Virtual Boy is the only "hard" rating** — the V810 CPU is obscure and
  stereoscopy (per-eye parallax) has no AI precedent; still practical for a
  one-scene depth demo, and thematically perfect for a VR frontend.

## Built so far (2026-06-01; updated 2026-06-16)

All authored CC0, added to `public/roms/manifest.json`, and runtime-verified by
booting in the actual app (headless-Chrome screenshot of the in-world CRT):

- **C64 — LWX Snake** (`scripts/make-c64-snake.mjs` → `freeware/lwx-snake.prg`).
  Joystick-steered, polls both control ports.
- **VIC-20 — demo** (`scripts/make-vic20-demo.mjs` → `freeware/lwx-vic20-demo.prg`).
  Load address `$1001` (unexpanded). Shares the C64 tokenizer.
- **NES — LWX Pong** (`games/nes-pong/main.c`, cc65 + neslib, `npm run make-nes-pong`
  → `freeware/lwx-nes-pong.nes`). NROM-256. Manifest pins **fceumm** (nestopia
  black-screens these neslib NROM ROMs — see "Known issue" below).
- **NES — LWX Bomberman** (`games/nes-bomberman/main.c`, cc65 + neslib,
  `npm run make-nes-bomberman` → `freeware/lwx-nes-bomberman.nes`). NROM-256,
  up to **4 players** via the NES **Four Score** (auto-detected from its
  signature; cleanly falls back to 2-player when absent). The grid arena —
  floor, walls, destructible bricks, bombs, flames — lives in the background
  nametable and is repainted incrementally with `set_vram_update`; only players
  are sprites. Bombs chain; ~1-in-4 bricks hide bomb/fire/speed power-ups. Pins
  **fceumm**. Headless-verified with **jsnes** (boot, explosion, power-up
  reveal/pickup, 2-player degrade). Frontend follow-up: actually feeding P3/P4
  input to the ROM needs the libretro layer to set the Four Score *device* on
  the NES ports (not a core option — there is no `fceumm_4player`); see the game
  README and the couch-co-op follow-on in `docs/ROADMAP.md`.
- **Game Boy — LWX Snake** (`games/gb-snake/main.c`, GBDK-2020, `npm run make-gb-snake`
  → `freeware/lwx-gb-snake.gb`). ROM-only, runs on gambatte. D-pad steer, START to start/restart.
- **Genesis — LWX Genesis Demo** (`games/genesis-demo/main.c`, SGDK 2.11, `npm run make-genesis-demo`
  → `freeware/lwx-genesis-demo.md`). D-pad sprite-mover, A/B/C recolor. Runs on
  genesis_plus_gx (the `md` default).
- **SMS + Game Gear — LWX Catch** (`games/sms-arcade/main.c`, devkitSMS + SDCC,
  `npm run make-sms-arcade` → `freeware/lwx-sms-arcade.sms` + `lwx-gg-arcade.gg`).
  One source, GG built with `-DTARGET_GG`. Catch falling fruit. Manifest pins **gearsystem**.
- **PC Engine — LWX Pong** (`games/pce-pong/main.c`, HuC, `npm run make-pce-pong`
  → `freeware/lwx-pce-pong.pce`). Two-joypad Pong on the char grid; runs on mednafen_pce_fast.
- **SNES — LWX SNES Demo** (`games/snes-demo/snesdemo.c`, PVSnesLib 4.5.0, `npm run make-snes-demo`
  → `freeware/lwx-snes-demo.sfc`). LoROM 256K sprite-mover; runs on snes9x.
- **GBA — LWX Paint** (`games/gba-paint/main.c`, devkitARM + libtonc Mode 3, `npm run make-gba-paint`
  → `freeware/lwx-gba-paint.gba`). Framebuffer paint toy; runs on mgba. (devkitARM installed
  non-interactively from devkitPro pacman packages — see the doc.)
- **Virtual Boy — LWX VB Demo** (`games/vb-demo/`, VUEngine ves-v0.6.0, `npm run make-vb-demo`
  → `freeware/lwx-vb-demo.vb`). Movable box with real stereoscopic A/B depth; runs on mednafen_vb.
  (V810 toolchain + VUEngine extracted from the VUEngine Studio installer with 7-Zip, no IDE.)
- **Atari 2600 — LWX Beam Dodger** (`games/atari-dodger/game.bas`, batari Basic 1.8 + dasm,
  `npm run make-atari-dodger` → `freeware/lwx-atari-dodger.a26`). 4K cart. ⚠ Built &
  structurally valid, but **not yet renderable** — Atari's only libretro core is Stella,
  which has no module build (see "Known issue" below). Held out of the manifest until then.

## Known issue — legacy "classic" cores render black (Atari 2600 only, now)

Runtime verification (booting each game in-app and screenshotting the CRT) revealed
that **every libretro core marked `style: 'classic'` in `src/systems.js` produces a
black screen**: the core loads and maps the ROM but never starts its video loop
(snes9x logged `Map_LoROMMap` then nothing; 0 WebGL draw calls). Every working core is
`style: 'module'`. The old `classic` cores were ~210 KB WebEmu auto-init builds; the
`module` cores are modern ~261 KB buildbot MODULARIZE (`export default` +
`import.meta`) builds.

This also explained the earlier "core pin" gotchas — NES rendered on fceumm not
nestopia, Genesis on picodrive not genesis_plus_gx — those weren't ROM quirks, they
were the same classic-core bug, masked by falling back to a module core.

**Resolved 2026-06-02** for snes9x, nestopia, genesis_plus_gx, mgba, mednafen_vb:
replaced them in `public/cores/` with modern buildbot MODULARIZE builds (from
`buildbot.libretro.com/nightly/emscripten/RetroArch.7z`) and flipped their `style` to
`'module'` in `src/systems.js`. SNES, NES (nestopia), and Genesis (genesis_plus_gx)
now render on their default cores — the fceumm/picodrive pins were dropped. GBA (mgba)
and Virtual Boy (mednafen_vb) use the same module path and will render once their
games exist.

**Still open: Atari 2600.** Its only libretro core is Stella, and the emscripten
buildbot ships **no Stella build**, so `stella2014` remains the legacy classic core
and Atari cannot render. Options: find/produce a module Stella build, or adapt the
loader for the EmulatorJS `.data`-packaged stella core.

The Commodore BASIC v2 tokenizer/assembler is shared in `scripts/lib/cbm-basic.mjs`.
Installed toolchains: cc65 `C:\cc65`, GBDK-2020 `C:\gbdk-2020`, SGDK 2.11 `C:\sgdk`,
SDCC `C:\sdcc` + devkitSMS `C:\devkitSMS`, HuC `C:\tools\huc`, batari Basic `C:\Atari2600\bB`,
PVSnesLib 4.5.0 `C:\pvsneslib`. (Virtual Boy/VUEngine Studio and GBA/devkitPro still need
their GUI installers.)

## Recommended next wave (build order)

1. **C64 — LWX Snake (BASIC)** — extend the existing tokenizer; zero new tooling.
2. **VIC-20 — port** — clone tokenizer → `make-vic20-demo.mjs`, load addr `$1001`.
3. **GBA — Mode 3 Paint** — install devkitPro once; flat-framebuffer, near-zero risk.
4. **Game Boy — Snake (GBDK-2020)** — unzip SDK; the canonical easy compiled target.
5. **NES — single-screen Pong (cc65 + neslib)** — the must-have; template-fill.
6. **Genesis — sprite-mover (SGDK)** and **C64 — Catch (cc65)** — prove the "real library" tier.

Then fill in SMS/GG, PC Engine, SNES, Atari (batari), and Virtual Boy.

## Suggested repo structure for authored games

```
games/                         # source we author (committed)
  c64-snake/        main.bas-style listing or game.c + build notes
  nes-pong/         game.c (+ frozen template: crt0.s, header, .cfg, neslib)
  gba-paint/        main.c (+ libtonc template)
  ...
scripts/
  make-c64-demo.mjs            # existing
  make-vic20-demo.mjs          # clone (next)
  build-games.mjs              # optional orchestrator: build all → public/roms/freeware/
public/roms/freeware/          # built ROMs ship here; manifest.json points at them
```

Per-system exact install + build commands live in each `<system>-game-creation.md`.
