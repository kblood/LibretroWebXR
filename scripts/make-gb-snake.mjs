#!/usr/bin/env node
// Build the CC0 "LWX Snake" Game Boy game from games/gb-snake/ into a .gb ROM.
//
// Pipeline (the research's recommended GBDK-2020 workflow):
//   1. lcc -Wm-yn"LWX SNAKE" -o lwx-gb-snake.gb main.c   ->  DMG ROM (ROM-only)
//   2. copy to public/roms/freeware/lwx-gb-snake.gb
// Only games/gb-snake/main.c is "ours to write" (CC0); all the GB boot/header
// boilerplate is supplied by GBDK's frozen crt0 + makebin, never hand-written.
// GBDK's GPLv2+Linking-Exception means the compiled ROM carries no GPL
// obligations, so the output ROM is clean CC0.
//
// Needs GBDK-2020 installed. lcc is looked up via: $GBDK_HOME\bin,
// C:\gbdk-2020\bin, C:\gbdk\bin, then PATH.
//
// Usage: node scripts/make-gb-snake.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'gb-snake');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-gb-snake.gb');
const ROM_NAME = 'lwx-gb-snake.gb';

// --- locate lcc (GBDK-2020 front-end driver) -----------------------------
function findLcc() {
  const exe = process.platform === 'win32' ? 'lcc.exe' : 'lcc';
  const candidates = [
    process.env.GBDK_HOME && join(process.env.GBDK_HOME, 'bin', exe),
    'C:\\gbdk-2020\\bin\\lcc.exe',
    'C:\\gbdk\\bin\\lcc.exe',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return exe; // fall back to PATH
}
const LCC = findLcc();

// --- build ---------------------------------------------------------------
// -Wm-yn... sets the cart title in the header (<=15 chars, no space so the
// arg survives shell quoting on every platform). ROM-only (no MBC) is fine
// for a game this small; lcc/makebin fixes up the Nintendo logo and header
// checksum automatically.
const args = ['-Wm-ynLWX_SNAKE', '-o', ROM_NAME, 'main.c'];
console.log(`> ${LCC} ${args.join(' ')}   (cwd: ${GAME_DIR})`);
const r = spawnSync(LCC, args, { cwd: GAME_DIR, stdio: 'inherit' });
if (r.error) {
  console.error(`\nFailed to run lcc (${LCC}). Install GBDK-2020 and/or set GBDK_HOME.`);
  console.error(r.error.message);
  process.exit(2);
}
if (r.status !== 0) { console.error(`\nlcc exited ${r.status}`); process.exit(r.status || 1); }

// --- publish + clean intermediates --------------------------------------
const built = join(GAME_DIR, ROM_NAME);
if (!existsSync(built)) { console.error(`\nExpected ${built} but it was not produced.`); process.exit(1); }
copyFileSync(built, OUT);
for (const f of [ROM_NAME, 'main.o', 'main.lst', 'main.sym', 'main.asm', 'main.adb', 'main.rel', 'main.map', 'main.noi', 'main.ihx', 'main.cdb']) {
  try { rmSync(join(GAME_DIR, f)); } catch {}
}
console.log(`\nWrote ${OUT} (${statSync(OUT).size} bytes)`);
