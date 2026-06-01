#!/usr/bin/env node
// Build the CC0 "LWX Beam Dodger" Atari 2600 game from games/atari-dodger/
// into a .a26 ROM for the stella2014 core.
//
// Pipeline (the research's recommended batari Basic path):
//   1. locate batari Basic (bB) install  ->  C:\Atari2600\bB
//   2. run 2600bas.bat game.bas  in a scratch dir (bB writes outputs next to
//      the source) with the `bB` env var set and the bB dir on PATH so its
//      helper exes (preprocess, 2600basic, postprocess, dasm, bbfilter,
//      relocateBB) resolve.
//   3. copy the produced game.bas.bin  ->  public/roms/freeware/lwx-atari-dodger.a26
//
// Only games/atari-dodger/game.bas is "ours to write"; bB generates the TIA
// kernel + 6502. The output ROM is CC0 (bB's GPL does not taint the ROM).
//
// GOTCHA (auto-handled below): the dasm.exe bundled with bB 1.8 (a
// 2.20.15-SNAPSHOT build) SEGFAULTS on Windows and silently emits a 0-byte
// .bin. We swap in the stable dasm 2.20.14.1 win-x64 release. If the bundled
// dasm has already been replaced (size matches the stable build) we skip the
// swap. To force a re-fetch, delete C:\Atari2600\dasm-stable\dasm.exe.
//
// Needs batari Basic installed at C:\Atari2600\bB (set BB_HOME to override).
// Install: download bB-1.8-win-x64.zip from
//   https://github.com/batari-Basic/batari-Basic/releases/tag/v1.8
// and extract so that C:\Atari2600\bB\2600bas.bat exists. (v1.9 ships WASM
// only — use the v1.8 native Windows zip.)
//
// Usage: node scripts/make-atari-dodger.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, mkdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'atari-dodger');
const SRC = join(GAME_DIR, 'game.bas');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-atari-dodger.a26');

// --- locate batari Basic --------------------------------------------------
const BB_HOME = process.env.BB_HOME || process.env.bB || 'C:\\Atari2600\\bB';
const BAT = join(BB_HOME, '2600bas.bat');
const DASM = join(BB_HOME, 'dasm.exe');

if (!existsSync(BAT)) {
  console.error(`batari Basic not found at ${BB_HOME} (expected ${BAT}).`);
  console.error('Download bB-1.8-win-x64.zip from');
  console.error('  https://github.com/batari-Basic/batari-Basic/releases/tag/v1.8');
  console.error('and extract so that 2600bas.bat exists there (or set BB_HOME).');
  process.exit(2);
}

// --- ensure a working dasm (swap the crashing bundled SNAPSHOT) -----------
// The stable dasm 2.20.14.1 win-x64 dasm.exe is ~227662 bytes; the bundled
// SNAPSHOT is larger and segfaults. Replace if the current one isn't the
// stable size.
const STABLE_DASM_SIZE = 227662;
const STABLE_DASM_URL =
  'https://github.com/dasm-assembler/dasm/releases/download/2.20.14.1/dasm-2.20.14.1-win-x64.zip';
const DASM_CACHE_DIR = join(dirname(BB_HOME), 'dasm-stable');
const DASM_CACHE = join(DASM_CACHE_DIR, 'dasm.exe');

function ensureGoodDasm() {
  if (existsSync(DASM) && statSync(DASM).size === STABLE_DASM_SIZE) return; // already good

  if (!(existsSync(DASM_CACHE) && statSync(DASM_CACHE).size === STABLE_DASM_SIZE)) {
    console.log('Fetching stable dasm 2.20.14.1 (bundled bB dasm crashes on Windows)...');
    mkdirSync(DASM_CACHE_DIR, { recursive: true });
    const zip = join(DASM_CACHE_DIR, 'dasm-stable.zip');
    // curl + Expand-Archive are both present on Windows 10/11.
    const dl = spawnSync('curl', ['-sL', '-o', zip, STABLE_DASM_URL], { stdio: 'inherit' });
    if (dl.status !== 0) { console.error('Failed to download stable dasm.'); process.exit(3); }
    const ex = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path '${zip}' -DestinationPath '${DASM_CACHE_DIR}' -Force`,
    ], { stdio: 'inherit' });
    if (ex.status !== 0 || !existsSync(DASM_CACHE)) {
      console.error('Failed to extract stable dasm.'); process.exit(3);
    }
  }

  // Back up the bundled dasm once, then swap in the stable one.
  const bak = join(BB_HOME, 'dasm-bundled.exe.bak');
  if (existsSync(DASM) && !existsSync(bak)) {
    try { copyFileSync(DASM, bak); } catch {}
  }
  copyFileSync(DASM_CACHE, DASM);
  console.log(`Installed stable dasm into ${DASM}`);
}
ensureGoodDasm();

// --- build in a scratch dir (bB writes its outputs next to the source) ----
const WORK = join(tmpdir(), `lwx-atari-dodger-${process.pid}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
copyFileSync(SRC, join(WORK, 'game.bas'));

const env = { ...process.env, bB: BB_HOME, PATH: `${BB_HOME};${process.env.PATH}` };
console.log(`> ${BAT} game.bas   (cwd: ${WORK}, bB=${BB_HOME})`);
const r = spawnSync('cmd.exe', ['/c', BAT, 'game.bas'], { cwd: WORK, env, stdio: 'inherit' });
if (r.error) {
  console.error(`\nFailed to run ${BAT}: ${r.error.message}`);
  process.exit(2);
}

// --- verify the produced ROM ----------------------------------------------
const bin = join(WORK, 'game.bas.bin');
if (!existsSync(bin) || statSync(bin).size === 0) {
  console.error('\nBuild produced no ROM (0-byte or missing game.bas.bin).');
  console.error('Check the bB compile/dasm output above.');
  process.exit(1);
}
const size = statSync(bin).size;
if (size !== 2048 && size !== 4096) {
  console.warn(`\nWarning: ROM size ${size} is not the usual 2K/4K for a 2600 cart.`);
}

// --- publish + clean -------------------------------------------------------
mkdirSync(dirname(OUT), { recursive: true });
copyFileSync(bin, OUT);
rmSync(WORK, { recursive: true, force: true });
console.log(`\nWrote ${OUT} (${size} bytes)`);
