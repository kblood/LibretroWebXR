#!/usr/bin/env node
// Build the CC0 "LWX Genesis Demo" Sega Genesis / Mega Drive game from
// games/genesis-demo/ into a .md ROM.
//
// Pipeline (the research's vetted SGDK recipe, fully headless):
//   1. clean games/genesis-demo/out/  (deterministic rebuild)
//   2. SGDK make:  <SGDK>\bin\make -f <SGDK>\makefile.gen   ->  out/rom.bin
//      (SGDK ships its own gcc + make; rescomp/sizebnd need Java, already on PATH)
//   3. copy out/rom.bin -> public/roms/freeware/lwx-genesis-demo.md
// Only games/genesis-demo/src/main.c is "ours to write" (CC0). The boot
// boilerplate (src/boot/sega.s + the ROM header struct in src/boot/rom_head.c)
// is generated/frozen from SGDK's known-good template by makefile.gen -- we
// never hand-write boot/header/vector code. The output ROM is CC0.
//
// Needs SGDK 2.11 installed (zip/7z extract only, no installer) and Java on
// PATH. SGDK is looked up via: $GDK, then C:\sgdk (the documented default).
//
// Usage: node scripts/make-genesis-demo.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'genesis-demo');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-genesis-demo.md');

// --- locate SGDK ---------------------------------------------------------
// SGDK isn't on PATH; mirror make-nes-pong.mjs's hardcoded-path style.
function findSgdk() {
  const candidates = [
    process.env.GDK,
    'C:\\sgdk',
    'C:\\SGDK',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'makefile.gen')) && existsSync(join(c, 'bin', 'make.exe'))) {
      return c;
    }
  }
  return null;
}
const SGDK = findSgdk();
if (!SGDK) {
  console.error('Could not find SGDK. Install SGDK 2.11 (extract sgdk211.7z) to C:\\sgdk');
  console.error('or set the GDK environment variable to its path. See');
  console.error('docs/research/genesis-game-creation.md for the install steps.');
  process.exit(2);
}
const MAKE = join(SGDK, 'bin', 'make.exe');
const MAKEFILE = join(SGDK, 'makefile.gen');

// --- 1. clean previous build for a deterministic result ------------------
try { rmSync(join(GAME_DIR, 'out'), { recursive: true, force: true }); } catch {}

// --- 2. build ------------------------------------------------------------
// SGDK derives GDK from the makefile location, but we also export GDK/GDK_WIN
// (some templates expect them) and put SGDK\bin first on PATH so its bundled
// gcc/objcopy/etc. are used.
const env = {
  ...process.env,
  GDK: SGDK,
  GDK_WIN: SGDK,
  PATH: join(SGDK, 'bin') + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
};
const args = ['-f', MAKEFILE];
console.log(`> ${MAKE} ${args.join(' ')}   (cwd: ${GAME_DIR}, GDK: ${SGDK})`);
const r = spawnSync(MAKE, args, { cwd: GAME_DIR, stdio: 'inherit', env });
if (r.error) {
  console.error(`\nFailed to run SGDK make (${MAKE}).`);
  console.error(r.error.message);
  process.exit(2);
}
if (r.status !== 0) { console.error(`\nSGDK make exited ${r.status}`); process.exit(r.status || 1); }

// --- 3. publish ----------------------------------------------------------
const romBin = join(GAME_DIR, 'out', 'rom.bin');
if (!existsSync(romBin)) { console.error(`\nBuild produced no ROM at ${romBin}`); process.exit(1); }
copyFileSync(romBin, OUT);

// --- 4. sanity-check the ROM (size + SEGA header at 0x100) ---------------
const size = statSync(OUT).size;
const buf = (await import('node:fs')).readFileSync(OUT);
const tag = buf.toString('ascii', 0x100, 0x104);
if (tag !== 'SEGA') {
  console.error(`\nWARNING: expected 'SEGA' at offset 0x100, found '${tag}'.`);
  process.exit(1);
}
console.log(`\nWrote ${OUT} (${size} bytes, header tag '${tag}')`);
