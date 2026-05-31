# Provenance

This repository (`C:\LLM\LibretroWebXR`) is a clean, shareable re-home of a
working prototype that was developed inside a larger scratch workspace.

## Source workspace

- **Path:** `C:\LLM\Projects\ClaudeTest\LibretroWebXR`
- **State at fork:** branch `main`, commit `d1e5a87` ("Per-core, two-hand
  RetroPad mapping"), working tree clean.
- **Date forked:** 2026-05-31

The source workspace was never published to a git host (no remote). It mixed
the actual application with a lot of material that does not belong in a shared
repo. This repo keeps only the application and adds proper licensing, docs, and
a forward-looking plan.

## What was carried over (the real app)

- `index.html`, `vite.config.js`, `package.json`, `package-lock.json`
- `src/` — all 23 modules (the Three.js + WebXR frontend, worker/main-thread
  emulator client, input managers, VR room: cartridges, shelf, console,
  memory card, grab/locomotion, menus, CRT shader, spatial audio, save states)
- `deploy/libretrowebxr.conf` — Apache COOP/COEP enablement
- `scripts/debug.js` — the puppeteer-based health-check harness
- `DEBUGGING.md` — the debugging playbook
- `docs/PROJECT_HISTORY.md` — the original `PROJECTS_OVERVIEW.md`, kept as a
  record of the five earlier prototypes the app distilled from
  (LibretroUnity, WebEmu, webretro ×3).

## What was deliberately left behind

| Left behind | Why |
|---|---|
| `source-projects/` (5 reference forks, ~hundreds of MB, each with its own `.git`) | Reference-only; available upstream. Lineage is summarized in `docs/PROJECT_HISTORY.md`. |
| `scripts/probe-*.js`, `scripts/snap-*.js`, `scripts/dump-controls-canvas.js` | One-off debugging probes and screenshot scratch — the "failed tests and such". The reusable harness (`debug.js`) was kept. |
| `public/cores/*.{js,wasm}` (25 core files) | Not redistributed here (licensing). Fetched at build/deploy time — see `scripts/fetch-cores.mjs`. |
| `public/roms/*` ROM binaries | Copyrighted; never committed. Replaced with a free/homebrew test set + a manifest schema. |
| `tmp/`, `dist/`, `node_modules/` | Build output / scratch / dependencies. |
| `NEW_PROJECT_PLAN.md` | Superseded by `docs/ROADMAP.md` (which now covers VR-room, collections, and multiplayer). |

## Relationship going forward

The source workspace remains the historical record. All new work happens here.
This repo is intended to be initialized as its own git repository and published
to a host (e.g. GitHub).
