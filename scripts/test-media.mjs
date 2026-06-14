// Node smoke-test for the medium mapping layer (mediumFor + SYSTEMS.medium).
// Pure logic — no THREE, no DOM, no browser.
// Run: node scripts/test-media.mjs
// Exit 0 = all pass, 1 = any failure.

import { mediumFor, SYSTEMS } from '../src/systems.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); }
};
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

// --- SYSTEMS.medium fields ---------------------------------------------------
eq('snes medium = cartridge',  SYSTEMS.snes.medium,  'cartridge');
eq('nes medium = cartridge',   SYSTEMS.nes.medium,   'cartridge');
eq('gb medium = cartridge',    SYSTEMS.gb.medium,    'cartridge');
eq('gbc medium = cartridge',   SYSTEMS.gbc.medium,   'cartridge');
eq('gba medium = cartridge',   SYSTEMS.gba.medium,   'cartridge');
eq('vb medium = cartridge',    SYSTEMS.vb.medium,    'cartridge');
eq('md medium = cartridge',    SYSTEMS.md.medium,    'cartridge');
eq('sms medium = cartridge',   SYSTEMS.sms.medium,   'cartridge');
eq('gg medium = cartridge',    SYSTEMS.gg.medium,    'cartridge');
eq('atari2600 medium = cartridge', SYSTEMS.atari2600.medium, 'cartridge');
eq('pce medium = cartridge',   SYSTEMS.pce.medium,   'cartridge');
eq('c64 medium = floppy',      SYSTEMS.c64.medium,   'floppy');
eq('vic20 medium = floppy',    SYSTEMS.vic20.medium, 'floppy');

// --- mediumFor: cartridge systems → cartridge --------------------------------
eq('mediumFor snes .sfc',      mediumFor({ file: 'game.sfc',   system: 'snes' }),    'cartridge');
eq('mediumFor nes .nes',       mediumFor({ file: 'game.nes',   system: 'nes' }),     'cartridge');
eq('mediumFor gb .gb',         mediumFor({ file: 'game.gb',    system: 'gb' }),      'cartridge');
eq('mediumFor gbc .gbc',       mediumFor({ file: 'game.gbc',   system: 'gbc' }),     'cartridge');
eq('mediumFor gba .gba',       mediumFor({ file: 'game.gba',   system: 'gba' }),     'cartridge');
eq('mediumFor md .md',         mediumFor({ file: 'game.md',    system: 'md' }),      'cartridge');
eq('mediumFor sms .sms',       mediumFor({ file: 'game.sms',   system: 'sms' }),     'cartridge');
eq('mediumFor gg .gg',         mediumFor({ file: 'game.gg',    system: 'gg' }),      'cartridge');
eq('mediumFor atari2600 .a26', mediumFor({ file: 'game.a26',   system: 'atari2600' }), 'cartridge');
eq('mediumFor pce .pce',       mediumFor({ file: 'game.pce',   system: 'pce' }),     'cartridge');
eq('mediumFor vb .vb',         mediumFor({ file: 'game.vb',    system: 'vb' }),      'cartridge');

// --- mediumFor: c64/vic20 disk/tape/program exts → floppy -------------------
eq('mediumFor c64 .d64',  mediumFor({ file: 'game.d64',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .d71',  mediumFor({ file: 'game.d71',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .d80',  mediumFor({ file: 'game.d80',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .d81',  mediumFor({ file: 'game.d81',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .d82',  mediumFor({ file: 'game.d82',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .g64',  mediumFor({ file: 'game.g64',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .x64',  mediumFor({ file: 'game.x64',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .t64',  mediumFor({ file: 'game.t64',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .tap',  mediumFor({ file: 'game.tap',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .prg',  mediumFor({ file: 'game.prg',  system: 'c64' }),   'floppy');
eq('mediumFor c64 .p00',  mediumFor({ file: 'game.p00',  system: 'c64' }),   'floppy');
eq('mediumFor vic20 .prg', mediumFor({ file: 'game.prg', system: 'vic20' }), 'floppy');
eq('mediumFor vic20 .20',  mediumFor({ file: 'game.20',  system: 'vic20' }), 'floppy');
eq('mediumFor vic20 .rom', mediumFor({ file: 'game.rom', system: 'vic20' }), 'floppy');

// --- mediumFor: c64 .crt → cartridge (overrides system floppy default) ------
eq('mediumFor c64 .crt = cartridge', mediumFor({ file: 'game.crt', system: 'c64' }),   'cartridge');

// --- mediumFor: extension refines without a system in meta ------------------
eq('mediumFor .d64 no system', mediumFor({ file: 'game.d64' }), 'floppy');
eq('mediumFor .crt no system', mediumFor({ file: 'game.crt' }), 'cartridge');
eq('mediumFor .prg no system', mediumFor({ file: 'game.prg' }), 'floppy');

// --- mediumFor: unknown → cartridge default ----------------------------------
eq('mediumFor unknown ext',    mediumFor({ file: 'game.zzz', system: 'snes' }), 'cartridge');
eq('mediumFor no file',        mediumFor({ system: 'c64' }),  'floppy');
eq('mediumFor null meta',      mediumFor(null),               'cartridge');
eq('mediumFor empty meta',     mediumFor({}),                 'cartridge');

// --- freeware demo files used in the headless probe -------------------------
// These are the actual files in public/roms/freeware/
eq('lwx-demo.prg → floppy',      mediumFor({ file: 'freeware/lwx-demo.prg',   system: 'c64' }),   'floppy');
eq('lwx-snake.prg → floppy',     mediumFor({ file: 'freeware/lwx-snake.prg',  system: 'c64' }),   'floppy');
eq('lwx-vic20-demo.prg → floppy', mediumFor({ file: 'freeware/lwx-vic20-demo.prg', system: 'vic20' }), 'floppy');
eq('lwx-snes-demo.sfc → cartridge', mediumFor({ file: 'freeware/lwx-snes-demo.sfc', system: 'snes' }), 'cartridge');
eq('lwx-nes-pong.nes → cartridge',  mediumFor({ file: 'freeware/lwx-nes-pong.nes',  system: 'nes' }),  'cartridge');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
