#!/usr/bin/env node
// Generate a tiny CC0 Commodore 64 BASIC game and emit it as a .prg ROM.
//
// This is "create your own game" content: it is entirely ours, public-domain
// (CC0), and therefore safe to ship and redistribute (see docs/LICENSING.md).
// Output: public/roms/freeware/lwx-demo.prg  (load with the vice_x64 core)
//
// It tokenizes C64 BASIC v2 the same way the C64 ROM does on program entry,
// so the resulting .prg RUNs directly.
//
// Usage: node scripts/make-c64-demo.mjs

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

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

// C64 BASIC v2 tokens (0x80..0xCB).
const TOKENS = [
  'END','FOR','NEXT','DATA','INPUT#','INPUT','DIM','READ','LET','GOTO','RUN',
  'IF','RESTORE','GOSUB','RETURN','REM','STOP','ON','WAIT','LOAD','SAVE',
  'VERIFY','DEF','POKE','PRINT#','PRINT','CONT','LIST','CLR','CMD','SYS',
  'OPEN','CLOSE','GET','NEW','TAB(','TO','FN','SPC(','THEN','NOT','STEP',
  '+','-','*','/','^','AND','OR','>','=','<','SGN','INT','ABS','USR','FRE',
  'POS','SQR','RND','LOG','EXP','COS','SIN','TAN','ATN','PEEK','LEN','STR$',
  'VAL','ASC','CHR$','LEFT$','RIGHT$','MID$','GO',
];
const tokenValue = (kw) => 0x80 + TOKENS.indexOf(kw);

function tokenizeLine(text) {
  const out = [];
  let i = 0, inQuote = false, inRem = false;
  while (i < text.length) {
    const ch = text[i];
    if (inRem) { out.push(text.charCodeAt(i)); i++; continue; }
    if (ch === '"') { inQuote = !inQuote; out.push(0x22); i++; continue; }
    if (inQuote) { out.push(text.charCodeAt(i)); i++; continue; }
    // Longest-match against the token table (outside quotes only).
    let best = null;
    for (const kw of TOKENS) {
      if (text.startsWith(kw, i) && (best === null || kw.length > best.length)) best = kw;
    }
    if (best) {
      out.push(tokenValue(best));
      i += best.length;
      if (best === 'REM') inRem = true;
      continue;
    }
    out.push(text.charCodeAt(i)); // digits, vars, ( ) ; : $ space, etc.
    i++;
  }
  return out;
}

// Assemble the .prg: 2-byte load address (0x0801), then linked BASIC lines.
const LOAD_ADDR = 0x0801;
const bytes = [LOAD_ADDR & 0xff, (LOAD_ADDR >> 8) & 0xff];

// Build each line body first, then patch the "next line" link pointers.
const records = LISTING.map(([num, text]) => {
  const toks = tokenizeLine(text.toUpperCase());
  return { num, body: [num & 0xff, (num >> 8) & 0xff, ...toks, 0x00] };
});

let addr = LOAD_ADDR;
for (const r of records) {
  const recLen = 2 + r.body.length;        // 2 link bytes + body
  const next = addr + recLen;
  bytes.push(next & 0xff, (next >> 8) & 0xff, ...r.body);
  addr = next;
}
bytes.push(0x00, 0x00);                     // end-of-program marker

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(bytes));
console.log(`Wrote ${OUT}`);
console.log(`  load address: $${LOAD_ADDR.toString(16)}  size: ${bytes.length} bytes  lines: ${records.length}`);
