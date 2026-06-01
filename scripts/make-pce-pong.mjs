#!/usr/bin/env node
// Build the CC0 "LWX Pong" PC Engine / TurboGrafx-16 game from games/pce-pong/
// into a .pce HuCard ROM.
//
// Pipeline (the research's recommended HuC batteries-included workflow):
//   1. huc -O2 main.c   ->  main.pce  (HuC writes the HuCard header + banks)
//   2. copy to public/roms/freeware/lwx-pce-pong.pce
// Only games/pce-pong/main.c is "ours to write"; HuC's startup code and runtime
// library do all the hardware bring-up. Output ROM is CC0.
//
// Needs HuC installed (prebuilt Win64 zip from pce-devel/huc, extracted so that
// huc.exe is under C:\tools\huc\bin). HuC's compiler driver shells out to
// pceas.exe (must be on PATH) and resolves its C library via the PCE_INCLUDE
// environment variable -- the script sets both, mirroring how make-nes-pong.mjs
// hardcodes the cc65 path because it isn't on PATH.
//
// Usage: node scripts/make-pce-pong.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'pce-pong');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-pce-pong.pce');
const ROM_NAME = 'main.pce';

// --- locate the HuC install ---------------------------------------------
// Looked up via: $HUC_HOME, then C:\tools\huc (the documented install dir).
function findHucHome() {
  const candidates = [
    process.env.HUC_HOME,
    'C:\\tools\\huc',
    '/opt/huc',
  ].filter(Boolean);
  for (const c of candidates) {
    const exe = process.platform === 'win32' ? 'huc.exe' : 'huc';
    if (existsSync(join(c, 'bin', exe))) return c;
  }
  return null;
}

const HUC_HOME = findHucHome();
if (!HUC_HOME) {
  console.error('Could not find HuC. Install the prebuilt Win64 zip to C:\\tools\\huc');
  console.error('(huc.exe must end up at C:\\tools\\huc\\bin\\huc.exe), or set HUC_HOME.');
  console.error('Download: https://github.com/pce-devel/huc/releases/download/current/huc-2026-05-28-Win64.zip');
  process.exit(2);
}

const BIN = join(HUC_HOME, 'bin');
const HUC = join(BIN, process.platform === 'win32' ? 'huc.exe' : 'huc');
// HuC's C library (huc.h + the .asm runtime) lives in include/huc.
const INCLUDE = join(HUC_HOME, 'include', 'huc');

// huc shells out to pceas (must be on PATH) and finds its includes via PCE_INCLUDE.
const env = {
  ...process.env,
  PCE_INCLUDE: INCLUDE,
  PATH: `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
};

// --- 1. build ------------------------------------------------------------
const args = ['-O2', 'main.c'];
console.log(`> ${HUC} ${args.join(' ')}   (cwd: ${GAME_DIR})`);
console.log(`  PCE_INCLUDE=${INCLUDE}`);
const r = spawnSync(HUC, args, { cwd: GAME_DIR, env, stdio: 'inherit' });
if (r.error) {
  console.error(`\nFailed to run huc (${HUC}). Install HuC and/or set HUC_HOME.`);
  console.error(r.error.message);
  process.exit(2);
}
if (r.status !== 0) { console.error(`\nhuc exited ${r.status}`); process.exit(r.status || 1); }

const built = join(GAME_DIR, ROM_NAME);
if (!existsSync(built)) {
  console.error(`\nhuc reported success but ${ROM_NAME} was not produced.`);
  process.exit(1);
}

// --- 2. publish + clean intermediates -----------------------------------
copyFileSync(built, OUT);
for (const f of [ROM_NAME, 'main.s', 'main.sym', 'main.lst']) {
  try { rmSync(join(GAME_DIR, f)); } catch {}
}
console.log(`\nWrote ${OUT}`);
