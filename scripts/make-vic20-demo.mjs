#!/usr/bin/env node
// Generate a tiny CC0 Commodore VIC-20 BASIC game and emit it as a .prg ROM.
//
// Entirely ours, public-domain (CC0) — safe to ship/redistribute (docs/LICENSING.md).
// Output: public/roms/freeware/lwx-vic20-demo.prg  (load with the vice_xvic core)
//
// VIC-20 BASIC v2 shares the C64's token table and .prg layout exactly, so we
// reuse scripts/lib/cbm-basic.mjs. The ONLY structural difference is the load
// address: an UNEXPANDED VIC-20 starts BASIC at $1001 (with +3K it's $0401,
// with +8K/16K/24K it's $1201). We ship for the unexpanded machine, which is
// the VICE xvic default — keep the core's memory-expansion set to "none".
// Also: the VIC-20 screen is only 22 columns wide, so keep PRINT lines short.
//
// Build: node scripts/make-vic20-demo.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assemblePrg } from './lib/cbm-basic.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-vic20-demo.prg');

// "Guess my number" — a direct port of the C64 demo. Text-only, so it needs no
// VIC-specific screen pokes; default colours are readable. Lines kept <22 cols.
const LISTING = [
  [10,  'PRINT CHR$(147)'],
  [20,  'PRINT "LIBRETROWEBXR"'],
  [25,  'PRINT "VIC-20 DEMO"'],
  [30,  'PRINT "GUESS MY NUMBER"'],
  [40,  'PRINT "1 TO 100"'],
  [45,  'Z=RND(-TI)'],
  [50,  'N=INT(RND(1)*100)+1'],
  [60,  'T=0'],
  [70,  'INPUT "YOUR GUESS";G'],
  [80,  'T=T+1'],
  [90,  'IF G<N THEN PRINT "TOO LOW":GOTO 70'],
  [100, 'IF G>N THEN PRINT "TOO HIGH":GOTO 70'],
  [110, 'PRINT "CORRECT IN";T;"TRIES"'],
  [120, 'PRINT "AGAIN? Y/N"'],
  [130, 'GET A$:IF A$="" THEN 130'],
  [140, 'IF A$="Y" THEN 10'],
  [150, 'PRINT "BYE!"'],
  [160, 'END'],
];

const LOAD_ADDR = 0x1001;                       // VIC-20 unexpanded BASIC start
const bytes = assemblePrg(LISTING, LOAD_ADDR);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bytes);
console.log(`Wrote ${OUT}`);
console.log(`  load address: $${LOAD_ADDR.toString(16)}  size: ${bytes.length} bytes  lines: ${LISTING.length}`);
