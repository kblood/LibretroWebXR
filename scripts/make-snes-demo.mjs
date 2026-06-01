#!/usr/bin/env node
// Build the CC0 "LWX SNES Demo" game from games/snes-demo/ into a LoROM .sfc ROM.
//
// Pipeline (the research's recommended PVSnesLib template-fill workflow):
//   1. gfx4snes converts pvsneslibfont.bmp -> font tiles (BG tile set + text)
//      and sprites.bmp -> the 16x16 player sprite  (driven by the Makefile)
//   2. PVSnesLib's make rules: 816-tcc -> 816-opt -> constify -> wla-65816 ->
//      wlalink  => snesdemo.sfc (256K LoROM, header from hdr.asm)
//   3. copy to public/roms/freeware/lwx-snes-demo.sfc
// Only games/snes-demo/snesdemo.c is "ours to write"; hdr.asm / data.asm /
// Makefile are frozen PVSnesLib template boilerplate, and the font/sprite art
// are PVSnesLib (MIT) example assets. The compiled ROM is CC0.
//
// PVSnesLib's Makefiles need GNU make + a Unix shell (sh/sed/ls/rm/echo/find).
// This script supplies them WITHOUT any interactive installer:
//   * make:  GNU `mingw32-make` (e.g. from a MinGW-w64 install) -- looked up via
//            $MAKE, then common install dirs, then PATH.
//   * shell: the `sh.exe` + coreutils that ship with Git for Windows -- looked
//            up via $GIT_BASH_BIN, then common install dirs. We pass SHELL=<that
//            sh.exe> to make and prepend its dir to PATH so the recipes' Unix
//            tools resolve.
//   * OS= :  PVSnesLib's snes_rules has a Windows-only path-munge branch that
//            emits a malformed library path under a real Unix shell. Forcing
//            make's OS variable empty selects the (correct) Unix branch.
//
// PVSnesLib itself is looked up via $PVSNESLIB_HOME (Windows path ok here; it is
// converted to the required /c/... Unix style for make), then C:\pvsneslib.
//
// Usage: node scripts/make-snes-demo.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'snes-demo');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-snes-demo.sfc');
const ROM_NAME = 'snesdemo.sfc';

// --- locate PVSnesLib -----------------------------------------------------
function findPvsneslib() {
  const candidates = [process.env.PVSNESLIB_HOME, 'C:\\pvsneslib', '/c/pvsneslib'].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'devkitsnes', 'snes_rules'))) return c;
  }
  return null;
}

// --- locate GNU make (mingw32-make / make) --------------------------------
function findMake() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    process.env.MAKE,
    `C:\\ProgramData\\mingw64\\mingw64\\bin\\mingw32-make${exe}`,
    `C:\\msys64\\usr\\bin\\make${exe}`,
    `C:\\MinGW\\bin\\mingw32-make${exe}`,
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  // fall back to PATH names
  return `mingw32-make${exe}`;
}

// --- locate the Unix shell + coreutils (Git for Windows) ------------------
function findShellBin() {
  const candidates = [
    process.env.GIT_BASH_BIN,
    'C:\\Program Files\\Git\\usr\\bin',
    'C:\\Program Files (x86)\\Git\\usr\\bin',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, 'sh.exe'))) return c;
  return null;
}

// PVSnesLib's snes_rules rejects PVSNESLIB_HOME if it contains a backslash, so
// the path must use forward slashes. We keep the drive letter (C:/pvsneslib)
// rather than /c/pvsneslib so native (non-MSYS) make can still `include` it via
// fopen -- a /c/ mount only exists inside an MSYS/Cygwin shell, not under Node.
function toMakePath(p) {
  return p.replace(/\\/g, '/');
}

const PVSNESLIB = findPvsneslib();
if (!PVSNESLIB) {
  console.error('Could not find PVSnesLib. Install it to C:\\pvsneslib (devkitsnes/snes_rules must exist)');
  console.error('or set PVSNESLIB_HOME. Download: https://github.com/alekmaul/pvsneslib/releases');
  process.exit(2);
}
const MAKE = findMake();
const SHELL_BIN = findShellBin();
if (!SHELL_BIN) {
  console.error('Could not find a Unix shell (sh.exe). Install Git for Windows (https://git-scm.com/download/win)');
  console.error('or set GIT_BASH_BIN to the dir containing sh.exe (e.g. C:\\Program Files\\Git\\usr\\bin).');
  process.exit(2);
}

const SH = join(SHELL_BIN, 'sh.exe');
const PVSNESLIB_MAKE = toMakePath(PVSNESLIB);

// Prepend the Unix-tools dir so make's recipes (sed/ls/rm/echo/find) resolve.
const env = {
  ...process.env,
  PVSNESLIB_HOME: PVSNESLIB_MAKE,
  PATH: `${SHELL_BIN};${process.env.PATH || ''}`,
};

// SHELL=<git sh> makes make run recipes under a real Unix shell.
// OS= selects PVSnesLib's Unix path branch (the Windows branch breaks under sh).
const args = [`SHELL=${SH}`, 'OS='];

console.log(`PVSnesLib : ${PVSNESLIB}  (as ${PVSNESLIB_MAKE})`);
console.log(`make      : ${MAKE}`);
console.log(`shell     : ${SH}`);
console.log(`> ${MAKE} ${args.join(' ')}   (cwd: ${GAME_DIR})`);

// Clean first so the build is deterministic (PVSnesLib ships prebuilt artifacts).
spawnSync(MAKE, [...args, 'clean'], { cwd: GAME_DIR, env, stdio: 'inherit' });

const r = spawnSync(MAKE, args, { cwd: GAME_DIR, env, stdio: 'inherit' });
if (r.error) {
  console.error(`\nFailed to run make (${MAKE}). ${r.error.message}`);
  process.exit(2);
}
if (r.status !== 0) { console.error(`\nmake exited ${r.status}`); process.exit(r.status || 1); }

// --- publish + clean intermediates ----------------------------------------
const built = join(GAME_DIR, ROM_NAME);
if (!existsSync(built)) { console.error(`\nBuild produced no ${ROM_NAME}`); process.exit(1); }
copyFileSync(built, OUT);

// Remove generated intermediates (keep the source + bmp assets).
for (const f of [
  ROM_NAME, 'snesdemo.sym', 'snesdemo.obj', 'data.obj', 'hdr.obj', 'linkfile',
  'pvsneslibfont.pic', 'pvsneslibfont.pal', 'pvsneslibfont.inc', 'pvsneslibfont_data.as',
  'sprites.pic', 'sprites.pal', 'sprites.inc', 'sprites_data.as',
]) {
  try { rmSync(join(GAME_DIR, f)); } catch {}
}

console.log(`\nWrote ${OUT}`);
