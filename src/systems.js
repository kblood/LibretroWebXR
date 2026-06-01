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
export const CORES = {
  // Legacy WebEmu cores (classic-script auto-init)
  snes9x:            { url: 'cores/snes9x_libretro.js',            exts: ['smc','sfc','swc','fig','bs'], label: 'SNES (snes9x)',               style: 'classic', license: 'Non-commercial' },
  nestopia:          { url: 'cores/nestopia_libretro.js',          exts: ['nes','fds','unf','unif'],     label: 'NES (nestopia)',              style: 'classic', license: 'GPLv2' },
  stella2014:        { url: 'cores/stella2014_libretro.js',        exts: ['a26','bin'],                  label: 'Atari 2600 (stella)',         style: 'classic', license: 'GPLv2' },
  genesis_plus_gx:   { url: 'cores/genesis_plus_gx_libretro.js',   exts: ['md','gen','smd'],             label: 'Genesis (genesis_plus_gx)',   style: 'classic', license: 'Non-commercial' },
  mgba:              { url: 'cores/mgba_libretro.js',              exts: ['gba'],                        label: 'GBA (mGBA)',                  style: 'classic', license: 'MPL-2.0' },
  mednafen_vb:       { url: 'cores/mednafen_vb_libretro.js',       exts: ['vb','vboy'],                  label: 'Virtual Boy (mednafen)',      style: 'classic', license: 'GPLv2' },

  // Modern libretro buildbot cores (ES-module factory)
  picodrive:         { url: 'cores/picodrive_libretro.js',         exts: ['sms','gg','md','gen','smd','32x','cue','iso'], label: 'Sega multi (picodrive)', style: 'module', license: 'Non-commercial' },
  gearsystem:        { url: 'cores/gearsystem_libretro.js',        exts: ['sms','gg','sg'],              label: 'SMS/GG (gearsystem)',         style: 'module', license: 'GPLv3' },
  fceumm:            { url: 'cores/fceumm_libretro.js',            exts: [],                             label: 'NES (fceumm)',                style: 'module', license: 'GPLv2' },
  gambatte:          { url: 'cores/gambatte_libretro.js',          exts: ['gb','gbc'],                   label: 'Game Boy/Color (gambatte)',   style: 'module', license: 'GPLv2' },
  mednafen_pce_fast: { url: 'cores/mednafen_pce_fast_libretro.js', exts: ['pce'],                        label: 'PC Engine/TurboGrafx (mednafen_pce_fast)', style: 'module', license: 'GPLv2' },
  vice_x64:          { url: 'cores/vice_x64_libretro.js',          exts: ['d64','d71','d80','d81','d82','g64','x64','t64','tap','prg','p00','crt'], label: 'C64 (VICE)', style: 'module', license: 'GPLv2' },
  vice_xvic:         { url: 'cores/vice_xvic_libretro.js',         exts: ['20','40','60','a0','b0','rom'], label: 'VIC-20 (VICE)',             style: 'module', license: 'GPLv2' },
};

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
  snes:      { label: 'Super Nintendo',     defaultCore: 'snes9x',           cores: ['snes9x'],                       exts: ['smc','sfc','swc','fig','bs'], aliases: ['snes','super nintendo','super famicom','sfc'],            thumbnailRepo: 'Nintendo_-_Super_Nintendo_Entertainment_System' },
  nes:       { label: 'Nintendo (NES)',     defaultCore: 'nestopia',         cores: ['nestopia','fceumm'],            exts: ['nes','fds','unf','unif'],     aliases: ['nes','nintendo','famicom','nintendo entertainment system'], thumbnailRepo: 'Nintendo_-_Nintendo_Entertainment_System' },
  gb:        { label: 'Game Boy',           defaultCore: 'gambatte',         cores: ['gambatte'],                     exts: ['gb'],                         aliases: ['gb','game boy','gameboy'],                               thumbnailRepo: 'Nintendo_-_Game_Boy' },
  gbc:       { label: 'Game Boy Color',     defaultCore: 'gambatte',         cores: ['gambatte'],                     exts: ['gbc'],                        aliases: ['gbc','game boy color','gameboy color'],                  thumbnailRepo: 'Nintendo_-_Game_Boy_Color' },
  gba:       { label: 'Game Boy Advance',   defaultCore: 'mgba',             cores: ['mgba'],                         exts: ['gba'],                        aliases: ['gba','game boy advance','gameboy advance'],              thumbnailRepo: 'Nintendo_-_Game_Boy_Advance' },
  vb:        { label: 'Virtual Boy',        defaultCore: 'mednafen_vb',      cores: ['mednafen_vb'],                  exts: ['vb','vboy'],                  aliases: ['vb','virtual boy','virtualboy'],                         thumbnailRepo: 'Nintendo_-_Virtual_Boy' },
  md:        { label: 'Sega Genesis',       defaultCore: 'genesis_plus_gx',  cores: ['genesis_plus_gx','picodrive'],  exts: ['md','gen','smd'],             aliases: ['md','genesis','mega drive','megadrive','sega genesis'],  thumbnailRepo: 'Sega_-_Mega_Drive_-_Genesis' },
  sms:       { label: 'Sega Master System', defaultCore: 'picodrive',        cores: ['picodrive','gearsystem'],       exts: ['sms'],                        aliases: ['sms','master system','sega master system','mark iii'],   thumbnailRepo: 'Sega_-_Master_System_-_Mark_III' },
  gg:        { label: 'Sega Game Gear',     defaultCore: 'picodrive',        cores: ['picodrive','gearsystem'],       exts: ['gg'],                         aliases: ['gg','game gear','gamegear'],                             thumbnailRepo: 'Sega_-_Game_Gear' },
  atari2600: { label: 'Atari 2600',         defaultCore: 'stella2014',       cores: ['stella2014'],                   exts: ['a26','bin'],                  aliases: ['atari2600','atari 2600','2600','vcs'],                   thumbnailRepo: 'Atari_-_2600' },
  pce:       { label: 'PC Engine / TG-16',  defaultCore: 'mednafen_pce_fast',cores: ['mednafen_pce_fast'],            exts: ['pce'],                        aliases: ['pce','pc engine','turbografx','turbografx-16','tg16'],   thumbnailRepo: 'NEC_-_PC_Engine_-_TurboGrafx_16' },
  c64:       { label: 'Commodore 64',       defaultCore: 'vice_x64',         cores: ['vice_x64'],                     exts: ['d64','d71','d80','d81','d82','g64','x64','t64','tap','prg','p00','crt'], aliases: ['c64','commodore 64','commodore64'], thumbnailRepo: 'Commodore_-_64' },
  vic20:     { label: 'Commodore VIC-20',   defaultCore: 'vice_xvic',        cores: ['vice_xvic'],                    exts: ['20','40','60','a0','b0','rom'], aliases: ['vic20','vic-20','commodore vic-20'],                    thumbnailRepo: 'Commodore_-_VIC-20' },
};

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
  // First system whose defaultCore (or cores list) includes this core.
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

// --- Cross-check at load: every system's cores must exist in CORES ---------
for (const [id, sys] of Object.entries(SYSTEMS)) {
  for (const c of sys.cores) {
    if (!CORES[c]) console.warn(`[systems] system '${id}' references unknown core '${c}'`);
  }
  if (!sys.cores.includes(sys.defaultCore)) {
    console.warn(`[systems] system '${id}' defaultCore '${sys.defaultCore}' not in its cores list`);
  }
}
