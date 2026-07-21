// System + core registry — the single source of truth for "what systems exist,
// which libretro core runs them, which file extensions they accept, and where
// their box art lives".
//
// Two views of the same data:
//   SYSTEMS — keyed by a canonical system id (the `system` field used in
//             manifests/collections and on cartridges). System-first: this is
//             what the room/collection layer reasons about.
//   CORES   — keyed by libretro core short-name. Core-first: this is what the
//             emulator loader (EmulatorClient) needs (url + module style).
//
// CORES is authoritative for *loading*; SYSTEMS is authoritative for
// *detection, labelling, and art*. They're cross-checked at module load.
//
// Cores are fetched at runtime into public/cores/ (see scripts/fetch-cores.mjs
// and docs/LICENSING.md) — they are never bundled in the repo.

// --- Cores (core-first; what the loader consumes) -------------------------
// style: 'classic' = old-style auto-init against window.Module (legacy WebEmu
//                    cores). 'module' = MODULARIZE=1 ES-module factory from the
//                    libretro buildbot, loaded via dynamic import().
// weight = relative emulation cost, used by the multi-console rack to decide how
//          many cores can run live at once on a headset (see RackBudget.js). The
//          Phase-0 spike held ~90fps on a Quest 3 with nes+gb+snes live
//          (weights 1+1+2 = 4), so DEFAULT_RACK_BUDGET is calibrated to that.
//          1 = light 8-bit, 2 = 16-bit / heavier, 3+ = would-be heavy cores
//          (N64/PSX/Saturn) which should be capped to one live instance.
export const CORES = {
  // Legacy WebEmu core (classic-script auto-init). NOTE: classic cores render
  // black in this loader (they load+map the ROM but never start video — see
  // docs/research/README.md "Known issue"). Replace with a buildbot MODULARIZE
  // build and move to the 'module' group when one becomes available. stella2014
  // is the last classic core because the emscripten buildbot ships no Stella
  // build, so Atari 2600 currently cannot render.
  stella2014:        { url: 'cores/stella2014_libretro.js',        exts: ['a26','bin'],                  label: 'Atari 2600 (stella)',         style: 'classic', license: 'GPLv2', weight: 1 },

  // Modern libretro buildbot cores (ES-module factory)
  // remapName = the RetroArch library_name used to name this core's per-core
  // input-remap dir/file (<userdata>/config/remaps/<name>/<name>.rmp) — the only
  // place a port-device override (e.g. a light gun) takes effect at boot in this
  // web build. Only set on the (patched) gun-capable cores. See LIGHTGUN_SUPPORT.md.
  snes9x:            { url: 'cores/snes9x_libretro.js',            exts: ['smc','sfc','swc','fig','bs'], label: 'SNES (snes9x)',               style: 'module', license: 'Non-commercial', weight: 2, remapName: 'Snes9x' },
  nestopia:          { url: 'cores/nestopia_libretro.js',          exts: ['nes','fds','unf','unif'],     label: 'NES (nestopia)',              style: 'module', license: 'GPLv2', weight: 1, remapName: 'Nestopia' },
  genesis_plus_gx:   { url: 'cores/genesis_plus_gx_libretro.js',   exts: ['md','gen','smd'],             label: 'Genesis (genesis_plus_gx)',   style: 'module', license: 'Non-commercial', weight: 2, remapName: 'Genesis Plus GX' },
  mgba:              { url: 'cores/mgba_libretro.js',              exts: ['gba'],                        label: 'GBA (mGBA)',                  style: 'module', license: 'MPL-2.0', weight: 2 },
  mednafen_vb:       { url: 'cores/mednafen_vb_libretro.js',       exts: ['vb','vboy'],                  label: 'Virtual Boy (mednafen)',      style: 'module', license: 'GPLv2', weight: 2 },
  picodrive:         { url: 'cores/picodrive_libretro.js',         exts: ['sms','gg','md','gen','smd','32x','cue','iso'], label: 'Sega multi (picodrive)', style: 'module', license: 'Non-commercial', weight: 2 },
  gearsystem:        { url: 'cores/gearsystem_libretro.js',        exts: ['sms','gg','sg'],              label: 'SMS/GG (gearsystem)',         style: 'module', license: 'GPLv3', weight: 1 },
  fceumm:            { url: 'cores/fceumm_libretro.js',            exts: [],                             label: 'NES (fceumm)',                style: 'module', license: 'GPLv2', weight: 1, remapName: 'FCEUmm' },
  gambatte:          { url: 'cores/gambatte_libretro.js',          exts: ['gb','gbc'],                   label: 'Game Boy/Color (gambatte)',   style: 'module', license: 'GPLv2', weight: 1 },
  mednafen_pce_fast: { url: 'cores/mednafen_pce_fast_libretro.js', exts: ['pce'],                        label: 'PC Engine/TurboGrafx (mednafen_pce_fast)', style: 'module', license: 'GPLv2', weight: 1 },
  vice_x64:          { url: 'cores/vice_x64_libretro.js',          exts: ['d64','d71','d80','d81','d82','g64','x64','t64','tap','prg','p00','crt'], label: 'C64 (VICE)', style: 'module', license: 'GPLv2', weight: 2 },
  vice_xvic:         { url: 'cores/vice_xvic_libretro.js',         exts: ['20','40','60','a0','b0','rom'], label: 'VIC-20 (VICE)',             style: 'module', license: 'GPLv2', weight: 2 },
  // Amiga (PUAE / WinUAE-based). Built for emscripten from EmulatorJS's
  // libretro-uae fork, linked against RetroArch's Makefile.emscripten →
  // `export default libretro_puae` (same MODULARIZE ES-module shape as the
  // buildbot cores). Boots via PUAE's built-in AROS Kickstart fallback when no
  // proprietary Kickstart is supplied (partial A500 compat). weight 2 = 16-bit
  // tier; the 68k + cycle-exact chipset is heavy in no-JIT wasm — bump to 3 if
  // it can't hold a rack slot on the headset. See [[amiga-puae-blocked]].
  // remapName 'PUAE' = the RA library_name; needed so a port-device override
  // (a MOUSE on a DB9 port) is written into the per-core .rmp and connects at
  // boot — the same mechanism the light guns use. DE-RISK VERIFIED (2026-06-25):
  // RETRO_DEVICE_MOUSE (id 2) on a PUAE port works via synthetic DOM mouse events
  // (movementX/movementY relative motion + button bitmask), no core rebuild —
  // proven by dragging an AROS Workbench window in headless puae (tmp/derisk-mouse5).
  // coreOptions/systemFiles: boot a REAL Kickstart when one is on the server.
  //   • systemFiles provisions the user-owned KS1.3 ROM (decrypted from their
  //     Amiga Forever rom.key) into RA's system dir under PUAE's canonical name
  //     `kick34005.A500` (KS1.3 rev 34.5 A500, md5 82a21c18…). EmulatorClient
  //     fetches it before callMain; a clean clone (no ROM on server → 404) skips
  //     it and PUAE falls back to the built-in AROS replacement (prior behaviour).
  //   • puae_model_fd pins the floppy model to the 1 MB A500 v1.3 preset (what
  //     Settlers and most A500 floppy games expect); puae_kickstart 'Automatic'
  //     then resolves to KS1.3 and loads kick34005.A500 from the system dir.
  //   The ROM lives under public/roms/local/ (gitignored, user-owned) so git stays
  //   copyright-clean; it ships only to the user's own server. See [[mouse-peripheral-amiga-dos-epic]].
  puae:              { url: 'cores/puae_libretro.js',              exts: ['adf','adz','dms','fdi','ipf','hdf','hdz','lha','uae'], label: 'Amiga (PUAE)', style: 'module', license: 'GPLv2', weight: 2, coreOptions: { puae_kickstart: 'Automatic', puae_model_fd: 'A500 (v1.3, 0.5M Chip + 0.5M Slow)' }, systemFiles: [{ name: 'kick34005.A500', url: 'roms/local/amiga/kick34005.A500' }, { name: 'kick40068.A1200', url: 'roms/local/amiga/kick40068.A1200' }], remapName: 'PUAE' },
  // DOS / IBM PC. virtualxt is the libretro buildbot's PREBUILT MODULARIZE ES6
  // core (`export default libretro_virtualxt`, fetched from RetroArch.7z like
  // every other `module` core — no custom build needed). It emulates an Intel
  // 8088 @ 4.77 MHz (IBM 5150/5160 PC/XT) with a BUILT-IN GLaBIOS, so it boots
  // with NO external BIOS and runs .com/.exe booters + FAT disk images directly.
  // Scope caveat: XT-class only (CGA, no 386/486) — fine for .COM/simple .EXE
  // DOS programs and 80s titles; later 386+ games (and anything needing a VxD or
  // protected mode) need DOSBox Pure, which the buildbot does NOT ship prebuilt
  // (it would require a heavy WSL2 emscripten build — see the dos system note).
  // weight 3 = heavy tier (full x86 + 18 MB wasm); cap to one live rack slot.
  virtualxt:         { url: 'cores/virtualxt_libretro.js',         exts: ['img','com','exe','ini'], label: 'DOS (VirtualXT)', style: 'module', license: 'MPL-2.0', weight: 3 },
  // PlayStation 2, via a from-scratch Emscripten build of jpd002/Play- (no
  // libretro buildbot PS2 core exists). Built + verified 2026-07-17 — see
  // docs/PS2_CORE_BUILD.md for the recipe (3 real build/link bugs found and
  // fixed) and the render-path verification (real WebGL draw calls + non-black
  // pixel readback from a booted PS2SDK homebrew ELF). weight 3 = heavy tier
  // (EE+VU MIPS-to-wasm JIT, same class as virtualxt's full-x86) — unmeasured
  // on a real headset, may need bumping; see the plan doc's open items.
  // remapName 'Play!' = this core's retro_get_system_info library_name; needed
  // for the GunCon2 port-device override below to connect at boot (same
  // mechanism as every other light gun here — see CORES doc comment above).
  play:              { url: 'cores/play_libretro.js',              exts: ['elf','iso','cso','isz','cue','chd'], label: 'PlayStation 2 (Play!)', style: 'module', license: 'GPLv2', weight: 3, remapName: 'Play!' },
  // PlayStation, via Beetle PSX HW + Lightrec + an adapter onto Play--CodeGen's
  // Jitter Wasm backend — see the published build tooling at
  // github.com/kblood/psx-wasm-jit-libretro and docs/PSX_CORE_BUILD.md for the
  // recipe. Desktop vertical slice implemented + verified 2026-07-21 (boots a
  // legal PS-X EXE, real non-black frames, live native Play--CodeGen blocks).
  // Runs in its own dedicated execution worker (not main-thread, unlike every
  // other core here — see src/RuntimeEmulatorClient.js) for Quest frame-timing
  // and to give the JIT's runtime Wasm compilation its own realm. New,
  // PSX-only schema fields (harmless no-ops for every other core):
  //   execution           — 'worker' routes through RuntimeEmulatorClient's
  //                          WorkerEmulatorClient delegate instead of the
  //                          default main-thread EmulatorClient.
  //   requiresThreads      — needs SharedArrayBuffer (COOP/COEP), same gate
  //                          every threaded core here already needs.
  //   contentIo            — 'transfer-memfs': content bytes are transferred
  //                          into the worker and mounted in its own MEMFS.
  //   multiFile            — content may be a CUE/M3U bundle of several
  //                          files (see src/ContentBundle.js), not one blob.
  //   companionExtensions  — non-entry files a multiFile bundle may reference
  //                          (the .bin/.img/.sub tracks a .cue points at).
  //   firmwareProfile      — BIOS requirement key for src/FirmwareStore.js
  //                          (user-supplied SCPH-550x, validated + persisted
  //                          locally — never shipped in this repo).
  //   buildHash            — save-state compatibility tag (checked via
  //                          checkSaveStateCompatibility in SaveState.js)
  //                          when RuntimeEmulatorClient can't resolve one
  //                          from the core's own build manifest at runtime.
  // .cue/.chd collide with `play`'s exts above — see coreForFile's doc
  // comment for how that's resolved.
  mednafen_psx_hw:   { url: 'cores/mednafen_psx_jit_libretro.js',    exts: ['chd','cue','m3u','ccd','pbp','exe'], label: 'PlayStation (Beetle PSX + Wasm JIT)', style: 'module', license: 'GPLv2', weight: 3,
    execution: 'worker', requiresThreads: true, contentIo: 'transfer-memfs', multiFile: true,
    companionExtensions: ['bin','img','iso','sub','sbi'], firmwareProfile: 'psx',
    buildHash: 'beetle-d6caed07-codegen-a5009f7d-jit-dev' },
  // Nintendo 64, via mupen64plus-libretro-nx (GLideN64, GLES3/WebGL2) — see
  // docs/N64_CORE_BUILD.md for the recipe. Phase N0 (interpreter baseline,
  // no dynarec) per docs/research/n64-wasm-jit-plan.md: new_dynarec is
  // native-x86/ARM-only and unusable in-browser (same wall PSX/PS2 hit —
  // see that plan's section 5), so this is CPU-interpreted; GLideN64 is a
  // real GPU plugin so 3D rendering is not emulated in software. Same
  // dedicated-worker execution topology as PSX (see src/RuntimeEmulatorClient.js);
  // no firmware/BIOS and single-file ROMs only, so multiFile/firmwareProfile
  // are omitted (simpler than PSX per the plan's file-level change map).
  // exts cover all three N64 ROM byte orders (.z64 big-endian native,
  // .n64 little-endian/byteswapped, .v64 byteswapped-16); the core
  // normalizes byte order internally.
  mupen64plus_next:  { url: 'cores/mupen64plus_next_libretro.js',    exts: ['n64','z64','v64'], label: 'Nintendo 64 (Mupen64Plus-Next)', style: 'module', license: 'GPLv2', weight: 3,
    execution: 'worker', requiresThreads: true, contentIo: 'transfer-memfs',
    buildHash: 'mupen64plus-98c1b0d8-n0-interpreter' },
};

// Rack budget calibration (see RackBudget.js). Tuned to the Phase-0 Quest-3
// spike: nes+gb+snes (1+1+2 = 4) held ~90fps, so 4 is a proven-safe ceiling.
export const DEFAULT_CORE_WEIGHT = 1;
export const DEFAULT_RACK_BUDGET = 4;   // total live weight a standalone headset sustains
export const DEFAULT_MAX_LIVE = 3;      // hard cap on simultaneously-live cores

/** Relative emulation cost of a core (defaults to 1 for unknown cores). */
export function coreWeight(name) {
  return CORES[name]?.weight ?? DEFAULT_CORE_WEIGHT;
}

// --- Systems (system-first; what the room/collection layer reasons about) --
// Each system:
//   label         — human-readable name
//   defaultCore   — core used when a game/folder doesn't specify one
//   cores         — all cores able to run this system (defaultCore first)
//   exts          — ROM file extensions (for auto-detect + local-folder scan)
//   aliases       — folder/name aliases for auto-detection (EmuVR-style); always
//                   includes the canonical id. Lower-cased, compared loosely.
//   thumbnailRepo — libretro-thumbnails repo name (for ArtResolver). null = none.
export const SYSTEMS = {
  snes:      { label: 'Super Nintendo',     defaultCore: 'snes9x',           cores: ['snes9x'],                       exts: ['smc','sfc','swc','fig','bs'], aliases: ['snes','super nintendo','super famicom','sfc'],            thumbnailRepo: 'Nintendo_-_Super_Nintendo_Entertainment_System', medium: 'cartridge',
    // SNES Super Scope (snes9x). Reads the native RETRO_DEVICE_LIGHTGUN path the
    // rwebinput patch feeds, so no read-mode core option is needed — just the
    // crosshair. Device id 260 = (1<<8)|RETRO_DEVICE_LIGHTGUN. See LIGHTGUN_SUPPORT.md.
    lightgun: { label: 'Super Scope', core: 'snes9x', device: 260, port: 1, coreOptions: { snes9x_superscope_crosshair: 'enabled' } },
    // SNES Justifier — the TWO-GUN co-op peripheral (Lethal Enforcers). snes9x
    // exposes Justifier=516 (gun 1) / Justifier2=772 (gun 2); we seat gun 1 on
    // port index 1 (player 2) and gun 2 on port index 2 (player 3) so each gun
    // drives an independent libretro port. The patched multiport rwebinput feeds
    // each port its OWN aim point (webgun_set per port) — see LIGHTGUN_SUPPORT.md
    // "Co-op caveat". Requested via lightgunLoadConfig(systemId, { twoGun:true }).
    lightgun2: { label: 'Justifier (2-gun)', core: 'snes9x', devices: [516, 772], ports: [1, 2], coreOptions: { snes9x_justifier1_crosshair: 'enabled', snes9x_justifier2_crosshair: 'enabled' } },
    // SNES Mouse (snes9x). Real hardware peripheral (Mario Paint); the strings
    // embedded in the fetched core binary confirm native support ("Cannot select
    // SNES Mouse: MouseMaster disabled", remap descriptors "Mouse1"/"Mouse2" per
    // port) with no dedicated core-option toggle found — same zero-coreOptions
    // shape as the Amiga mouse (CORES.puae note): just assign RETRO_DEVICE_MOUSE
    // (device 2, the base id — SNES has only one mouse type, unlike the gun's
    // per-peripheral SUBCLASS ids) to a port. Mario Paint requires the mouse on
    // Port 2 (port index 1), matching this system's existing Super Scope port
    // convention above. See docs/MOUSE_SUPPORT.md for the headless verification.
    mouse: { label: 'SNES Mouse', core: 'snes9x', device: 2, port: 1 } },
  nes:       { label: 'Nintendo (NES)',     defaultCore: 'nestopia',         cores: ['nestopia','fceumm'],            exts: ['nes','fds','unf','unif'],     aliases: ['nes','nintendo','famicom','nintendo entertainment system'], thumbnailRepo: 'Nintendo_-_Nintendo_Entertainment_System',       medium: 'cartridge',
    // NES Zapper (nestopia). Device 262 = SUBCLASS(POINTER,0); nestopia hardcodes
    // reading the gun from port index 1 (player 2), and needs the zapper_device
    // option set to "lightgun" to read the patched RETRO_DEVICE_LIGHTGUN path.
    // This is the fully-proven core (docs/LIGHTGUN_SUPPORT.md).
    lightgun: { label: 'Zapper', core: 'nestopia', device: 262, port: 1, coreOptions: { nestopia_zapper_device: 'lightgun', nestopia_show_crosshair: 'enabled' } } },
  gb:        { label: 'Game Boy',           defaultCore: 'gambatte',         cores: ['gambatte'],                     exts: ['gb'],                         aliases: ['gb','game boy','gameboy'],                               thumbnailRepo: 'Nintendo_-_Game_Boy',                            medium: 'cartridge' },
  gbc:       { label: 'Game Boy Color',     defaultCore: 'gambatte',         cores: ['gambatte'],                     exts: ['gbc'],                        aliases: ['gbc','game boy color','gameboy color'],                  thumbnailRepo: 'Nintendo_-_Game_Boy_Color',                      medium: 'cartridge' },
  gba:       { label: 'Game Boy Advance',   defaultCore: 'mgba',             cores: ['mgba'],                         exts: ['gba'],                        aliases: ['gba','game boy advance','gameboy advance'],              thumbnailRepo: 'Nintendo_-_Game_Boy_Advance',                    medium: 'cartridge' },
  vb:        { label: 'Virtual Boy',        defaultCore: 'mednafen_vb',      cores: ['mednafen_vb'],                  exts: ['vb','vboy'],                  aliases: ['vb','virtual boy','virtualboy'],                         thumbnailRepo: 'Nintendo_-_Virtual_Boy',                         medium: 'cartridge' },
  md:        { label: 'Sega Genesis',       defaultCore: 'genesis_plus_gx',  cores: ['genesis_plus_gx','picodrive'],  exts: ['md','gen','smd'],             aliases: ['md','genesis','mega drive','megadrive','sega genesis'],  thumbnailRepo: 'Sega_-_Mega_Drive_-_Genesis',                    medium: 'cartridge',
    // Genesis Menacer (genesis_plus_gx). Device 516 = SUBCLASS(LIGHTGUN,1) on port
    // index 1; reads the native RETRO_DEVICE_LIGHTGUN path. genesis_plus_gx defaults
    // gun_input to the touchscreen path on a no-mouse (web) build, which never sees
    // our synthetic mouse aim — force 'lightgun' so SCREEN_X/Y track the gun. The
    // cursor option draws the in-game crosshair so the player can aim (NES/SNES guns
    // enable their own crosshair; without it the SMS/MD gun aims blind).
    lightgun: { label: 'Menacer', core: 'genesis_plus_gx', device: 516, port: 1, coreOptions: { genesis_plus_gx_gun_input: 'lightgun', genesis_plus_gx_gun_cursor: 'enabled' } } },
  sms:       { label: 'Sega Master System', defaultCore: 'picodrive',        cores: ['picodrive','gearsystem'],       exts: ['sms'],                        aliases: ['sms','master system','sega master system','mark iii'],   thumbnailRepo: 'Sega_-_Master_System_-_Mark_III',                medium: 'cartridge',
    // SMS Light Phaser. Device 260 = SUBCLASS(LIGHTGUN,0) on port index 0. Provided
    // by genesis_plus_gx (the patched, gun-capable SMS core) — NOT the system's
    // default picodrive core, so the gun forces a core switch when seated.
    // genesis_plus_gx defaults gun_input to a touchscreen path on a no-mouse (web)
    // build, which ignores our synthetic mouse aim → the gun "fires" (trigger is a
    // button) but never hits (position dead). Force 'lightgun' so SCREEN_X/Y read
    // the mouse. gun_cursor draws the crosshair so the player can actually aim —
    // the NES Zapper / SNES Super Scope enable theirs; the Phaser had none, so it
    // aimed blind (the user's "no crosshair, couldn't hit, but trigger used bullets").
    lightgun: { label: 'Light Phaser', core: 'genesis_plus_gx', device: 260, port: 0, coreOptions: { genesis_plus_gx_gun_input: 'lightgun', genesis_plus_gx_gun_cursor: 'enabled' } } },
  gg:        { label: 'Sega Game Gear',     defaultCore: 'picodrive',        cores: ['picodrive','gearsystem'],       exts: ['gg'],                         aliases: ['gg','game gear','gamegear'],                             thumbnailRepo: 'Sega_-_Game_Gear',                               medium: 'cartridge' },
  sg1000:    { label: 'Sega SG-1000',       defaultCore: 'gearsystem',       cores: ['gearsystem','genesis_plus_gx'], exts: ['sg'],                         aliases: ['sg1000','sg-1000','sega sg-1000','sega sg1000','game 1000'], thumbnailRepo: 'Sega_-_SG-1000',                              medium: 'cartridge' },
  sega32x:   { label: 'Sega 32X',           defaultCore: 'picodrive',        cores: ['picodrive'],                    exts: ['32x'],                        aliases: ['sega32x','sega 32x','32x','mega 32x','super 32x'],        thumbnailRepo: 'Sega_-_32X',                                     medium: 'cartridge' },
  atari2600: { label: 'Atari 2600',         defaultCore: 'stella2014',       cores: ['stella2014'],                   exts: ['a26','bin'],                  aliases: ['atari2600','atari 2600','2600','vcs'],                   thumbnailRepo: 'Atari_-_2600',                                   medium: 'cartridge' },
  pce:       { label: 'PC Engine / TG-16',  defaultCore: 'mednafen_pce_fast',cores: ['mednafen_pce_fast'],            exts: ['pce'],                        aliases: ['pce','pc engine','turbografx','turbografx-16','tg16'],   thumbnailRepo: 'NEC_-_PC_Engine_-_TurboGrafx_16',                medium: 'cartridge' },
  c64:       { label: 'Commodore 64',       defaultCore: 'vice_x64',         cores: ['vice_x64'],                     exts: ['d64','d71','d80','d81','d82','g64','x64','t64','tap','prg','p00','crt'], aliases: ['c64','commodore 64','commodore64'], thumbnailRepo: 'Commodore_-_64',  medium: 'floppy', keyboard: true,
    // Commodore 1351 mouse (vice_x64). Real hardware peripheral (GEOS). UNLIKE
    // Amiga/SNES, vice-libretro does NOT read a per-port retro_set_controller_
    // port_device assignment for this — it's entirely coreOptions-driven: ONE
    // joyport is picked (vice_joyport: "1"|"2", default "2" — "most games use
    // port 2") and that port's device TYPE is picked separately (vice_joyport_type,
    // "3" = "Mouse (1351)"; "1" = Joystick is the default). Confirmed against the
    // actual upstream source (github.com/libretro/vice-libretro, libretro/
    // libretro-core.c, the RETRO_VARIABLE definitions) — an earlier guess based on
    // strings embedded in the fetched .wasm ("1351mouse") was WRONG; the real
    // value is the numeric string "3". device/port below are inert for VICE (kept
    // only so this descriptor's shape matches every other system's).
    mouse: { label: 'C64 Mouse (1351)', core: 'vice_x64', device: 2, port: 1,
      coreOptions: { vice_joyport: '2', vice_joyport_type: '3' } } },
  vic20:     { label: 'Commodore VIC-20',   defaultCore: 'vice_xvic',        cores: ['vice_xvic'],                    exts: ['20','40','60','a0','b0','rom'], aliases: ['vic20','vic-20','commodore vic-20'],                    thumbnailRepo: 'Commodore_-_VIC-20',                             medium: 'floppy', keyboard: true },
  amiga:     { label: 'Commodore Amiga',    defaultCore: 'puae',             cores: ['puae'],                         exts: ['adf','adz','dms','fdi','ipf','hdf','hdz','lha','uae'], aliases: ['amiga','commodore amiga','a500','a1200','amiga 500','amiga 1200'], thumbnailRepo: 'Commodore_-_Amiga', medium: 'floppy', keyboard: true,
    // Amiga mouse. The DB9 ports take a mouse just like a joystick; PUAE reads it
    // as RETRO_DEVICE_MOUSE (id 2). One mouse on port 0 is the single-player default
    // (Workbench, point-and-click games). DE-RISK VERIFIED: relative motion + buttons
    // reach the core via DOM mouse events (see CORES.puae note).
    mouse: { label: 'Amiga Mouse', core: 'puae', device: 2, port: 0 },
    // TWO-MOUSE variant: one mouse on each of the two DB9 ports so two players each
    // drive their OWN pointer — the path The Settlers' 2-player mode needs. PUAE
    // accepts a mouse on ports 0 and 1 (devices [2,2], ports [0,1]). NOTE: feeding
    // two INDEPENDENT pointers needs a multiport rwebinput patch on puae (the same
    // kind the light guns got) — the stock core reads both ports from mouse_index 0,
    // so without the patch both ports follow the SAME pointer. EmulatorClient.sendMouse
    // is future-proofed to use a patched per-port setter when present, else the shared
    // DOM path. See docs/MOUSE_SUPPORT.md "Two-mouse caveat".
    mouse2: { label: 'Amiga 2-Mouse', core: 'puae', devices: [2, 2], ports: [0, 1] } },
  // DOS / IBM PC. Computer-class system (keyboard:true, like c64/amiga). Runs on
  // virtualxt (prebuilt buildbot core; XT/8088-class — see CORES.virtualxt).
  // exts: virtualxt loads .com/.exe booters and FAT .img disk images directly. We
  // also list the common DOSBox archive/disc exts (zip/dosz/iso/cue/conf/bat) so
  // that IF a DOSBox-class core is later added (DOSBox Pure would need a WSL2
  // build; the buildbot ships none), those games still auto-detect as `dos` — the
  // current virtualxt core ignores them. medium 'floppy' mirrors the other
  // disk-based computers. DOS uses a MOUSE + keyboard; the mouse path is the
  // shared EmulatorClient.sendMouse primitive owned by the parallel mouse agent —
  // see the "DOS mouse" follow-up comment below SYSTEM_PORTS.
  dos:       { label: 'DOS / IBM PC',       defaultCore: 'virtualxt',        cores: ['virtualxt'],                    exts: ['exe','com','bat','conf','img','dosz','zip','iso','cue'], aliases: ['dos','ms-dos','msdos','pc','ibm pc','dosbox','virtualxt'], thumbnailRepo: null, medium: 'floppy', keyboard: true },
  // PlayStation 2 (Play!, see CORES.play). medium: 'floppy' is a placeholder —
  // there's no disc-shaped prop yet (only cartridge/floppy exist); PS2 discs
  // render as a floppy until one is built.
  ps2:       { label: 'PlayStation 2',      defaultCore: 'play',              cores: ['play'],                         exts: ['elf','iso','cso','isz','cue','chd'], aliases: ['ps2','playstation 2','playstation2','sony playstation 2'], thumbnailRepo: 'Sony_-_PlayStation_2', medium: 'floppy',
    // GunCon2 (Play!'s new CGunCon2UsbDevice — see docs/PS2_CORE_BUILD.md).
    // Device 260 = SUBCLASS(LIGHTGUN,0), matching main_libretro.cpp's
    // controllers[] registration; reads the standard RETRO_DEVICE_LIGHTGUN
    // path (same libretro API every other gun here uses), so no core-specific
    // read-mode coreOption is needed, unlike nestopia/genesis_plus_gx.
    // UNVERIFIED end-to-end: no real GunCon2-compatible PS2 game ISO was
    // available to confirm the LLD name string a real IOP-side driver
    // registers with (see UsbGunCon2Device.h) — the device binds correctly to
    // libretro's input path and the core builds/boots/renders with it present,
    // but "does a real GunCon2 game's driver actually attach to it" is untested.
    lightgun: { label: 'GunCon2', core: 'play', device: 260, port: 0, coreOptions: {} } },
  psx:       { label: 'PlayStation',        defaultCore: 'mednafen_psx_hw',  cores: ['mednafen_psx_hw'],              exts: ['chd','cue','m3u','ccd','pbp','exe'], aliases: ['psx','ps1','playstation','sony playstation'], thumbnailRepo: 'Sony_-_PlayStation', medium: 'floppy' },
  n64:       { label: 'Nintendo 64',        defaultCore: 'mupen64plus_next', cores: ['mupen64plus_next'],             exts: ['n64','z64','v64'], aliases: ['n64','nintendo 64'], thumbnailRepo: 'Nintendo_-_Nintendo_64', medium: 'cartridge' },
};

// Controller ports per system — how many controllers the base hardware
// accepts (the console's "up to 4" port row enables exactly this many; the
// rest hide). Handhelds = 1. Most cartridge consoles = 2. Systems with a
// stock 4-player adapter (NES Four Score, Genesis/Mega Drive team-player,
// SNES multitap) are given 4 here so the full port row is exercised; the
// multitap-5 systems (PCE, SNES) are capped at 4 by the console mesh anyway.
// A room/console prop may override via `ports` on the console descriptor.
const SYSTEM_PORTS = {
  nes: 4, snes: 4, md: 4,        // stock 4-player adapters existed
  sms: 2, gg: 1, atari2600: 2,
  gb: 1, gbc: 1, gba: 1, vb: 1,
  pce: 2, c64: 2, vic20: 1,
  sg1000: 2, sega32x: 2,
  amiga: 2,   // two DB9 joystick/mouse ports
  dos: 2,     // mouse (port 0) + keyboard / second device
  ps2: 2,     // two native DualShock2 ports (no stock multitap)
  psx: 2,     // two native digital-pad ports (no stock multitap)
  n64: 4,     // four native controller ports
};
// --- DOS mouse follow-up (do NOT implement here) -------------------------
// DOS games are mouse-driven. The mouse transport is the SHARED
// `EmulatorClient.sendMouse(dx, dy, buttons)` primitive being built by the
// parallel mouse-peripheral agent (branch feat/mouse-peripheral). When that
// lands, wire `dos` to it: virtualxt reads RETRO_DEVICE_MOUSE on port 0, so a
// `dos` boot should route the room's mouse prop / aim-ray through sendMouse to
// the active DOS console's EmulatorClient (relative-motion + L/R buttons). No
// core option is needed — virtualxt enables the PS/2 mouse by default. This file
// intentionally does NOT touch the mouse path to avoid colliding with that
// agent's EmulatorClient changes; this comment is the hook/TODO.
const DEFAULT_PORTS = 2;   // unknown system / no game loaded yet
export const MAX_PORTS = 4; // hardware ceiling the console mesh renders

/** Controller-port count for a system id (clamped to [1, MAX_PORTS]). */
export function portsForSystem(systemId) {
  const n = SYSTEM_PORTS[systemId] ?? DEFAULT_PORTS;
  return Math.max(1, Math.min(MAX_PORTS, n));
}

/**
 * True if a system is a "computer" that takes keyboard input (so the
 * physical keyboard device auto-shows / can usefully connect to it). Pure
 * registry lookup of the `keyboard` flag — see [[src/Keyboard.js]] /
 * the keyboard-device wiring in main.js.
 */
export function isKeyboardCapable(systemId) {
  return SYSTEMS[systemId]?.keyboard === true;
}

/**
 * Light-gun descriptor for a system, or null. Shape:
 *   { label, core, device, port, coreOptions }
 * where `device` is the libretro controller-device id to assign on `port`
 * (0-based), `core` is the (patched) core that implements the gun, and
 * `coreOptions` are any core options needed to select the light-gun read path.
 * See docs/LIGHTGUN_SUPPORT.md for how these were derived. Pure registry lookup.
 */
export function lightgunForSystem(systemId) {
  return SYSTEMS[systemId]?.lightgun ?? null;
}

/** True if a system has a light-gun peripheral wired up. */
export function isLightgunCapable(systemId) {
  return !!SYSTEMS[systemId]?.lightgun;
}

/**
 * Two-gun (co-op) light-gun descriptor for a system, or null. Shape:
 *   { label, core, devices:[d1,d2], ports:[p1,p2], coreOptions }
 * Only systems with a genuine two-gun peripheral (e.g. SNES Justifier) expose
 * this. Drives the multiport rwebinput path — each port gets its own aim point.
 */
export function twoGunForSystem(systemId) {
  return SYSTEMS[systemId]?.lightgun2 ?? null;
}

/** True if a system has a two-gun (co-op) light-gun peripheral. */
export function isTwoGunCapable(systemId) {
  return !!SYSTEMS[systemId]?.lightgun2;
}

/**
 * The ordered libretro gun PORTs a system's two-gun device seats its guns on
 * (e.g. SNES Justifier → [1, 2]), or [] for a single-gun / no-gun system. This is
 * the per-system value `_twoGunPorts` holds at boot for the active two-gun config;
 * exposed pure so a gun plugged into ANY console can resolve THAT console's ports
 * from its loaded system (main.js `_twoGunPortsForConsole`). Always returns an
 * array, so it feeds straight into libretroGunPortFor.
 */
export function twoGunPortsForSystem(systemId) {
  const tg = SYSTEMS[systemId]?.lightgun2;
  return tg ? [...tg.ports] : [];
}

/**
 * Build the EmulatorClient.start() light-gun wiring for a system, or null if it
 * has no gun. Returns { core, inputDevices, coreOptions, remapName } where:
 *   • core         — the (patched) core that implements the gun. May differ from
 *                    the system's defaultCore (e.g. SMS uses genesis_plus_gx, not
 *                    picodrive), so the caller must load THIS core for the gun.
 *   • inputDevices — { player: deviceId } to assign (player = gun port + 1).
 *   • coreOptions  — core options selecting the gun read path.
 *   • remapName    — the gun core's RA library name for its remap file.
 * The device only connects at boot, so this is applied at load time.
 *
 * With { twoGun:true } and a system that defines `lightgun2` (e.g. SNES
 * Justifier), returns the TWO-GUN config instead: BOTH gun ports appear in
 * inputDevices ({ p1: dev1, p2: dev2 }), and `guns` lists each gun's
 * { device, port } so the caller can map gun A→portX, gun B→portY. The patched
 * multiport rwebinput feeds each port its own aim point (webgun_set per port).
 */
export function lightgunLoadConfig(systemId, opts = {}) {
  if (opts.twoGun) {
    const tg = SYSTEMS[systemId]?.lightgun2;
    if (!tg) return null;
    const remapName = CORES[tg.core]?.remapName ?? null;
    const inputDevices = {};
    const guns = [];
    tg.ports.forEach((port, i) => {
      const device = tg.devices[i];
      inputDevices[port + 1] = device;
      guns.push({ device, port });
    });
    return { core: tg.core, inputDevices, coreOptions: tg.coreOptions || {}, remapName, guns };
  }
  const lg = SYSTEMS[systemId]?.lightgun;
  if (!lg) return null;
  const remapName = CORES[lg.core]?.remapName ?? null;
  return {
    core: lg.core,
    inputDevices: { [lg.port + 1]: lg.device },
    coreOptions: lg.coreOptions || {},
    remapName,
    guns: [{ device: lg.device, port: lg.port }],
  };
}

/**
 * Map a 0-based CABLE-slot index (which gun-in-port-order this is among the guns
 * plugged into a console) to the libretro gun input PORT it should drive.
 *
 * The two namespaces differ: the cable port is 0-based and shared with gamepads
 * (port 0 = player 1), whereas the two-gun device seats its guns on the libretro
 * ports listed in `lightgun2.ports` (e.g. the SNES Justifier uses [1, 2]). So the
 * Kth gun in cable-port order drives `twoGunPorts[K]` — this decouples the
 * in-world jack the gun's plug sits in from the device's libretro port numbering,
 * and lets physically swapping two guns' jacks swap their players.
 *
 * `twoGunPorts` is `_twoGunPorts` in main.js — the per-boot list of the active
 * two-gun device's ports (empty outside two-gun mode). Returns null when there's
 * no two-gun device or the slot index is out of range / invalid, which routes the
 * gun to the single-gun DOM-mouse path (unchanged).
 */
export function libretroGunPortFor(cableSlotIndex, twoGunPorts) {
  if (!Array.isArray(twoGunPorts) || twoGunPorts.length === 0) return null;
  if (!Number.isInteger(cableSlotIndex) || cableSlotIndex < 0) return null;
  const p = twoGunPorts[cableSlotIndex];
  return Number.isInteger(p) ? p : null;
}

// --- Mouse peripheral (Amiga, later DOS) ------------------------------------
// The mouse mirrors the light-gun descriptors, but feeds RELATIVE motion (dx,dy)
// + L/R buttons into RETRO_DEVICE_MOUSE on a port instead of an absolute aim.
// One mouse → one port is the proven path. A two-mouse variant seats a mouse on
// each of two ports for split-pointer 2-player (e.g. The Settlers on Amiga).

/**
 * Single-mouse descriptor for a system, or null. Shape:
 *   { label, core, device, port }
 * `device` is the libretro controller-device id (RETRO_DEVICE_MOUSE = 2) to
 * assign on `port` (0-based), `core` the core that runs it. Pure registry lookup.
 */
export function mouseForSystem(systemId) {
  return SYSTEMS[systemId]?.mouse ?? null;
}

/** True if a system has a mouse peripheral wired up. */
export function isMouseCapable(systemId) {
  return !!SYSTEMS[systemId]?.mouse;
}

/**
 * Two-mouse descriptor for a system, or null. Shape:
 *   { label, core, devices:[d1,d2], ports:[p1,p2] }
 * Only systems with a genuine two-mouse use (Amiga split-pointer 2-player) expose
 * this. Drives the (patched) multiport mouse path — each port its own pointer.
 */
export function twoMouseForSystem(systemId) {
  return SYSTEMS[systemId]?.mouse2 ?? null;
}

/** True if a system has a two-mouse peripheral. */
export function isTwoMouseCapable(systemId) {
  return !!SYSTEMS[systemId]?.mouse2;
}

/**
 * The ordered libretro mouse PORTs a system's two-mouse device seats its mice on
 * (Amiga → [0, 1]), or [] for a single-mouse / no-mouse system. The per-console
 * analogue of twoGunPortsForSystem: a mouse plugged into ANY console resolves
 * THAT console's ports from its loaded system. Always returns an array.
 */
export function twoMousePortsForSystem(systemId) {
  const tm = SYSTEMS[systemId]?.mouse2;
  return tm ? [...tm.ports] : [];
}

/**
 * Build the EmulatorClient.start() mouse wiring for a system, or null if it has
 * no mouse. Returns { core, inputDevices, coreOptions, remapName, mice } where:
 *   • core         — the core that runs the mouse (== defaultCore for Amiga).
 *   • inputDevices — { player: deviceId } to assign (player = mouse port + 1).
 *   • coreOptions  — any core options (none needed for PUAE mouse; PUAE auto-reads
 *                    a connected mouse device).
 *   • remapName    — the core's RA library name for its per-core remap file (the
 *                    only thing that connects a port device at boot in this build).
 *   • mice         — each mouse's { device, port } so the caller can map mouse A→
 *                    portX, mouse B→portY (mirrors lightgunLoadConfig's `guns`).
 *
 * With { twoMouse:true } and a system that defines `mouse2` (Amiga), returns the
 * TWO-MOUSE config: BOTH ports in inputDevices and both mice in `mice`.
 */
export function mouseLoadConfig(systemId, opts = {}) {
  if (opts.twoMouse) {
    const tm = SYSTEMS[systemId]?.mouse2;
    if (!tm) return null;
    const remapName = CORES[tm.core]?.remapName ?? null;
    const inputDevices = {};
    const mice = [];
    tm.ports.forEach((port, i) => {
      const device = tm.devices[i];
      inputDevices[port + 1] = device;
      mice.push({ device, port });
    });
    return { core: tm.core, inputDevices, coreOptions: tm.coreOptions || {}, remapName, mice };
  }
  const m = SYSTEMS[systemId]?.mouse;
  if (!m) return null;
  const remapName = CORES[m.core]?.remapName ?? null;
  return {
    core: m.core,
    inputDevices: { [m.port + 1]: m.device },
    // Per-descriptor coreOptions (mirrors lightgunLoadConfig): most systems need
    // none (Amiga/SNES just read whatever device retro_set_controller_port_device
    // assigns), but VICE's C64/VIC-20 mouse is entirely coreOptions-driven
    // (vice_joyport/vice_joyport_type pick ONE joyport + device type; the
    // inputDevices assignment above is inert for VICE, kept only so this
    // descriptor's shape matches every other system's).
    coreOptions: m.coreOptions || {},
    remapName,
    mice: [{ device: m.device, port: m.port }],
  };
}

/**
 * Map a 0-based CABLE-slot index (which mouse-in-port-order this is among the mice
 * plugged into a console) to the libretro mouse input PORT it should drive. The
 * mouse analogue of libretroGunPortFor: the Kth mouse in cable-port order drives
 * `twoMousePorts[K]`. Returns null when there's no two-mouse device or the slot
 * is out of range/invalid → routes to the single-mouse DOM path (unchanged).
 */
export function libretroMousePortFor(cableSlotIndex, twoMousePorts) {
  if (!Array.isArray(twoMousePorts) || twoMousePorts.length === 0) return null;
  if (!Number.isInteger(cableSlotIndex) || cableSlotIndex < 0) return null;
  const p = twoMousePorts[cableSlotIndex];
  return Number.isInteger(p) ? p : null;
}

// --- NES Four Score (4-player multitap) -------------------------------------
// A real NES has only two controller ports; a 4-player NES ROM reads players
// 3 and 4 over the Four Score multitap's serial protocol. For the fceumm core
// to present that to the ROM, the libretro layer must connect a controller
// device on the player-3/4 ports — fceumm enables its Four Score whenever
// ports 2 and 3 (0-based; players 3 and 4) are set to RETRO_DEVICE_GAMEPAD and
// disables it otherwise (verified from libretro-fceumm src/drivers/libretro/
// libretro.c: `if (nes_input.type[2]==GAMEPAD || nes_input.type[3]==GAMEPAD)
// FCEUI_DisableFourScore(0); else FCEUI_DisableFourScore(1);`). There is no
// `fceumm_4player` core option — it is purely a port-device assignment.
//
// RETRO_DEVICE_GAMEPAD = RETRO_DEVICE_SUBCLASS(RETRO_DEVICE_JOYPAD, 1), and
// SUBCLASS(base,id) = ((id+1)<<8)|base, so with JOYPAD=1 → ((1+1)<<8)|1 = 513.
// We assign 513 to players 3 and 4 (ports 2,3); players 1,2 stay on the core's
// default JOYPAD/Auto, so 1- and 2-player NES games are unaffected (the ROM
// only reads the pads it polls — an enabled-but-unused Four Score is inert).
//
// fceumm-only: the system's default core is nestopia (a different, proven
// Zapper path that handles its own input wiring), and the shipped 4-player NES
// homebrew (LWX Bomberman) pins fceumm anyway. Keeping this fceumm-scoped
// leaves every nestopia and non-NES boot byte-for-byte unchanged.
export const RETRO_DEVICE_NES_GAMEPAD = 513; // SUBCLASS(JOYPAD,1)

/**
 * Build the EmulatorClient.start() Four Score wiring for an NES boot, or null
 * when it doesn't apply. Returns { inputDevices, remapName } where:
 *   • inputDevices — { 3: 513, 4: 513 } connects players 3+4 as gamepads, which
 *                    is what makes fceumm enable the Four Score multitap so the
 *                    ROM can read P3/P4 over the serial protocol.
 *   • remapName    — fceumm's RA library name ('FCEUmm') for its per-core remap
 *                    file; the device only connects at boot via that .rmp.
 * Applies only when systemId === 'nes', the boot core is fceumm, and the system
 * exposes 4 ports (portsForSystem). Otherwise returns null (no-op) so single/
 * two-player NES and every other system are untouched. Pure registry logic.
 */
export function fourScoreLoadConfig(systemId, coreName) {
  if (systemId !== 'nes') return null;
  if (coreName !== 'fceumm') return null;
  if (portsForSystem(systemId) < 4) return null;
  return {
    inputDevices: { 3: RETRO_DEVICE_NES_GAMEPAD, 4: RETRO_DEVICE_NES_GAMEPAD },
    remapName: CORES.fceumm?.remapName ?? null,
  };
}

// .bin is ambiguous (Atari 2600 / Mega Drive / PSX / …). When detection sees a
// bare .bin we default to Atari 2600, the only .bin system we ship sample
// content for. Override with an explicit `core`/`system`, or ?core= in the URL.
//
// .cue/.chd are ambiguous between `play` (PS2) and `mednafen_psx_hw` (PSX) —
// both are real disc-image containers on both consoles, and this table can
// only pick a name-based default, not read bytes. Defaults to `play` (the
// console already shipping before PSX existed) to keep existing PS2 content
// resolving exactly as it did. The file-picker path in main.js reads the
// actual disc via src/DiscIdentity.js's identifyPlayStationDisc() first and
// passes an explicit override down to coreForFile when it can — this default
// only matters when that check is skipped or inconclusive.
//
// .exe is ALSO ambiguous, between `virtualxt` (DOS) and `mednafen_psx_hw`
// (bare PS-X EXE homebrew) — unlike cue/chd there's no disc to sniff, so
// there's no better-than-filename signal here at all. Defaults to `virtualxt`
// (existing shipped behaviour); loading a PS-X EXE needs an explicit
// override (`?core=mednafen_psx_hw`) until/unless this gets a real content
// sniff (a PS-X EXE header starts with the ASCII magic "PS-X EXE").
const AMBIGUOUS_EXT_DEFAULT = { bin: 'stella2014', cue: 'play', chd: 'play', exe: 'virtualxt' };

/** Core short-name → its info, or null. */
export function coreInfo(name) {
  return CORES[name] ? { name, ...CORES[name] } : null;
}

/** Lower-cased extension of a filename (no dot), or ''. */
export function extOf(filename) {
  const i = String(filename).lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

/**
 * Resolve which core to use for a file.
 *   override   — explicit core short-name (wins if known)
 *   returns the core's info ({name,url,exts,label,style,...}) or null.
 * Mirrors the legacy detectCore() in main.js, now registry-driven.
 *
 * `mednafen_psx_hw` (PSX) and `play` (PS2) both claim .cue/.chd — see
 * AMBIGUOUS_EXT_DEFAULT above for the name-only default, and
 * src/DiscIdentity.js's identifyPlayStationDisc() (tested:
 * tmp/verify-disc-identity.mjs, verified against a real commercial PS2 disc)
 * for the real, byte-level disambiguation main.js's file-picker path runs
 * before falling back to this default.
 */
export function coreForFile(filename, override) {
  if (override && CORES[override]) return coreInfo(override);
  const ext = extOf(filename);
  if (AMBIGUOUS_EXT_DEFAULT[ext]) return coreInfo(AMBIGUOUS_EXT_DEFAULT[ext]);
  for (const [name, info] of Object.entries(CORES)) {
    if (info.exts.includes(ext)) return coreInfo(name);
  }
  return null;
}

/** Canonical system id for a file, via its core's owning system. */
export function systemForFile(filename, override) {
  const core = coreForFile(filename, override);
  if (!core) return null;
  const ext = extOf(filename);
  // Prefer the system that both runs this core AND claims this extension. This
  // disambiguates cores shared across systems — e.g. picodrive runs md/sms/gg/
  // sega32x and gearsystem runs sms/gg/sg1000, so a bare core→system lookup
  // would mis-route `.32x`/`.sg` to whichever system lists the core first.
  for (const [id, sys] of Object.entries(SYSTEMS)) {
    if (sys.cores.includes(core.name) && sys.exts.includes(ext)) return id;
  }
  // Fallback: first system whose cores list includes this core.
  for (const [id, sys] of Object.entries(SYSTEMS)) {
    if (sys.cores.includes(core.name)) return id;
  }
  return null;
}

/** Match a free-text folder/label name to a canonical system id (EmuVR-style). */
export function systemForName(name) {
  const n = String(name).trim().toLowerCase();
  for (const [id, sys] of Object.entries(SYSTEMS)) {
    if (sys.aliases.some((a) => a === n)) return id;
  }
  // Looser contains-match as a fallback (e.g. "My SNES Games").
  for (const [id, sys] of Object.entries(SYSTEMS)) {
    if (sys.aliases.some((a) => n.includes(a))) return id;
  }
  return null;
}

// --- Medium mapping ----------------------------------------------------------
// Per-extension overrides. C64/VIC-20 cartridges (.crt) are cartridges even
// though the system default medium is 'floppy'; disk/tape/program images are
// all treated as 'floppy' for Phase 1 (we have only two media types).
const FLOPPY_EXTS = new Set([
  // C64/VIC-20 disk images
  'd64','d71','d80','d81','d82','g64','x64',
  // Tape and program images (treated as floppy this phase)
  't64','tap','prg','p00',
  // VIC-20 ROM cartridge as disk-style (vic20 default medium = floppy)
  '20','40','60','a0','b0','rom',
  // Amiga floppy / disk / WHDLoad images (all treated as 'floppy' this phase)
  'adf','adz','dms','fdi','ipf','hdf','hdz','lha','uae',
]);
const CARTRIDGE_EXTS = new Set([
  'crt', // C64 cartridge format — always a cartridge regardless of system medium
]);

/**
 * Resolve the physical medium for a game meta object.
 * Returns 'cartridge' | 'floppy'.
 *
 * Resolution order:
 *   1. File extension in CARTRIDGE_EXTS → 'cartridge'  (overrides system default)
 *   2. File extension in FLOPPY_EXTS   → 'floppy'
 *   3. System registry medium field     → system default
 *   4. Fallback                         → 'cartridge'
 */
export function mediumFor(meta) {
  if (meta?.file) {
    const ext = extOf(meta.file);
    if (CARTRIDGE_EXTS.has(ext)) return 'cartridge';
    if (FLOPPY_EXTS.has(ext)) return 'floppy';
  }
  const systemId = meta?.system;
  if (systemId && SYSTEMS[systemId]?.medium) return SYSTEMS[systemId].medium;
  return 'cartridge';
}

// --- Cross-check at load: every system's cores must exist in CORES ---------
for (const [id, sys] of Object.entries(SYSTEMS)) {
  for (const c of sys.cores) {
    if (!CORES[c]) console.warn(`[systems] system '${id}' references unknown core '${c}'`);
  }
  if (!sys.cores.includes(sys.defaultCore)) {
    console.warn(`[systems] system '${id}' defaultCore '${sys.defaultCore}' not in its cores list`);
  }
}
