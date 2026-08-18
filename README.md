# LibretroWebXR

A **browser-based WebXR libretro frontend** — play retro console games inside a
3D room, on **desktop browsers** and **standalone Meta Quest**, with no install.
Think [EmuVR](https://emuvr.net), but open-source and running in a web page.

> **Status:** live at `dionysus.dk/webxr/libretrowebxr2/` — rooms/collections as
> JSON, an in-VR room editor, and networked multiplayer are all built and
> deployed. See `docs/ROADMAP.md` for what's shipped vs. still in progress and
> `docs/HANDOFF.md` for the current state of the world.

## What it does today

- A 3D room you can enter in VR (Quest browser / PCVR) or explore on a flat
  screen — plus a **flat-screen-only `desktop.html` build** with the same
  netplay for players without a headset.
- Grabbable **cartridges** on **shelves/bookcases**; slot one into a **console**
  and it boots on the in-world **CRT TV**. A **patchable AV rack** lets you spawn
  more consoles/TVs and repatch video, controller, and keyboard cords between
  them, EmuVR-style.
- **20 systems** via libretro cores — `src/systems.js` (`SYSTEMS`) is the single
  source of truth for the count and the gating below. In order of registration:
  SNES, NES, Game Boy / Color / Advance, Virtual Boy, Genesis / Master System /
  Game Gear / SG-1000 / Sega 32X, Atari 2600, PC Engine / TurboGrafx-16, C64,
  VIC-20, **Amiga** (PUAE — boots PUAE's built-in AROS replacement out of the
  box, or a real Kickstart you supply yourself in `public/roms/local/amiga/`),
  **DOS / IBM PC** (DOSBox Pure —
  see `docs/DOS_CORE_BUILD.md`), **PlayStation 2** (a from-scratch Emscripten
  build of Play!, boots real commercial discs — `docs/PS2_CORE_BUILD.md`),
  **PlayStation** (Beetle PSX HW + Lightrec on a Wasm JIT —
  `docs/PSX_CORE_BUILD.md`) and **Nintendo 64** (Mupen64Plus-Next —
  `docs/N64_CORE_BUILD.md`).

  19 of the 20 are on the default shelf. Only **`n64`** still carries
  `experimental: true` in `src/systems.js`, which hides its cartridges from
  collection-declared shelves unless you pass `?experimental=1` (the "Load ROM"
  file picker was never filtered by that flag). DOS came off the gate
  2026-08-01, PSX on 2026-08-07 — see `docs/ROADMAP.md` for the evidence behind
  each un-gating.

  Known gap: **Atari 2600 renders nothing.** `stella2014` is the last remaining
  `classic`-style core here and issues 0 draw calls; the fix is shipping a
  `module`-style Stella build (`src/systems.js` CORES note, `docs/ROADMAP.md`).
- Keyboard, gamepad, and WebXR-controller input with per-core RetroPad mapping;
  local couch co-op (up to 4 players, NES Four Score included); **light-gun**
  peripherals (Zapper, Super Scope, Justifier 2-gun, Menacer, Light Phaser,
  PS1 GunCon incl. 2-gun, PS2 GunCon2) and a **mouse** peripheral (Amiga
  point-and-click) as grabbable, cord-connected, net-synced props — see
  `docs/LIGHTGUN_SUPPORT.md` / `docs/MOUSE_SUPPORT.md`.
- Save states, spatial audio, in-VR menus, a C64/VIC-20 virtual keyboard.
- **Networked multiplayer**: shared room presence, voice, room-object sync,
  and host-authoritative 2-player game streaming — see `docs/MULTIPLAYER.md`.
  The relay (`server/`) is deployed on a public box, so it carries real
  admission control — per-room/-peer/-address caps, payload and rate limits,
  backpressure eviction, and a server-side trust model for who may say what
  (host-only `STATE` on `tv`/`room`/`shelf:*`, host-only `INPUT`, owner-only
  clears of `hold:*`/`gamepad:*`). Limits and env knobs: `server/README.md`;
  the trust rules and why each exists: `docs/MULTIPLAYER.md`.
- **Remote logging** for headset debugging: the app ships console/error logs to
  `https://dionysus.dk/logs?session=<room>`. **Reads are token-gated in
  production** (`LOG_TOKEN`, set on the box, never in the repo) because an
  ungated `logs.json` hands every session's room names, nicks and private-library
  ROM filenames to anyone — `POST /log` stays open, so the headset carries no
  secret. See `docs/HANDOFF.md` → "Reading headset logs (the token)".

## Important: no ROMs, no bundled cores

This repo ships **neither game ROMs nor emulator cores**, by design — see
`docs/LICENSING.md`.

- **Cores** (`.wasm`/`.js`) are fetched at build/deploy time, not committed.
  Run `npm run fetch-cores` (see that script for sources). They keep their own
  upstream licenses (`THIRD_PARTY_LICENSES.md`); some are non-commercial.
  Their **provenance manifests are tracked**, though: `public/cores/*.build.json`
  records the upstream repos + commit SHAs, the emsdk/emscripten versions, the
  build flags and a sha256 per emitted artifact for the cores this project
  builds itself. A few KB of reviewable text is the entire record of how a
  shipped binary was produced, and without it a clean clone could neither
  reproduce nor authenticate a single core (CODEX_REVIEW ARC-3). The binaries
  stay out; their provenance comes in.
- **ROMs & BIOS** are copyrighted — supply your own from media you own. The only
  game content here is free / homebrew / public-domain test material; see
  `public/roms/README.md`.

## Quick start

```bash
npm install
npm run fetch-cores      # populates public/cores/ (gitignored) — see script
npm run dev              # http://localhost:5173  (sets COOP/COEP for SharedArrayBuffer)
```

Click **Load ROM** to pick a game, or load a collection/room (see
`docs/ROOM_AND_COLLECTIONS.md`). On Quest, open the HTTPS deploy and tap **Enter
VR**. `npm run debug` runs the headless health-check harness (`DEBUGGING.md`).

`npm test` runs the release gate: every `scripts/test-*.mjs` that is not a
server suite — **discovered from the filesystem**, so there is no list to
append to and no count worth writing down here (the runner prints it; this
paragraph said "35" for long enough to be wrong by sixteen) — plus the three
`node --test` files in `test/`. It needs no browser, no server and no cores.

CI runs it in two jobs (`.github/workflows/ci.yml`): **app** does `npm ci` /
`npm test` / `npm run build` and uploads `dist/`; **server** does a locked
`server/` install, `node --check` on each server module, and `npm run
test:servers` — the socket-level tier that spawns the room/log servers on
8891-8897 and is deliberately kept out of `npm test`. A separate scheduled
workflow (`.github/workflows/audit.yml`) runs `npm audit` over **both** package
trees weekly and on any manifest/lockfile change, and reports an unreachable
registry as UNKNOWN rather than clean; `.github/dependabot.yml` raises grouped
monthly dependency PRs for both trees, which the same CI then gates.

One suite is **inert** on a clean runner and says so: `test-patched-cores`
inspects `public/cores/`, which is gitignored, so with no cores fetched it
asserts nothing and the summary prints `(1 INERT)` instead of a green that
implies coverage. Inert is not a failure — see the note in
`scripts/run-tests.mjs`.

The `probe-*` / `smoke-*` scripts in `scripts/` are opt-in diagnostics that need
real Chrome, a running room-server, or fetched cores — they are deliberately
**not** part of the gate.

Requirements: HTTPS + `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp` (handled by `vite.config.js` in dev
and `deploy/` + `public/.htaccess` in prod) so `SharedArrayBuffer` — and thus the
threaded cores — work.

### Testing on a real headset: `LAN=1`

**The dev and preview servers bind to `127.0.0.1` only.** A Quest on your Wi-Fi
therefore **cannot** reach `npm run dev` unless you opt in:

```powershell
$env:LAN=1; npm run dev        # PowerShell — then: Remove-Item Env:LAN
```
```bash
LAN=1 npm run dev              # bash/zsh   (works for `npm run preview` too)
npm run dev -- --host          # vite's own flag still works for a one-off
```

With `LAN=1` set, vite prints `[vite.config] LAN=1 — dev/preview server exposed
on 0.0.0.0 (headset testing mode).` and the Network URL it shows is the one to
open in the headset browser.

Loopback is the default on purpose: binding `0.0.0.0` on Windows is the exact
precondition of the vite dev-server advisories (the `server.fs.deny` bypass via
Windows alternate paths, GHSA-fx2h-pf6j-xcff, and the esbuild arbitrary-file-read),
which `server.fs.strict` does **not** mitigate. Un-set `LAN` when you're done, and
don't leave it on untrusted Wi-Fi.

## Building & publishing

```bash
npm run build        # vite build → dist/, then `postbuild` runs the guard
npm run check-dist   # run the guard on its own against ./dist
npm run deploy       # full deploy: build → guard → staging upload → atomic swap
npm run deploy-app   # FAST code-only refresh (see the warning below)
```

### `check-dist` — the publishing boundary

`.gitignore` is **not** the publishing boundary: vite copies `public/` into
`dist/` and the deploy scp's `dist/` to a public web server. Nothing checked what
was in there, so editor backups, the pre-patch `*.bak` cores (10 in the tree as
this was written, and the count moves every time a core is re-patched), a stray
`.env`, or a ROM this project has no right to redistribute would all have shipped
silently. Two independent things check now:

1. `vite.config.js` turns vite's blanket `copyPublicDir` **off** and does the copy
   itself through a deny filter, so denied paths are never copied at all. It
   resolves the **real** `build.outDir` (config file *and* `--outDir`), then runs
   the guard on it and **fails the build** on any violation.
2. `scripts/check-dist.mjs` re-derives the verdict from the bytes on disk, knowing
   nothing about how the directory was produced. It runs as npm `postbuild` after
   every `npm run build`, and again inside `scripts/deploy.ps1` **before the first
   `scp`** — a failing guard aborts the deploy having uploaded nothing.

#### `roms/local/` ships on purpose — don't "fix" it

The private sideload is **published deliberately**, and the guard only *reports*
it (file count + size, on every build). dionysus.dk is the user's own box, and
putting those ROMs on it is the only practical way to test **light guns on a real
Quest** — real HTTPS gives a WebXR secure context with no `adb reverse`, and the
redistributable light-gun game universe is essentially empty. A strip guard has
been added and reverted **twice** (`0df8aeb` → `b192911`, then again on
2026-08-14 after both whole-repo reviews flagged it as their #1 critical
finding). Stripping it also strips `roms/local/amiga/kick*.A500`, which
`src/systems.js` points PUAE's `systemFiles` at, so deployed Amiga would silently
stop booting real Kickstart titles.

For a genuinely public release — a link to strangers, not the user's own test box
— use `npm run check-dist -- --strict` (or `CHECK_DIST_STRICT=1`), which turns it
into a hard refusal. Everything below is refused in **both** modes.

The guard **refuses** (exit 1, listing every offender):

| rule | what it refuses |
| --- | --- |
| `private-roms` | anything under `roms/local/` — **only under `--strict`** |
| `unlisted-rom` | a file under `roms/freeware/` that is not an allowlisted title |
| `oversize-rom` | a `roms/freeware/` file over **16 MiB** |
| `backup-file` | `*.bak` / `*.orig` / `*.rej` / `*.swp` / `*.tmp` (e.g. the pre-patch core backups) |
| `credential` | `.env*`, `id_rsa`, `*.pem`, `*.p12`, `*.key`, `*.ppk`, … |
| `vcs-or-deps` | `.git/`, `.svn/`, `node_modules/` |
| `scratch` | `tmp/`, `.vite/`, `coverage/` |
| `symlink` | any symlink/junction in the output (it can point anywhere) |
| `not-allowlisted` | a top-level entry that isn't one of the expected ones, or a `roms/` path that isn't `freeware/` or a `*.json`/README pointer |
| `unexpected-type` | a file type outside the publishable extension allowlist |
| `oversize-file` / `oversize-total` | over **32 MiB** for one file / **400 MiB** for the tree |
| `oversize-chunk` | a hashed `assets/*.js`/`*.css` chunk over its **per-chunk** raw *or* gzip budget (`BUNDLE_BUDGETS`) |

`oversize-chunk` is the bundle-regression guard (CODEX_REVIEW PERF-5). The
32 MiB per-file rule was the only ceiling `dist/assets/` ever faced, so pulling
`three` into the flat-screen `desktop` chunk — a 25x regression — passed every
gate in the project. Each named rollup chunk now carries a raw **and** a gzip
ceiling, and gzip is the one to care about: it is what a Quest downloads on a
cold load. The guard prints the whole chunk table on every green build, so the
trend is visible before it breaks. **Raising a budget is a deliberate, reviewed
act** — a number bumped in the same commit as the growth that broke it is a
changelog, not a budget. `vite.config.js` derives rollup's own advisory
`chunkSizeWarningLimit` from the largest budget here so the two cannot drift.

`roms/freeware/` is **not** a blanket "anything in here is publishable" folder.
It is the tree this repo *tracks*, so what lands there should be reviewable. A
file ships from there
only if its exact name is in `FREEWARE_ALLOW` in `scripts/check-dist.mjs`, or it
is referenced by a git-tracked descriptor in `public/roms/*.json` (or is a
`.cue`/`.bin`-style sidecar of one of those). **Adding a game** = add the filename
to that list; rebuilding an existing one needs no change (names are pinned, not
hashes, so `npm run make-*` never breaks the build).

Budgets are overridable for a one-off: `CHECK_DIST_MAX_FILE_MB`,
`CHECK_DIST_MAX_ROM_MB`, `CHECK_DIST_MAX_TOTAL_MB` (all in MiB). There is no
override for the deny rules, by design.

### ⚠ `npm run deploy-app` cannot UN-publish anything

`deploy-app` is `deploy.ps1 -SkipCores -AppOnly`. It uploads only `assets/`, the
`.html` entry points, `favicon.svg` and `.htaccess`, straight into the live
folder — it **deliberately skips `roms/` and `cores/`**, and it never deletes
anything on the server.

So if something private was published by an earlier deploy, **`deploy-app` will
not remove it.** It is a speed optimisation, never a safety control. Removing
already-published content needs the full `npm run deploy` (staging dir + atomic
`mv` swap, which replaces the whole live folder), or a manual `rm -rf` of the
offending path on the server. Fixing the build and running `deploy-app` leaves
the live copy exactly where it was.

### Amiga Kickstart

`src/systems.js` points PUAE's `systemFiles` at `roms/local/amiga/kick34005.A500`
(and `kick40068.A1200`). Because `roms/local/` ships, a Kickstart you place there
reaches the deploy and real Kickstart-1.3 floppy titles boot on the headset.

If it is **absent**, the failure is silent: the fetch 404s, `EmulatorClient` logs
`system file kick34005.A500 not available (404) — core uses its built-in
default`, and PUAE falls back to its bundled **AROS** replacement. The shipped
`lwx-amiga-demo.adf` still boots (it was authored for AROS); Kickstart-only
titles will not, with no on-screen indication.

Under `--strict` those files are excluded along with the rest of `roms/local/`,
so a strict build is an AROS-only build by construction.

## The big idea: rooms & collections as portable JSON

Instead of EmuVR's opaque binary room saves and per-machine folder scans,
everything here is **open, declarative JSON** that references content by location
(a web URL, or a local folder on your PC / headset) and **never embeds ROMs**:

- a **Collection** (`*.collection.json`) is a library of games (system, core,
  boxart, and a ROM *pointer*);
- a **Room** (`*.room.json`) is the 3D scene + how collections are laid out in
  it (wallpaper, shelves, console, posters, portals to other rooms);
- a room can be **shared as a single file or URL** — free games travel with it,
  your owned games resolve against your own local folder.

Try it: `?room=roms/bedroom.room.json` loads an example room (walk into the
doorway to portal to `arcade.room.json`); `?collection=URL` drops a bare
collection into the default room; or drag a `.room.json` / `.collection.json`
onto the page. With no parameter you get the built-in room.

Full design: `docs/ROOM_AND_COLLECTIONS.md`. Multiplayer plan:
`docs/MULTIPLAYER.md`. EmuVR research that informs all of this:
`docs/EMUVR_RESEARCH.md`.

## Layout

```
LibretroWebXR/
├── index.html              Flat-mode shell (header + canvases)
├── vite.config.js          Dev server with COOP/COEP
├── .github/
│   ├── workflows/ci.yml    CI release gate: app (ci/test/build) + server (test:servers)
│   ├── workflows/audit.yml Scheduled npm audit over both package trees
│   └── dependabot.yml      Monthly grouped dependency PRs (root + server/)
├── src/                    The app (Three.js + WebXR, emulator client, input, VR room)
├── scripts/
│   ├── debug.js            Puppeteer health-check harness (see DEBUGGING.md)
│   ├── check-dist.mjs      Publishing guard — postbuild + pre-scp deploy gate
│   ├── deploy.ps1          (gitignored, real hosts) — deploy.example.ps1 is the template
│   └── fetch-cores.mjs     Pulls libretro cores into public/cores/ (gitignored)
├── public/
│   ├── cores/              (gitignored) fetched cores — except the tracked
│   │                       *.build.json provenance manifests (see above)
│   └── roms/               freeware/ (tracked) + roms/local/ (private sideload)
├── deploy/                 Apache config to enable .htaccess COOP/COEP
└── docs/                   ROADMAP, EMUVR_RESEARCH, ROOM_AND_COLLECTIONS, MULTIPLAYER, LICENSING, PROJECT_HISTORY
```

## Picking this up

New to the codebase (or a fresh session)? Read **`docs/HANDOFF.md`** first — it
orients you on state, how to run it, the hard invariants, the architecture map,
and what's next.

## License

Frontend code: **MIT** (`LICENSE`). Cores and ROMs are **not** covered by it —
see `THIRD_PARTY_LICENSES.md` and `docs/LICENSING.md`.

History of the five prototypes this distilled from: `docs/PROJECT_HISTORY.md`.
Where it came from: `PROVENANCE.md`.
