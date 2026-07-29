# DOS core build (DOSBox Pure)

`build.sh` builds the `dosbox_pure` libretro core for the web, following the
same recipe already proven for Amiga/PS2/PSX/N64 in this repo (see
`docs/AMIGA_CORE_BUILD.md`, `docs/PS2_CORE_BUILD.md`, `docs/N64_CORE_BUILD.md`).
Full header comment inside the script documents every phase, every
environment-variable override, and the concurrency lock it takes on the
shared `~/amiga-build/RetroArch` checkout.

Run from **WSL2 Ubuntu**, not Git Bash (MSYS path translation corrupts
`/home/<user>/...` paths — see `CLAUDE.md`).

```bash
# foreground
bash scripts/cores/dos/build.sh

# detached (recommended — can take a long time)
nohup setsid bash scripts/cores/dos/build.sh \
  > /home/caldor/dosbox-build/build.out.log 2>&1 < /dev/null &
disown
```

Poll for completion by checking whether `~/dosbox-build/BUILD_STATUS` exists
(it is only written once the build has fully finished, success or failure —
no log-parsing needed). Its first line is `SUCCESS` or `FAILED`.

**This script never touches `public/cores/`.** It stages built artifacts
(`.js`/`.wasm`/`.worker.js` + a `MANIFEST.txt` with pins/hashes) under
`~/dosbox-build/stage/<timestamp>/` and `~/dosbox-build/stage/latest/`.
Installing into `public/cores/` — and everything after that (headless boot
verification, `src/systems.js` registration, test content) — is deliberately
a separate, later step; see the DOS build plan for phases 7-10.

`docs/DOS_CORE_BUILD.md` currently documents the earlier, blocked VirtualXT
attempt — it has not yet been updated for the DOSBox Pure path this script
builds. Update it once a build from this script has been verified.
