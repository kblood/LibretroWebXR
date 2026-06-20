#!/usr/bin/env node
// Build the CC0 "LWX Zapper Test" NES diagnostic ROM from games/nes-zapper-test/.
//
// A minimal light-gun verification target (see games/nes-zapper-test/main.c):
// a white box on black; the backdrop recolours from the Zapper's light + trigger
// bits so the browser->core lightgun path is directly observable.
//
// Pipeline mirrors scripts/make-nes-bomberman.mjs:
//   1. generate tiles.chr — tile 0 = solid colour 0 (black), tile 1 = solid colour 1
//   2. cl65 -t nes -C nes.cfg main.c crt0.s -> NROM .nes
//   3. copy to public/roms/freeware/lwx-nes-zapper-test.nes
// Only main.c is "ours"; the neslib boilerplate is frozen. Output ROM is CC0.
//
// Needs cc65 (looked up via $CC65_HOME\bin, C:\cc65\bin, then PATH).
// Usage: node scripts/make-nes-zapper-test.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'nes-zapper-test');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-nes-zapper-test.nes');
const ROM_NAME = 'lwx-nes-zapper-test.nes';

function findCl65() {
  const exe = process.platform === 'win32' ? 'cl65.exe' : 'cl65';
  const candidates = [
    process.env.CC65_HOME && join(process.env.CC65_HOME, 'bin', exe),
    'C:\\cc65\\bin\\cl65.exe',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return exe;
}
const CL65 = findCl65();

// --- generate CHR: tile 0 = solid colour 0, tile 1 = solid colour 1 ----------
// A solid 2-bit colour C tile = 16 bytes: plane0 rows = 0xFF if (C&1), plane1
// rows = 0xFF if (C&2). Colour 0 -> all 0x00; colour 1 -> plane0 0xFF, plane1 0x00.
const chr = Buffer.alloc(8192, 0);
function putSolid(id, color) {
  for (let y = 0; y < 8; y++) chr[id * 16 + y]     = (color & 1) ? 0xff : 0x00; // plane 0
  for (let y = 0; y < 8; y++) chr[id * 16 + 8 + y] = (color & 2) ? 0xff : 0x00; // plane 1
}
putSolid(0, 0);   // black
putSolid(1, 1);   // white (palette entry 1)

writeFileSync(join(GAME_DIR, 'tiles.chr'), chr);

// --- build -------------------------------------------------------------------
const args = ['-t', 'nes', '-C', 'nes.cfg', '-Oisr', 'main.c', 'crt0.s', '-o', ROM_NAME];
console.log(`> ${CL65} ${args.join(' ')}   (cwd: ${GAME_DIR})`);
const r = spawnSync(CL65, args, { cwd: GAME_DIR, stdio: 'inherit' });
if (r.error) {
  console.error(`\nFailed to run cl65 (${CL65}). Install cc65 and/or set CC65_HOME.`);
  console.error(r.error.message);
  process.exit(2);
}
if (r.status !== 0) { console.error(`\ncl65 exited ${r.status}`); process.exit(r.status || 1); }

// --- publish + clean ---------------------------------------------------------
copyFileSync(join(GAME_DIR, ROM_NAME), OUT);
for (const f of ['tiles.chr', 'main.o', 'crt0.o', ROM_NAME]) {
  try { rmSync(join(GAME_DIR, f)); } catch {}
}
console.log(`\nWrote ${OUT}`);
