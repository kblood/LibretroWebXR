#!/usr/bin/env node
// Build the CC0 "LWX Paint" GBA game from games/gba-paint/ into a .gba ROM.
//
// Pipeline (the research's recommended devkitARM + libtonc Mode 3 workflow):
//   1. arm-none-eabi-gcc -c main.c              -> main.o   (Thumb, ARM7TDMI)
//   2. arm-none-eabi-gcc main.o -specs=gba.specs -ltonc -> .elf  (crt0 + linker
//      script are supplied by gba.specs; never hand-rolled)
//   3. arm-none-eabi-objcopy -O binary .elf .gba
//   4. gbafix .gba   (writes the header complement at 0x0BD + checksum so the
//      ROM boots on mGBA / real hardware)
//   5. copy to public/roms/freeware/lwx-gba-paint.gba
// Only games/gba-paint/main.c is "ours to write"; devkitARM + libtonc are the
// frozen, documented toolchain/library. Output ROM is CC0.
//
// Needs devkitARM + libtonc installed (devkitPro pacman packages, extracted to
// C:\devkitPro -- see docs/research/gba-game-creation.md for the exact
// non-interactive install). The toolchain is NOT on PATH, so -- mirroring
// scripts/make-nes-pong.mjs -- we discover/hardcode C:\devkitPro here.
//
// Usage: node scripts/make-gba-paint.mjs
//
// Released under CC0 1.0.

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'gba-paint');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-gba-paint.gba');
const ROM_NAME = 'lwx-gba-paint.gba';
const EXE = process.platform === 'win32' ? '.exe' : '';

// --- locate devkitPro / devkitARM ---------------------------------------
function findDevkitPro() {
  const candidates = [
    process.env.DEVKITPRO,
    'C:\\devkitPro',
    '/c/devkitPro',
    '/opt/devkitpro',
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'devkitARM', 'bin', `arm-none-eabi-gcc${EXE}`))) return c;
  }
  return null;
}

const DEVKITPRO = findDevkitPro();
if (!DEVKITPRO) {
  console.error('Could not find devkitARM. Install the devkitPro pacman packages');
  console.error('(devkitarm-gcc/binutils/newlib + libtonc) into C:\\devkitPro, or set');
  console.error('DEVKITPRO. See docs/research/gba-game-creation.md for the exact URLs.');
  process.exit(2);
}
const DEVKITARM = join(DEVKITPRO, 'devkitARM');
const GCC = join(DEVKITARM, 'bin', `arm-none-eabi-gcc${EXE}`);
const OBJCOPY = join(DEVKITARM, 'bin', `arm-none-eabi-objcopy${EXE}`);
const GBAFIX = join(DEVKITPRO, 'tools', 'bin', `gbafix${EXE}`);
const LIBTONC = join(DEVKITPRO, 'libtonc');

for (const [name, p] of [['objcopy', OBJCOPY], ['gbafix', GBAFIX],
                         ['libtonc/lib', join(LIBTONC, 'lib', 'libtonc.a')]]) {
  if (!existsSync(p)) {
    console.error(`Missing ${name} at ${p} -- install the matching devkitPro package.`);
    process.exit(2);
  }
}

// devkitARM tools expect these in the environment.
const env = { ...process.env, DEVKITPRO, DEVKITARM };

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: GAME_DIR, stdio: 'inherit', env });
  if (r.error) { console.error(r.error.message); process.exit(2); }
  if (r.status !== 0) { console.error(`\n${cmd} exited ${r.status}`); process.exit(r.status || 1); }
}

// --- GBA build flags (libtonc-template defaults) -------------------------
const ARCH = ['-mthumb', '-mthumb-interwork'];
const CFLAGS = [
  ...ARCH, '-O2', '-mcpu=arm7tdmi', '-mtune=arm7tdmi',
  '-fomit-frame-pointer', '-Wall',
  `-I${join(LIBTONC, 'include')}`,
];
const LDFLAGS = [
  ...ARCH, '-specs=gba.specs',
  `-L${join(LIBTONC, 'lib')}`,
];

const ELF = 'lwx-gba-paint.elf';
const OBJ = 'main.o';

// 1. compile
run(GCC, [...CFLAGS, '-c', 'main.c', '-o', OBJ]);
// 2. link (gba.specs pulls in gba_crt0.o + the GBA linker script)
run(GCC, [OBJ, ...LDFLAGS, '-ltonc', '-o', ELF]);
// 3. objcopy -> raw .gba
run(OBJCOPY, ['-O', 'binary', ELF, ROM_NAME]);
// 4. gbafix: valid header complement + checksum (required to boot)
run(GBAFIX, [ROM_NAME, '-tLWXPAINT', '-cLWXP', '-m00']);

// 5. publish + clean intermediates
copyFileSync(join(GAME_DIR, ROM_NAME), OUT);
for (const f of [OBJ, ELF, ROM_NAME]) {
  try { rmSync(join(GAME_DIR, f)); } catch {}
}
console.log(`\nWrote ${OUT} (${statSync(OUT).size} bytes)`);
