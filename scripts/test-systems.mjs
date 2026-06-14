// Node smoke-test for the system/core registry: new systems (SG-1000, 32X) and
// the systemForFile extension-disambiguation fix (cores shared across systems
// must route by extension, not by which system lists the core first).
// Pure logic — no THREE, no DOM, no browser.
// Run: node scripts/test-systems.mjs   Exit 0 = pass, 1 = any failure.

import {
  CORES, SYSTEMS, coreForFile, systemForFile, systemForName,
  portsForSystem, mediumFor, coreWeight,
} from '../src/systems.js';

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

// --- New systems are registered, well-formed, and use cores we already ship --
for (const id of ['sg1000', 'sega32x', 'amiga']) {
  ok(`${id} registered`, !!SYSTEMS[id]);
  const sys = SYSTEMS[id];
  if (!sys) continue;
  ok(`${id} defaultCore in cores`, sys.cores.includes(sys.defaultCore));
  ok(`${id} every core exists in CORES`, sys.cores.every((c) => !!CORES[c]),
     sys.cores.join(','));
  ok(`${id} has exts`, Array.isArray(sys.exts) && sys.exts.length > 0);
  ok(`${id} has thumbnailRepo`, typeof sys.thumbnailRepo === 'string' && sys.thumbnailRepo.length > 0);
}

eq('sg1000 defaultCore = gearsystem', SYSTEMS.sg1000.defaultCore, 'gearsystem');
eq('sega32x defaultCore = picodrive', SYSTEMS.sega32x.defaultCore, 'picodrive');
eq('sg1000 thumbnailRepo', SYSTEMS.sg1000.thumbnailRepo, 'Sega_-_SG-1000');
eq('sega32x thumbnailRepo', SYSTEMS.sega32x.thumbnailRepo, 'Sega_-_32X');

// --- Detection: new systems route by extension -------------------------------
eq('coreForFile .sg → gearsystem',  coreForFile('demo.sg')?.name,  'gearsystem');
eq('coreForFile .32x → picodrive',  coreForFile('demo.32x')?.name, 'picodrive');
eq('systemForFile .sg → sg1000',    systemForFile('demo.sg'),      'sg1000');
eq('systemForFile .32x → sega32x',  systemForFile('demo.32x'),     'sega32x');

// --- Detection: shared cores still route existing systems correctly ----------
// (regression guard for the systemForFile ext-disambiguation change)
eq('systemForFile .md → md',   systemForFile('sonic.md'),  'md');
eq('systemForFile .gen → md',  systemForFile('sonic.gen'), 'md');
eq('systemForFile .sms → sms', systemForFile('alex.sms'),  'sms');  // not 'md' (picodrive shared)
eq('systemForFile .gg → gg',   systemForFile('sonic.gg'),  'gg');   // not 'md'/'sms'
eq('systemForFile .a26 → atari2600', systemForFile('combat.a26'), 'atari2600');
eq('systemForFile .nes → nes', systemForFile('mario.nes'), 'nes');
eq('systemForFile .sfc → snes', systemForFile('mario.sfc'), 'snes');
eq('systemForFile unknown ext → null', systemForFile('x.zzz'), null);

// --- Amiga (PUAE) — locally-built emscripten core ----------------------------
eq('amiga defaultCore = puae',  SYSTEMS.amiga.defaultCore, 'puae');
eq('amiga thumbnailRepo',       SYSTEMS.amiga.thumbnailRepo, 'Commodore_-_Amiga');
eq('amiga medium = floppy',     SYSTEMS.amiga.medium, 'floppy');
ok('amiga keyboard-capable',    SYSTEMS.amiga.keyboard === true);
eq('puae core registered',      CORES.puae?.url, 'cores/puae_libretro.js');
eq('puae selects AROS kickstart', CORES.puae?.coreOptions?.puae_kickstart, 'aros');
eq('coreForFile .adf → puae',   coreForFile('game.adf')?.name, 'puae');
eq('coreForFile .lha → puae',   coreForFile('game.lha')?.name, 'puae');
eq('systemForFile .adf → amiga', systemForFile('game.adf'), 'amiga');
eq('systemForFile .ipf → amiga', systemForFile('game.ipf'), 'amiga');
eq('amiga ports = 2',           portsForSystem('amiga'), 2);
eq('amiga .adf medium = floppy', mediumFor({ file: 'game.adf', system: 'amiga' }), 'floppy');
eq('amiga .adf no system → floppy', mediumFor({ file: 'game.adf' }), 'floppy');

// --- Name-based detection (EmuVR-style folder aliases) -----------------------
eq('systemForName "SG-1000"',  systemForName('SG-1000'),  'sg1000');
eq('systemForName "Sega 32X"', systemForName('Sega 32X'), 'sega32x');
eq('systemForName "32X"',      systemForName('32X'),      'sega32x');
eq('systemForName "Amiga"',    systemForName('Amiga'),    'amiga');
eq('systemForName "Commodore Amiga"', systemForName('Commodore Amiga'), 'amiga');

// --- Ports, medium, weight ---------------------------------------------------
eq('sg1000 ports = 2',  portsForSystem('sg1000'),  2);
eq('sega32x ports = 2', portsForSystem('sega32x'), 2);
eq('sg1000 medium cartridge',  mediumFor({ file: 'demo.sg',  system: 'sg1000' }),  'cartridge');
eq('sega32x medium cartridge', mediumFor({ file: 'demo.32x', system: 'sega32x' }), 'cartridge');
eq('sg1000 weight (gearsystem) = 1',  coreWeight('gearsystem'), 1);
eq('sega32x weight (picodrive) = 2',  coreWeight('picodrive'),  2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
