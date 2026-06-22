// Node smoke-test for the system/core registry: new systems (SG-1000, 32X) and
// the systemForFile extension-disambiguation fix (cores shared across systems
// must route by extension, not by which system lists the core first).
// Pure logic — no THREE, no DOM, no browser.
// Run: node scripts/test-systems.mjs   Exit 0 = pass, 1 = any failure.

import {
  CORES, SYSTEMS, coreForFile, systemForFile, systemForName,
  portsForSystem, mediumFor, coreWeight,
  lightgunLoadConfig, twoGunForSystem, isTwoGunCapable, libretroGunPortFor,
  twoGunPortsForSystem,
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

// --- Light-gun load config: single-gun unchanged + two-gun co-op -------------
// Single-gun (NES Zapper) still yields one inputDevices port (player 2) + the
// single-gun device, plus a `guns` list of one for the per-port mapping.
const nesLg = lightgunLoadConfig('nes');
eq('nes single-gun core', nesLg?.core, 'nestopia');
eq('nes single-gun inputDevices', nesLg?.inputDevices, { 2: 262 });
eq('nes single-gun guns', nesLg?.guns, [{ device: 262, port: 1 }]);
// SNES single-gun = Super Scope (260) on port 1 — unchanged.
eq('snes single-gun device', lightgunLoadConfig('snes')?.inputDevices, { 2: 260 });

// SNES two-gun = Justifier (516 gun1 on port1, 772 gun2 on port2).
ok('snes two-gun capable', isTwoGunCapable('snes'));
ok('nes NOT two-gun capable', !isTwoGunCapable('nes'));
eq('snes twoGunForSystem devices', twoGunForSystem('snes')?.devices, [516, 772]);
const snesTwo = lightgunLoadConfig('snes', { twoGun: true });
eq('snes two-gun core', snesTwo?.core, 'snes9x');
eq('snes two-gun inputDevices (two ports)', snesTwo?.inputDevices, { 2: 516, 3: 772 });
eq('snes two-gun guns A/B → ports', snesTwo?.guns, [{ device: 516, port: 1 }, { device: 772, port: 2 }]);
eq('snes two-gun remapName', snesTwo?.remapName, 'Snes9x');
// twoGun requested on a system without lightgun2 → null (no crash).
eq('nes two-gun → null', lightgunLoadConfig('nes', { twoGun: true }), null);

// --- libretroGunPortFor: cable-slot index → libretro gun port -----------------
// The SNES Justifier seats its two guns on libretro ports [1, 2] (from
// lightgunLoadConfig(...).guns.map(g => g.port)). The Kth gun in cable order maps
// to the Kth of those ports — decoupling the in-world jack from the device port.
const justPorts = snesTwo.guns.map((g) => g.port); // [1, 2]
eq('libretroGunPortFor justPorts', justPorts, [1, 2]);
eq('gun slot 0 → libretro port 1', libretroGunPortFor(0, justPorts), 1);
eq('gun slot 1 → libretro port 2', libretroGunPortFor(1, justPorts), 2);
// Out-of-range / single-gun / invalid → null (→ single-gun DOM-mouse path).
eq('gun slot 2 (out of range) → null', libretroGunPortFor(2, justPorts), null);
eq('empty twoGunPorts (single-gun) → null', libretroGunPortFor(0, []), null);
eq('non-array twoGunPorts → null', libretroGunPortFor(0, null), null);
eq('negative slot → null', libretroGunPortFor(-1, justPorts), null);
eq('non-integer slot → null', libretroGunPortFor(0.5, justPorts), null);

// --- twoGunPortsForSystem + per-console port derivation -----------------------
// A gun plugged into ANY console must resolve THAT console's two-gun ports, not
// just the primary's. twoGunPortsForSystem is the pure core of main.js's
// _twoGunPortsForConsole (which returns the live _twoGunPorts verbatim for the
// PRIMARY, and derives from the console runtime's loaded system for SECONDARY
// consoles). A two-gun system yields its ports; a single-gun / no-gun system [].
eq('twoGunPortsForSystem snes (two-gun) → [1,2]', twoGunPortsForSystem('snes'), [1, 2]);
eq('twoGunPortsForSystem nes (single-gun) → []', twoGunPortsForSystem('nes'), []);
eq('twoGunPortsForSystem gb (no gun) → []', twoGunPortsForSystem('gb'), []);
eq('twoGunPortsForSystem unknown → []', twoGunPortsForSystem('nope'), []);
eq('twoGunPortsForSystem null → []', twoGunPortsForSystem(null), []);
// Derivation matches lightgunLoadConfig's guns→ports for the two-gun config (the
// value _twoGunPorts holds at boot), so primary === secondary for the same system.
eq('twoGunPortsForSystem snes === lightgunLoadConfig guns ports',
  twoGunPortsForSystem('snes'),
  lightgunLoadConfig('snes', { twoGun: true }).guns.map((g) => g.port));

// Model the full per-console resolution main.js does: pick the system from the
// console runtime (primary uses the live _twoGunPorts; secondary derives), then
// libretroGunPortFor(slot, ports). Proves: (a) PRIMARY path unchanged — equals
// today's _twoGunPorts; (b) a SECONDARY two-gun console resolves its own [1,2];
// (c) a non-gun secondary → []/null → DOM-mouse path.
const CONSOLE_ID = 'console0';
const primaryTwoGunPorts = [1, 2]; // what _twoGunPorts holds for a booted SNES Justifier
const fakeRack = {
  console0: { system: 'snes' },   // primary (booted two-gun)
  console1: { system: 'snes' },   // secondary two-gun-capable
  console2: { system: 'nes' },    // secondary single-gun
  console3: { system: 'gb' },     // secondary no-gun
};
const portsForConsole = (id) =>
  (id === CONSOLE_ID ? primaryTwoGunPorts : twoGunPortsForSystem(fakeRack[id]?.system));
eq('PRIMARY unchanged: ports === live _twoGunPorts', portsForConsole('console0'), primaryTwoGunPorts);
eq('PRIMARY gun slot 0 → port 1', libretroGunPortFor(0, portsForConsole('console0')), 1);
eq('PRIMARY gun slot 1 → port 2', libretroGunPortFor(1, portsForConsole('console0')), 2);
eq('SECONDARY two-gun console resolves own [1,2]', portsForConsole('console1'), [1, 2]);
eq('SECONDARY gun slot 0 → port 1', libretroGunPortFor(0, portsForConsole('console1')), 1);
eq('SECONDARY gun slot 1 → port 2', libretroGunPortFor(1, portsForConsole('console1')), 2);
eq('SECONDARY single-gun console → [] → null', libretroGunPortFor(0, portsForConsole('console2')), null);
eq('SECONDARY no-gun console → [] → null', libretroGunPortFor(0, portsForConsole('console3')), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
