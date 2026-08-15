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
set -x
SRC=~/amiga-build/RetroArch
DST=~/puae-gun-build/RetroArch
UAE=~/amiga-build/libretro-uae

source ~/emsdk/emsdk_env.sh

rm -rf ~/puae-gun-build
mkdir -p ~/puae-gun-build
cp -a "$SRC" "$DST" || exit 1
cd "$DST" || exit 1
git checkout -- gfx/drivers/gl2.c gfx/drivers/gl3.c || exit 1
rm -f libretro_emscripten.bc libretro_emscripten.a

echo "--- frontend patch present?"
grep -c rwebinput_set_lightgun input/drivers/rwebinput_input.c
grep -c _rwebinput_set_lightgun Makefile.emscripten

echo "--- building the 7-Zip SDK the core expects"
mkdir -p ~/puae-gun-build/7z && cd ~/puae-gun-build/7z || exit 1
for f in 7zArcIn 7zBuf 7zCrc 7zCrcOpt 7zDec 7zFile 7zStream Bcj2 Bra Bra86 BraIA64 CpuArch Delta Lzma2Dec LzmaDec LzFind LzmaEnc; do
  emcc -O3 -D_7ZIP_ST -I"$UAE"/deps/7zip -c "$UAE/deps/7zip/$f.c" -o "$f.o" || exit 1
done
ls -la

echo "--- core archive + 7-Zip objects"
cd "$DST" || exit 1
cp "$UAE"/puae_libretro_emscripten.bc libretro_emscripten.a || exit 1
emar r libretro_emscripten.a ~/puae-gun-build/7z/*.o || exit 1
emranlib libretro_emscripten.a
emar t libretro_emscripten.a | wc -l

echo "--- link"
# Fresh objects: obj-emscripten/ came from another core's build and possibly other
# HAVE_* flags. Same command line as docs/AMIGA_CORE_BUILD.md's step 4.
emmake make -f Makefile.emscripten LIBRETRO=puae HAVE_THREADS=0 HAVE_CHD=0 clean
rm -f libretro_emscripten.bc   # `clean` must not leave a .bc that mv would use
emmake make -f Makefile.emscripten LIBRETRO=puae HAVE_THREADS=0 HAVE_CHD=0 -j"$(nproc)"
echo "BUILD_EXIT=$?"
ls -la "$DST"/puae_libretro.js "$DST"/puae_libretro.wasm
echo "LIGHTGUN_EXPORTS=$(grep -c rwebinput_set_lightgun "$DST"/puae_libretro.js)"
echo "DONE"
