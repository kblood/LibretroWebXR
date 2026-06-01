#!/usr/bin/env node
// Generate a tiny CC0 Commodore 64 SNAKE game and emit it as a .prg ROM.
//
// Entirely ours, public-domain (CC0) — safe to ship/redistribute (docs/LICENSING.md).
// Output: public/roms/freeware/lwx-snake.prg   (load with the vice_x64 core)
//
// A real-time arcade game in BASIC v2, steered by the joystick. We poll BOTH
// control ports ($DC00 port 2 AND $DC01 port 1) so it responds no matter which
// port the frontend's RetroPad maps to. Snake/apple are POKEd straight to screen
// RAM ($0400) + colour RAM ($D800) — no PRINT during play (fast + flicker-free).
//
// Build: node scripts/make-c64-snake.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assemblePrg } from './lib/cbm-basic.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-snake.prg');

// Screen code 81 = filled ball (snake body), 87 = open ball (apple).
// Joystick bits are active-LOW: up=1 down=2 left=4 right=8 fire=16.
// JV = PEEK(56320) AND PEEK(56321) merges both ports (a bit is 0 if pressed
// on EITHER port). Variable names avoid BASIC-keyword substrings on purpose.
const LISTING = [
  [10,  'POKE 53280,0:POKE 53281,0:PRINT CHR$(147);'],
  [20,  'SB=1024:CB=55296'],
  [30,  'DIM XP(255):DIM YP(255)'],
  [40,  'PRINT "  LIBRETROWEBXR - C64 SNAKE"'],
  [50,  'PRINT "  JOYSTICK TO STEER"'],
  [60,  'PRINT "  PRESS FIRE TO START"'],
  [70,  'IF (PEEK(56320) AND PEEK(56321) AND 16)<>0 THEN 70'],
  [100, 'PRINT CHR$(147);:POKE 53280,0:POKE 53281,0'],
  [110, 'HX=20:HY=12:DX=1:DY=0:LN=5:TL=0:SC=0:Z=RND(-TI)'],
  [120, 'FOR K=0 TO LN-1:XP(K)=HX-(LN-1)+K:YP(K)=HY'],
  [125, 'POKE SB+YP(K)*40+XP(K),81:POKE CB+YP(K)*40+XP(K),5:NEXT'],
  [130, 'HD=LN-1'],
  [140, 'GOSUB 600'],
  [210, 'JV=PEEK(56320) AND PEEK(56321)'],
  [220, 'IF (JV AND 1)=0 AND DY<>1 THEN DX=0:DY=-1'],
  [230, 'IF (JV AND 2)=0 AND DY<>-1 THEN DX=0:DY=1'],
  [240, 'IF (JV AND 4)=0 AND DX<>1 THEN DX=-1:DY=0'],
  [250, 'IF (JV AND 8)=0 AND DX<>-1 THEN DX=1:DY=0'],
  [260, 'NX=XP(HD)+DX:NY=YP(HD)+DY'],
  [270, 'IF NX<0 OR NX>39 OR NY<0 OR NY>24 THEN 800'],
  [280, 'CH=PEEK(SB+NY*40+NX)'],
  [290, 'IF CH=81 THEN 800'],
  [300, 'HD=(HD+1) AND 255:XP(HD)=NX:YP(HD)=NY'],
  [310, 'POKE SB+NY*40+NX,81:POKE CB+NY*40+NX,5'],
  [320, 'IF CH=87 THEN SC=SC+1:GOSUB 600:GOTO 360'],
  [330, 'POKE SB+YP(TL)*40+XP(TL),32'],
  [340, 'TL=(TL+1) AND 255'],
  [360, 'FOR DE=1 TO 40:NEXT'],
  [370, 'GOTO 210'],
  [600, 'AX=INT(RND(1)*40):AY=INT(RND(1)*25)'],
  [610, 'IF PEEK(SB+AY*40+AX)<>32 THEN 600'],
  [620, 'POKE SB+AY*40+AX,87:POKE CB+AY*40+AX,2'],
  [630, 'RETURN'],
  [800, 'PRINT CHR$(147);'],
  [810, 'PRINT "  GAME OVER"'],
  [820, 'PRINT "  SCORE:";SC'],
  [830, 'PRINT "  PRESS FIRE TO PLAY AGAIN"'],
  [840, 'IF (PEEK(56320) AND PEEK(56321) AND 16)<>0 THEN 840'],
  [850, 'GOTO 100'],
];

const LOAD_ADDR = 0x0801;                       // C64 BASIC start
const bytes = assemblePrg(LISTING, LOAD_ADDR);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bytes);
console.log(`Wrote ${OUT}`);
console.log(`  load address: $${LOAD_ADDR.toString(16)}  size: ${bytes.length} bytes  lines: ${LISTING.length}`);
