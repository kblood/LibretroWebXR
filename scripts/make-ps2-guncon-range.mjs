#!/usr/bin/env node
// Build the CC0 "LWX GunCon Range" PS2 homebrew light-gun game from
// games/ps2-guncon-range/.
//
// Unlike the other make-*.mjs scripts (native Windows toolchains), this one
// builds with the PS2SDK via the ps2dev/ps2dev Docker image, run from WSL2 —
// the same toolchain used to build the play_libretro core itself (see
// docs/PS2_CORE_BUILD.md) and the ~/ps2-guncon2-test/ GunCon2 driver-test
// harness this game's IOP driver is copied from.
//
// Steps: sync games/ps2-guncon-range/ into a WSL2-native scratch directory
// (avoids /mnt/c/... Docker-volume friction), build the IOP module first
// (the ee/ Makefile only bin2c's an already-built .irx, it doesn't build
// it), then the EE ELF, copy the stripped ELF back, and clean up.
//
// Needs: WSL2 with a distro that has Docker available (default distro name
// "Ubuntu", override with WSL_DISTRO) and the ps2dev/ps2dev image pulled
// (`docker pull ps2dev/ps2dev`).
// Usage: node scripts/make-ps2-guncon-range.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'ps2-guncon-range');
const ELF_NAME = 'guncon-range.elf';
const ROM_NAME = 'lwx-ps2-guncon-range.elf';
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', ROM_NAME);

const WSL_DISTRO = process.env.WSL_DISTRO || 'Ubuntu';
const WSL_DIR = '~/ps2-guncon-range-build';

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

// The docker container runs as root, so a prior run's build artifacts
// (obj/*.o etc.) are root-owned in the bind-mounted scratch dir and can't be
// rm'd by the WSL user directly — clear them from inside a container first.
wsl(`if [ -d ${WSL_DIR} ]; then docker run --rm -v ${WSL_DIR}:/work ps2dev/ps2dev sh -c "rm -rf /work/*"; fi`);
wsl(`rm -rf ${WSL_DIR} && mkdir -p ${WSL_DIR} && cp -r ${wslGameDir}/. ${WSL_DIR}/`);
wsl(`docker run --rm -v ${WSL_DIR}:/work -w /work ps2dev/ps2dev sh -c "apk add --no-cache make >/dev/null && make -C iop/guncon2_ldd && make -C ee"`);
wsl(`cp ${WSL_DIR}/ee/${ELF_NAME} ${wslGameDir}/${ELF_NAME}`);

copyFileSync(join(GAME_DIR, ELF_NAME), OUT);
rmSync(join(GAME_DIR, ELF_NAME));
console.log(`\nWrote ${OUT}`);
