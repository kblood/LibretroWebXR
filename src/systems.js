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
  fceumm:            { url: 'cores/fceumm_libretro.js',            exts: [],                             label: 'NES (fceumm)',                style: 'module', license: 'GPLv2', weight: 1 },
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
  puae:              { url: 'cores/puae_libretro.js',              exts: ['adf','adz','dms','fdi','ipf','hdf','hdz','lha','uae'], label: 'Amiga (PUAE)', style: 'module', license: 'GPLv2', weight: 2, coreOptions: { puae_kickstart: 'aros' } },
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
    lightgun2: { label: 'Justifier (2-gun)', core: 'snes9x', devices: [516, 772], ports: [1, 2], coreOptions: { snes9x_justifier_crosshair: 'enabled' } } },
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
    // index 1; reads the native RETRO_DEVICE_LIGHTGUN path (no read-mode option).
    lightgun: { label: 'Menacer', core: 'genesis_plus_gx', device: 516, port: 1, coreOptions: {} } },
  sms:       { label: 'Sega Master System', defaultCore: 'picodrive',        cores: ['picodrive','gearsystem'],       exts: ['sms'],                        aliases: ['sms','master system','sega master system','mark iii'],   thumbnailRepo: 'Sega_-_Master_System_-_Mark_III',                medium: 'cartridge',
    // SMS Light Phaser. Device 260 = SUBCLASS(LIGHTGUN,0) on port index 0. Provided
    // by genesis_plus_gx (the patched, gun-capable SMS core) — NOT the system's
    // default picodrive core, so the gun forces a core switch when seated.
    lightgun: { label: 'Light Phaser', core: 'genesis_plus_gx', device: 260, port: 0, coreOptions: {} } },
  gg:        { label: 'Sega Game Gear',     defaultCore: 'picodrive',        cores: ['picodrive','gearsystem'],       exts: ['gg'],                         aliases: ['gg','game gear','gamegear'],                             thumbnailRepo: 'Sega_-_Game_Gear',                               medium: 'cartridge' },
  sg1000:    { label: 'Sega SG-1000',       defaultCore: 'gearsystem',       cores: ['gearsystem','genesis_plus_gx'], exts: ['sg'],                         aliases: ['sg1000','sg-1000','sega sg-1000','sega sg1000','game 1000'], thumbnailRepo: 'Sega_-_SG-1000',                              medium: 'cartridge' },
  sega32x:   { label: 'Sega 32X',           defaultCore: 'picodrive',        cores: ['picodrive'],                    exts: ['32x'],                        aliases: ['sega32x','sega 32x','32x','mega 32x','super 32x'],        thumbnailRepo: 'Sega_-_32X',                                     medium: 'cartridge' },
  atari2600: { label: 'Atari 2600',         defaultCore: 'stella2014',       cores: ['stella2014'],                   exts: ['a26','bin'],                  aliases: ['atari2600','atari 2600','2600','vcs'],                   thumbnailRepo: 'Atari_-_2600',                                   medium: 'cartridge' },
  pce:       { label: 'PC Engine / TG-16',  defaultCore: 'mednafen_pce_fast',cores: ['mednafen_pce_fast'],            exts: ['pce'],                        aliases: ['pce','pc engine','turbografx','turbografx-16','tg16'],   thumbnailRepo: 'NEC_-_PC_Engine_-_TurboGrafx_16',                medium: 'cartridge' },
  c64:       { label: 'Commodore 64',       defaultCore: 'vice_x64',         cores: ['vice_x64'],                     exts: ['d64','d71','d80','d81','d82','g64','x64','t64','tap','prg','p00','crt'], aliases: ['c64','commodore 64','commodore64'], thumbnailRepo: 'Commodore_-_64',  medium: 'floppy', keyboard: true },
  vic20:     { label: 'Commodore VIC-20',   defaultCore: 'vice_xvic',        cores: ['vice_xvic'],                    exts: ['20','40','60','a0','b0','rom'], aliases: ['vic20','vic-20','commodore vic-20'],                    thumbnailRepo: 'Commodore_-_VIC-20',                             medium: 'floppy', keyboard: true },
  amiga:     { label: 'Commodore Amiga',    defaultCore: 'puae',             cores: ['puae'],                         exts: ['adf','adz','dms','fdi','ipf','hdf','hdz','lha','uae'], aliases: ['amiga','commodore amiga','a500','a1200','amiga 500','amiga 1200'], thumbnailRepo: 'Commodore_-_Amiga', medium: 'floppy', keyboard: true },
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
};
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

// .bin is ambiguous (Atari 2600 / Mega Drive / PSX / …). When detection sees a
// bare .bin we default to Atari 2600, the only .bin system we ship sample
// content for. Override with an explicit `core`/`system`, or ?core= in the URL.
const AMBIGUOUS_EXT_DEFAULT = { bin: 'stella2014' };

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
