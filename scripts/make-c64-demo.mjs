#!/usr/bin/env node
// Generate a tiny CC0 Commodore 64 BASIC game and emit it as a .prg ROM.
//
// This is "create your own game" content: it is entirely ours, public-domain
// (CC0), and therefore safe to ship and redistribute (see docs/LICENSING.md).
// Output: public/roms/freeware/lwx-demo.prg  (load with the vice_x64 core)
//
// The BASIC v2 tokenizer + .prg assembler live in scripts/lib/cbm-basic.mjs
// (shared with the VIC-20 generator). The resulting .prg RUNs directly.
//
// Usage: node scripts/make-c64-demo.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assemblePrg } from './lib/cbm-basic.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-demo.prg');

// --- The game: classic "guess my number", with a clear screen + colors. ---
const LISTING = [
  [10,  'PRINT CHR$(147)'],
  [20,  'POKE 53280,6:POKE 53281,6'],
  [30,  'PRINT "  LIBRETROWEBXR - C64 DEMO"'],
  [40,  'PRINT "  GUESS MY NUMBER 1 TO 100"'],
  [45,  'X=RND(-TI)'],
  [50,  'N=INT(RND(1)*100)+1'],
  [60,  'T=0'],
  [70,  'INPUT "YOUR GUESS";G'],
  [80,  'T=T+1'],
  [90,  'IF G<N THEN PRINT "TOO LOW":GOTO 70'],
  [100, 'IF G>N THEN PRINT "TOO HIGH":GOTO 70'],
  [110, 'PRINT "CORRECT IN";T;"TRIES!"'],
  [120, 'PRINT "PLAY AGAIN? Y/N"'],
  [130, 'GET A$:IF A$="" THEN 130'],
  [140, 'IF A$="Y" THEN 10'],
  [150, 'PRINT "BYE!"'],
  [160, 'END'],
];

const LOAD_ADDR = 0x0801;                       // C64 BASIC start
const bytes = assemblePrg(LISTING, LOAD_ADDR);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bytes);
console.log(`Wrote ${OUT}`);
console.log(`  load address: $${LOAD_ADDR.toString(16)}  size: ${bytes.length} bytes  lines: ${LISTING.length}`);
