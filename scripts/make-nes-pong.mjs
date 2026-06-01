#!/usr/bin/env node
// Build the CC0 "LWX Pong" NES game from games/nes-pong/ into a .nes ROM.
//
// Pipeline (the research's recommended cc65 + neslib template-fill workflow):
//   1. generate tiles.chr  (tile 0 = blank, tile 1 = solid 8x8 block)
//   2. cl65 -t nes -C nes.cfg  main.c crt0.s  ->  NROM .nes
//   3. copy to public/roms/freeware/lwx-nes-pong.nes
// Only games/nes-pong/main.c is "ours to write"; the neslib boilerplate
// (crt0.s, *.sinc, neslib.h — zlib, Shiru/clbr) is frozen. Output ROM is CC0.
//
// Needs cc65 installed. Looked up via: $CC65_HOME\bin, C:\cc65\bin, then PATH.
//
// Usage: node scripts/make-nes-pong.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'nes-pong');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-nes-pong.nes');
const ROM_NAME = 'lwx-nes-pong.nes';

// --- locate cl65 ---------------------------------------------------------
function findCl65() {
  const exe = process.platform === 'win32' ? 'cl65.exe' : 'cl65';
  const candidates = [
    process.env.CC65_HOME && join(process.env.CC65_HOME, 'bin', exe),
    'C:\\cc65\\bin\\cl65.exe',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return exe; // fall back to PATH
}
const CL65 = findCl65();

// --- 1. generate CHR: 512 tiles x 16 bytes; tile 1 = solid colour-1 block ---
const chr = Buffer.alloc(8192, 0);
for (let i = 0; i < 8; i++) chr[16 + i] = 0xff;   // tile 1, bit-plane 0 all set
writeFileSync(join(GAME_DIR, 'tiles.chr'), chr);

// --- 2. build ------------------------------------------------------------
const args = ['-t', 'nes', '-C', 'nes.cfg', '-Oisr', 'main.c', 'crt0.s', '-o', ROM_NAME];
console.log(`> ${CL65} ${args.join(' ')}   (cwd: ${GAME_DIR})`);
const r = spawnSync(CL65, args, { cwd: GAME_DIR, stdio: 'inherit' });
if (r.error) {
  console.error(`\nFailed to run cl65 (${CL65}). Install cc65 and/or set CC65_HOME.`);
  console.error(r.error.message);
  process.exit(2);
}
if (r.status !== 0) { console.error(`\ncl65 exited ${r.status}`); process.exit(r.status || 1); }

// --- 3. publish + clean intermediates -----------------------------------
copyFileSync(join(GAME_DIR, ROM_NAME), OUT);
for (const f of ['tiles.chr', 'main.o', 'crt0.o', ROM_NAME]) {
  try { rmSync(join(GAME_DIR, f)); } catch {}
}
console.log(`\nWrote ${OUT}`);
