# LWX Pong (PC Engine / TurboGrafx-16)

A tiny **CC0** PC Engine game for LibretroWebXR test content. Single screen,
plain HuCard (`.pce`).

- **Left paddle** = player 1 (D-pad up/down on joypad 1 — the WebXR frontend's
  RetroPad maps to it).
- **Right paddle** = player 2 (D-pad up/down on joypad 2, matching the repo's
  two-hand RetroPad mapping). Until joypad 2 touches the D-pad, the right paddle
  is a simple CPU that tracks the ball at half speed so it can miss.
- First side to **9** wins. Press **RUN** to serve / play again.

Everything is drawn on the character grid with HuC's documented text library
(`put_char` / `put_string` / `put_number` / `cls`) — no sprites, no raw VDC
register banging, and no hand-written HuCard header. HuC's startup code and
runtime library do all the hardware bring-up; the only file we author is
`main.c` (game logic calling HuC's documented small-C API). That
batteries-included split is the AI-friendly path the project's research doc
(`docs/research/pcengine-game-creation.md`) recommends.

## Build

```
node scripts/make-pce-pong.mjs      # from the repo root
```

Needs **HuC** (`pce-devel/huc`) installed. The script finds the install via
`%HUC_HOME%`, then `C:\tools\huc` (the documented install dir — `huc.exe` must
be at `C:\tools\huc\bin\huc.exe`). It sets `PCE_INCLUDE` to HuC's
`include\huc` library dir and puts `C:\tools\huc\bin` on `PATH` (HuC shells out
to `pceas.exe`), runs `huc -O2 main.c`, and writes
`public/roms/freeware/lwx-pce-pong.pce` (a 64 KB HuCard, an 8 KB multiple).

Install HuC (zip-extract only, no installer):

```powershell
$zip = "$env:TEMP\huc-win64.zip"
Invoke-WebRequest "https://github.com/pce-devel/huc/releases/download/current/huc-2026-05-28-Win64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath "C:\tools\huc" -Force
# The zip nests everything under an inner huc\ folder; move its contents up one
# level so that bin\huc.exe sits at C:\tools\huc\bin\huc.exe.
```

## Files

| File | Origin | License |
|---|---|---|
| `main.c` | **ours** — the game | CC0 |

The compiled `.pce` is **CC0** — HuC's freeware/BSD runtime library does not
taint the output (standard "compiler output" reasoning), and our source is the
only authored content.

## Runtime / controls

Runs on **mednafen_pce_fast** (the project's default `pce` core), which loads a
plain `.pce` HuCard directly.

- P1 D-pad Up/Down — move the left paddle.
- P2 D-pad Up/Down — move the right paddle (takes over from the CPU once used).
- RUN — start / serve / play again.
