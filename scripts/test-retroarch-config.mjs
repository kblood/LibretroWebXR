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
import { RETROARCH_CFG, RETROARCH_SYSTEM_DIR } from '../src/RetroArchConfig.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
