#!/bin/bash
# Relink PUAE against the lightgun-patched RetroArch emscripten frontend.
#
# WHY A RELINK: the Amiga core was built 2026-06-14, BEFORE the light-gun work.
# libretro-uae itself needs no patch — it already reads
# input_state_cb(port, RETRO_DEVICE_LIGHTGUN, ...) (libretro/libretro-mapper.c,
# retro_ui_get_pointer_state) and maps RETRO_DEVICE_PUAE_LIGHTGUN / _LIGHTPEN onto
# UAE jport mode 8. The FRONTEND half is what was stock: upstream rwebinput has no
# RETRO_DEVICE_LIGHTGUN case at all, so aim and trigger always read 0. That is what
# docs/patches/rwebinput-lightgun.diff (+ -multiport) add, and
# ~/amiga-build/RetroArch already carries both — it is the tree the NES/SNES/MD gun
# cores were linked from.
#
# WHY A PRIVATE COPY OF THE TREE: that tree also holds another session's in-progress
# gl2.c/gl3.c fix for the PS2 hardware-render present path, which uses GLES3-only
# entry points and only compiles with HAVE_OPENGLES3=1 (PUAE does not set it, and
# PUAE is software-rendered so it never takes that path). Build in a copy with those
# two files at HEAD rather than touching someone else's work or changing PUAE's
# graphics config, which is not what is under test.
#
# WHY THE 7-ZIP OBJECTS ARE INJECTED: libretro-uae excludes its vendored deps/7zip
# under STATIC_LINKING=1 (Makefile.common:213) because the frontend used to supply
# the 7-Zip SDK. Since June, RetroArch master replaced that vendored SDK with its own
# formats/7z/r7z_* implementation, so SzArEx_*/LzmaDec_*/LookToRead2_*/File_* no
# longer exist anywhere in the frontend and the link fails on ~20 undefined symbols
# from the core's libretro-glue.o and libchdr_chd.o. The core's own deps/7zip is
# still the exact SDK those objects were compiled against, so compile it here and
# add it to the core archive — restoring precisely what the June link had, with no
# behavioural change (Amiga .7z/.chd content keeps working).
#
# PROVENANCE (ARC-3, 2026-08-17). This script used to pin nothing, check nothing
# and always exit 0. Three concrete consequences, all fixed below:
#
#   1. It printed `grep -c rwebinput_set_lightgun input/drivers/rwebinput_input.c`
#      and CARRIED ON regardless of the answer. A `0` there means the frontend
#      light-gun patch is absent, and the run then produces a perfectly healthy
#      Amiga core whose gun input reads 0 for ever — silently, which is exactly
#      the genesis_plus_gx incident that scripts/test-patched-cores.mjs exists
#      for. The counts are now assertions.
#   2. `echo "BUILD_EXIT=$?"` recorded the link's exit status into the log and
#      then returned 0 anyway, so a failed link looked like a successful build to
#      anything reading the exit code. It aborts now.
#   3. It `cp -a`'d whatever was in ~/amiga-build/RetroArch that day and recorded
#      nothing about it. It now writes puae_libretro.build.json — the same shape
#      as the git-tracked manifests in public/cores/ — plus the shared checkout's
#      local patch set as a real .patch file, so a rebuild after that tree is
#      reset has something to reapply instead of a prose description.
#
# The commit pins below default to EMPTY on purpose: unlike the DOS core there is
# no shipped puae build.json to copy real SHAs out of, and inventing them would be
# worse than admitting the gap. The first run after this change RECORDS the
# commits it used; paste them into the two variables (and commit the generated
# public/cores/puae_libretro.build.json) to turn the record into a pin.
#
#   ALLOW_UNPINNED=1  downgrades every check below to a warning.

set -uo pipefail

EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"
EMSDK_VERSION_EXPECTED="${EMSDK_VERSION_EXPECTED:-3.1.46}"
SRC="${SRC:-$HOME/amiga-build/RetroArch}"
DST="${DST:-$HOME/puae-gun-build/RetroArch}"
UAE="${UAE:-$HOME/amiga-build/libretro-uae}"
STAGE_DIR="${STAGE_DIR:-$HOME/puae-gun-build/stage}"

RETROARCH_COMMIT_EXPECTED="${RETROARCH_COMMIT_EXPECTED:-}"
LIBRETRO_UAE_COMMIT_EXPECTED="${LIBRETRO_UAE_COMMIT_EXPECTED:-}"
ALLOW_UNPINNED="${ALLOW_UNPINNED:-0}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }
pin_violation() {
  if [ "$ALLOW_UNPINNED" = "1" ]; then
    log "WARNING (ALLOW_UNPINNED=1): $*"
  else
    log "ERROR: $*" >&2
    log "       Re-run with ALLOW_UNPINNED=1 if this is deliberate, then update the pins at the top of this script and the generated build.json in the same commit." >&2
    exit 1
  fi
}

set -x
[ -d "$SRC/.git" ] || die "no RetroArch checkout at $SRC (see docs/AMIGA_CORE_BUILD.md step 2)"
[ -d "$UAE" ]      || die "no libretro-uae checkout at $UAE (see docs/AMIGA_CORE_BUILD.md step 2)"

RETROARCH_COMMIT="$(git -C "$SRC" rev-parse HEAD)"
LIBRETRO_UAE_COMMIT="$(git -C "$UAE" rev-parse HEAD 2>/dev/null || echo 'unknown')"
{ set +x; } 2>/dev/null
log "RetroArch commit    : $RETROARCH_COMMIT"
log "libretro-uae commit : $LIBRETRO_UAE_COMMIT"
if [ -n "$RETROARCH_COMMIT_EXPECTED" ] && [ "$RETROARCH_COMMIT" != "$RETROARCH_COMMIT_EXPECTED" ]; then
  pin_violation "RetroArch is at $RETROARCH_COMMIT, pin says $RETROARCH_COMMIT_EXPECTED."
fi
if [ -n "$LIBRETRO_UAE_COMMIT_EXPECTED" ] && [ "$LIBRETRO_UAE_COMMIT" != "$LIBRETRO_UAE_COMMIT_EXPECTED" ]; then
  pin_violation "libretro-uae is at $LIBRETRO_UAE_COMMIT, pin says $LIBRETRO_UAE_COMMIT_EXPECTED."
fi

# Capture the SHARED checkout's local patch set before copying it. That tree is
# supposed to be dirty — the rwebinput light-gun diffs and the rwebaudio bridge
# live there and are not upstreamed — so the useful act is to record it, not to
# demand it be clean. This file is the answer to "what happens if
# ~/amiga-build/RetroArch is ever reset".
mkdir -p "$STAGE_DIR"
RETROARCH_WORKTREE_PATCH="$STAGE_DIR/retroarch-worktree.patch"
(cd "$SRC" && git diff) > "$RETROARCH_WORKTREE_PATCH" || true
RETROARCH_WORKTREE_SHA256="$(sha256sum "$RETROARCH_WORKTREE_PATCH" | cut -d' ' -f1)"
log "Captured shared-checkout patch set: $RETROARCH_WORKTREE_PATCH ($(stat -c%s "$RETROARCH_WORKTREE_PATCH") bytes, sha256 $RETROARCH_WORKTREE_SHA256)"

# shellcheck disable=SC1090
source "$EMSDK_DIR/emsdk_env.sh" || die "could not source $EMSDK_DIR/emsdk_env.sh"
EMCC_VERSION_LINE="$(emcc --version | head -1)"
log "emcc reports: $EMCC_VERSION_LINE"
case "$EMCC_VERSION_LINE" in
  *"$EMSDK_VERSION_EXPECTED"*) log "emsdk matches the pin ($EMSDK_VERSION_EXPECTED)." ;;
  *) pin_violation "emcc reports '$EMCC_VERSION_LINE', not the pinned emsdk '$EMSDK_VERSION_EXPECTED'. The compiler decides the emitted glue and the exported symbol set, so a different emsdk is a different core." ;;
esac

set -x
rm -rf "$HOME/puae-gun-build/RetroArch"
mkdir -p "$HOME/puae-gun-build"
cp -a "$SRC" "$DST" || exit 1
cd "$DST" || exit 1
git checkout -- gfx/drivers/gl2.c gfx/drivers/gl3.c || exit 1
rm -f libretro_emscripten.bc libretro_emscripten.a
{ set +x; } 2>/dev/null

# ASSERTED, not printed. A 0 here means the frontend light-gun patch is missing
# and the relink — the entire point of this script — would produce a gun-less
# core that looks perfectly fine.
PATCH_IN_DRIVER="$(grep -c rwebinput_set_lightgun input/drivers/rwebinput_input.c || true)"
PATCH_IN_MAKEFILE="$(grep -c _rwebinput_set_lightgun Makefile.emscripten || true)"
log "frontend patch: rwebinput_input.c=$PATCH_IN_DRIVER  Makefile.emscripten=$PATCH_IN_MAKEFILE"
[ "$PATCH_IN_DRIVER" -gt 0 ] || die "input/drivers/rwebinput_input.c has no rwebinput_set_lightgun — the light-gun frontend patch (docs/patches/rwebinput-lightgun-multiport.diff) is NOT applied to $SRC. Relinking now would emit an Amiga core whose gun input reads 0 for ever, exactly the failure this script exists to fix. Apply the patch first."
[ "$PATCH_IN_MAKEFILE" -gt 0 ] || die "Makefile.emscripten does not EXPORT _rwebinput_set_lightgun — the patch is half-applied: the symbol exists in the driver but will not be exported to JS, so the app cannot call it. Apply the Makefile half of docs/patches/rwebinput-lightgun-multiport.diff."

set -x
echo "--- building the 7-Zip SDK the core expects"
mkdir -p "$HOME/puae-gun-build/7z" && cd "$HOME/puae-gun-build/7z" || exit 1
for f in 7zArcIn 7zBuf 7zCrc 7zCrcOpt 7zDec 7zFile 7zStream Bcj2 Bra Bra86 BraIA64 CpuArch Delta Lzma2Dec LzmaDec LzFind LzmaEnc; do
  emcc -O3 -D_7ZIP_ST -I"$UAE"/deps/7zip -c "$UAE/deps/7zip/$f.c" -o "$f.o" || exit 1
done
ls -la

echo "--- core archive + 7-Zip objects"
cd "$DST" || exit 1
cp "$UAE"/puae_libretro_emscripten.bc libretro_emscripten.a || exit 1
emar r libretro_emscripten.a "$HOME"/puae-gun-build/7z/*.o || exit 1
emranlib libretro_emscripten.a
emar t libretro_emscripten.a | wc -l

echo "--- link"
# Fresh objects: obj-emscripten/ came from another core's build and possibly other
# HAVE_* flags. Same command line as docs/AMIGA_CORE_BUILD.md's step 4.
emmake make -f Makefile.emscripten LIBRETRO=puae HAVE_THREADS=0 HAVE_CHD=0 clean
rm -f libretro_emscripten.bc   # `clean` must not leave a .bc that mv would use
emmake make -f Makefile.emscripten LIBRETRO=puae HAVE_THREADS=0 HAVE_CHD=0 -j"$(nproc)"
BUILD_EXIT=$?
{ set +x; } 2>/dev/null

# The old script printed BUILD_EXIT and then exited 0 regardless, so a failed
# link was indistinguishable from a successful one to anything but a human
# reading the log.
[ "$BUILD_EXIT" -eq 0 ] || die "the link failed (exit $BUILD_EXIT) — see the emmake output above"
[ -f "$DST/puae_libretro.js" ] && [ -f "$DST/puae_libretro.wasm" ] \
  || die "the link reported success but $DST/puae_libretro.js/.wasm are not both present"

LIGHTGUN_EXPORTS="$(grep -c rwebinput_set_lightgun "$DST/puae_libretro.js" || true)"
log "LIGHTGUN_EXPORTS=$LIGHTGUN_EXPORTS"
[ "$LIGHTGUN_EXPORTS" -gt 0 ] || die "the linked puae_libretro.js does NOT export rwebinput_set_lightgun. The relink produced a stock-behaviour core; shipping it would put the Amiga back where it was before 2026-08-15 with nothing to show for it. This is the same static check scripts/test-patched-cores.mjs runs."

# --- stage + provenance ------------------------------------------------------
cp "$DST/puae_libretro.js" "$DST/puae_libretro.wasm" "$STAGE_DIR/"
BUILD_JSON="$STAGE_DIR/puae_libretro.build.json"
{
  echo '{'
  echo '  "schemaVersion": 1,'
  echo '  "artifactBasename": "puae_libretro",'
  echo '  "artifacts": {'
  sep=''
  for f in "$STAGE_DIR"/puae_libretro.js "$STAGE_DIR"/puae_libretro.wasm; do
    printf '%s    "%s": { "bytes": %s, "sha256": "%s" }' \
      "$sep" "$(basename "$f")" "$(stat -c%s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
    sep=$',\n'
  done
  echo
  echo '  },'
  echo '  "pins": {'
  echo '    "RETROARCH_REPOSITORY": "https://github.com/libretro/RetroArch.git",'
  echo "    \"RETROARCH_COMMIT\": \"$RETROARCH_COMMIT\","
  echo "    \"RETROARCH_LOCAL_PATCH_SHA256\": \"$RETROARCH_WORKTREE_SHA256\","
  echo '    "LIBRETRO_UAE_REPOSITORY": "https://github.com/EmulatorJS/libretro-uae.git",'
  echo "    \"LIBRETRO_UAE_COMMIT\": \"$LIBRETRO_UAE_COMMIT\","
  echo "    \"EMSDK_VERSION\": \"$EMSDK_VERSION_EXPECTED\""
  echo '  },'
  echo '  "build": {'
  echo "    \"emccVersionLine\": \"$EMCC_VERSION_LINE\","
  echo '    "haveThreads": 0,'
  echo '    "haveChd": 0,'
  echo '    "sevenZipInjected": true,'
  echo '    "lightgunPatch": "docs/patches/rwebinput-lightgun.diff + rwebinput-lightgun-multiport.diff (frontend relink; libretro-uae itself is unpatched)",'
  echo "    \"lightgunExportsInGlue\": $LIGHTGUN_EXPORTS,"
  echo "    \"allowUnpinned\": $([ "$ALLOW_UNPINNED" = "1" ] && echo true || echo false),"
  echo '    "generatedBy": "scripts/cores/amiga/build-puae-lightgun.sh",'
  echo "    \"generatedAt\": \"$(date '+%Y-%m-%d %H:%M:%S')\""
  echo '  }'
  echo '}'
} > "$BUILD_JSON"
if command -v node >/dev/null 2>&1; then
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$BUILD_JSON" \
    || die "generated $BUILD_JSON is not valid JSON"
fi

log "Staged: $STAGE_DIR"
log "  puae_libretro.js / .wasm      — copy into public/cores/ (gitignored binaries)"
log "  puae_libretro.build.json      — copy into public/cores/ too; this one IS git-tracked"
log "  retroarch-worktree.patch      — the shared checkout's local patch set, keep it"
log "Paste RETROARCH_COMMIT=$RETROARCH_COMMIT and LIBRETRO_UAE_COMMIT=$LIBRETRO_UAE_COMMIT into"
log "this script's *_COMMIT_EXPECTED variables to turn today's record into tomorrow's pin."
log "DONE"
