#!/usr/bin/env node
// Build the CC0 "LWX Frontline Fury" SNES Operation-Wolf-style two-gun on-rails
// light-gun shooter from games/snes-opwolf/ into a LoROM .sfc ROM.
//
// Pipeline (same PVSnesLib template-fill workflow as make-snes-scope.mjs):
//   1. THIS script generates games/snes-opwolf/sprites.bmp procedurally (CC0):
//      a 64x16 / 8bpp sheet of four 16x16 sprites laid out left->right ->
//        tile 0 = enemy soldier, tile 1 = P1 crosshair (cyan),
//        tile 2 = P2 crosshair (pink), tile 3 = muzzle/hit burst.
//   2. the Makefile's gfx4snes converts sprites.bmp -> sprite tiles + palette,
//      and pvsneslibfont.bmp (PVSnesLib MIT font, reused) -> the text/BG tiles.
//   3. PVSnesLib make rules: 816-tcc -> 816-opt -> constify -> wla-65816 ->
//      wlalink  => opwolf.sfc (256K LoROM, header from hdr.asm).
//   4. copy to public/roms/freeware/lwx-snes-opwolf.sfc
// Only games/snes-opwolf/opwolf.c is "ours to write" (hdr.asm/data.asm/Makefile
// are frozen PVSnesLib template boilerplate, font art is PVSnesLib MIT). The
// generated sprite sheet + the compiled ROM are CC0.
//
// Toolchain lookup (PVSnesLib, GNU make, Git-for-Windows sh) is identical to
// make-snes-scope.mjs - see that file's header for the why of each knob.
//
// Usage: node scripts/make-snes-opwolf.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'snes-opwolf');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-snes-opwolf.sfc');
const ROM_NAME = 'opwolf.sfc';

// --- 1. generate the CC0 sprite sheet (sprites.bmp) ------------------------
// 64x16, 8bpp indexed, four 16x16 tiles laid out left->right. gfx4snes (-s16)
// reads them in that order, so tile 0=soldier, 1=P1 xhair, 2=P2 xhair, 3=burst.
function generateSpritesBmp(path) {
  const W = 64, H = 16;
  const px = new Uint8Array(W * H);              // palette indices, 0 = transparent
  const set = (tx, x, y, c) => {
    const X = tx * 16 + x, Y = y;
    if (X >= 0 && X < W && Y >= 0 && Y < H) px[Y * W + X] = c;
  };

  // palette indices: 0 transparent, 1 white, 2 cyan, 3 pink, 4 enemy-green,
  // 5 enemy-dark, 6 skin, 7 orange (burst), 8 yellow (burst core).

  // Tile 0: enemy soldier - a little marching figure (head + body + legs).
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    let c = 0;
    // head (skin) rows 1..4 centred
    if (y >= 1 && y <= 4 && x >= 6 && x <= 9) c = 6;
    // helmet line
    if (y === 0 && x >= 5 && x <= 10) c = 5;
    if (y === 1 && (x === 5 || x === 10)) c = 5;
    // body (green) rows 5..11
    if (y >= 5 && y <= 11 && x >= 4 && x <= 11) c = 4;
    // belt
    if (y === 9 && x >= 4 && x <= 11) c = 5;
    // arms
    if ((y === 6 || y === 7) && (x === 3 || x === 12)) c = 4;
    // legs (dark) rows 12..15 two columns
    if (y >= 12 && y <= 15 && (x === 5 || x === 6 || x === 9 || x === 10)) c = 5;
    if (c) set(0, x, y, c);
  }

  // Crosshair tiles 1 (cyan=2) and 2 (pink=3): ring + cross arms + centre dot.
  const xhair = (tile, col) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const dx = x - 7.5, dy = y - 7.5, r = Math.sqrt(dx * dx + dy * dy);
      let c = 0;
      if (r >= 5.4 && r <= 6.8) c = col;                       // ring
      else if (r <= 1.4) c = 1;                                // white centre dot
      else if ((x === 7 || x === 8) && (y < 4 || y > 11)) c = col; // vertical arms
      else if ((y === 7 || y === 8) && (x < 4 || x > 11)) c = col; // horizontal arms
      if (c) set(tile, x, y, c);
    }
  };
  xhair(1, 2);   // P1 cyan
  xhair(2, 3);   // P2 pink

  // Tile 3: muzzle/hit burst - a starburst (yellow core, orange spikes).
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const dx = x - 7.5, dy = y - 7.5, r = Math.sqrt(dx * dx + dy * dy);
    let c = 0;
    if (r <= 2.2) c = 8;                                       // yellow core
    else if (r <= 4.0 && (Math.abs(dx) < 1.6 || Math.abs(dy) < 1.6 ||
             Math.abs(dx - dy) < 1.6 || Math.abs(dx + dy) < 1.6)) c = 7; // spikes
    if (c) set(3, x, y, c);
  }

  // Palette: 256 entries, B,G,R,0 (BI_RGB). Only 0..8 used.
  const pal = Buffer.alloc(256 * 4, 0);
  const putPal = (i, r, g, b) => { pal[i * 4 + 0] = b; pal[i * 4 + 1] = g; pal[i * 4 + 2] = r; pal[i * 4 + 3] = 0; };
  putPal(0, 0, 0, 0);          // transparent
  putPal(1, 248, 248, 248);    // white
  putPal(2, 64, 224, 240);     // cyan (P1)
  putPal(3, 240, 120, 200);    // pink (P2)
  putPal(4, 72, 160, 72);      // enemy green
  putPal(5, 40, 56, 40);       // enemy dark / helmet / legs
  putPal(6, 232, 192, 152);    // skin
  putPal(7, 240, 140, 32);     // burst orange
  putPal(8, 248, 232, 96);     // burst yellow

  const rowSize = W;           // 64 bytes/row, multiple of 4 (no padding)
  const dataOff = 14 + 40 + 256 * 4;   // 1078
  const fileSize = dataOff + rowSize * H;
  const buf = Buffer.alloc(fileSize, 0);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(dataOff, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(W, 18);
  buf.writeInt32LE(H, 22);     // positive = bottom-up
  buf.writeUInt16LE(1, 26);    // planes
  buf.writeUInt16LE(8, 28);    // bpp
  buf.writeUInt32LE(0, 30);    // BI_RGB
  buf.writeUInt32LE(rowSize * H, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(256, 46);
  buf.writeUInt32LE(256, 50);
  pal.copy(buf, 54);
  for (let y = 0; y < H; y++) {
    const srcRow = (H - 1 - y) * W;
    px.subarray(srcRow, srcRow + W).forEach((v, i) => { buf[dataOff + y * rowSize + i] = v; });
  }
  writeFileSync(path, buf);
  console.log(`generated ${path} (${fileSize} bytes, ${W}x${H} 8bpp)`);
}

generateSpritesBmp(join(GAME_DIR, 'sprites.bmp'));

// --- 2. locate toolchain (mirrors make-snes-scope.mjs) ---------------------
function findPvsneslib() {
  const candidates = [process.env.PVSNESLIB_HOME, 'C:\\pvsneslib', '/c/pvsneslib'].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, 'devkitsnes', 'snes_rules'))) return c;
  return null;
}
function findMake() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    process.env.MAKE,
    `C:\\ProgramData\\mingw64\\mingw64\\bin\\mingw32-make${exe}`,
    `C:\\msys64\\usr\\bin\\make${exe}`,
    `C:\\MinGW\\bin\\mingw32-make${exe}`,
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return `mingw32-make${exe}`;
}
function findShellBin() {
  const candidates = [
    process.env.GIT_BASH_BIN,
    'C:\\Program Files\\Git\\usr\\bin',
    'C:\\Program Files (x86)\\Git\\usr\\bin',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, 'sh.exe'))) return c;
  return null;
}
function toMakePath(p) { return p.replace(/\\/g, '/'); }

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
const env = {
  ...process.env,
  PVSNESLIB_HOME: PVSNESLIB_MAKE,
  PATH: `${SHELL_BIN};${process.env.PATH || ''}`,
};
const args = [`SHELL=${SH}`, 'OS='];

console.log(`PVSnesLib : ${PVSNESLIB}  (as ${PVSNESLIB_MAKE})`);
console.log(`make      : ${MAKE}`);
console.log(`shell     : ${SH}`);
console.log(`> ${MAKE} ${args.join(' ')}   (cwd: ${GAME_DIR})`);

spawnSync(MAKE, [...args, 'clean'], { cwd: GAME_DIR, env, stdio: 'inherit' });

const r = spawnSync(MAKE, args, { cwd: GAME_DIR, env, stdio: 'inherit' });
if (r.error) { console.error(`\nFailed to run make (${MAKE}). ${r.error.message}`); process.exit(2); }
if (r.status !== 0) { console.error(`\nmake exited ${r.status}`); process.exit(r.status || 1); }

// --- 3. publish + clean intermediates -------------------------------------
const built = join(GAME_DIR, ROM_NAME);
if (!existsSync(built)) { console.error(`\nBuild produced no ${ROM_NAME}`); process.exit(1); }
copyFileSync(built, OUT);

for (const f of [
  ROM_NAME, 'opwolf.sym', 'opwolf.obj', 'data.obj', 'hdr.obj', 'linkfile',
  'pvsneslibfont.pic', 'pvsneslibfont.pal', 'pvsneslibfont.inc', 'pvsneslibfont_data.as',
  'sprites.pic', 'sprites.pal', 'sprites.inc', 'sprites_data.as',
]) {
  try { rmSync(join(GAME_DIR, f)); } catch {}
}

console.log(`\nWrote ${OUT}`);
