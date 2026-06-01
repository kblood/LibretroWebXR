#!/usr/bin/env node
// Build the CC0 "LWX VB Demo" Nintendo Virtual Boy game from games/vb-demo/
// into a .vb ROM, using VUEngine + the V810 (NEC) GCC toolchain.
//
// Pipeline (the research's recommended VUEngine make-based workflow):
//   1. VUEngine's make chain transpiles the project's "Virtual C" (a bash/awk
//      preprocessor in VUEngine-Core), compiles every class with v810-gcc 4.7.4,
//      links against libcore.a + the plugin libs, and emits build/output.vb.
//   2. The makefile pads the ROM to a power-of-two size (mednafen_vb requires it).
//   3. copy build/output.vb -> public/roms/freeware/lwx-vb-demo.vb
// Only games/vb-demo/source/States/MyGameState/* and source/Game.c are "ours to
// write" (CC0); the rest is the frozen MIT VUEngine-Barebone template (ves-v0.6.0)
// and the MIT VUEngine-Core engine. The compiled ROM is released CC0.
//
// ---- Toolchain (NON-INTERACTIVE install) --------------------------------
// The V810 GCC toolchain + VUEngine-Core + the full make/bash/awk chain are all
// bundled inside the VUEngine Studio installer. We obtain them WITHOUT running
// the Electron IDE: download the NSIS Setup .exe and extract it with 7-Zip
// (Setup.exe -> $PLUGINSDIR/app-64.7z -> resources/app/...). See
// docs/research/virtualboy-game-creation.md for the exact one-time commands.
//
// After extraction, point VUENGINE_HOME at the extracted "resources/app" dir
// (the one containing binaries/ and vuengine/). Default looked-up locations:
//   $VUENGINE_HOME, C:\vuengine\app\resources\app
//
// This mirrors scripts/make-snes-demo.mjs: GNU make + a Unix shell drive the
// build; here BOTH the v810 GCC and a full MSYS2 (make/bash/sed/awk) ship inside
// VUEngine Studio, so there are no external toolchain prerequisites.
//
// VUEngine's build service requires that NO path involved contains a space
// (project, engine, plugins). C:\vuengine\... and this repo's path qualify.
//
// Usage: node scripts/make-vb-demo.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'vb-demo');
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', 'lwx-vb-demo.vb');
const BUILD_MODE = 'release';

// --- locate the extracted VUEngine Studio "resources/app" -----------------
// Must contain binaries/vuengine-studio-tools/win and vuengine/core.
function findVuengine() {
  const candidates = [
    process.env.VUENGINE_HOME,
    'C:\\vuengine\\app\\resources\\app',
    '/c/vuengine/app/resources/app',
  ].filter(Boolean);
  for (const c of candidates) {
    if (
      existsSync(join(c, 'vuengine', 'core', 'lib', 'compiler', 'make', 'makefile-game')) &&
      existsSync(join(c, 'binaries', 'vuengine-studio-tools', 'win'))
    ) {
      return c;
    }
  }
  return null;
}

const APP = findVuengine();
if (!APP) {
  console.error('Could not find an extracted VUEngine Studio toolchain.');
  console.error('Expected VUENGINE_HOME (or C:\\vuengine\\app\\resources\\app) to contain:');
  console.error('  vuengine/core/lib/compiler/make/makefile-game  and  binaries/vuengine-studio-tools/win');
  console.error('');
  console.error('Install non-interactively (one time):');
  console.error('  1) Download VUEngine-Studio-0-6-0-Setup.exe from');
  console.error('     https://github.com/VUEngine/VUEngine-Studio/releases/download/v0.6.0/VUEngine-Studio-0-6-0-Setup.exe');
  console.error('  2) 7z x Setup.exe -oTMP ; 7z x "TMP/$PLUGINSDIR/app-64.7z" -oC:\\vuengine\\app');
  console.error('  See docs/research/virtualboy-game-creation.md for the full recipe.');
  process.exit(2);
}

// MSYS-style (/c/...) path for the bundled bash/make recipes.
function toMsysPath(p) {
  return p.replace(/\\/g, '/').replace(/^([a-zA-Z]):\//, (_m, d) => `/${d.toLowerCase()}/`);
}

const TOOLS = join(APP, 'binaries', 'vuengine-studio-tools', 'win');
const BASH = join(TOOLS, 'msys', 'usr', 'bin', 'bash.exe');
if (!existsSync(BASH)) {
  console.error(`Bundled MSYS bash not found at ${BASH}. Re-extract the installer.`);
  process.exit(2);
}

// The same PATH entries VUEngine Studio's build service prepends:
//   gcc/bin, gcc/libexec/gcc/v810/4.7.4, msys/usr/bin (make + coreutils)
const PATH_DIRS = [
  toMsysPath(join(TOOLS, 'gcc', 'bin')),
  toMsysPath(join(TOOLS, 'gcc', 'libexec', 'gcc', 'v810', '4.7.4')),
  toMsysPath(join(TOOLS, 'msys', 'usr', 'bin')),
].join(':');

const CORE = toMsysPath(join(APP, 'vuengine', 'core'));
const PLUGINS = toMsysPath(join(APP, 'vuengine', 'plugins'));
const GAME_M = toMsysPath(GAME_DIR);
const MAKEFILE = `${CORE}/lib/compiler/make/makefile-game`;

// One bash --login -c command reproducing the IDE's make invocation, with
// PAD_ROM=1 so mednafen_vb gets a power-of-two ROM.
const script =
  `cd '${GAME_M}' && ` +
  `export PATH='${PATH_DIRS}':$PATH ` +
  `LC_ALL=C BUILD_ALL=0 MAKE_JOBS=4 PREPROCESSING_WAIT_FOR_LOCK_DELAY_FACTOR=0.0 ` +
  `DUMP_ELF=0 PRINT_PEDANTIC_WARNINGS=0 && ` +
  `make all -e TYPE=${BUILD_MODE} PAD_ROM=1 ` +
  `ENGINE_FOLDER='${CORE}' PLUGINS_FOLDER='${PLUGINS}' USER_PLUGINS_FOLDER='${PLUGINS}' ` +
  `-f '${MAKEFILE}'`;

console.log(`VUEngine : ${APP}`);
console.log(`bash     : ${BASH}`);
console.log(`game     : ${GAME_DIR}`);
console.log(`> bash --login -c "<make ${BUILD_MODE}>"   (cwd: ${GAME_DIR})\n`);

const r = spawnSync(BASH, ['--login', '-c', script], { stdio: 'inherit' });
if (r.error) {
  console.error(`\nFailed to run the bundled bash (${BASH}).`);
  console.error(r.error.message);
  process.exit(2);
}
if (r.status !== 0) {
  console.error(`\nmake exited ${r.status}`);
  process.exit(r.status || 1);
}

// --- publish --------------------------------------------------------------
const built = join(GAME_DIR, 'build', 'output.vb');
if (!existsSync(built)) {
  console.error(`\nBuild reported success but ${built} is missing.`);
  process.exit(1);
}
copyFileSync(built, OUT);

// Clean the (large) build tree so the repo stays lean; the build is reproducible.
try { rmSync(join(GAME_DIR, 'build'), { recursive: true, force: true }); } catch {}

console.log(`\nWrote ${OUT}`);
