#!/usr/bin/env node
// Build the CC0 "LWX Scope Range" SNES Super Scope light-gun game from
// games/snes-scope/ into a LoROM .sfc ROM.
//
// Pipeline (same PVSnesLib template-fill workflow as make-snes-demo.mjs):
//   1. THIS script generates games/snes-scope/sprites.bmp procedurally (CC0):
//      a 32x32 / 8bpp sheet of four 16x16 sprites -> tile 0 = bullseye target,
//      tile 1 = aim/calibration dot (tiles 2-3 blank).
//   2. the Makefile's gfx4snes converts sprites.bmp -> sprite tiles + palette,
//      and pvsneslibfont.bmp (PVSnesLib MIT font, reused) -> the text/BG tiles.
//   3. PVSnesLib make rules: 816-tcc -> 816-opt -> constify -> wla-65816 ->
//      wlalink  => scopegame.sfc (256K LoROM, header from hdr.asm).
//   4. copy to public/roms/freeware/lwx-snes-scope.sfc
// Only games/snes-scope/scopegame.c is "ours to write" (hdr.asm/data.asm/Makefile
// are frozen PVSnesLib template boilerplate, font art is PVSnesLib MIT). The
// generated sprite sheet + the compiled ROM are CC0.
//
// Toolchain lookup (PVSnesLib, GNU make, Git-for-Windows sh) is identical to
// make-snes-demo.mjs - see that file's header for the why of each knob.
//
// Usage: node scripts/make-snes-scope.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'snes-scope');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-snes-scope.sfc');
const ROM_NAME = 'scopegame.sfc';

// --- 1. generate the CC0 sprite sheet (sprites.bmp) ------------------------
// 32x32, 8bpp indexed, four 16x16 tiles laid out TL,TR,BL,BR. gfx4snes (-s16)
// reads them in that order, so tile 0 = bullseye, tile 1 = aim dot.
function generateSpritesBmp(path) {
  const W = 32, H = 32;
  const px = new Uint8Array(W * H);              // palette indices, 0 = transparent
  const set = (x, y, c) => { if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = c; };

  // Tile 0 (0..15, 0..15): concentric bullseye, alternating white(1)/red(2).
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const dx = x - 7.5, dy = y - 7.5, r = Math.sqrt(dx * dx + dy * dy);
    let c = 0;
    if (r <= 1.7) c = 1;
    else if (r <= 3.3) c = 2;
    else if (r <= 4.9) c = 1;
    else if (r <= 6.5) c = 2;
    else if (r <= 7.6) c = 1;
    set(x, y, c);
  }

  // Tile 1 (16..31, 0..15): yellow(3) aim cursor - a small disc + crosshair arms.
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const dx = x - 7.5, dy = y - 7.5, r = Math.sqrt(dx * dx + dy * dy);
    let c = 0;
    if (r <= 2.6) c = 3;
    else if ((x === 7 || x === 8) && y >= 1 && y <= 14) c = 3;
    else if ((y === 7 || y === 8) && x >= 1 && x <= 14) c = 3;
    if (c) set(16 + x, y, c);
  }

  // Palette: 256 entries, B,G,R,0 (BI_RGB). Only 0..3 used.
  const pal = Buffer.alloc(256 * 4, 0);
  const putPal = (i, r, g, b) => { pal[i * 4 + 0] = b; pal[i * 4 + 1] = g; pal[i * 4 + 2] = r; pal[i * 4 + 3] = 0; };
  putPal(0, 0, 0, 0);          // transparent (index 0)
  putPal(1, 248, 248, 248);    // white
  putPal(2, 216, 32, 32);      // red
  putPal(3, 240, 216, 40);     // yellow

  const rowSize = W;           // 32 bytes/row, already a multiple of 4 (no padding)
  const dataOff = 14 + 40 + 256 * 4;   // 1078
  const fileSize = dataOff + rowSize * H;
  const buf = Buffer.alloc(fileSize, 0);
  // BITMAPFILEHEADER
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(dataOff, 10);
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(W, 18);
  buf.writeInt32LE(H, 22);     // positive = bottom-up
  buf.writeUInt16LE(1, 26);    // planes
  buf.writeUInt16LE(8, 28);    // bpp
  buf.writeUInt32LE(0, 30);    // BI_RGB
  buf.writeUInt32LE(rowSize * H, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(256, 46);  // clrUsed
  buf.writeUInt32LE(256, 50);  // clrImportant
  pal.copy(buf, 54);
  // Pixel data, bottom-up.
  for (let y = 0; y < H; y++) {
    const srcRow = (H - 1 - y) * W;
    px.subarray(srcRow, srcRow + W).forEach((v, i) => { buf[dataOff + y * rowSize + i] = v; });
  }
  writeFileSync(path, buf);
  console.log(`generated ${path} (${fileSize} bytes, 32x32 8bpp)`);
}

generateSpritesBmp(join(GAME_DIR, 'sprites.bmp'));

// --- 2. locate toolchain (mirrors make-snes-demo.mjs) ---------------------
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

// Clean first so the build is deterministic (PVSnesLib ships prebuilt artifacts).
spawnSync(MAKE, [...args, 'clean'], { cwd: GAME_DIR, env, stdio: 'inherit' });

const r = spawnSync(MAKE, args, { cwd: GAME_DIR, env, stdio: 'inherit' });
if (r.error) { console.error(`\nFailed to run make (${MAKE}). ${r.error.message}`); process.exit(2); }
if (r.status !== 0) { console.error(`\nmake exited ${r.status}`); process.exit(r.status || 1); }

// --- 3. publish + clean intermediates -------------------------------------
const built = join(GAME_DIR, ROM_NAME);
if (!existsSync(built)) { console.error(`\nBuild produced no ${ROM_NAME}`); process.exit(1); }
copyFileSync(built, OUT);

for (const f of [
  ROM_NAME, 'scopegame.sym', 'scopegame.obj', 'data.obj', 'hdr.obj', 'linkfile',
  'pvsneslibfont.pic', 'pvsneslibfont.pal', 'pvsneslibfont.inc', 'pvsneslibfont_data.as',
  'sprites.pic', 'sprites.pal', 'sprites.inc', 'sprites_data.as',
]) {
  try { rmSync(join(GAME_DIR, f)); } catch {}
}

console.log(`\nWrote ${OUT}`);
