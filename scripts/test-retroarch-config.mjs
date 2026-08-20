// Pins the RetroArch config's directory keys. Pure logic: no browser, no core,
// no ports — part of `npm test`.  Standalone: node scripts/test-retroarch-config.mjs
//
// WHY THIS EXISTS
// ---------------
// RetroArch keeps the FIRST occurrence of a duplicated key in its cfg and
// silently ignores every later one. That is a uniquely quiet failure mode for
// directory keys, because a core with no BIOS does not error — it falls back
// (PUAE boots its built-in AROS ROM instead of the user's Kickstart, mednafen
// boots the HLE BIOS), so the game still comes up and only behaves subtly wrong.
//
// It happened: EmulatorClient declared its own SYSTEM_DIR
// ('/home/web_user/retroarch/system', without `userdata/`), provisioned every
// opts.systemFiles ROM into it, and APPENDED a second `system_directory` line
// pointing there. RETROARCH_CFG's own line came first and won, so RetroArch read
// a different directory than the one every BIOS had been written to, for every
// main-thread core, silently. It surfaced on 2026-08-15 only because PUAE's
// WHDLoad helper copies Kickstarts out of retro_system_directory and stopped with
// "DOS-Error #205 on reading devs:kickstarts/kick34005.a500". The worker runtime
// had always used the userdata path, which is why the worker-hosted PSX real-BIOS
// probe passed throughout.
//
// So the invariant this file defends is not "the path is spelled correctly" but:
// ONE definition, written ONCE, and every consumer reads that one.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  RETROARCH_CFG,
  RETROARCH_CORE_OPTIONS,
  RETROARCH_CORE_OPTIONS_PATH,
  RETROARCH_SYSTEM_DIR,
  buildRetroArchLaunchConfig,
} from '../src/RetroArchConfig.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`); }
};

console.log('--- retroarch.cfg directory keys ---');

// Counts assignments of `key` in a cfg body. RetroArch's parser is
// line-oriented and tolerant of whitespace around `=`, so this matches the same
// shapes it would.
const keyLines = (cfg, key) =>
  cfg.split('\n').filter((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));

const sysLines = keyLines(RETROARCH_CFG, 'system_directory');
ok('RETROARCH_CFG defines system_directory exactly once',
   sysLines.length === 1,
   `found ${sysLines.length} lines:\n  ${sysLines.join('\n  ') || '(none)'}\n  `
   + `RetroArch honours the FIRST one and ignores the rest, so a second line is `
   + `not an override — it is a silent no-op that splits BIOS provisioning from `
   + `BIOS reading. Change the single definition instead.`);

ok('the cfg\'s system_directory is exactly RETROARCH_SYSTEM_DIR',
   sysLines[0]?.includes(`"${RETROARCH_SYSTEM_DIR}"`),
   `cfg line: ${sysLines[0] || '(none)'}\n  RETROARCH_SYSTEM_DIR: ${RETROARCH_SYSTEM_DIR}\n  `
   + `The export exists so consumers never restate the literal; if the cfg no `
   + `longer interpolates it, they are free to drift apart again.`);

// INVERTING CONTROL. Everything above would also pass if `keyLines` simply never
// matched anything — the exact way a duplicate-key check can be vacuously green.
// Feed it a cfg that IS broken in the historical way and require it to notice.
const brokenCfg = `${RETROARCH_CFG}\nsystem_directory = "/home/web_user/retroarch/system"\n`;
ok('control: the same check FAILS on a cfg with the historical duplicate appended',
   keyLines(brokenCfg, 'system_directory').length === 2,
   `the duplicate-key detector did not see a planted duplicate, so its green `
   + `verdict above means nothing`);
ok('control: the detector finds nothing for a key that is not in the cfg',
   keyLines(RETROARCH_CFG, 'definitely_not_a_retroarch_key').length === 0);

console.log('--- every consumer reads the one definition ---');

// EmulatorClient (main-thread cores) must neither restate the literal nor append
// its own line. Source-level, because the failure was a source-level duplication:
// importing the module and inspecting a value cannot see a second cfg line that
// only exists inside a template string.
const client = read('src/EmulatorClient.js');
ok('EmulatorClient imports RETROARCH_SYSTEM_DIR rather than spelling a path',
   /import\s*\{[^}]*RETROARCH_SYSTEM_DIR[^}]*\}\s*from\s*'\.\/RetroArchConfig\.js'/.test(client),
   'src/EmulatorClient.js no longer imports the shared constant');
ok('EmulatorClient contains no hard-coded retroarch system path',
   !/['"`]\/home\/web_user\/retroarch\/(userdata\/)?system['"`]/.test(client),
   'a literal system path is back in src/EmulatorClient.js — it must use RETROARCH_SYSTEM_DIR');
ok('EmulatorClient writes no second system_directory line',
   !/system_directory\s*=/.test(client.replace(/^\s*\/\/.*$/gm, '')),
   'src/EmulatorClient.js emits a system_directory assignment again; RETROARCH_CFG '
   + 'already carries one and RetroArch would ignore this one');

// The worker runtime is a SEPARATE execution path with its own copy of the
// constant (it runs inside a worker and does not import the app module graph).
// It is allowed to restate the path — but it must restate the SAME path, which
// is precisely what nothing checked while the two silently disagreed.
const worker = read('src/runtime/EmulatorWorkerRuntime.js');
const workerDir = worker.match(/SYSTEM_DIR\s*=\s*'([^']+)'/)?.[1];
ok('the worker runtime\'s SYSTEM_DIR matches RETROARCH_SYSTEM_DIR',
   workerDir === RETROARCH_SYSTEM_DIR,
   `worker: ${workerDir || '(not found)'}\n  shared: ${RETROARCH_SYSTEM_DIR}\n  `
   + `Worker-hosted cores provision BIOS files into their own path; if it drifts `
   + `from the cfg's, those cores get the same invisible fallback the main-thread `
   + `path had.`);


// ---------------------------------------------------------------------------
// LAUNCH-CONFIG ASSEMBLY — GOLDEN TEXT (CODEX ARC-2 (b))
// ---------------------------------------------------------------------------
// WHY THIS SECTION EXISTS
// -----------------------
// Everything above pins the shared CONSTANTS. The part with the actual
// semantics — which ports get a device line, which get the gun mouse-button
// binds, what goes in the per-core .rmp, where each file lands — used to live
// in two hand-copied copies: EmulatorClient.js's `_writeRetroArchConfig` (main-
// thread cores) and EmulatorWorkerRuntime.js's `writeConfig` (worker-execution
// cores: PSX, N64, DOS). Nothing asserted on either backend's emitted text, so
// fixing `input_player${p}_gun_offscreen_shot_mbtn` on one backend and not the
// other was an invisible regression — in exactly the area this project keeps
// re-fixing (the gun/mouse arming leak, the Amiga beam fix, the GunCon2 port+1
// inputDevices key).
//
// Both backends now call one pure builder, buildRetroArchLaunchConfig. This
// section is the proof that the builder emits BYTE-FOR-BYTE what each backend
// emitted before it, for real launch configurations taken from src/systems.js.
// Two independent oracles, because either alone could be wrong in the same
// direction as the code:
//   1. LITERAL goldens — the exact expected cfg suffix / .rmp body, typed out.
//      A reviewer can read these without running anything.
//   2. FROZEN LEGACY REPLICAS — verbatim copies of both pre-refactor functions
//      (reduced to their text emission, with the FS calls recorded instead of
//      performed), run over the whole fixture table and diffed against the
//      builder. These are frozen on purpose: they are the "before" side of the
//      diff and must never be edited to match a new builder.
// Plus controls that fail on purpose, because a golden test that compares two
// things that are both empty is the classic way this kind of suite goes vacuous.
//
// src/main.js has no test coverage at all, so a green `npm test` says nothing
// about whether an extraction from it was faithful. This file is the reason the
// SAME statement is not true of the launch-config extraction.

console.log('--- launch config: golden text (CODEX ARC-2 (b)) ---');

const eq = (name, actual, expected) => ok(
  name,
  actual === expected,
  actual === expected ? '' :
  `expected:\n    ${JSON.stringify(expected)}\n  actual:\n    ${JSON.stringify(actual)}`);

// The cfg body is RETROARCH_CFG plus a per-launch suffix. Golden-testing the
// SUFFIX (rather than pasting the whole multi-kilobyte cfg four times) keeps the
// expectations readable while still being byte-exact: the assertion below also
// pins that the emitted text really does start with the shared constant.
const suffixOf = (name, cfgText) => {
  ok(`${name}: cfg starts with the shared RETROARCH_CFG`, cfgText.startsWith(RETROARCH_CFG),
     'the launch cfg no longer begins with the shared base config — the suffix '
     + 'comparison below would be meaningless');
  return cfgText.slice(RETROARCH_CFG.length);
};

// EmulatorClient.start()'s normalization step, replicated (src/EmulatorClient.js
// @ c48db3d). This is the MAIN-THREAD CALLER's half, not the builder's: `{}` is
// collapsed to null before _writeRetroArchConfig ever runs. The worker backend
// has no equivalent step and forwards its start payload raw, which is why the
// two backends legitimately differ on an empty map. Modelling it here (rather
// than pre-normalizing the fixture table, or normalizing inside the builder) is
// what lets the same fixtures be diffed against BOTH frozen replicas.
const normalizeBootMap = (v) => (v && typeof v === 'object' && Object.keys(v).length) ? v : null;

const CORE_OPTS_LINE = 'core_options_path = "/home/web_user/retroarch/userdata/retroarch-core-options.cfg"\n';
const REMAP_HEAD = 'input_remap_binds_enable = "true"\n'
                 + 'input_remapping_directory = "/home/web_user/retroarch/userdata/config/remaps"\n';

// --- 1. literal goldens, main-thread backend ------------------------------
// A plain gamepad launch: no inputDevices at all (every cartridge boot that
// isn't a gun/mouse/Four Score). Nothing may be appended to the cfg, and no
// .rmp and no core-options file may be written.
{
  const b = buildRetroArchLaunchConfig({ emitCoreOptionsPathLine: true });
  eq('plain gamepad boot: cfg suffix is empty', suffixOf('plain gamepad boot', b.cfgText), '');
  eq('plain gamepad boot: no .rmp', b.rmpPath, null);
  eq('plain gamepad boot: no .rmp text', b.rmpText, null);
  eq('plain gamepad boot: no core-options file', b.coreOptionsText, null);
  eq('plain gamepad boot: no warning', b.warning, null);
}

// NES Four Score: two extra JOYPADs on players 3+4 (systems.js fourScore).
// 513 & 0xff = 1 = RETRO_DEVICE_JOYPAD, so these get the device line and
// NOTHING else — no mouse_index, no gun binds.
{
  const b = buildRetroArchLaunchConfig({
    inputDevices: { 3: 513, 4: 513 }, remapName: 'FCEUmm', emitCoreOptionsPathLine: true,
  });
  eq('four-score boot: cfg suffix', suffixOf('four-score boot', b.cfgText),
     REMAP_HEAD
     + 'input_libretro_device_p3 = "513"\n'
     + 'input_libretro_device_p4 = "513"\n');
  eq('four-score boot: .rmp path', b.rmpPath,
     '/home/web_user/retroarch/userdata/config/remaps/FCEUmm/FCEUmm.rmp');
  eq('four-score boot: .rmp text', b.rmpText,
     'input_libretro_device_p3 = "513"\ninput_libretro_device_p4 = "513"\n');
}

// NES Zapper (SYSTEMS.nes.lightgun): device 262 on port 1 → player 2. 262 & 0xff
// = 6 = RETRO_DEVICE_POINTER, which is a GUN for our purposes — nestopia's Zapper
// is a POINTER subclass read through the LIGHTGUN path, so it must get the gun
// mouse-button binds. This is the case a base-class check written as
// `=== RETRO_DEVICE_LIGHTGUN` alone would silently drop.
{
  const b = buildRetroArchLaunchConfig({
    inputDevices: { 2: 262 }, remapName: 'Nestopia', emitCoreOptionsPathLine: true,
    coreOptions: { nestopia_zapper_device: 'lightgun', nestopia_show_crosshair: 'enabled' },
  });
  eq('zapper boot: cfg suffix', suffixOf('zapper boot', b.cfgText),
     CORE_OPTS_LINE
     + REMAP_HEAD
     + 'input_libretro_device_p2 = "262"\n'
     + 'input_player2_mouse_index = "0"\n'
     + 'input_player2_gun_trigger_mbtn = "1"\n'
     + 'input_player2_gun_offscreen_shot_mbtn = "2"\n');
  eq('zapper boot: .rmp text', b.rmpText, 'input_libretro_device_p2 = "262"\n');
  eq('zapper boot: .rmp path', b.rmpPath,
     '/home/web_user/retroarch/userdata/config/remaps/Nestopia/Nestopia.rmp');
  eq('zapper boot: core options', b.coreOptionsText,
     'nestopia_zapper_device = "lightgun"\nnestopia_show_crosshair = "enabled"\n');
}

// Two guns on one console (SNES Justifier / Lethal Enforcers, systems.js's
// twoGun path): BOTH ports in inputDevices, both getting their own binds.
{
  const b = buildRetroArchLaunchConfig({
    inputDevices: { 1: 260, 2: 260 }, remapName: 'Snes9x', emitCoreOptionsPathLine: true,
  });
  eq('two-gun boot: cfg suffix', suffixOf('two-gun boot', b.cfgText),
     REMAP_HEAD
     + 'input_libretro_device_p1 = "260"\n'
     + 'input_player1_mouse_index = "0"\n'
     + 'input_player1_gun_trigger_mbtn = "1"\n'
     + 'input_player1_gun_offscreen_shot_mbtn = "2"\n'
     + 'input_libretro_device_p2 = "260"\n'
     + 'input_player2_mouse_index = "0"\n'
     + 'input_player2_gun_trigger_mbtn = "1"\n'
     + 'input_player2_gun_offscreen_shot_mbtn = "2"\n');
  eq('two-gun boot: .rmp text', b.rmpText,
     'input_libretro_device_p1 = "260"\ninput_libretro_device_p2 = "260"\n');
}

// A mouse port (SNES Mouse, device 2 on port 1 → player 2). A MOUSE gets the
// mouse_index line and MUST NOT get the gun trigger binds — binding a gun
// trigger on a mouse port is one of the ways this has broken before.
{
  const b = buildRetroArchLaunchConfig({
    inputDevices: { 2: 2 }, remapName: 'Snes9x', emitCoreOptionsPathLine: true,
  });
  const suffix = suffixOf('mouse boot', b.cfgText);
  eq('mouse boot: cfg suffix', suffix,
     REMAP_HEAD
     + 'input_libretro_device_p2 = "2"\n'
     + 'input_player2_mouse_index = "0"\n');
  ok('mouse boot: no gun binds on a mouse port', !/gun_/.test(suffix),
     `a gun bind leaked onto a MOUSE port:\n  ${suffix}`);
}

// PS2 GunCon2 (SYSTEMS.ps2.lightgun): gun port 0, so the inputDevices KEY is 1
// — systems.js writes `inputDevices[port + 1] = device`, the "port+1" convention
// that took a real debugging session to establish. Its coreOptions is literally
// `{}`. Note this is called THE WAY EmulatorClient CALLS IT — through start()'s
// normalizeBootMap — because that collapse is the main thread's, not the
// builder's; the worker hands the same `{}` straight to the builder and gets a
// different (and correct-for-it) answer. See section 4.
{
  const b = buildRetroArchLaunchConfig({
    inputDevices: normalizeBootMap({ 1: 260 }), remapName: 'Play!',
    coreOptions: normalizeBootMap({}), emitCoreOptionsPathLine: true,
  });
  eq('ps2 guncon2 boot: cfg suffix', suffixOf('ps2 guncon2 boot', b.cfgText),
     REMAP_HEAD
     + 'input_libretro_device_p1 = "260"\n'
     + 'input_player1_mouse_index = "0"\n'
     + 'input_player1_gun_trigger_mbtn = "1"\n'
     + 'input_player1_gun_offscreen_shot_mbtn = "2"\n');
  eq('ps2 guncon2 boot: .rmp path uses the library name verbatim, punctuation and all',
     b.rmpPath, '/home/web_user/retroarch/userdata/config/remaps/Play!/Play!.rmp');
  eq('ps2 guncon2 boot: empty coreOptions writes no core-options file on the main thread',
     b.coreOptionsText, null);
  // ...and the SAME launch config on the worker backend, which does not
  // normalize: `{}` is present, so the baseline gets the legacy bare newline.
  // Two backends, one shared builder, two different — and both correct — answers.
  eq('ps2 guncon2 boot: the same empty coreOptions DOES reach the worker core-options file',
     buildRetroArchLaunchConfig({
       inputDevices: { 1: 260 }, remapName: 'Play!', coreOptions: {},
       coreOptionsBaseline: RETROARCH_CORE_OPTIONS,
     }).coreOptionsText, RETROARCH_CORE_OPTIONS + '\n');
}

// --- 2. literal goldens, worker backend -----------------------------------
// Same builder, called the way EmulatorWorkerRuntime does: with the static
// RETROARCH_CORE_OPTIONS baseline and WITHOUT the main thread's duplicate
// core_options_path line.
{
  const b = buildRetroArchLaunchConfig({
    inputDevices: { 1: 260 }, remapName: 'Beetle PSX',
    coreOptions: { beetle_psx_gun_input_mode: 'lightgun' },
    coreOptionsBaseline: RETROARCH_CORE_OPTIONS,
  });
  eq('psx guncon boot (worker): cfg suffix has no core_options_path line',
     suffixOf('psx guncon boot (worker)', b.cfgText),
     REMAP_HEAD
     + 'input_libretro_device_p1 = "260"\n'
     + 'input_player1_mouse_index = "0"\n'
     + 'input_player1_gun_trigger_mbtn = "1"\n'
     + 'input_player1_gun_offscreen_shot_mbtn = "2"\n');
  eq('psx guncon boot (worker): core options are the baseline plus the override',
     b.coreOptionsText, RETROARCH_CORE_OPTIONS + 'beetle_psx_gun_input_mode = "lightgun"\n');
  eq('psx guncon boot (worker): a worker launch with no overrides still writes the baseline',
     buildRetroArchLaunchConfig({ coreOptionsBaseline: RETROARCH_CORE_OPTIONS }).coreOptionsText,
     RETROARCH_CORE_OPTIONS);
}

// The three cfg search paths, in order. RetroArch does NOT search
// /home/web_user/retroarch/userdata/ (the `-c` target); the other two are its
// real defaults. Both backends wrote this exact list; if a refactor ever
// normalizes it to one "obvious" path, device binding stops working with no
// other symptom.
{
  const b = buildRetroArchLaunchConfig({});
  eq('cfg search paths', JSON.stringify(b.cfgPaths), JSON.stringify([
    ['/home/web_user/retroarch/userdata', '/home/web_user/retroarch/userdata/retroarch.cfg'],
    ['/home/web_user/.config/retroarch', '/home/web_user/.config/retroarch/retroarch.cfg'],
    ['/home/web_user', '/home/web_user/.retroarch.cfg'],
  ]));
  eq('core-options path', b.coreOptionsPath,
     '/home/web_user/retroarch/userdata/retroarch-core-options.cfg');
  eq('system dir is the one shared definition', b.systemDir, RETROARCH_SYSTEM_DIR);
}

// --- 3. frozen legacy replicas --------------------------------------------
// VERBATIM copies of the two pre-refactor functions (HEAD c48db3d), reduced to
// their text emission: `M.FS.writeFile` is recorded instead of performed, and
// the log call is recorded instead of logged. DO NOT "fix" these to agree with
// the builder — they are the frozen "before" side of the diff. If the builder
// must legitimately change, the divergence section below is where that is
// declared, one named case at a time.

// src/EmulatorClient.js:864-963 @ c48db3d
function legacyMainThread({ inputDevices, remapName, coreOptions }) {
  const RETROARCH_CFG_DIR = '/home/web_user/retroarch/userdata';
  const RETROARCH_CFG_PATH = RETROARCH_CFG_DIR + '/retroarch.cfg';
  const CORE_OPTIONS_PATH = RETROARCH_CFG_DIR + '/retroarch-core-options.cfg';
  const REMAP_DIR = RETROARCH_CFG_DIR + '/config/remaps';
  const normalizeBootMap = (v) => (v && typeof v === 'object' && Object.keys(v).length) ? v : null;
  const out = { cfg: null, files: {}, warnings: [], cfgPaths: null };
  const M = { FS: { mkdirTree() {}, writeFile: (p, c) => { out.files[p] = c; } } };
  const self = {
    _coreOptions: normalizeBootMap(coreOptions),
    _inputDevices: normalizeBootMap(inputDevices),
    _remapName: remapName || null,
  };
  const console = { warn: (...a) => out.warnings.push(a.join(' ')) };

  let cfg = RETROARCH_CFG;
  if (self._coreOptions) {
    cfg += `core_options_path = "${CORE_OPTIONS_PATH}"\n`;
    const body = Object.entries(self._coreOptions)
      .map(([k, v]) => `${k} = "${v}"`).join('\n') + '\n';
    try { M.FS.mkdirTree(RETROARCH_CFG_DIR); } catch (_) {}
    try { M.FS.writeFile(CORE_OPTIONS_PATH, body); } catch (e) {
      console.warn('[EmulatorClient] failed to write core options', e);
    }
  }
  if (self._inputDevices) {
    const RETRO_DEVICE_MASK = 0xff, RETRO_DEVICE_MOUSE = 2, RETRO_DEVICE_LIGHTGUN = 4, RETRO_DEVICE_POINTER = 6;
    const validPorts = Object.entries(self._inputDevices)
      .filter(([player]) => Number.isInteger(Number(player)) && Number(player) >= 1);
    cfg += `input_remap_binds_enable = "true"\n`;
    cfg += `input_remapping_directory = "${REMAP_DIR}"\n`;
    for (const [player, dev] of validPorts) {
      const p = Number(player);
      cfg += `input_libretro_device_p${p} = "${dev}"\n`;
      const base = Number(dev) & RETRO_DEVICE_MASK;
      if (base === RETRO_DEVICE_LIGHTGUN || base === RETRO_DEVICE_POINTER) {
        cfg += `input_player${p}_mouse_index = "0"\n`;
        cfg += `input_player${p}_gun_trigger_mbtn = "1"\n`;
        cfg += `input_player${p}_gun_offscreen_shot_mbtn = "2"\n`;
      } else if (base === RETRO_DEVICE_MOUSE) {
        cfg += `input_player${p}_mouse_index = "0"\n`;
      }
    }
    if (self._remapName && validPorts.length) {
      const rmp = validPorts.map(([p, dev]) => `input_libretro_device_p${Number(p)} = "${dev}"`).join('\n') + '\n';
      const dir = `${REMAP_DIR}/${self._remapName}`;
      try { M.FS.mkdirTree(dir); } catch (_) {}
      try { M.FS.writeFile(`${dir}/${self._remapName}.rmp`, rmp); } catch (e) {
        console.warn('[EmulatorClient] failed to write remap', e);
      }
    } else if (self._inputDevices) {
      console.warn('[EmulatorClient] inputDevices set without remapName — port device will not connect at boot');
    }
  }
  out.cfgPaths = [
    [RETROARCH_CFG_DIR, RETROARCH_CFG_PATH],
    ['/home/web_user/.config/retroarch', '/home/web_user/.config/retroarch/retroarch.cfg'],
    ['/home/web_user',                   '/home/web_user/.retroarch.cfg'],
  ];
  for (const [, path] of out.cfgPaths) out.files[path] = cfg;
  out.cfg = cfg;
  return out;
}

// src/runtime/EmulatorWorkerRuntime.js:296-359 @ c48db3d
function legacyWorker(payload = {}) {
  const REMAP_DIR = '/home/web_user/retroarch/userdata/config/remaps';
  const RA_CFG_PATH = '/home/web_user/retroarch/userdata/retroarch.cfg';
  const out = { cfg: null, files: {}, warnings: [], cfgPaths: null };
  const moduleInstance = { FS: { mkdirTree() {}, writeFile: (p, c) => { out.files[p] = c; } } };
  const postMessage = (m) => out.warnings.push(m);
  const eventMessage = (_kind, { text }) => text;

  let coreOptionsBody = RETROARCH_CORE_OPTIONS;
  if (payload.coreOptions) {
    coreOptionsBody += Object.entries(payload.coreOptions)
      .map(([k, v]) => `${k} = "${v}"`).join('\n') + '\n';
  }
  let cfg = RETROARCH_CFG;
  if (payload.inputDevices) {
    const RETRO_DEVICE_MASK = 0xff, RETRO_DEVICE_MOUSE = 2, RETRO_DEVICE_LIGHTGUN = 4, RETRO_DEVICE_POINTER = 6;
    const validPorts = Object.entries(payload.inputDevices)
      .filter(([player]) => Number.isInteger(Number(player)) && Number(player) >= 1);
    cfg += `input_remap_binds_enable = "true"\n`;
    cfg += `input_remapping_directory = "${REMAP_DIR}"\n`;
    for (const [player, dev] of validPorts) {
      const p = Number(player);
      cfg += `input_libretro_device_p${p} = "${dev}"\n`;
      const base = Number(dev) & RETRO_DEVICE_MASK;
      if (base === RETRO_DEVICE_LIGHTGUN || base === RETRO_DEVICE_POINTER) {
        cfg += `input_player${p}_mouse_index = "0"\n`;
        cfg += `input_player${p}_gun_trigger_mbtn = "1"\n`;
        cfg += `input_player${p}_gun_offscreen_shot_mbtn = "2"\n`;
      } else if (base === RETRO_DEVICE_MOUSE) {
        cfg += `input_player${p}_mouse_index = "0"\n`;
      }
    }
    if (payload.remapName && validPorts.length) {
      const rmp = validPorts.map(([p, dev]) => `input_libretro_device_p${Number(p)} = "${dev}"`).join('\n') + '\n';
      const dir = `${REMAP_DIR}/${payload.remapName}`;
      try { moduleInstance.FS.mkdirTree(dir); } catch (_) {}
      try { moduleInstance.FS.writeFile(`${dir}/${payload.remapName}.rmp`, rmp); }
      catch (e) { postMessage(eventMessage('log', { level: 'error', text: `[EmulatorWorkerRuntime] failed to write remap: ${e?.message || e}` })); }
    } else {
      postMessage(eventMessage('log', { level: 'error', text: '[EmulatorWorkerRuntime] inputDevices set without remapName — port device will not connect at boot' }));
    }
  }
  const targets = [
    ['/home/web_user/retroarch/userdata', RA_CFG_PATH, cfg],
    ['/home/web_user/retroarch/userdata', RETROARCH_CORE_OPTIONS_PATH, coreOptionsBody],
    ['/home/web_user/.config/retroarch', '/home/web_user/.config/retroarch/retroarch.cfg', cfg],
    ['/home/web_user', '/home/web_user/.retroarch.cfg', cfg],
  ];
  for (const [, path, contents] of targets) out.files[path] = contents;
  out.cfgPaths = targets.filter(([, p]) => p !== RETROARCH_CORE_OPTIONS_PATH).map(([d, p]) => [d, p]);
  out.cfg = cfg;
  return out;
}

// Turns a builder result into the same {cfg, files, warnings} shape the two
// legacy replicas produce, applying each backend's caller half exactly as the
// refactored functions now do: `normalize` for start()'s collapse, then the
// FS-writer half.
function emitViaBuilder(fixture, { baseline = '', coreOptionsPathLine = false, normalize = false, tag }) {
  const asCalled = normalize ? normalizeBootMap : ((v) => v);
  const b = buildRetroArchLaunchConfig({
    inputDevices: asCalled(fixture.inputDevices),
    remapName: fixture.remapName,
    coreOptions: asCalled(fixture.coreOptions),
    systemFiles: fixture.systemFiles,
    coreOptionsBaseline: baseline,
    emitCoreOptionsPathLine: coreOptionsPathLine,
  });
  const out = { cfg: b.cfgText, files: {}, warnings: [], cfgPaths: b.cfgPaths };
  if (b.coreOptionsText !== null) out.files[b.coreOptionsPath] = b.coreOptionsText;
  if (b.rmpPath) out.files[b.rmpPath] = b.rmpText;
  if (b.warning) out.warnings.push(`${tag} ${b.warning}`);
  for (const [, path] of b.cfgPaths) out.files[path] = b.cfgText;
  return out;
}

// Real launch configurations, from src/systems.js.
const FIXTURES = [
  { name: 'plain gamepad (no overrides)', inputDevices: null, remapName: null, coreOptions: null },
  { name: 'NES Four Score (two extra pads)', inputDevices: { 3: 513, 4: 513 }, remapName: 'FCEUmm' },
  { name: 'NES Zapper (POINTER subclass)', inputDevices: { 2: 262 }, remapName: 'Nestopia',
    coreOptions: { nestopia_zapper_device: 'lightgun', nestopia_show_crosshair: 'enabled' } },
  { name: 'SNES Super Scope', inputDevices: { 2: 260 }, remapName: 'Snes9x',
    coreOptions: { snes9x_superscope_crosshair: 'enabled' } },
  { name: 'SNES two-gun co-op', inputDevices: { 1: 260, 2: 260 }, remapName: 'Snes9x' },
  { name: 'SNES Mouse', inputDevices: { 2: 2 }, remapName: 'Snes9x' },
  { name: 'Amiga Trojan Phazer (PUAE)', inputDevices: { 1: 260 }, remapName: 'PUAE',
    coreOptions: { puae_kickstart: 'Automatic' } },
  { name: 'PS2 GunCon2 (port+1 key, empty coreOptions)', inputDevices: { 1: 260 }, remapName: 'Play!', coreOptions: {} },
  { name: 'PSX GunCon (worker core)', inputDevices: { 1: 260 }, remapName: 'Beetle PSX',
    coreOptions: { beetle_psx_gun_input_mode: 'lightgun' } },
  { name: 'DOS mouse (worker core)', inputDevices: { 1: 2 }, remapName: 'DOSBox-pure' },
  { name: 'devices with no remapName (the warned case)', inputDevices: { 2: 260 }, remapName: null },
  { name: 'invalid port keys only', inputDevices: { 0: 260, notaport: 4 }, remapName: 'Snes9x' },
  { name: 'core options only, no devices', inputDevices: null, remapName: 'Snes9x',
    coreOptions: { puae_model_fd: 'A500 (v1.3, 0.5M Chip + 0.5M Slow)' } },
  // --- the UNTIDY shapes ---------------------------------------------------
  // These are the shapes that actually reach the two functions and that the
  // first version of this table missed, which is exactly how an empty-map
  // regression got through it: every fixture above passes either a populated
  // map or an explicit null, and `{}` is neither. systems.js produces `{}`
  // constantly (`coreOptions: tg.coreOptions || {}`, `coreOptions: m.coreOptions
  // || {}`, SYSTEMS.ps2.lightgun's literal `coreOptions: {}`), and an ABSENT
  // field (undefined) is a third, distinct input — the Four Score config carries
  // no coreOptions key at all. All three must round-trip per backend.
  { name: 'empty inputDevices map (present but empty)', inputDevices: {}, remapName: 'Beetle PSX' },
  { name: 'empty inputDevices map, no remapName', inputDevices: {}, remapName: null },
  { name: 'empty coreOptions map (present but empty)', inputDevices: null, remapName: 'Play!', coreOptions: {} },
  { name: 'both maps empty', inputDevices: {}, remapName: 'Beetle PSX', coreOptions: {} },
  { name: 'every field undefined (absent, not null)' },
  { name: 'devices present, coreOptions absent (Four Score shape)', inputDevices: { 3: 513, 4: 513 }, remapName: 'FCEUmm' },
  { name: 'empty coreOptions with populated devices (PS2 shape on the worker)',
    inputDevices: { 1: 260 }, remapName: 'Beetle PSX', coreOptions: {} },
  { name: 'empty inputDevices with populated coreOptions', inputDevices: {}, remapName: 'DOSBox-pure',
    coreOptions: { dosbox_pure_mouse_input: 'true' } },
  // PUAE's real launch config: option VALUES carrying spaces, commas,
  // parentheses and dots, plus systemFiles. Nothing quotes or escapes these, so
  // a well-meaning escaping pass would surface right here.
  { name: 'PUAE core defaults (punctuated option values + systemFiles)', inputDevices: null, remapName: 'PUAE',
    coreOptions: { puae_kickstart: 'Automatic', puae_model_fd: 'A500 (v1.3, 0.5M Chip + 0.5M Slow)' },
    systemFiles: [{ name: 'kick34005.A500', url: 'roms/local/amiga/kick34005.A500' }] },
];

const sameEmission = (label, a, b) => {
  eq(`${label}: cfg text`, a.cfg, b.cfg);
  eq(`${label}: files written`, JSON.stringify(a.files, Object.keys(a.files).sort()),
     JSON.stringify(b.files, Object.keys(b.files).sort()));
  eq(`${label}: file set`, JSON.stringify(Object.keys(a.files).sort()),
     JSON.stringify(Object.keys(b.files).sort()));
  eq(`${label}: warnings`, JSON.stringify(a.warnings), JSON.stringify(b.warnings));
  eq(`${label}: cfg paths`, JSON.stringify(a.cfgPaths), JSON.stringify(b.cfgPaths));
};

// EVERY fixture must reproduce BOTH frozen replicas byte for byte, with no
// declared exception. There was one for a while — `coreOptions: {}` on the
// worker — and it was a regression wearing a rationale: an exception in this
// loop is precisely how a behaviour change hides inside a move billed as
// verbatim. If a future change to the emitted text is genuinely wanted, change
// the backend that wants it and re-freeze ITS replica, one named case at a time.
for (const fx of FIXTURES) {
  sameEmission(`main-thread "${fx.name}"`,
    emitViaBuilder(fx, { coreOptionsPathLine: true, normalize: true, tag: '[EmulatorClient]' }),
    legacyMainThread(fx));
  sameEmission(`worker "${fx.name}"`,
    emitViaBuilder(fx, { baseline: RETROARCH_CORE_OPTIONS, tag: '[EmulatorWorkerRuntime]' }),
    legacyWorker(fx));
}

// --- 4. `{}` vs undefined: two inputs, two backends, four answers ---------
// The empty map is the shape this suite exists to hold still, because it is the
// one the first draft of the extraction got wrong (it collapsed `{}` to null in
// the shared builder, silently changing the worker's bytes) and the one
// production reaches most: systems.js hands out `coreOptions: tg.coreOptions ||
// {}` for every gun/mouse config that declares none, and SYSTEMS.ps2.lightgun
// carries a literal `coreOptions: {}`.
//
// `{}` and undefined are DIFFERENT INPUTS, and the two backends answer them
// differently — legitimately, because the difference lives in the CALLER, not in
// the shared text assembler:
//
//   • EmulatorClient.start() runs every per-launch map through normalizeBootMap,
//     so `{}` is already null by the time the builder is called. Empty map ⇒
//     identical to undefined ⇒ nothing emitted.
//   • EmulatorWorkerRuntime forwards its start payload raw and has never had a
//     normalization step, so a truthy `{}` emits: the two remap-header lines
//     with no device line under them, an "inputDevices set without remapName"
//     error log, and a bare "\n" appended to the core-options file (from
//     `[].map(...).join('\n') + '\n'`).
//
// All four combinations are pinned below against the frozen replicas. Guns and
// mice on PSX / PS2 / N64 / Amiga all run on the worker backend, and its error
// log is read off a headset (docs/HANDOFF.md, "Reading headset logs"), so the
// diagnostic is not decoration — dropping it was the finding that produced this
// section.
{
  const both = { inputDevices: {}, coreOptions: {}, remapName: 'Beetle PSX' };
  const absent = { remapName: 'Beetle PSX' };

  // --- worker backend: `{}` is PRESENT --------------------------------------
  const w = emitViaBuilder(both, { baseline: RETROARCH_CORE_OPTIONS, tag: '[EmulatorWorkerRuntime]' });
  const wLegacy = legacyWorker(both);
  eq('worker + empty maps: cfg suffix is the inert remap header', suffixOf('worker empty maps', w.cfg), REMAP_HEAD);
  eq('worker + empty maps: matches the frozen legacy worker cfg byte for byte', w.cfg, wLegacy.cfg);
  eq('worker + empty maps: the no-remapName error log is still posted',
     JSON.stringify(w.warnings),
     JSON.stringify(['[EmulatorWorkerRuntime] inputDevices set without remapName — port device will not connect at boot']));
  eq('worker + empty maps: the log matches the frozen legacy worker',
     JSON.stringify(w.warnings), JSON.stringify(wLegacy.warnings));
  eq('worker + empty maps: core options are the baseline plus the legacy bare newline',
     w.files[RETROARCH_CORE_OPTIONS_PATH], RETROARCH_CORE_OPTIONS + '\n');
  eq('worker + empty maps: core options match the frozen legacy worker',
     w.files[RETROARCH_CORE_OPTIONS_PATH], wLegacy.files[RETROARCH_CORE_OPTIONS_PATH]);
  eq('worker + empty maps: still no .rmp (no valid ports)', w.files['/home/web_user/retroarch/userdata/config/remaps/Beetle PSX/Beetle PSX.rmp'], undefined);

  // --- worker backend: undefined is ABSENT, and must NOT look the same ------
  const wAbsent = emitViaBuilder(absent, { baseline: RETROARCH_CORE_OPTIONS, tag: '[EmulatorWorkerRuntime]' });
  eq('worker + absent maps: cfg suffix is empty', suffixOf('worker absent maps', wAbsent.cfg), '');
  eq('worker + absent maps: no error log', JSON.stringify(wAbsent.warnings), '[]');
  eq('worker + absent maps: core options are the bare baseline',
     wAbsent.files[RETROARCH_CORE_OPTIONS_PATH], RETROARCH_CORE_OPTIONS);
  ok('worker: `{}` and undefined produce DIFFERENT cfg text',
     w.cfg !== wAbsent.cfg,
     'the worker backend now treats a present-but-empty map as absent — that is '
     + 'the regression this section exists to catch, and it drops the '
     + '"inputDevices set without remapName" diagnostic on the gun/mouse path');
  ok('worker: `{}` and undefined produce DIFFERENT core-options bytes',
     w.files[RETROARCH_CORE_OPTIONS_PATH] !== wAbsent.files[RETROARCH_CORE_OPTIONS_PATH]);

  // --- main thread: start() collapses `{}`, so the two ARE the same ---------
  const m = emitViaBuilder(both, { coreOptionsPathLine: true, normalize: true, tag: '[EmulatorClient]' });
  const mAbsent = emitViaBuilder(absent, { coreOptionsPathLine: true, normalize: true, tag: '[EmulatorClient]' });
  eq('main thread + empty maps: cfg suffix is empty (start() already collapsed them)',
     suffixOf('main-thread empty maps', m.cfg), '');
  eq('main thread + empty maps: no warning', JSON.stringify(m.warnings), '[]');
  eq('main thread + empty maps: no core-options file at all',
     JSON.stringify(Object.keys(m.files).sort()), JSON.stringify(Object.keys(mAbsent.files).sort()));
  sameEmission('main-thread: `{}` is indistinguishable from undefined', m, mAbsent);
  sameEmission('main-thread + empty maps vs the frozen legacy main thread', m, legacyMainThread(both));

  // --- and the builder itself must not be the one deciding ------------------
  // Called directly, with no caller in front of it, `{}` is present. If this
  // ever flips, both backends change at once and neither golden above can say
  // which one was meant to.
  const raw = buildRetroArchLaunchConfig({ inputDevices: {}, coreOptions: {}, remapName: 'Beetle PSX' });
  eq('builder: a bare `{}` inputDevices still emits the remap header',
     suffixOf('builder raw empty', raw.cfgText), REMAP_HEAD);
  eq('builder: a bare `{}` inputDevices still returns the warning', raw.warning,
     'inputDevices set without remapName — port device will not connect at boot');
  eq('builder: a bare `{}` coreOptions still emits its newline', raw.coreOptionsText, '\n');
  const rawAbsent = buildRetroArchLaunchConfig({ remapName: 'Beetle PSX' });
  eq('builder: undefined inputDevices emits nothing', suffixOf('builder absent', rawAbsent.cfgText), '');
  eq('builder: undefined inputDevices returns no warning', rawAbsent.warning, null);
  eq('builder: undefined coreOptions writes no core-options file', rawAbsent.coreOptionsText, null);

  // Control: the frozen legacy worker really did emit all three, so the
  // paragraph above is describing history and not a straw man.
  ok('control: the legacy worker DID emit the inert remap header',
     wLegacy.cfg.includes('input_remap_binds_enable'),
     'the behaviour this section pins cannot be reproduced from the frozen legacy '
     + 'copy — one of them is wrong');
  ok('control: the legacy worker DID log the no-remapName error', wLegacy.warnings.length === 1);
  ok('control: the legacy worker DID append a stray newline to core options',
     wLegacy.files[RETROARCH_CORE_OPTIONS_PATH] === RETROARCH_CORE_OPTIONS + '\n');
  // Control: and the legacy MAIN THREAD really did not, so "the two backends
  // differ" is a fact about HEAD rather than an artefact of this file.
  ok('control: the legacy main thread did NOT emit the remap header for `{}`',
     !legacyMainThread(both).cfg.includes('input_remap_binds_enable'));
}

// --- 5. anti-vacuity controls ---------------------------------------------
// Everything above is a string comparison, and a string comparison passes
// trivially if both sides are empty or if the fixture never reaches the code
// under test. These fail on purpose if that happens.
{
  const gunFixtures = FIXTURES.filter((f) => /Zapper|Scope|two-gun|GunCon|Phazer/.test(f.name));
  ok('control: the fixture table really exercises the gun path',
     gunFixtures.length >= 5, `only ${gunFixtures.length} gun fixtures`);
  for (const fx of gunFixtures) {
    const b = buildRetroArchLaunchConfig({ inputDevices: fx.inputDevices, remapName: fx.remapName });
    ok(`control: "${fx.name}" emits a gun trigger bind`,
       b.cfgText.includes('_gun_trigger_mbtn = "1"'),
       'this fixture produced no gun bind at all, so comparing it against the '
       + 'legacy copy proves nothing');
    ok(`control: "${fx.name}" emits an offscreen-shot bind`,
       b.cfgText.includes('_gun_offscreen_shot_mbtn = "2"'));
  }
  // A planted regression — the exact one CODEX ARC-2 (b) describes, a changed
  // offscreen-shot button — must break the comparison.
  const good = emitViaBuilder(FIXTURES[2], { coreOptionsPathLine: true, tag: '[EmulatorClient]' });
  const tampered = { ...good, cfg: good.cfg.replace('_gun_offscreen_shot_mbtn = "2"', '_gun_offscreen_shot_mbtn = "3"') };
  ok('control: a changed gun_offscreen_shot_mbtn makes the golden comparison FAIL',
     tampered.cfg !== legacyMainThread(FIXTURES[2]).cfg && tampered.cfg !== good.cfg,
     'the comparison cannot see a changed gun binding — it is vacuous');
  // And a planted regression in the .rmp, which is what actually connects the
  // device at boot.
  const b = buildRetroArchLaunchConfig({ inputDevices: { 2: 262 }, remapName: 'Nestopia' });
  ok('control: the .rmp body is not empty', b.rmpText.length > 0);
  ok('control: a dropped port would change the .rmp',
     buildRetroArchLaunchConfig({ inputDevices: {}, remapName: 'Nestopia' }).rmpText !== b.rmpText);
}

// --- 6. the empty-map answer must stay in the CALLERS ----------------------
// Sections 3-5 compare emitted text, and text comparisons can only see what the
// fixtures feed them. This one is structural: it pins WHERE the `{}` decision
// lives, because the regression it guards against was a one-line move of that
// decision from EmulatorClient.start() into the shared builder — which changed
// the worker's bytes without touching a line of the worker.
{
  const config = read('src/RetroArchConfig.js');
  const uncommented = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  ok('EmulatorClient still collapses `{}` in start(), before the builder sees it',
     /this\._coreOptions\s*=\s*normalizeBootMap\(/.test(client)
     && /this\._inputDevices\s*=\s*normalizeBootMap\(/.test(client),
     'src/EmulatorClient.js no longer normalizes its per-launch maps in start(). '
     + 'That collapse is what makes `{}` a no-op for every main-thread gun and '
     + 'mouse; without it the main thread starts emitting the worker\'s inert '
     + 'remap header and a spurious no-remapName warning.');

  ok('the shared builder does NOT collapse `{}` for both backends at once',
     !/Object\.keys\([^)]*\)\.length/.test(uncommented(config)),
     'src/RetroArchConfig.js has an emptiness test in it again. Normalizing there '
     + 'silently rewrites the WORKER backend too — it forwards its start payload '
     + 'raw — dropping its remap header, its "inputDevices set without remapName" '
     + 'diagnostic and a core-options newline for every PSX/PS2/N64/Amiga gun and '
     + 'mouse launch. Decide it in the caller that wants it.');

  ok('the worker runtime passes its payload maps to the builder unnormalized',
     /inputDevices:\s*payload\.inputDevices/.test(worker)
     && /coreOptions:\s*payload\.coreOptions/.test(worker),
     'src/runtime/EmulatorWorkerRuntime.js now transforms its maps on the way to '
     + 'the builder; at c48db3d it forwarded them raw');

  ok('the worker\'s seated-device echo tests the SAME value the builder was given',
     /seatedInputDevices\s*=\s*payload\.inputDevices\s*\?/.test(worker),
     'seatedInputDevices no longer reads the same raw payload.inputDevices the '
     + 'builder is handed, so the worker can report a seated map the emitted cfg '
     + 'does not agree with');

  // Anti-vacuity: the two regexes above must actually be capable of failing.
  ok('control: the start()-normalization check would notice its removal',
     !/this\._coreOptions\s*=\s*normalizeBootMap\(/.test(
       client.replace('this._coreOptions = normalizeBootMap(', 'this._coreOptions = (')));
  ok('control: the builder-emptiness check would notice a planted collapse',
     /Object\.keys\([^)]*\)\.length/.test(uncommented(config) + 'Object.keys(v).length'));
}

// --- 7. neither backend may hand-assemble these lines again ----------------
// Source-level, because that is the shape the duplication had: two copies of the
// same template literals, drifting silently. If a future change adds a device or
// gun line straight into either backend, it is outside the builder and outside
// every golden above.
for (const [label, src] of [['EmulatorClient', client], ['EmulatorWorkerRuntime', worker]]) {
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  ok(`${label} no longer emits gun/device cfg lines of its own`,
     !/input_(libretro_device_p|player\$\{|remap_binds_enable|remapping_directory)/.test(code),
     `${label} builds RetroArch input lines by hand again — put them in `
     + `buildRetroArchLaunchConfig so both execution backends get them`);
  ok(`${label} calls the shared builder`,
     /buildRetroArchLaunchConfig\(/.test(code),
     `${label} no longer calls buildRetroArchLaunchConfig`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
