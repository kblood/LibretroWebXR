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

## Built so far (2026-06-01)

All authored CC0, added to `public/roms/manifest.json`, and runtime-verified by
booting in the actual app (headless-Chrome screenshot of the in-world CRT):

- **C64 — LWX Snake** (`scripts/make-c64-snake.mjs` → `freeware/lwx-snake.prg`).
  Joystick-steered, polls both control ports.
- **VIC-20 — demo** (`scripts/make-vic20-demo.mjs` → `freeware/lwx-vic20-demo.prg`).
  Load address `$1001` (unexpanded). Shares the C64 tokenizer.
- **NES — LWX Pong** (`games/nes-pong/main.c`, cc65 + neslib, `npm run make-nes-pong`
  → `freeware/lwx-nes-pong.nes`). NROM-256. ⚠ renders on **fceumm**; nestopia shows
  black for this ROM, so the manifest pins `"core": "fceumm"`.

The Commodore BASIC v2 tokenizer/assembler is shared in `scripts/lib/cbm-basic.mjs`.
cc65 is installed at `C:\cc65`.

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
