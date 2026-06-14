#!/usr/bin/env node
// Generate a bootable CC0 Commodore Amiga demo disk and emit it as a .adf image.
//
// Entirely ours, public-domain (CC0) — safe to ship/redistribute (docs/LICENSING.md).
// Output: public/roms/freeware/lwx-amiga-demo.adf  (boots under the puae core
// using PUAE's built-in AROS Kickstart — no proprietary BIOS needed).
//
// The disk is a standard double-density Amiga floppy: 80 cylinders x 2 heads x
// 11 sectors x 512 bytes = 901120 bytes, all zero except the 1024-byte boot
// block (sectors 0-1). The boot block holds a tiny 68000 program assembled from
// scripts/amiga-bootblock.s with vasm; on boot the Kickstart validates the
// "DOS" signature + boot-block checksum and jumps to offset 12, where our code
// bangs the OCS custom chips directly to cycle the full-screen background colour
// forever — unmistakable proof a real 68k program ran from the disk.
//
// The assembled boot-block bytes are embedded below (output of
//   vasm/vasmm68k_mot -Fbin -o boot.bin scripts/amiga-bootblock.s
// ) so this script is self-contained and needs no m68k toolchain to re-run.
// The dc.l 0 checksum placeholder in the source is filled in here.
//
// Build: node scripts/make-amiga-demo.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-amiga-demo.adf');

const ADF_SIZE = 901120;        // 80 * 2 * 11 * 512  (double-density)
const BOOTBLOCK_SIZE = 1024;    // sectors 0-1

// Assembled boot block (scripts/amiga-bootblock.s, vasm -Fbin). 54 bytes:
// 12-byte header (DOS\0 / checksum=0 / rootblock=880) + 42 bytes of 68k code.
// The checksum longword at offset 4 is recomputed below; its value here is 0.
const BOOTCODE_HEX =
  '444f5300' + '00000000' + '00000370' +   // 'DOS\0', checksum=0, rootblock=880
  '41f900df' + 'f000317c' + '7fff009a' +   // lea $dff000,a0 ; INTENA clear
  '317c7fff' + '00967000' + '31400180' +   // DMACON clear ; moveq #0,d0 ; COLOR00=d0
  '223c0002' + 'ffff5381' + '66fc5240' +   // move.l #$2ffff,d1 ; delay ; addq.w #1,d0
  '02400fff' + '60ea';                      // andi.w #$0fff,d0 ; bra .loop

// Amiga boot-block checksum: sum all 256 big-endian longwords of the 1024-byte
// block (the checksum field pre-set to 0) with end-around carry, then NOT.
function bootChecksum(block) {
  let chk = 0;
  for (let i = 0; i < BOOTBLOCK_SIZE; i += 4) {
    const v = ((block[i] << 24) | (block[i + 1] << 16) | (block[i + 2] << 8) | block[i + 3]) >>> 0;
    chk = (chk + v) >>> 0;
    if (chk < v) chk = (chk + 1) >>> 0;     // end-around carry
  }
  return (~chk) >>> 0;
}

const adf = new Uint8Array(ADF_SIZE);       // blank disk

// Lay the assembled boot block at sector 0.
const code = Buffer.from(BOOTCODE_HEX, 'hex');
adf.set(code, 0);

// Compute + store the checksum (offset 4, big-endian), with field zeroed first.
adf[4] = adf[5] = adf[6] = adf[7] = 0;
const csum = bootChecksum(adf.subarray(0, BOOTBLOCK_SIZE));
adf[4] = (csum >>> 24) & 0xff;
adf[5] = (csum >>> 16) & 0xff;
adf[6] = (csum >>> 8) & 0xff;
adf[7] = csum & 0xff;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, adf);
console.log(`Wrote ${OUT}`);
console.log(`  size: ${adf.length} bytes  boot code: ${code.length} bytes  checksum: $${csum.toString(16).padStart(8, '0')}`);
