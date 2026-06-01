# Creating SNES (.sfc) Test Games for LibretroWebXR

Research date: 2026-06-01. Goal: author a small CC0/MIT SNES game we own, build a
standard LoROM `.sfc` (no special chips/SuperFX) that the libretro **snes9x** core
runs in-browser. Toolchains must work headless on Windows so an AI agent can build
without GUI steps.

snes9x accepted extensions (verified): `.smc .sfc .swc .fig .bs .st`
(source: <https://github.com/libretro/libretro-core-info/blob/master/snes9x_libretro.info>).
A LoROM `.sfc` with a correct header is the safe target. (`.smc` output from some
toolchains is the same image; renaming `.smc`→`.sfc` is fine when there is no 512-byte
copier header — ca65/WLA output has no copier header.)

---

## Goal 1 — C / high-level toolchains

### PVSnesLib (recommended high-level path)
- Repo: <https://github.com/alekmaul/pvsneslib> — **MIT license** (toolchain license
  does NOT taint our game; output is ours).
- Latest release: **4.5.0** (Dec 2025). Prebuilt Windows 64-bit zips published in the
  GitHub Releases section (e.g. `pvsneslib_4xx_64b_windows_release.zip`).
- C-based SDK: a 65816 C compiler/linker (tcc-816 derived "snes-sdk") plus a library
  with helpers for backgrounds, sprites, pads, music/sound, plus asset tools
  (gfx conversion, map/tile tools). Produces `.sfc` ROMs directly via `make`.
- It is a real C SDK (unlike cc65, whose C compiler does NOT target 65816 — see Goal 2),
  so Claude can write ordinary C against documented library functions instead of raw
  65816 assembly. This is the single biggest reliability win for LLM authoring.

Windows install (verified from project wiki):
1. Install **MSYS2** (UCRT64 shell): <https://www.msys2.org/#installation>.
2. In MSYS2 UCRT64: `pacman -Suuy` then `pacman -S make`, restart the shell.
   (Python is used by the C source optimizer on some setups — install if a build
   step complains; "install for all users".)
3. Download + extract the Windows release zip, e.g. to `C:\snesdev` (path must have
   NO spaces).
4. Set the home var in MSYS2 with a **Unix-style** path:
   `setx PVSNESLIB_HOME "/c/snesdev"` (using `c:\` here causes build failures).
5. Build the sample: `cd /c/snesdev/snes-examples/hello_world && make` → produces
   `hello_world.sfc`. That ROM loads in snes9x.

Project template = copy any folder under `snes-examples/` (each has a `Makefile`
that includes `$(PVSNESLIB_HOME)/devkitsnes/...` rules). Fully headless/scriptable.

Wiki refs:
<https://github.com/alekmaul/pvsneslib/wiki/Installation>,
<https://github.com/alekmaul/pvsneslib/wiki/Installation-with-Windows>.

### Other higher-level options (secondary)
- **SNES-IDE** (<https://github.com/BrunoRNS/SNES-IDE>) — a cross-platform GUI wrapper
  *around* PVSnesLib. Adds GUI steps; not needed for an agent. Skip for headless.
- **DotnetSnes / C#** (<https://github.com/KallDrexx/DotnetSnes>) — experimental, niche,
  not recommended for reliability.
- **cc65's C compiler does NOT support 65816** (only its ca65 assembler/ld65 linker do),
  so cc65 is an *assembly* path, not a C path — see Goal 2.

---

## Goal 2 — Assembly toolchains (65816)

### ca65 / ld65 (cc65 suite) — recommended assembly path
- Tool: cc65 suite; `ca65 --cpu 65816` assembles, `ld65 -C <cfg>` links. Prebuilt
  Windows binaries exist (cc65 snapshot). Fully scriptable/headless.
- License: cc65 is zlib-style permissive; *your* source is yours.
- Minimal build (from SuperFamicom wiki "Basic ca65 Usage"):
  ```
  ca65 --cpu 65816 -o game.o game.s
  ld65 -C lorom128.cfg -o game.sfc game.o
  ```
  LoROM linker cfg needs MEMORY areas (ZEROPAGE, BSS, ROM banks at 0x8000/0x18000/…)
  and SEGMENTS: `HEADER` @ 0xFFC0, `ROMINFO` @ 0xFFD5, `VECTORS` @ 0xFFE0.
  Ref: <https://wiki.superfamicom.org/basic-ca65-usage-for-snes-programming>.
- Best ready-made template + tutorial: **georgjz "SNES Assembly Adventure"**
  code repo <https://github.com/georgjz/snes-assembly-adventure-code> — **MIT license**,
  buildable snippets, includes a CMake/Make project structure, ca65 sources, linker cfg.
  Tutorial: <https://georgjz.github.io/snesaa01/>. Build cmds:
  `ca65 --cpu 65816 -o nihil.o nihil.s` ; `ld65 -C memmap.cfg nihil.o -o nihil.smc`.

### WLA-DX (wla-65816 + wlalink)
- Repo: <https://github.com/vhelin/wla-dx> (permissive/zlib-style; SNES fork
  <https://github.com/nArnoSNES/wla-dx-65816>). Mature, widely used for SNES.
- Build: `wla-65816 -o game.o game.asm` then `wlalink -vr link.prj game.sfc`
  (needs a `.prj` link file listing the object + ROM/header settings).
  Ref: <https://wiki.superfamicom.org/setting-up-a-programming-environment>.
- Slightly more setup (link file + memorymap/rombankmap directives) than ca65.

### bass / asar / 64tass
- **asar** is the dominant SNES community assembler (great for ROM patching, also full
  builds); **64tass** and **bass** also support 65816. All permissive. ca65 has the best
  Mesen debugger support, which is why it's the recommended assembly path here.

### Honest assembly note
All assembly paths require the author (human or LLM) to hand-write the SNES boot
sequence: ROM header, native/emulation mode switch, PPU/DMA register init, NMI/IRQ
vector table, VRAM/CGRAM upload. This is exactly where LLMs fail (Goal 3).

---

## Goal 3 — AI-assisted creation: honest verdict

**Raw 65816 assembly: Claude/LLMs are unreliable.** A documented nesdev experiment with
ChatGPT-generated SNES asm
(<https://forums.nesdev.org/viewtopic.php?t=24578>) found the output broken in
fundamental ways:
- **Fabricated PPU register addresses** (wrong/invented hardware registers).
- **Invented a non-existent DMA "auto-increment-until-null" mode** — SNES DMA needs
  explicit byte counts and is VRAM/CPU-bus only.
- Confused `WDM` with `WAI` to "wait for DMA" (DMA auto-suspends the CPU; no wait needed).
- **Omitted vector table, interrupt handlers, ROM header, and font/CHR graphics.**
Consensus: "not accurate enough to complete entire projects… especially in assembly,"
"needs babysitting." This matches the SNES register/DMA/mode-7/header setup being
genuinely complex.

**Most reliable LLM path = C with PVSnesLib + a known-good template.** Claude reliably
writes C game logic against documented library calls (sprite/BG/pad/sound helpers); the
hardware boot/init boilerplate lives in the SDK, not in generated code. The remaining
risk surface (header config, VRAM layout, asset conversion via the SDK's gfx tools) is
small and copy-from-example.

**Reliability ranking for an AI agent (best→worst):**
1. PVSnesLib (C) starting from `hello_world`/a sprite example — high success.
2. ca65 assembly starting from georgjz's working template, asking Claude to modify
   only game logic between proven init/NMI code — medium success.
3. Asking Claude to write a full SNES ROM from scratch in assembly — low/failure.

**Failure modes to expect even on the good path:** wrong VRAM/CGRAM addresses, DMA
size/mode mistakes, OAM sprite attribute layout errors, forgetting to force-blank before
VRAM writes, NMI not re-enabling, and header checksum/size mismatches. Mitigation: always
start from a building template, change one thing at a time, and test each build in snes9x.

No mature "SNES game generator" skill exists; AI retro successes are almost all
JS/browser games or NES emulators, not native `.sfc` output.

---

## Goal 4 — Concrete recommendation + exact pipeline

**Primary recommendation:** Author a tiny **CC0** game in **C with PVSnesLib**.
Realistic first-game scope (pick one):
1. **"Move the sprite"** — one player sprite on a colored background, D-pad moves it,
   A/B changes color. Smallest viable, exercises BG + sprite + pad. *Best first target.*
2. **"Dodge" / one-screen avoider** — player sprite + 1–3 moving sprites, collision =
   reset, simple on-screen score. Still small, feels like a game.

Ship our source under **CC0 (or MIT)**; PVSnesLib's MIT does not affect our game's license.

### Exact build pipeline (Windows, headless after install)
```
:: 1. Install MSYS2 from https://www.msys2.org , open "MSYS2 UCRT64"
pacman -Suuy
pacman -S make
:: (reopen shell)

:: 2. Get PVSnesLib (MIT) — extract the Windows release zip to C:\snesdev (no spaces)
::    https://github.com/alekmaul/pvsneslib/releases

:: 3. Point the SDK at it (UNIX-STYLE path!)
setx PVSNESLIB_HOME "/c/snesdev"
:: reopen shell so the var is live

:: 4. Sanity-build a known-good sample -> hello_world.sfc
cd /c/snesdev/snes-examples/hello_world
make

:: 5. Author our game: copy a sample folder as a template, edit main.c + Makefile name
cp -r /c/snesdev/snes-examples/hello_world /c/snesdev/mygame
cd /c/snesdev/mygame
:: (edit main.c with Claude; keep the Makefile's PVSNESLIB include lines)
make            ::  -> mygame.sfc

:: 6. Test: load mygame.sfc in snes9x (RetroArch or the LibretroWebXR build)
```
Output `mygame.sfc` is a standard LoROM ROM snes9x runs. Each PVSnesLib example
Makefile already sets the ROM header and emits `.sfc`.

**Assembly alternative (if we want zero C runtime / tiniest ROM):** clone
`georgjz/snes-assembly-adventure-code` (MIT), build the green-screen/sprite example with
`ca65 --cpu 65816` + `ld65 -C memmap.cfg`, and have Claude edit only the game-logic
section. Use this only if the C path is unsuitable.

---

## Goal 5 — Fallback: ship existing permissive/PD SNES homebrew

Be skeptical: most "homebrew ROM" sites are NOT CC0 and are source-less.

- **retrobrews/snes-games** (<https://github.com/retrobrews/snes-games>) — **DO NOT
  rely on.** Explicit text: ROMs "approved for free distribution on this site/project
  only… contact owner/developer" to share elsewhere. Not CC0, no source. Reject.
- **freeroms.com "public domain" SNES** — unverified, no license files, no source.
  Treat as unsafe; reject.
- **Better fallback = build from permissively licensed *source*, so we control license:**
  - `georgjz/snes-assembly-adventure-code` — **MIT**, buildable; we'd be shipping our
    own build of MIT-licensed example code (attribution required). Safe.
  - PVSnesLib `snes-examples/` (the `hello_world`, sprite, etc.) — **MIT**; building and
    shipping these is clean with attribution. Safe as immediate placeholder content.
  - SNESdev Wiki code snippets (<https://snes.nesdev.org>) — wiki content is **CC0**
    ("CC0 Public Domain unless otherwise noted"); the Initialization Tutorial code is
    public-domain, usable as a CC0 seed we expand.

**Recommendation for fallback:** rather than ship a third-party prebuilt ROM of uncertain
license, build a ROM ourselves from MIT (PVSnesLib examples / georgjz) or CC0 (SNESdev
wiki) sources — then we know the provenance and can relicense our additions CC0/MIT.

---

## Key URLs
- PVSnesLib repo (MIT): https://github.com/alekmaul/pvsneslib
- PVSnesLib install wiki: https://github.com/alekmaul/pvsneslib/wiki/Installation
- georgjz SNES Assembly Adventure (MIT code): https://github.com/georgjz/snes-assembly-adventure-code
- Tutorial: https://georgjz.github.io/snesaa01/
- SuperFamicom dev wiki (ca65 usage): https://wiki.superfamicom.org/basic-ca65-usage-for-snes-programming
- SuperFamicom dev wiki (env setup, WLA-DX): https://wiki.superfamicom.org/setting-up-a-programming-environment
- WLA-DX: https://github.com/vhelin/wla-dx
- SNESdev Wiki (CC0): https://snes.nesdev.org/wiki/Main_Page
- ChatGPT SNES asm failure thread: https://forums.nesdev.org/viewtopic.php?t=24578
- snes9x extensions: https://github.com/libretro/libretro-core-info/blob/master/snes9x_libretro.info
