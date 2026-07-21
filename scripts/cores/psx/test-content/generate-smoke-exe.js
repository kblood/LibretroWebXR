#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A tiny, original PS-X EXE used to prove that the browser core reaches
// executable MIPS code. It resets the GPU, enables a 320x240 display, fills
// VRAM with a deterministic colour, then runs a hot integer loop. No Sony BIOS
// or commercial game data is included or required; Beetle's embedded OpenBIOS
// can boot this file.
const HEADER_SIZE = 0x800;
const LOAD_ADDRESS = 0x80010000;
const STACK_ADDRESS = 0x801fff00;

const words = [
  0x3c08bf80, // lui   t0, 0xbf80
  0x35081814, // ori   t0, t0, 0x1814       (GP1)
  0xad000000, // sw    zero, 0(t0)          (reset GPU)
  0x3c090300, // lui   t1, 0x0300
  0xad090000, // sw    t1, 0(t0)            (display enable)
  0x3c090500, // lui   t1, 0x0500
  0xad090000, // sw    t1, 0(t0)            (display VRAM origin)
  0x3c090800, // lui   t1, 0x0800
  0x35290001, // ori   t1, t1, 1            (320x240, NTSC, 15-bit)
  0xad090000, // sw    t1, 0(t0)
  0x2508fffc, // addiu t0, t0, -4           (GP0)
  0x3c090240, // lui   t1, 0x0240
  0x352980e0, // ori   t1, t1, 0x80e0       (fill colour command)
  0xad090000, // sw    t1, 0(t0)
  0x34090000, // ori   t1, zero, 0          (x/y)
  0xad090000, // sw    t1, 0(t0)
  0x3c0900f0, // lui   t1, 0x00f0
  0x35290140, // ori   t1, t1, 0x0140       (320x240)
  0xad090000, // sw    t1, 0(t0)
  0x254a0001, // addiu t2, t2, 1            (hot loop begins)
  0x394b55aa, // xori  t3, t2, 0x55aa
  0x014b6021, // addu  t4, t2, t3
  0x08004013, // j     0x8001004c
  0x00000000, // nop                        (delay slot)
];

const code = Buffer.alloc(words.length * 4);
words.forEach((word, index) => code.writeUInt32LE(word >>> 0, index * 4));

const header = Buffer.alloc(HEADER_SIZE);
header.write('PS-X EXE', 0, 'ascii');
header.writeUInt32LE(LOAD_ADDRESS, 0x10);
header.writeUInt32LE(0, 0x14); // initial GP
header.writeUInt32LE(LOAD_ADDRESS, 0x18);
header.writeUInt32LE(code.length, 0x1c);
header.writeUInt32LE(STACK_ADDRESS, 0x30);
header.writeUInt32LE(0, 0x34); // stack offset
header.write('LibretroWebXR legal PSX JIT smoke test', 0x4c, 'ascii');

const defaultOutput = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'psx-jit-smoke.exe',
);
const output = path.resolve(process.argv[2] || defaultOutput);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([header, code]));
console.log(`Wrote ${HEADER_SIZE + code.length} byte PS-X EXE to ${output}`);
