# LWX VB Demo — a tiny CC0 Nintendo Virtual Boy demo

A minimal one-scene Virtual Boy demo for LibretroWebXR. A box drawn on the
red/black VB display that you move with the D-pad, plus an A/B depth control
that changes the whole layer's **stereoscopic parallax** (a genuine "hello,
depth" — thematically perfect for a WebXR frontend).

Runs in the `mednafen_vb` core. Output: `public/roms/freeware/lwx-vb-demo.vb`.

## Controls

- **Left D-pad** — move the box one cell at a time (up/down/left/right).
- **A** — push the box farther *into* the screen (increase parallax).
- **B** — pull the box *out* toward the viewer (decrease parallax).

The depth is real left/right-eye parallax: it reads as depth in a stereo
viewer / LibretroWebXR's stereo path. In a flat 2D screenshot it shows as a
small horizontal shift.

## License

- **Game logic** — `source/States/MyGameState/MyGameState.{c,h}` and the
  entry-point change in `source/Game.c` are **CC0 1.0** (public domain
  dedication), authored for LibretroWebXR.
- **Engine + template** — everything else is the **MIT-licensed** VUEngine
  Barebone template (`ves-v0.6.0`) and VUEngine-Core engine
  (© Jorge Eremiev & Christian Radke). Their MIT notice is preserved in
  `LICENSE`. The MIT engine code linked into the ROM is permissive, so the
  shipped `.vb` is distributable as CC0.

## Build

The toolchain (V810 GCC 4.7.4 + VUEngine-Core + a full MSYS2 make/bash/awk
chain) ships **bundled inside the VUEngine Studio installer**; we extract it
with 7-Zip and never run the IDE. See
`docs/research/virtualboy-game-creation.md` for the one-time, non-interactive
install (download `…Setup.exe`, `7z x` it, pull out `app-64.7z`).

Once the toolchain is at `C:\vuengine\app\resources\app` (or `$VUENGINE_HOME`):

```
node scripts/make-vb-demo.mjs
```

This runs VUEngine's `make` chain (`makefile-game`, `TYPE=release`,
`PAD_ROM=1`) via the bundled bash, then copies `build/output.vb` to
`public/roms/freeware/lwx-vb-demo.vb` (512 KB, power-of-two padded so
`mednafen_vb` accepts it) and cleans the build tree.

## What's ours vs. frozen

- **Authored (CC0):** `source/States/MyGameState/MyGameState.c`,
  `MyGameState.h`, and the one-line first-state change in `source/Game.c`.
- **Frozen template (MIT):** `config.make`, `config/`, `headers/`, `lib/`,
  `assets/`, the rest of `source/`, and the VUEngine engine itself.
