#!/usr/bin/env node
// Build the CC0 "LWX Zap Gallery" NES light-gun game from games/nes-gallery/.
//
// A real Zapper shooting gallery (see games/nes-gallery/main.c). This script
// generates the CHR bank — solid field tiles, a 16x16 circular bullseye target
// metasprite (tiles 2..5), and a 0-9 / A-Z font (tiles 16.. / 32..) — then
// compiles with cc65 and copies the ROM into public/roms/freeware/.
//
// Pipeline mirrors scripts/make-nes-zapper-test.mjs. Only main.c is "ours"; the
// neslib boilerplate in the game dir is frozen. Output ROM is CC0.
//
// Needs cc65 (looked up via $CC65_HOME\bin, C:\cc65\bin, then PATH).
// Usage: node scripts/make-nes-gallery.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'nes-gallery');
const ROM_NAME = 'lwx-nes-gallery.nes';
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', ROM_NAME);

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

// --- CHR helpers -------------------------------------------------------------
const chr = Buffer.alloc(8192, 0);

// Pack an 8x8 color grid (rows of 8 values 0..3) into the 16-byte 2bpp tile.
function putTile(id, grid) {
  const base = id * 16;
  for (let y = 0; y < 8; y++) {
    let p0 = 0, p1 = 0;
    for (let x = 0; x < 8; x++) {
      const c = grid[y][x] | 0;
      p0 |= ((c & 1) ? 1 : 0) << (7 - x);
      p1 |= ((c & 2) ? 1 : 0) << (7 - x);
    }
    chr[base + y] = p0;
    chr[base + 8 + y] = p1;
  }
}

// Build an 8x8 grid from 8 strings: '.'=0, '1'/'2'/'3' = color index.
function grid8(rows) {
  return rows.map((r) => Array.from({ length: 8 }, (_, x) => {
    const ch = r[x] || '.';
    return ch === '.' ? 0 : (ch.charCodeAt(0) - 48);
  }));
}

// Solid color tile (all 8x8 = color c).
function solid(c) { return Array.from({ length: 8 }, () => Array(8).fill(c)); }

putTile(0, solid(0));   // T_BLANK — transparent/black field
putTile(1, solid(1));   // T_WHITE — solid white

// --- 16x16 circular bullseye target -> tiles 2,3,4,5 (TL,TR,BL,BR) -----------
// White disc (color 1) with a small red centre (color 2) on a transparent field.
const big = Array.from({ length: 16 }, () => Array(16).fill(0));
for (let y = 0; y < 16; y++) {
  for (let x = 0; x < 16; x++) {
    const dx = x - 7.5, dy = y - 7.5;
    const r2 = dx * dx + dy * dy;
    if (r2 <= 7.4 * 7.4) big[y][x] = 1;       // white disc
    if (r2 <= 2.4 * 2.4) big[y][x] = 2;       // red bullseye centre
  }
}
function quadrant(ox, oy) {
  return Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => big[oy + y][ox + x]));
}
putTile(2, quadrant(0, 0));   // TL
putTile(3, quadrant(8, 0));   // TR
putTile(4, quadrant(0, 8));   // BL
putTile(5, quadrant(8, 8));   // BR

// --- font: 0-9 -> tiles 16.., A-Z -> tiles 32.. ------------------------------
// Compact 5x7 uppercase glyphs ('1' = white pixel). Authored here (CC0).
const FONT = {
  '0': ['.111....', '1...1...', '1...1...', '1...1...', '1...1...', '1...1...', '.111....', '........'],
  '1': ['..1.....', '.11.....', '..1.....', '..1.....', '..1.....', '..1.....', '.111....', '........'],
  '2': ['.111....', '1...1...', '....1...', '...1....', '..1.....', '.1......', '11111...', '........'],
  '3': ['1111....', '....1...', '...1....', '..11....', '....1...', '1...1...', '.111....', '........'],
  '4': ['...1....', '..11....', '.1.1....', '1..1....', '11111...', '...1....', '...1....', '........'],
  '5': ['11111...', '1.......', '1111....', '....1...', '....1...', '1...1...', '.111....', '........'],
  '6': ['..11....', '.1......', '1.......', '1111....', '1...1...', '1...1...', '.111....', '........'],
  '7': ['11111...', '....1...', '...1....', '..1.....', '.1......', '.1......', '.1......', '........'],
  '8': ['.111....', '1...1...', '1...1...', '.111....', '1...1...', '1...1...', '.111....', '........'],
  '9': ['.111....', '1...1...', '1...1...', '.1111...', '....1...', '...1....', '.11.....', '........'],
  'A': ['.111....', '1...1...', '1...1...', '11111...', '1...1...', '1...1...', '1...1...', '........'],
  'B': ['1111....', '1...1...', '1...1...', '1111....', '1...1...', '1...1...', '1111....', '........'],
  'C': ['.111....', '1...1...', '1.......', '1.......', '1.......', '1...1...', '.111....', '........'],
  'D': ['111.....', '1..1....', '1...1...', '1...1...', '1...1...', '1..1....', '111.....', '........'],
  'E': ['11111...', '1.......', '1.......', '1111....', '1.......', '1.......', '11111...', '........'],
  'F': ['11111...', '1.......', '1.......', '1111....', '1.......', '1.......', '1.......', '........'],
  'G': ['.111....', '1...1...', '1.......', '1.111...', '1...1...', '1...1...', '.111....', '........'],
  'H': ['1...1...', '1...1...', '1...1...', '11111...', '1...1...', '1...1...', '1...1...', '........'],
  'I': ['.111....', '..1.....', '..1.....', '..1.....', '..1.....', '..1.....', '.111....', '........'],
  'J': ['..111...', '...1....', '...1....', '...1....', '1..1....', '1..1....', '.11.....', '........'],
  'K': ['1...1...', '1..1....', '1.1.....', '11......', '1.1.....', '1..1....', '1...1...', '........'],
  'L': ['1.......', '1.......', '1.......', '1.......', '1.......', '1.......', '11111...', '........'],
  'M': ['1...1...', '11.11...', '1.1.1...', '1...1...', '1...1...', '1...1...', '1...1...', '........'],
  'N': ['1...1...', '11..1...', '1.1.1...', '1..11...', '1...1...', '1...1...', '1...1...', '........'],
  'O': ['.111....', '1...1...', '1...1...', '1...1...', '1...1...', '1...1...', '.111....', '........'],
  'P': ['1111....', '1...1...', '1...1...', '1111....', '1.......', '1.......', '1.......', '........'],
  'Q': ['.111....', '1...1...', '1...1...', '1...1...', '1.1.1...', '1..1....', '.11.1...', '........'],
  'R': ['1111....', '1...1...', '1...1...', '1111....', '1.1.....', '1..1....', '1...1...', '........'],
  'S': ['.1111...', '1.......', '1.......', '.111....', '....1...', '....1...', '1111....', '........'],
  'T': ['11111...', '..1.....', '..1.....', '..1.....', '..1.....', '..1.....', '..1.....', '........'],
  'U': ['1...1...', '1...1...', '1...1...', '1...1...', '1...1...', '1...1...', '.111....', '........'],
  'V': ['1...1...', '1...1...', '1...1...', '1...1...', '1...1...', '.1.1....', '..1.....', '........'],
  'W': ['1...1...', '1...1...', '1...1...', '1.1.1...', '1.1.1...', '11.11...', '1...1...', '........'],
  'X': ['1...1...', '1...1...', '.1.1....', '..1.....', '.1.1....', '1...1...', '1...1...', '........'],
  'Y': ['1...1...', '1...1...', '.1.1....', '..1.....', '..1.....', '..1.....', '..1.....', '........'],
  'Z': ['11111...', '....1...', '...1....', '..1.....', '.1......', '1.......', '11111...', '........'],
};
for (let d = 0; d <= 9; d++) putTile(16 + d, grid8(FONT[String(d)]));
for (let i = 0; i < 26; i++) putTile(32 + i, grid8(FONT[String.fromCharCode(65 + i)]));

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

copyFileSync(join(GAME_DIR, ROM_NAME), OUT);
for (const f of ['tiles.chr', 'main.o', 'crt0.o', ROM_NAME]) {
  try { rmSync(join(GAME_DIR, f)); } catch {}
}
console.log(`\nWrote ${OUT}`);
