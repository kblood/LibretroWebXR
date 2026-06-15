#!/usr/bin/env node
// Build the CC0 "LWX Bomberman" NES game from games/nes-bomberman/ into a .nes.
//
// Pipeline (the cc65 + neslib template-fill workflow):
//   1. generate tiles.chr from the readable tile maps below
//      (0 floor, 1 wall, 2 brick, 3-6 bomb, 7 flame, 8-11 player)
//   2. cl65 -t nes -C nes.cfg  main.c crt0.s  ->  NROM .nes
//   3. copy to public/roms/freeware/lwx-nes-bomberman.nes
// Only games/nes-bomberman/main.c is "ours to write"; the neslib boilerplate
// (crt0.s, *.sinc, neslib.h — zlib, Shiru) is frozen. Output ROM is CC0.
//
// Needs cc65 installed. Looked up via: $CC65_HOME\bin, C:\cc65\bin, then PATH.
//
// Usage: node scripts/make-nes-bomberman.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'nes-bomberman');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-nes-bomberman.nes');
const ROM_NAME = 'lwx-nes-bomberman.nes';

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

// --- 1. generate CHR -----------------------------------------------------
// Tile maps use '.'=colour 0, '1'..'3' = colours 1..3 (2-bit NES pixels).
// Each 8x8 tile -> 16 bytes (8 bitplane-0 rows, then 8 bitplane-1 rows).
const COL = { '.': 0, '1': 1, '2': 2, '3': 3 };

function tileBytes(rows /* 8 strings of length 8 */) {
  const out = [];
  for (let plane = 0; plane < 2; plane++) {
    for (let y = 0; y < 8; y++) {
      let byte = 0;
      for (let x = 0; x < 8; x++) {
        const c = COL[rows[y][x]] ?? 0;
        byte = (byte << 1) | ((c >> plane) & 1);
      }
      out.push(byte);
    }
  }
  return out; // 16 bytes
}

// Split a 16x16 map (16 strings of length 16) into TL,TR,BL,BR tiles.
function split16(rows16) {
  const sub = (ox, oy) => {
    const r = [];
    for (let y = 0; y < 8; y++) r.push(rows16[oy + y].slice(ox, ox + 8));
    return tileBytes(r);
  };
  return [sub(0, 0), sub(8, 0), sub(0, 8), sub(8, 8)];
}

const FLOOR = [
  '........', '........', '........', '........',
  '........', '........', '........', '........',
];
const WALL = [
  '11111111', '11111111', '11111111', '11111111',
  '11111111', '11111111', '11111111', '11111111',
];
const BRICK = [
  '22232222', '22232222', '22232222', '33333333',
  '22222223', '22222223', '22222223', '33333333',
];
const FLAME = [
  '23322332', '33333333', '33233233', '33333333',
  '33333333', '33233233', '33333333', '23322332',
];
const BOMB16 = [
  '.......33.......',
  '.......3........',
  '......3.........',
  '....111111......',
  '...11111111.....',
  '..1111111111....',
  '..1131111111....',
  '.111111111111...',
  '.111111111111...',
  '.111111111111...',
  '.111111111111...',
  '..1111111111....',
  '..1111111111....',
  '...11111111.....',
  '....111111......',
  '................',
];
const PLAYER16 = [
  '.....11111......',
  '....1111111.....',
  '...11111111.....',
  '...11311311.....',
  '...11311311.....',
  '...11111111.....',
  '....1111111.....',
  '.....22222......',
  '...11111111.....',
  '..111111111111..',
  '..111211112111..',
  '..111111111111..',
  '..111111111111..',
  '...111...111....',
  '...222...222....',
  '................',
];

const chr = Buffer.alloc(8192, 0);
function putTile(id, bytes) { for (let b = 0; b < 16; b++) chr[id * 16 + b] = bytes[b]; }

putTile(0, tileBytes(FLOOR));
putTile(1, tileBytes(WALL));
putTile(2, tileBytes(BRICK));
split16(BOMB16).forEach((t, n) => putTile(3 + n, t));   // 3,4,5,6
putTile(7, tileBytes(FLAME));
split16(PLAYER16).forEach((t, n) => putTile(8 + n, t)); // 8,9,10,11

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
