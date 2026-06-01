# Creating New Atari 2600 (VCS) Games for LibretroWebXR

Research date: 2026-06-01. Target core: **stella2014** (libretro). Extensions: `.a26`, `.bin`.
Goal: small CC0/MIT games **we author**, built **headless on Windows**, shippable as test content.

> License principle honored throughout: a GPL toolchain (batari Basic, dasm) does **not** taint
> the ROM it produces. The compiler authors state this explicitly (see below). We license our own
> game source/ROM under CC0 or MIT regardless of the build tool's license.

---

## Goal 1 — High-level / lowest-effort path: **batari Basic (bB)**

**Verdict: This is THE recommended path. It is realistically the only AI-friendly way to author a 2600 game.**

batari Basic is a BASIC-like language that compiles to 6502 + a prebuilt TIA "kernel," so it hides
the brutal race-the-beam timing that makes raw 2600 asm so hard. You write `player0x`, `playfield:`,
`score`, `if joy0up then ...`, and the bundled standard kernel handles the scanline drawing.

- Homepage: https://bataribasic.com/
- Source / releases: https://github.com/batari-Basic/batari-Basic
- Latest release: **v1.9 (2025-10-13)**, ~7 releases total. Also a WASM build exists (used by Atari Dev Studio).
- Tutorial / docs: https://bataribasic.com/tutorial.html , https://www.randomterrain.com/atari-2600-memories-batari-basic-vbb.html (excellent, exhaustive reference by Random Terrain)

### License
- batari Basic itself: **GPL v2**.
- README explicitly states: *"The license does not apply to Atari 2600 games created with Batari BASIC.
  You may license your games however you wish."* → **Our ROM/source can be CC0 or MIT.** Clean.

### Windows install (raw bB)
1. Download the release zip from the GitHub releases page and extract to e.g. `C:\Atari2600\bB`.
2. Double-click `install_win.bat` (sets `bB` and `PATH` env vars). If it fails, set manually:
   ```
   setx bB C:\Atari2600\bB
   setx PATH "%PATH%;C:\Atari2600\bB"
   ```
3. bB bundles its own assembler step (it shells out to dasm internally; dasm is included).

### Build a ROM (CLI / headless)
```
2600bas.bat mygame.bas
```
- Output: **`mygame.bas.bin`** — a standard 4K ROM. Rename to `mygame.a26` (or `.bin`) for stella2014.
- The compile pipeline is: preprocess → compile to `bB.asm` → link kernel → assemble with dasm.
- No GUI required — `2600bas.bat` is a pure CLI batch file. **Fully scriptable for an AI agent.**

### Easiest turnkey Windows option: **Atari Dev Studio** (VS Code extension)
- https://github.com/chunkypixel/atari-dev-studio
- Bundles **batari Basic 1.9 (WASM)**, **dasm**, **7800basic**, **Stella 7.0**, **A7800** — install and build immediately.
- Primarily GUI, but supports scripted/makefile/batch builds (preview). Good for a human; raw `2600bas.bat`
  is better for a headless agent.

### Online IDE: **8bitworkshop**
- https://8bitworkshop.com (platform: VCS) — supports **batari Basic** directly, with presets from
  "Hello World" to full games, in-browser emulator (Javatari), disassembler, memory browser.
- Docs: https://8bitworkshop.com/docs/platforms/vcs/
- Source: https://github.com/sehugg/8bitworkshop
- Use it for quick prototyping / verifying a bB snippet, then export the `.bin`. Not needed for the
  automated pipeline but great for sanity-checking.

### How well can Claude write batari Basic?
**Well.** bB is line-numbered/structured BASIC with a small, well-documented vocabulary and a fixed
memory model (variables `a`–`z`, `player0`/`player1` sprites, 32-wide `playfield`, `score`, `joy0`/`joy0fire`).
The hard part (timing) is delegated to the kernel. Claude can produce a compiling, playable game on the
first or second try. Main pitfalls Claude must respect (all documented):
- Keep logic inside the `drawscreen` frame loop; call `drawscreen` exactly once per frame.
- Don't exceed the standard kernel's sprite/playfield limits; watch the 4K ROM size.
- bB syntax quirks (`then` on same line, `:` for multi-statement, `rem` comments, `dim` for var aliases).

---

## Goal 2 — Assembly toolchain: **dasm**

**Verdict: Works perfectly as a tool, but hand-writing cycle-exact 6502 is a poor fit for an LLM. Use only if bB can't express something.**

- Home: https://dasm-assembler.github.io/ , repo: https://github.com/dasm-assembler/dasm
- Releases (Win/mac/Linux, x86+x64 binaries): https://github.com/dasm-assembler/dasm/releases
- Latest: **2.20.14.1** (bugfix; long-stable line from 2.20.11). Ships `vcs.h` + `macro.h` for the 2600.
- License: **GPL v2** (same non-taint reasoning — our asm/ROM stays CC0/MIT).
- User guide PDF: https://github.com/dasm-assembler/dasm/blob/master/docs/dasm.pdf

### Install (Windows)
1. Download the Windows zip from releases; extract `dasm.exe` to e.g. `C:\Atari2600\dasm`.
2. Add to PATH (or call with full path). Copy `vcs.h`/`macro.h` next to your source or onto the include path.

### Build a ROM (the canonical command)
```
dasm mygame.asm -f3 -omygame.bin -Iinclude\
```
- `-f3` = raw binary output format (correct for a 2600 cartridge image).
- `-o` = output file. Rename `.bin` → `.a26` if desired. `-I` adds an include dir for `vcs.h`.

### Learning path (the classic references)
- **"Atari 2600 Programming for Newbies"** (Andrew Davie) — AtariAge tutorial series, the standard intro.
- **Stella Programmer's Guide** (Steve Wright, 1979) — the TIA/RIOT register bible.
- **"Racing the Beam"** (Bogost & Montfort) — conceptual background (this inspired Halo 2600).
- Sample asm repos: https://github.com/johnidm/asm-atari-2600 , https://github.com/NikolaVetnic/Atari2600Project

### Honest difficulty
2600 asm has **no framebuffer**. You must rewrite TIA registers in exact CPU-cycle windows as the
electron beam scans each of ~192 visible scanlines, and account for 76 cycles/line and vertical
blank/overscan timing manually. A single misplaced instruction shifts or tears the whole image.
This is exactly the kind of dense, cycle-counted state-tracking that LLMs get wrong. **Not recommended
for AI-authored content.**

---

## Goal 3 — AI-assisted creation: feasibility

**Why batari Basic >> raw asm for an LLM:**
- bB abstracts the kernel, so the model reasons about *game logic* (BASIC), not beam timing.
- Output is small, the vocabulary is tiny and well-documented, and errors are usually compile-time
  (catchable + fixable by re-prompting) rather than silent visual corruption.
- Community evidence: the AtariAge thread "Using ChatGPT-4 to help with Atari 2600 game development"
  (https://forums.atariage.com/topic/349833-) reports GPT-4 was "surprisingly coherent" for bB-style
  assistance; the consensus is that bB is the approachable route and raw asm "extremely daunting."

**Raw-asm failure modes for an LLM (real, observed):**
- **Kernel timing**: not hitting register writes within the correct cycle window → tearing/garbage.
- **Scanline counting**: miscounting visible lines / VBLANK / overscan → rolling or non-standard frames
  that some hardware/emulators reject.
- **Cycle budget**: game logic overrunning the 76-cycle line or HBLANK window.
- **Page-boundary penalties** silently breaking timing.

**Realistic AI claim:** Claude can produce a *playable* `.a26`/`.bin` via **batari Basic** reliably.
Claude can *assist* with dasm asm (boilerplate, macros, explaining `vcs.h`) but should not be expected
to author a clean, glitch-free cycle-exact kernel unaided.

---

## Goal 4 — Concrete recommendation + exact pipeline

### Recommended toolchain
**batari Basic v1.9** (raw CLI `2600bas.bat`) on Windows. dasm comes bundled inside bB; no separate
install needed for the bB path.

### Two small CC0 game ideas (both very doable in bB with the standard kernel)
1. **"Beam Dodger"** — single player sprite (`player0`) you move left/right with `joy0`; obstacles
   fall down the `playfield`; `score` counts survival time; collision via `collision(player0,playfield)`
   ends the game. ~50–100 lines of bB. Trivial for Claude.
2. **"Square Pong"** — one paddle (`player0`), a ball (`player1` or `missile0`) bouncing off walls,
   bounce off paddle, `score` on hits. Classic, fits the standard kernel easily.

Ship the `.bas` source under CC0/MIT and the built `.bin` (renamed `.a26`) as the test ROM.

### EXACT build pipeline (headless Windows)
```powershell
# 1. One-time install
#    Download latest bB release zip from:
#    https://github.com/batari-Basic/batari-Basic/releases  -> extract to C:\Atari2600\bB
setx bB "C:\Atari2600\bB"
setx PATH "%PATH%;C:\Atari2600\bB"     # open a new shell after setx

# 2. Author the game  ->  C:\LLM\LibretroWebXR\games\src\beamdodger.bas  (CC0/MIT, our own)

# 3. Build (CLI, no GUI)
C:\Atari2600\bB\2600bas.bat beamdodger.bas
#    Produces: beamdodger.bas.bin   (4K standard ROM)

# 4. Ship for stella2014
copy beamdodger.bas.bin C:\LLM\LibretroWebXR\games\beamdodger.a26
```
Load `beamdodger.a26` in LibretroWebXR's stella2014 core. Done.

> Pure-asm alternative (only if needed):
> `dasm game.asm -f3 -ogame.bin -Iinclude\` then rename `game.bin` → `game.a26`.

### Minimal bB sanity snippet (compiles, moves a sprite)
```basic
  rem minimal bB demo - CC0
  player0:
  %00111100
  %01111110
  %11111111
  %11111111
  %01111110
  %00111100
end
main
  COLUBK = $00 : COLUP0 = $1E
  if joy0left  then player0x = player0x - 1
  if joy0right then player0x = player0x + 1
  if joy0up    then player0y = player0y - 1
  if joy0down  then player0y = player0y + 1
  drawscreen
  goto main
```

---

## Goal 5 — Fallback: genuinely CC0 / public-domain homebrew

Be skeptical: **most AtariAge homebrew is commercial / sold**, even if a free ROM circulates. Verify
each license individually. Authoring our own bB game (Goal 4) sidesteps all of this and is preferred.

### Verified / strong candidates
- **Halo 2600** (Ed Fries, 2010, 4K) — **public domain**. The Smithsonian American Art Museum catalogs
  the work as in the public domain (free of copyright restrictions). ROM on Internet Archive:
  https://archive.org/details/atari_2600_halo_2600 ; background:
  https://en.wikipedia.org/wiki/Halo_2600 , http://bogost.com/blog/halo_2600/
  - Caveat: "Halo" is a Microsoft trademark/IP; the *code* is PD but shipping it under the Halo name in
    an open-source project carries trademark optics. Safe technically as PD content; consider naming.

### Source-available collections (CHECK EACH LICENSE before shipping)
- https://github.com/retrobrews/atari2600-games — ROMs "approved for free distribution **on that site
  only**"; **not** a blanket redistribution/CC0 license. Do **not** assume reusable. Contact authors.
- https://github.com/johnidm/asm-atari-2600 — sample/teaching asm source; check repo LICENSE per file.
- https://github.com/nickbild/journey_to_xenos — homebrew with source; verify its LICENSE.
- https://archive.org/details/atari-2600-source — mixed/reverse-engineered source dumps; provenance and
  license are unclear → **not safe** for a clean CC0/MIT project.

**Bottom line on fallback:** only Halo 2600 is clearly PD, and it has a trademark wrinkle. For
guaranteed-clean test content, **author our own bB game** — it is easy enough that the fallback is
largely unnecessary.

---

## Sources
- batari Basic: https://bataribasic.com/ , https://github.com/batari-Basic/batari-Basic , https://github.com/batari-Basic/batari-Basic/releases
- bB reference: https://www.randomterrain.com/atari-2600-memories-batari-basic-vbb.html , https://bataribasic.com/tutorial.html
- Atari Dev Studio: https://github.com/chunkypixel/atari-dev-studio
- 8bitworkshop: https://8bitworkshop.com/docs/platforms/vcs/ , https://github.com/sehugg/8bitworkshop
- dasm: https://dasm-assembler.github.io/ , https://github.com/dasm-assembler/dasm , https://github.com/dasm-assembler/dasm/releases
- AI assist thread: https://forums.atariage.com/topic/349833-using-chatgpt-4-to-help-with-atari-2600-game-development-ai-assisted-programming/
- Halo 2600: https://archive.org/details/atari_2600_halo_2600 , https://en.wikipedia.org/wiki/Halo_2600
- Homebrew collections: https://github.com/retrobrews/atari2600-games , https://github.com/johnidm/asm-atari-2600
