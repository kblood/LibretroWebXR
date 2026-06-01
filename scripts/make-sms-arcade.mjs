#!/usr/bin/env node
// Build the CC0 "LWX Catch" game from games/sms-arcade/main.c into BOTH a
// Sega Master System ROM (.sms) and a Sega Game Gear ROM (.gg) from the one
// source file, using devkitSMS (SMSlib + ihx2sms) on top of the SDCC Z80
// compiler.
//
// Pipeline (the devkitSMS recipe from docs/research/sms-gg-game-creation.md):
//   SMS:  sdcc -c -mz80 -I<SMSlib/src> --peep-file <peep> main.c -o main.rel
//         sdcc -o game.ihx -mz80 --no-std-crt0 --data-loc 0xC000 \
//              crt0_sms.rel SMSlib.lib main.rel
//         ihx2sms game.ihx lwx-sms-arcade.sms
//   GG:   same, but add -DTARGET_GG to the compile, link SMSlib_GG.lib,
//         and pack to .gg.
// ihx2sms pads the ROM to a 16 KiB multiple and writes the Sega checksum.
//
// Only games/sms-arcade/main.c is "ours to write"; crt0_sms.rel, SMSlib*.lib
// and the ihx2sms packer are the frozen, known-good devkitSMS templates. The
// output ROMs are CC0.
//
// Toolchain is zip-installed (no PATH assumption), mirroring how
// make-nes-pong.mjs hardcodes cc65: SDCC at C:\sdcc, devkitSMS at C:\devkitSMS,
// each overridable via SDCC_HOME / DEVKITSMS_HOME.
//
// Usage: node scripts/make-sms-arcade.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, copyFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GAME_DIR = join(ROOT, 'games', 'sms-arcade');
const OUT_DIR = join(ROOT, 'public', 'roms', 'freeware');
const OUT_SMS = join(OUT_DIR, 'lwx-sms-arcade.sms');
const OUT_GG = join(OUT_DIR, 'lwx-gg-arcade.gg');

// --- locate the zip-installed toolchains --------------------------------
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);

function pick(label, candidates, hint) {
  for (const c of candidates.filter(Boolean)) if (existsSync(c)) return c;
  console.error(`Could not find ${label}. Looked in:`);
  for (const c of candidates.filter(Boolean)) console.error(`  ${c}`);
  console.error(hint);
  process.exit(2);
}

const SDCC_HOME = process.env.SDCC_HOME || 'C:\\sdcc';
const DEVKIT = process.env.DEVKITSMS_HOME || 'C:\\devkitSMS';

const SDCC = pick('sdcc', [
  join(SDCC_HOME, 'bin', exe('sdcc')),
  'C:\\sdcc\\bin\\sdcc.exe',
], 'Install the SDCC Windows portable zip to C:\\sdcc (or set SDCC_HOME).');

const IHX2SMS = pick('ihx2sms', [
  join(DEVKIT, 'ihx2sms', 'Windows', exe('ihx2sms')),
  join(DEVKIT, 'ihx2sms', exe('ihx2sms')),
  'C:\\devkitSMS\\ihx2sms\\Windows\\ihx2sms.exe',
], 'Install devkitSMS to C:\\devkitSMS (or set DEVKITSMS_HOME).');

const SMSLIB_DIR = join(DEVKIT, 'SMSlib');
const SMSLIB_SRC = join(SMSLIB_DIR, 'src');
const PEEP = join(SMSLIB_SRC, 'peep-rules.txt');
const CRT0 = join(DEVKIT, 'crt0', 'crt0_sms.rel');
const LIB_SMS = join(SMSLIB_DIR, 'SMSlib.lib');
const LIB_GG = join(SMSLIB_DIR, 'SMSlib_GG.lib');

for (const [label, p] of [['peep-rules.txt', PEEP], ['crt0_sms.rel', CRT0],
  ['SMSlib.lib', LIB_SMS], ['SMSlib_GG.lib', LIB_GG]]) {
  if (!existsSync(p)) {
    console.error(`Missing devkitSMS file: ${label} (${p})`);
    process.exit(2);
  }
}

// --- helpers -------------------------------------------------------------
function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: GAME_DIR, stdio: 'inherit' });
  if (r.error) { console.error(r.error.message); process.exit(2); }
  if (r.status !== 0) { console.error(`exited ${r.status}`); process.exit(r.status || 1); }
}

// Build one target. `gg` => add -DTARGET_GG and link the GG lib.
function build(target, lib, outFile) {
  const rel = `main_${target}.rel`;
  const ihx = `game_${target}.ihx`;

  const cflags = ['-mz80', `-I${SMSLIB_SRC}`, '--peep-file', PEEP];
  if (target === 'gg') cflags.push('-DTARGET_GG');

  run(SDCC, [...cflags, '-c', 'main.c', '-o', rel]);
  run(SDCC, ['-o', ihx, '-mz80', '--no-std-crt0', '--data-loc', '0xC000',
    CRT0, lib, rel]);
  run(IHX2SMS, [ihx, outFile]);
}

console.log('=== Master System (.sms) ===');
build('sms', LIB_SMS, 'lwx-sms-arcade.sms');
console.log('\n=== Game Gear (.gg) ===');
build('gg', LIB_GG, 'lwx-gg-arcade.gg');

// --- publish + verify ----------------------------------------------------
copyFileSync(join(GAME_DIR, 'lwx-sms-arcade.sms'), OUT_SMS);
copyFileSync(join(GAME_DIR, 'lwx-gg-arcade.gg'), OUT_GG);

// clean intermediates
for (const f of ['main_sms.rel', 'main_gg.rel', 'game_sms.ihx', 'game_gg.ihx',
  'lwx-sms-arcade.sms', 'lwx-gg-arcade.gg',
  'main_sms.lst', 'main_gg.lst', 'main_sms.sym', 'main_gg.sym',
  'main_sms.asm', 'main_gg.asm', 'game_sms.map', 'game_gg.map',
  'game_sms.noi', 'game_gg.noi', 'game_sms.lk', 'game_gg.lk']) {
  try { rmSync(join(GAME_DIR, f)); } catch { /* ignore */ }
}

function checkSega(path) {
  // The "TMR SEGA" signature sits at 0x7FF0 in the last/only 16K bank for SMS.
  const buf = readFileSync(path);
  for (let off = 0x7ff0; off + 8 <= buf.length; off += 0x4000) {
    if (buf.toString('ascii', off, off + 8) === 'TMR SEGA') return off;
  }
  // GG can place it at 0x7FF0 too; scan whole ROM as a fallback.
  const idx = buf.indexOf('TMR SEGA');
  return idx >= 0 ? idx : -1;
}

for (const [label, path] of [['SMS', OUT_SMS], ['GG', OUT_GG]]) {
  const size = statSync(path).size;
  const sig = checkSega(path);
  console.log(`${label}: ${path}  (${size} bytes)  TMR SEGA @ ${sig >= 0 ? '0x' + sig.toString(16) : 'NOT FOUND'}`);
  if (size === 0 || size % 16384 !== 0) {
    console.error(`  WARNING: ${label} size is not a 16 KiB multiple`);
  }
}

console.log('\nDone.');
