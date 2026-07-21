#!/usr/bin/env node
// Build the CC0 "LWX N64 Orbit Cubes" libdragon homebrew ROM from
// games/n64-scene/ - a real 3D scene (rotating cube, analog input, EEPROM
// save, audio HLE), used as this project's "representative 3D title"
// stand-in for N64 Phase N0 fps measurement (no commercial N64 ROM is
// available or sourced for this repo).
//
// Same build environment as make-n64-smoke.mjs: anacierdem/libdragon
// Docker image via WSL2 (see docs/N64_CORE_BUILD.md).
//
// Needs: WSL2 with Docker available (default distro "Ubuntu", override with
// WSL_DISTRO) and the anacierdem/libdragon image pulled.
// Usage: node scripts/make-n64-scene.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(__dirname, '..', 'games', 'n64-scene');
const ROM_NAME = 'lwx-n64-scene.z64';
const OUT = resolve(__dirname, '..', 'public', 'roms', 'freeware', ROM_NAME);

const WSL_DISTRO = process.env.WSL_DISTRO || 'Ubuntu';
const WSL_DIR = '~/n64-scene-build';

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

// The docker container runs as root, so a prior run's build artifacts are
// root-owned in the bind-mounted scratch dir and can't be rm'd by the WSL
// user directly - clear them from inside a container first.
wsl(`if [ -d ${WSL_DIR} ]; then docker run --rm -v ${WSL_DIR}:/n64 anacierdem/libdragon sh -c "rm -rf /n64/*"; fi`);
wsl(`rm -rf ${WSL_DIR} && mkdir -p ${WSL_DIR} && cp -r ${wslGameDir}/. ${WSL_DIR}/`);
wsl(`docker run --rm -v ${WSL_DIR}:/n64 -w /n64 anacierdem/libdragon make`);
wsl(`cp ${WSL_DIR}/${ROM_NAME} ${wslGameDir}/${ROM_NAME}`);

copyFileSync(join(GAME_DIR, ROM_NAME), OUT);
rmSync(join(GAME_DIR, ROM_NAME));
console.log(`Wrote ${OUT}`);
