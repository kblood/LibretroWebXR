# Building the Amiga (PUAE) core for the web

The libretro Amiga core (PUAE / WinUAE-based) is **not** on the libretro
emscripten buildbot, so — unlike the other 13 cores — `puae_libretro.js/.wasm`
can't be fetched. We build it ourselves. The output is a standard
`MODULARIZE=1 EXPORT_ES6=1` module (`export default libretro_puae`) — the exact
same shape `EmulatorClient` already loads for every other `module`-style core,
so no loader changes are needed to *load* it.

Built 2026-06-14 on WSL2 Ubuntu (the Linux toolchain libretro emscripten builds
expect; Git Bash on Windows has no `make`). Result: `puae_libretro.wasm` ≈ 18 MB.

## Recipe

```bash
# 1. emsdk, pinned to the version RetroArch's Makefile.emscripten expects
git clone --depth 1 https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk install 3.1.46 && ./emsdk activate 3.1.46
source ~/emsdk/emsdk_env.sh

# 2. Sources. The core MUST come from the EmulatorJS fork — upstream
#    libretro/libretro-uae's emscripten Makefile branch is missing
#    STATIC_LINKING_LINK and won't link. The frontend comes from OFFICIAL
#    RetroArch, whose Makefile.emscripten emits `export default libretro_puae`
#    (the EmulatorJS RetroArch fork instead exports a global `EJS_Runtime`,
#    which our loader can't consume).
mkdir -p ~/amiga-build && cd ~/amiga-build
git clone --depth 1 https://github.com/EmulatorJS/libretro-uae.git
git clone --depth 1 https://github.com/libretro/RetroArch.git

# 3. Build the core to LLVM bitcode → puae_libretro_emscripten.bc (~93 MB)
cd ~/amiga-build/libretro-uae
emmake make -f Makefile platform=emscripten -j$(nproc)

# 4. Link against the RetroArch emscripten frontend → puae_libretro.js + .wasm
cp puae_libretro_emscripten.bc ~/amiga-build/RetroArch/libretro_emscripten.bc
cd ~/amiga-build/RetroArch
emmake make -f Makefile.emscripten LIBRETRO=puae HAVE_THREADS=0 HAVE_CHD=0 -j$(nproc)

# 5. Vendor into the project (cores are gitignored — never committed, licensing)
cp puae_libretro.js puae_libretro.wasm <repo>/public/cores/
```

## Booting

PUAE has a **built-in AROS Kickstart** (compiled into the core, `aros.rom.c`), so
it boots with no proprietary BIOS. Two pieces of loader glue make it work, both
now in place and verified (`tmp/probe-amiga-boot.mjs` reaches the AROS boot
screen headless):

1. **Content extension.** `EmulatorClient` used to write all content to a fixed
   `/rom/rom.bin`. PUAE identifies content by *extension* and rejected `.bin`
   with "Unsupported file format". The loader now writes `/rom/rom.<ext>` from
   `opts.contentExt` (cartridge cores keep `.bin`). Threaded from the loaded
   game's filename at the `client.start(...)` call sites in `main.js`.
2. **AROS selection.** PUAE's default kickstart is "Automatic", which looks for a
   real ROM (`kick34005.A500`) and halts when absent. The `puae` registry entry
   sets `coreOptions: { puae_kickstart: 'aros' }`; `EmulatorClient` writes a
   `retroarch-core-options.cfg` and points RA at it via `core_options_path`.

A real Kickstart (`kick34005.A500`, `kick40068.A1200`, …) is proprietary and
user-supplied — never redistributed.

## Remaining: a bootable test disk

The engine + loader are complete; what's left is *content*. A blank disk lands at
the AROS boot screen (verified). A bootable public-domain `.adf` is needed to
show an actual program — that's the per-system test-game authoring goal, not a
code gap.

## Deploy

`public/cores/` is gitignored; `npm run deploy` rehosts cores on dionysus.dk.
The 18 MB `puae_libretro.wasm` must be uploaded with the other cores.
