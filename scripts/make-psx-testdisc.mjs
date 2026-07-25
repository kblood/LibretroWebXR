#!/usr/bin/env node
// Build the CC0 "LWX PSX Test Disc" PSn00bSDK homebrew CD image from
// games/psx-testdisc/ - a real bootable CUE+BIN (mkpsxiso), the first PSX
// title in this repo authored as a real disc rather than the bare
// scripts/cores/psx/test-content/generate-smoke-exe.js smoke test. See
// docs/PSX_TESTDISC.md for the full build recipe, the toolchain used, and a
// known content-independent rendering gap in this project's PSX worker
// runtime discovered while verifying this disc.
//
// Toolchain: luksamuk/psxtoolchain Docker image via WSL2 (a pre-built
// PSn00bSDK install, including mkpsxiso). No bootstrap/build step needed for
// the SDK itself - only the game's own CMake configure+build runs here.
//
// Needs: WSL2 with Docker available (default distro "Ubuntu", override with
// WSL_DISTRO) and the luksamuk/psxtoolchain image pulled (`docker pull
// luksamuk/psxtoolchain`). If dockerd reports as active but `docker ps`
// hangs/fails, see docs/PSX_TESTDISC.md "Docker socket gotcha".
// Usage: node scripts/make-psx-testdisc.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'psx-testdisc');
const OUT_DIR = resolve(__dirname, '..', 'public', 'roms', 'freeware');
const BASENAME = 'lwx-psx-testdisc';
const BUILT_BASENAME = 'psxtest'; // psn00bsdk_add_cd_image() target name in CMakeLists.txt

const WSL_DISTRO = process.env.WSL_DISTRO || 'Ubuntu';
const WSL_DIR = '~/psx-testdisc-build';
const DOCKER_IMAGE = 'luksamuk/psxtoolchain';

function toWslPath(winPath) {
  const norm = winPath.replace(/\\/g, '/');
  const m = norm.match(/^([A-Za-z]):\/(.*)$/);
  if (!m) throw new Error(`cannot convert path to WSL: ${winPath}`);
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
}

function wsl(cmd) {
  console.log(`> wsl -d ${WSL_DISTRO} -- bash -c "${cmd}"`);
  const r = spawnSync('wsl.exe', ['-d', WSL_DISTRO, '--', 'bash', '-c', cmd], { stdio: 'inherit' });
  if (r.error) {
    console.error(`\nFailed to run wsl.exe. Is WSL2 installed?`);
    console.error(r.error.message);
    process.exit(2);
  }
  if (r.status !== 0) { console.error(`\nwsl command exited ${r.status}`); process.exit(r.status || 1); }
}

const wslGameDir = toWslPath(GAME_DIR);

// The docker container runs as root, so a prior run's build/ directory is
// root-owned in the bind-mounted scratch dir and can't be rm'd by the WSL
// user directly - clear it from inside a throwaway container first (same
// pattern as make-n64-scene.mjs / make-ps2-guncon-range.mjs).
wsl(`if [ -d ${WSL_DIR} ]; then docker run --rm -v ${WSL_DIR}:/work ${DOCKER_IMAGE} 'rm -rf /work/build'; fi`);
wsl(`rm -rf ${WSL_DIR} && mkdir -p ${WSL_DIR} && cp -r ${wslGameDir}/. ${WSL_DIR}/`);
wsl(`docker run --rm -v ${WSL_DIR}:/work -w /work ${DOCKER_IMAGE} 'cmake --preset default && cmake --build build'`);

const wslBin = `${WSL_DIR}/build/${BUILT_BASENAME}.bin`;
const wslCue = `${WSL_DIR}/build/${BUILT_BASENAME}.cue`;
const outBin = join(GAME_DIR, `${BUILT_BASENAME}.bin`);
const outCue = join(GAME_DIR, `${BUILT_BASENAME}.cue`);
wsl(`cp ${wslBin} ${wslGameDir}/${BUILT_BASENAME}.bin && cp ${wslCue} ${wslGameDir}/${BUILT_BASENAME}.cue`);

const finalBin = resolve(OUT_DIR, `${BASENAME}.bin`);
const finalCue = resolve(OUT_DIR, `${BASENAME}.cue`);
copyFileSync(outBin, finalBin);
rmSync(outBin);

// mkpsxiso bakes the built .bin's own basename into the .cue's FILE line;
// rewrite it to match the published basename so the two stay consistent.
const cueText = readFileSync(outCue, 'utf8').replace(
  new RegExp(`${BUILT_BASENAME}\\.bin`, 'g'),
  `${BASENAME}.bin`,
);
writeFileSync(finalCue, cueText);
rmSync(outCue);

console.log(`Wrote ${finalBin}`);
console.log(`Wrote ${finalCue}`);
console.log('Verify with: node scripts/probe-psx-testdisc.js');
