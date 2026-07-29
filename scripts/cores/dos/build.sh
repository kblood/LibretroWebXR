#!/usr/bin/env bash
# scripts/cores/dos/build.sh — build the DOS (DOSBox Pure) libretro core for
# the web, following the puae/play/mupen64plus_next recipe already proven in
# this repo (see docs/AMIGA_CORE_BUILD.md, docs/PS2_CORE_BUILD.md,
# docs/N64_CORE_BUILD.md). Run this from WSL2 Ubuntu, NOT Git Bash on
# Windows — Git Bash's MSYS path translation corrupts /home/<user>/... paths.
#
# WHAT THIS SCRIPT DOES (phases 1-6 of the agreed DOS build plan):
#   1. Clone the EmulatorJS fork of dosbox-pure (the only fork with a working
#      `platform=emscripten` Makefile block).
#   2. Build the core itself to bitcode/objects via emmake.
#   3. Prepare the link input (.bc if the Makefile produced real relocatable
#      bitcode, else archive the surviving .o files into a .a).
#   4. Verify (and, only if missing, reapply) the worker-safe rwebaudio patch
#      on the SHARED RetroArch checkout every prior core build in this repo
#      reuses (~/amiga-build/RetroArch).
#   5. Link the core against RetroArch's Makefile.emscripten frontend
#      (HAVE_THREADS=1 — DOSBox Pure needs real pthread_create, unlike PUAE).
#   6. Stage the built artifacts (+ sha256/size manifest) into a LOCAL STAGING
#      DIRECTORY. This script NEVER touches public/cores/ — installing the
#      core is a separate, deliberate step performed by a human/agent after
#      reviewing the staged output and (per the build plan) running the real
#      headless boot verification in phase 7.
#
# WHAT THIS SCRIPT DELIBERATELY DOES NOT DO:
#   - It does not copy anything into public/cores/ (that dir is gitignored
#     and has regressed invisibly before — see CLAUDE.md / MEMORY.md).
#   - It does not register the core in src/systems.js.
#   - It does not run the headless Puppeteer boot verification (phase 7).
#   - It does not add -sASYNC=1/ASYNCIFY. That was specifically needed for
#     N64's libco-fiber co_switch() hack; DOSBox Pure's DBP_ThreadControl
#     uses plain pthread_create()+semaphores, which HAVE_THREADS=1 already
#     supports. Do not add it "just in case" without a documented reason.
#
# USAGE
#   Run directly (foreground, blocks until done):
#     bash scripts/cores/dos/build.sh
#
#   Run detached (recommended — this build can take a long time):
#     nohup setsid bash scripts/cores/dos/build.sh > /home/caldor/dosbox-build/build.out.log 2>&1 < /dev/null &
#     disown
#
#   Poll for completion without parsing the log:
#     the script writes $WORK_DIR/BUILD_STATUS only once it has fully
#     finished (success OR failure) — its mere existence means "done";
#     its first line says which. While the build is running, that file
#     does not exist.
#
# RE-RUNNING
#   Safe to re-run. By default it reuses whatever it finds from a previous
#   run (existing clone, existing build outputs) and only repeats work that
#   is actually missing. Force any step to redo with:
#     FORCE_RECLONE=1        re-clone dosbox-pure from scratch
#     FORCE_REBUILD_CORE=1   `make clean` + rebuild the core step
#     FORCE_RELINK=1         always re-run the RetroArch link step
#   Extra flags can be appended to the final link command (e.g. if phase 7's
#   verification finds a stalled pthread_create and the mitigation in the
#   build plan applies) via:
#     EXTRA_LINK_FLAGS='-sPTHREAD_POOL_SIZE=2' bash scripts/cores/dos/build.sh
#
# CONCURRENCY NOTE
#   ~/amiga-build/RetroArch is a SHARED checkout reused by every core build
#   in this project (Amiga, PS2, PSX, N64, and now DOS). Other concurrent
#   agent sessions may be using it. This script takes a flock(1) lock on it
#   for the duration of steps 3-6 (anything that writes into that tree) and
#   will refuse to proceed if it can't get the lock within LOCK_WAIT_SECS —
#   it will NOT silently barge in and clobber a build in progress.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (all overridable via environment for re-runs / experiments)
# ---------------------------------------------------------------------------
EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"
EMSDK_VERSION_EXPECTED="${EMSDK_VERSION_EXPECTED:-3.1.46}"

WORK_DIR="${WORK_DIR:-$HOME/dosbox-build}"
SRC_DIR="${SRC_DIR:-$WORK_DIR/dosbox-pure}"
STAGE_DIR="${STAGE_DIR:-$WORK_DIR/stage}"

DOSBOX_PURE_REPO="${DOSBOX_PURE_REPO:-https://github.com/EmulatorJS/dosbox-pure.git}"

RETROARCH_DIR="${RETROARCH_DIR:-$HOME/amiga-build/RetroArch}"
RWEBAUDIO_SOURCE_REPO="${RWEBAUDIO_SOURCE_REPO:-https://github.com/kblood/psx-wasm-jit-libretro.git}"

LIBRETRO_NAME="${LIBRETRO_NAME:-dosbox_pure}"
HAVE_THREADS="${HAVE_THREADS:-1}"
EXTRA_LINK_FLAGS="${EXTRA_LINK_FLAGS:-}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

FORCE_RECLONE="${FORCE_RECLONE:-0}"
FORCE_REBUILD_CORE="${FORCE_REBUILD_CORE:-0}"
FORCE_RELINK="${FORCE_RELINK:-0}"

LOCK_FILE="$RETROARCH_DIR/.core-build.lock"
LOCK_WAIT_SECS="${LOCK_WAIT_SECS:-14400}"   # 4h — this repo's core links can be slow

STATUS_FILE="$WORK_DIR/BUILD_STATUS"
CURRENT_PHASE="init"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }
phase() { CURRENT_PHASE="$1"; log "===== PHASE: $1 ====="; }
run() { log "+ $*"; "$@"; }

on_exit() {
  local code=$?
  mkdir -p "$WORK_DIR"
  if [ "$code" -eq 0 ]; then
    {
      echo "SUCCESS"
      echo "finished: $(ts)"
      echo "stage_dir: $STAGE_DIR"
    } > "$STATUS_FILE"
    log "=== DOS (DOSBox Pure) core build: SUCCESS ==="
    log "Staged artifacts are in: $STAGE_DIR"
    log "public/cores/ was NOT touched. Installing is a separate, deliberate step."
  else
    {
      echo "FAILED"
      echo "finished: $(ts)"
      echo "exit_code: $code"
      echo "last_phase: $CURRENT_PHASE"
    } > "$STATUS_FILE"
    log "=== DOS (DOSBox Pure) core build: FAILED (exit $code) at phase: $CURRENT_PHASE ===" >&2
  fi
}
trap on_exit EXIT

mkdir -p "$WORK_DIR"
rm -f "$STATUS_FILE"   # while this file is absent, a poller knows the build is still running

# ---------------------------------------------------------------------------
# Banner — printed BEFORE anything else so a future session can reproduce
# this exact build from the log alone even if the run fails immediately.
# ---------------------------------------------------------------------------
phase "banner"
log "DOS (DOSBox Pure) core build starting"
log "  EMSDK_DIR             = $EMSDK_DIR"
log "  EMSDK_VERSION_EXPECTED = $EMSDK_VERSION_EXPECTED"
log "  WORK_DIR               = $WORK_DIR"
log "  SRC_DIR                = $SRC_DIR"
log "  STAGE_DIR               = $STAGE_DIR"
log "  DOSBOX_PURE_REPO        = $DOSBOX_PURE_REPO"
log "  RETROARCH_DIR           = $RETROARCH_DIR"
log "  RWEBAUDIO_SOURCE_REPO   = $RWEBAUDIO_SOURCE_REPO"
log "  LIBRETRO_NAME           = $LIBRETRO_NAME"
log "  HAVE_THREADS            = $HAVE_THREADS"
log "  EXTRA_LINK_FLAGS        = '${EXTRA_LINK_FLAGS}'  (empty by default — see header comment for -sPTHREAD_POOL_SIZE=2 retry)"
log "  JOBS                    = $JOBS"
log "  FORCE_RECLONE           = $FORCE_RECLONE"
log "  FORCE_REBUILD_CORE      = $FORCE_REBUILD_CORE"
log "  FORCE_RELINK            = $FORCE_RELINK"
log "  ASYNC/ASYNCIFY          = NOT USED (intentional — see header comment)"
log "  STATUS_FILE (sentinel)  = $STATUS_FILE"

if [ -f /etc/os-release ]; then
  log "  host OS                 = $(. /etc/os-release; echo "$PRETTY_NAME")"
fi

# ---------------------------------------------------------------------------
# PHASE 1 — get the DOSBox Pure source (EmulatorJS fork, has the emscripten
# Makefile block; upstream schellingb/dosbox-pure has none at all).
# ---------------------------------------------------------------------------
phase "1-clone-source"
if [ -d "$SRC_DIR/.git" ] && [ "$FORCE_RECLONE" != "1" ]; then
  log "dosbox-pure checkout already present at $SRC_DIR — reusing (set FORCE_RECLONE=1 to re-clone)."
else
  rm -rf "$SRC_DIR"
  run git clone --depth 1 "$DOSBOX_PURE_REPO" "$SRC_DIR"
fi
DOSBOX_PURE_COMMIT="$(git -C "$SRC_DIR" rev-parse HEAD)"
log "dosbox-pure commit (PIN for build.json later): $DOSBOX_PURE_COMMIT"

if ! grep -q 'platform.*emscripten' "$SRC_DIR/Makefile" 2>/dev/null; then
  log "ERROR: no 'platform...emscripten' block found in $SRC_DIR/Makefile — has the EmulatorJS fork changed shape? Re-check the recipe in the build plan before continuing." >&2
  exit 1
fi
log "Confirmed: $SRC_DIR/Makefile has an emscripten platform block."

# ---------------------------------------------------------------------------
# PHASE 2 — build the core itself to bitcode/objects.
# ---------------------------------------------------------------------------
phase "2-build-core"
if [ ! -f "$EMSDK_DIR/emsdk_env.sh" ]; then
  log "ERROR: $EMSDK_DIR/emsdk_env.sh not found. Per the build plan, emsdk $EMSDK_VERSION_EXPECTED should already be installed+activated from the Amiga/PS2/PSX/N64 builds. Install it first (see docs/AMIGA_CORE_BUILD.md step 1)." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$EMSDK_DIR/emsdk_env.sh"

EMCC_VERSION_LINE="$(emcc --version | head -1)"
log "emcc reports: $EMCC_VERSION_LINE"
case "$EMCC_VERSION_LINE" in
  *"$EMSDK_VERSION_EXPECTED"*) log "emsdk version matches expected pin ($EMSDK_VERSION_EXPECTED)." ;;
  *) log "WARNING: emcc version line does not contain expected pin '$EMSDK_VERSION_EXPECTED' — proceeding anyway, but note this in build.json's pins block." ;;
esac

cd "$SRC_DIR"
if [ "$FORCE_REBUILD_CORE" = "1" ]; then
  log "FORCE_REBUILD_CORE=1 — cleaning first"
  run emmake make platform=emscripten clean || true
fi
run emmake make platform=emscripten -j"$JOBS"
log "Core compile step finished."

# ---------------------------------------------------------------------------
# PHASE 3 — prepare the link input. Try the simple Amiga/PS2-style bitcode
# path first; fall back to archiving .o files if the .bc turns out to be a
# non-relocatable link (the N64 build hit exactly this).
# ---------------------------------------------------------------------------
phase "3-prepare-link-input"
CORE_BC_NAME="dosbox_pure_libretro_emscripten.bc"
CORE_BC_PATH="$SRC_DIR/$CORE_BC_NAME"
LINK_INPUT=""
LINK_INPUT_KIND=""

if [ -f "$CORE_BC_PATH" ]; then
  LINK_INPUT="$CORE_BC_PATH"
  LINK_INPUT_KIND="bc"
  log "Found expected bitcode artifact: $CORE_BC_PATH ($(stat -c%s "$CORE_BC_PATH") bytes)"
else
  FOUND_BC="$(find "$SRC_DIR" -maxdepth 1 -name '*.bc' | head -1 || true)"
  if [ -n "$FOUND_BC" ]; then
    LINK_INPUT="$FOUND_BC"
    LINK_INPUT_KIND="bc"
    log "Expected name $CORE_BC_NAME not found, but found a .bc artifact: $FOUND_BC — using it."
  else
    log "No .bc artifact found. Falling back to archiving surviving .o files into a .a (per the build plan's documented fallback)."
    mapfile -t OBJ_FILES < <(find "$SRC_DIR" -name '*.o')
    if [ "${#OBJ_FILES[@]}" -eq 0 ]; then
      log "ERROR: neither a .bc file nor any .o files were produced — the core compile step (phase 2) must have failed silently. Check the log above for the real emmake error." >&2
      exit 1
    fi
    log "Archiving ${#OBJ_FILES[@]} object files."
    CORE_A_PATH="$SRC_DIR/dosbox_pure_libretro_emscripten.a"
    run emar rcs "$CORE_A_PATH" "${OBJ_FILES[@]}"
    LINK_INPUT="$CORE_A_PATH"
    LINK_INPUT_KIND="a"
  fi
fi
log "Link input: $LINK_INPUT (kind=$LINK_INPUT_KIND)"

if [ ! -d "$RETROARCH_DIR/.git" ]; then
  log "ERROR: shared RetroArch checkout not found at $RETROARCH_DIR. Per the build plan this should already exist (reused by every prior core build). Clone RetroArch there first — see docs/AMIGA_CORE_BUILD.md step 2." >&2
  exit 1
fi
RETROARCH_COMMIT_PRELOCK="$(git -C "$RETROARCH_DIR" rev-parse HEAD)"
log "Shared RetroArch checkout commit: $RETROARCH_COMMIT_PRELOCK"
log "Shared RetroArch checkout local diffs (git status --short):"
(cd "$RETROARCH_DIR" && git status --short) | sed 's/^/    /' || true

# ---------------------------------------------------------------------------
# Acquire the shared-checkout lock. Everything from here through the end of
# phase 6 touches $RETROARCH_DIR, which other concurrent agent sessions may
# also be using for a different core build.
# ---------------------------------------------------------------------------
phase "lock-shared-retroarch-checkout"
log "Waiting up to ${LOCK_WAIT_SECS}s for lock on $LOCK_FILE ..."
exec 9>"$LOCK_FILE"
if ! flock -w "$LOCK_WAIT_SECS" 9; then
  log "ERROR: could not acquire lock on $LOCK_FILE within ${LOCK_WAIT_SECS}s. Another core build is very likely using the shared RetroArch checkout right now. Re-run this script later rather than forcing it — writing into that tree concurrently with another build WILL corrupt both." >&2
  exit 1
fi
log "Lock acquired."

# Stage the link input into the shared checkout, without disturbing whatever
# the previous occupant left behind for OTHER cores.
cp "$LINK_INPUT" "$RETROARCH_DIR/libretro_emscripten.$LINK_INPUT_KIND"
if [ "$LINK_INPUT_KIND" = "bc" ]; then
  rm -f "$RETROARCH_DIR/libretro_emscripten.a"
else
  rm -f "$RETROARCH_DIR/libretro_emscripten.bc"
fi
log "Copied link input into shared checkout as libretro_emscripten.$LINK_INPUT_KIND"

# ---------------------------------------------------------------------------
# PHASE 4 — confirm (or, only if missing, reapply) the worker-safe rwebaudio
# patch on the shared RetroArch checkout.
# ---------------------------------------------------------------------------
phase "4-verify-rwebaudio-patch"
RWEBAUDIO_JS="$RETROARCH_DIR/emscripten/library_libretrowebxr_rwebaudio.js"
if grep -q 'RWEBAUDIO_JS_LIBRARY' "$RETROARCH_DIR/Makefile.emscripten" 2>/dev/null && [ -f "$RWEBAUDIO_JS" ]; then
  log "rwebaudio patch already present in shared checkout (Makefile.emscripten references RWEBAUDIO_JS_LIBRARY, and $RWEBAUDIO_JS exists) — not reapplying."
else
  log "rwebaudio patch missing — fetching it from $RWEBAUDIO_SOURCE_REPO and applying (per docs/N64_CORE_BUILD.md step 6)."
  RWEBAUDIO_TMP="$(mktemp -d)"
  run git clone --depth 1 "$RWEBAUDIO_SOURCE_REPO" "$RWEBAUDIO_TMP/psx-repo"
  (cd "$RETROARCH_DIR" && run git apply "$RWEBAUDIO_TMP/psx-repo/core-build/patches/retroarch-rwebaudio.patch")
  cp "$RWEBAUDIO_TMP/psx-repo/core-build/rwebaudio/library_libretrowebxr_rwebaudio.js" "$RETROARCH_DIR/emscripten/"
  rm -rf "$RWEBAUDIO_TMP"
  if ! grep -q 'RWEBAUDIO_JS_LIBRARY' "$RETROARCH_DIR/Makefile.emscripten" || [ ! -f "$RWEBAUDIO_JS" ]; then
    log "ERROR: applied the rwebaudio patch but verification still fails — patch may not have matched cleanly against this checkout's current state." >&2
    exit 1
  fi
  log "rwebaudio patch applied and verified."
fi

# ---------------------------------------------------------------------------
# PHASE 5 — link against RetroArch's Makefile.emscripten frontend.
# ---------------------------------------------------------------------------
phase "5-link"
cd "$RETROARCH_DIR"
BUILT_JS="$RETROARCH_DIR/${LIBRETRO_NAME}_libretro.js"
BUILT_WASM="$RETROARCH_DIR/${LIBRETRO_NAME}_libretro.wasm"
BUILT_WORKER="$RETROARCH_DIR/${LIBRETRO_NAME}_libretro.worker.js"

if [ -f "$BUILT_JS" ] && [ -f "$BUILT_WASM" ] && [ "$FORCE_RELINK" != "1" ]; then
  log "Link outputs already present ($BUILT_JS, $BUILT_WASM) — reusing (set FORCE_RELINK=1 to force a real relink)."
else
  # HAVE_OPENGLES3=1: required here for the same reason docs/N64_CORE_BUILD.md
  # and docs/PS2_CORE_BUILD.md both pass it explicitly — RetroArch's shared
  # gfx/drivers/gl2.o (compiled once into the shared checkout's obj-emscripten/
  # tree and reused across core builds) references glMapBufferRange/
  # glUnmapBuffer under #ifdef HAVE_OPENGLES3, which only resolves at link
  # time when LDFLAGS also picks the FULL_ES3/MAX_WEBGL_VERSION=2 branch
  # (Makefile.emscripten gates that branch on this same var). Omitting it
  # produced a real `wasm-ld: undefined symbol: glMapBufferRange` failure on
  # the first DOS link attempt (2026-07-29) because a HAVE_OPENGLES3=1 gl2.o
  # from a prior core build (N64/PS2) was still sitting in the shared
  # obj-emscripten/ dir while this link's LDFLAGS defaulted to the ES2/FULL_ES2
  # path — passing it here keeps DEFINES and LDFLAGS consistent with whatever
  # object is actually on disk.
  # shellcheck disable=SC2086
  run emmake make -f Makefile.emscripten \
    LIBRETRO="$LIBRETRO_NAME" \
    HAVE_THREADS="$HAVE_THREADS" \
    HAVE_OPENGLES3=1 \
    RWEBAUDIO_JS_LIBRARY=emscripten/library_libretrowebxr_rwebaudio.js \
    $EXTRA_LINK_FLAGS \
    -j"$JOBS"
fi

for f in "$BUILT_JS" "$BUILT_WASM"; do
  if [ ! -f "$f" ]; then
    log "ERROR: expected link output missing after the link step: $f" >&2
    exit 1
  fi
done
log "Link step produced: $BUILT_JS ($(stat -c%s "$BUILT_JS") bytes), $BUILT_WASM ($(stat -c%s "$BUILT_WASM") bytes)"
if [ -f "$BUILT_WORKER" ]; then
  log "Link step also produced: $BUILT_WORKER ($(stat -c%s "$BUILT_WORKER") bytes) — expected for a HAVE_THREADS=1 pthread build."
else
  log "WARNING: no $BUILT_WORKER produced. A HAVE_THREADS=1 build normally emits a pthread worker bootstrap file (see docs/PS2_CORE_BUILD.md's note after its step 10) — double check EmulatorClient.js's locateFile will find whatever this build DID produce, or investigate why it's missing before staging."
fi

# ---------------------------------------------------------------------------
# PHASE 6 — identify the real library_name and stage artifacts (staging
# only — this script never writes into public/cores/).
# ---------------------------------------------------------------------------
phase "6-stage-artifacts"
log "Strings matching 'dosbox' inside the built .wasm (use this to confirm the real retro_get_system_info library_name before authoring build.json / systems.js — do not just assume it's '$LIBRETRO_NAME'):"
strings "$BUILT_WASM" | grep -i dosbox | sort -u | sed 's/^/    /' || log "    (no case-insensitive 'dosbox' strings found — inspect $BUILT_JS by hand)"

mkdir -p "$STAGE_DIR"
STAGE_TS_DIR="$STAGE_DIR/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$STAGE_TS_DIR"
cp "$BUILT_JS" "$BUILT_WASM" "$STAGE_TS_DIR/"
[ -f "$BUILT_WORKER" ] && cp "$BUILT_WORKER" "$STAGE_TS_DIR/"

# Also refresh a stable "latest" copy so a follow-up step doesn't need to
# know the timestamp.
LATEST_DIR="$STAGE_DIR/latest"
rm -rf "$LATEST_DIR"
mkdir -p "$LATEST_DIR"
cp "$STAGE_TS_DIR"/* "$LATEST_DIR/"

MANIFEST="$STAGE_TS_DIR/MANIFEST.txt"
{
  echo "DOS (DOSBox Pure) core build manifest"
  echo "generated: $(ts)"
  echo
  echo "pins:"
  echo "  EMSDK_VERSION      = $EMCC_VERSION_LINE"
  echo "  DOSBOX_PURE_REPO   = $DOSBOX_PURE_REPO"
  echo "  DOSBOX_PURE_COMMIT = $DOSBOX_PURE_COMMIT"
  echo "  RETROARCH_DIR      = $RETROARCH_DIR"
  echo "  RETROARCH_COMMIT   = $(git -C "$RETROARCH_DIR" rev-parse HEAD)"
  echo "  LIBRETRO_NAME (make var) = $LIBRETRO_NAME"
  echo "  HAVE_THREADS       = $HAVE_THREADS"
  echo "  EXTRA_LINK_FLAGS   = '${EXTRA_LINK_FLAGS}'"
  echo
  echo "artifacts (path, bytes, sha256):"
  for f in "$STAGE_TS_DIR"/*.js "$STAGE_TS_DIR"/*.wasm; do
    [ -f "$f" ] || continue
    printf '  %s\t%s\t%s\n' "$(basename "$f")" "$(stat -c%s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
  done
  echo
  echo "NOTE: this manifest is a convenience reference for hand-authoring"
  echo "public/cores/${LIBRETRO_NAME}_libretro.build.json (mirror the shape of"
  echo "the existing mupen64plus_next_libretro.build.json) — it is NOT that"
  echo "build.json itself, and nothing here has been copied into public/cores/."
} > "$MANIFEST"
log "Wrote manifest: $MANIFEST"
cat "$MANIFEST" | sed 's/^/    /'

log "Staged output (timestamped): $STAGE_TS_DIR"
log "Staged output (latest alias): $LATEST_DIR"

# Lock is released automatically when fd 9 closes at script exit (trap runs
# after this point); nothing further touches $RETROARCH_DIR.
log "Build phases 1-6 complete."
