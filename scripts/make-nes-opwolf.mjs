#!/usr/bin/env node
// Build the CC0 "LWX Frontline Fury (NES)" light-gun wave shooter from
// games/nes-opwolf/ — an NES-native design reference-port of our own SNES
// "LWX Frontline Fury" (games/snes-opwolf), NOT a code port (see main.c's
// header comment for why: nestopia's Zapper gives the ROM only a light-sense +
// trigger bit, no X/Y, so only ONE enemy can ever be "shootable" at a time).
//
// This script generates the CHR bank — solid field tile, a 16x16 soldier
// metasprite (tiles 2..5), a 16x16 dark "hit poof" metasprite (tiles 6..9), and
// the 0-9 / A-Z font (tiles 16.. / 32..) — then compiles with cc65 and copies
// the ROM into public/roms/freeware/.
//
// Pipeline mirrors scripts/make-nes-gallery.mjs (font generator reused
// verbatim — our own CC0 tooling, not game logic).
//
// Needs cc65 (looked up via $CC65_HOME\bin, C:\cc65\bin, then PATH).
// Usage: node scripts/make-nes-opwolf.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'nes-opwolf');
const ROM_NAME = 'lwx-nes-opwolf.nes';
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

// --- CHR helpers (verbatim from make-nes-gallery.mjs) ------------------------
const chr = Buffer.alloc(8192, 0);

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

function grid8(rows) {
  return rows.map((r) => Array.from({ length: 8 }, (_, x) => {
    const ch = r[x] || '.';
    return ch === '.' ? 0 : (ch.charCodeAt(0) - 48);
  }));
}

function solid(c) { return Array.from({ length: 8 }, () => Array(8).fill(c)); }

function quadrant(big, ox, oy) {
  return Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => big[oy + y][ox + x]));
}

putTile(0, solid(0));   // T_BLANK — transparent/black field
putTile(1, solid(1));   // solid color-1 tile (spare/unused, kept for parity with the gallery build)

// --- 16x16 soldier -> tiles 2,3,4,5 (TL,TR,BL,BR) ----------------------------
// A simple marching-figure silhouette in ONE colour (index 1) so it can be
// recoloured wholesale per-instance by sprite palette alone: palette 0 (bright
// white) marks the frontmost "active" soldier — the only one the Zapper's
// light-sense can register a hit on — while palette 1 (dark) renders every
// other soldier as a dim, unlit silhouette. See main.c's header comment for
// why: nestopia's Zapper gives the ROM only a light/trigger bit, never an X/Y
// position, so at most one shootable object can exist on screen at a time.
const soldier = Array.from({ length: 16 }, () => Array(16).fill(0));
for (let y = 0; y < 16; y++) {
  for (let x = 0; x < 16; x++) {
    let c = 0;
    if (y >= 1 && y <= 4 && x >= 6 && x <= 9) c = 1;              // head
    if (y >= 5 && y <= 11 && x >= 4 && x <= 11) c = 1;            // torso
    if ((y === 6 || y === 7) && (x === 3 || x === 12)) c = 1;     // arms
    if (y >= 12 && y <= 15 && (x >= 5 && x <= 6 || x >= 9 && x <= 10)) c = 1; // legs (marching stride)
    if (c) soldier[y][x] = c;
  }
}
putTile(2, quadrant(soldier, 0, 0));
putTile(3, quadrant(soldier, 8, 0));
putTile(4, quadrant(soldier, 0, 8));
putTile(5, quadrant(soldier, 8, 8));

// --- 16x16 hit poof -> tiles 6,7,8,9 (TL,TR,BL,BR) ---------------------------
// Deliberately DIM (drawn with the dark sprite palette, never the bright one)
// so a fading kill-poof can never itself register as a false light-hit on the
// next frame's Zapper read — see main.c.
const poof = Array.from({ length: 16 }, () => Array(16).fill(0));
for (let y = 0; y < 16; y++) {
  for (let x = 0; x < 16; x++) {
    const dx = x - 7.5, dy = y - 7.5, r = Math.sqrt(dx * dx + dy * dy);
    if (r <= 6.5 && (Math.abs(dx) < 1.6 || Math.abs(dy) < 1.6 ||
        Math.abs(dx - dy) < 1.6 || Math.abs(dx + dy) < 1.6)) poof[y][x] = 1;
  }
}
putTile(6, quadrant(poof, 0, 0));
putTile(7, quadrant(poof, 8, 0));
putTile(8, quadrant(poof, 0, 8));
putTile(9, quadrant(poof, 8, 8));

// --- font: 0-9 -> tiles 16.., A-Z -> tiles 32.. (verbatim from make-nes-gallery.mjs) ---
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

// --- build --------------------------------------------------------------------
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
