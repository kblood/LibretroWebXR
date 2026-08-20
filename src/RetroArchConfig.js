// Bytes we write to /home/web_user/retroarch/userdata/retroarch.cfg before
// the core's callMain. Without this, the RA-wrapped libretro core (these
// are webretro's builds) falls back to RA stock keybinds — A=x, B=z,
// Select=rshift — which don't match what GameInputMgr dispatches.
//
// The strings are webretro's defaultKeybinds + nulKeys + extraConfig from
// source-projects/webretro/assets/base.js lines 18-20, verbatim. The
// per-button *_axis / *_btn / *_mbtn null settings matter: without them
// RA stock gamepad/mouse defaults for player1 buttons may shadow our
// keyboard binds and the same key produces no effect.

import { EXTRA_PLAYER_KEYS, RA_KEY_NAME } from './ControllerMaps.js';

const DEFAULT_KEYBINDS = `input_player1_start = "enter"
input_player1_select = "space"
input_player1_l = "e"
input_player1_l2 = "r"
input_player1_r = "p"
input_player1_r2 = "o"
input_player1_a = "h"
input_player1_b = "g"
input_player1_x = "y"
input_player1_y = "t"
input_player1_up = "up"
input_player1_left = "left"
input_player1_down = "down"
input_player1_right = "right"
input_player1_l_x_minus = "a"
input_player1_l_x_plus = "d"
input_player1_l_y_minus = "w"
input_player1_l_y_plus = "s"
input_player1_l3_btn = "x"
input_player1_r_x_minus = "j"
input_player1_r_x_plus = "l"
input_player1_r_y_minus = "i"
input_player1_r_y_plus = "k"
input_player1_r3_btn = "comma"
input_menu_toggle = "f1"
input_save_state = "f2"
input_load_state = "f3"
input_screenshot = "f4"
input_hold_fast_forward = "nul"
input_toggle_fast_forward = "nul"
input_hold_slowmotion = "nul"
input_toggle_slowmotion = "nul"
input_grab_mouse_toggle = "nul"
input_game_focus_toggle = "nul"
`;
// ^ grab_mouse_toggle (backslash) and game_focus_toggle (tilde≡backquote) are
// nulled because player 4's binds below claim those physical keys. Neither
// hotkey is reachable in VR anyway.

const NUL_KEYS = 'input_ai_service = "nul"\ninput_ai_service_axis = "nul"\ninput_ai_service_btn = "nul"\ninput_ai_service_mbtn = "nul"\ninput_audio_mute = "nul"\ninput_audio_mute_axis = "nul"\ninput_audio_mute_btn = "nul"\ninput_audio_mute_mbtn = "nul"\ninput_cheat_index_minus = "nul"\ninput_cheat_index_minus_axis = "nul"\ninput_cheat_index_minus_btn = "nul"\ninput_cheat_index_minus_mbtn = "nul"\ninput_cheat_index_plus = "nul"\ninput_cheat_index_plus_axis = "nul"\ninput_cheat_index_plus_btn = "nul"\ninput_cheat_index_plus_mbtn = "nul"\ninput_cheat_toggle = "nul"\ninput_cheat_toggle_axis = "nul"\ninput_cheat_toggle_btn = "nul"\ninput_cheat_toggle_mbtn = "nul"\ninput_desktop_menu_toggle = "nul"\ninput_desktop_menu_toggle_axis = "nul"\ninput_desktop_menu_toggle_btn = "nul"\ninput_desktop_menu_toggle_mbtn = "nul"\ninput_disk_eject_toggle = "nul"\ninput_disk_eject_toggle_axis = "nul"\ninput_disk_eject_toggle_btn = "nul"\ninput_disk_eject_toggle_mbtn = "nul"\ninput_disk_next = "nul"\ninput_disk_next_axis = "nul"\ninput_disk_next_btn = "nul"\ninput_disk_next_mbtn = "nul"\ninput_disk_prev = "nul"\ninput_disk_prev_axis = "nul"\ninput_disk_prev_btn = "nul"\ninput_disk_prev_mbtn = "nul"\ninput_duty_cycle = "nul"\ninput_enable_hotkey = "nul"\ninput_enable_hotkey_axis = "nul"\ninput_enable_hotkey_btn = "nul"\ninput_enable_hotkey_mbtn = "nul"\ninput_exit_emulator = "nul"\ninput_exit_emulator_axis = "nul"\ninput_exit_emulator_btn = "nul"\ninput_exit_emulator_mbtn = "nul"\ninput_fps_toggle = "nul"\ninput_fps_toggle_axis = "nul"\ninput_fps_toggle_btn = "nul"\ninput_fps_toggle_mbtn = "nul"\ninput_frame_advance = "nul"\ninput_frame_advance_axis = "nul"\ninput_frame_advance_btn = "nul"\ninput_frame_advance_mbtn = "nul"\ninput_game_focus_toggle_axis = "nul"\ninput_game_focus_toggle_btn = "nul"\ninput_game_focus_toggle_mbtn = "nul"\ninput_grab_mouse_toggle_axis = "nul"\ninput_grab_mouse_toggle_btn = "nul"\ninput_grab_mouse_toggle_mbtn = "nul"\ninput_hold_fast_forward_axis = "nul"\ninput_hold_fast_forward_btn = "nul"\ninput_hold_fast_forward_mbtn = "nul"\ninput_slowmotion = "nul"\ninput_hold_slowmotion_axis = "nul"\ninput_hold_slowmotion_btn = "nul"\ninput_hold_slowmotion_mbtn = "nul"\ninput_hotkey_block_delay = "nul"\ninput_load_state_axis = "nul"\ninput_load_state_btn = "nul"\ninput_load_state_mbtn = "nul"\ninput_menu_toggle_axis = "nul"\ninput_menu_toggle_btn = "nul"\ninput_menu_toggle_mbtn = "nul"\ninput_movie_record_toggle = "nul"\ninput_movie_record_toggle_axis = "nul"\ninput_movie_record_toggle_btn = "nul"\ninput_movie_record_toggle_mbtn = "nul"\ninput_netplay_game_watch = "nul"\ninput_netplay_game_watch_axis = "nul"\ninput_netplay_game_watch_btn = "nul"\ninput_netplay_game_watch_mbtn = "nul"\ninput_netplay_host_toggle = "nul"\ninput_netplay_host_toggle_axis = "nul"\ninput_netplay_host_toggle_btn = "nul"\ninput_netplay_host_toggle_mbtn = "nul"\ninput_osk_toggle = "nul"\ninput_osk_toggle_axis = "nul"\ninput_osk_toggle_btn = "nul"\ninput_osk_toggle_mbtn = "nul"\ninput_overlay_next = "nul"\ninput_overlay_next_axis = "nul"\ninput_overlay_next_btn = "nul"\ninput_overlay_next_mbtn = "nul"\ninput_pause_toggle = "nul"\ninput_pause_toggle_axis = "nul"\ninput_pause_toggle_btn = "nul"\ninput_pause_toggle_mbtn = "nul"\ninput_player1_a_axis = "nul"\ninput_player1_a_btn = "nul"\ninput_player1_a_mbtn = "nul"\ninput_player1_b_axis = "nul"\ninput_player1_b_btn = "nul"\ninput_player1_b_mbtn = "nul"\ninput_player1_down_axis = "nul"\ninput_player1_down_btn = "nul"\ninput_player1_down_mbtn = "nul"\ninput_player1_gun_aux_a = "nul"\ninput_player1_gun_aux_a_axis = "nul"\ninput_player1_gun_aux_a_btn = "nul"\ninput_player1_gun_aux_a_mbtn = "nul"\ninput_player1_gun_aux_b = "nul"\ninput_player1_gun_aux_b_axis = "nul"\ninput_player1_gun_aux_b_btn = "nul"\ninput_player1_gun_aux_b_mbtn = "nul"\ninput_player1_gun_aux_c = "nul"\ninput_player1_gun_aux_c_axis = "nul"\ninput_player1_gun_aux_c_btn = "nul"\ninput_player1_gun_aux_c_mbtn = "nul"\ninput_player1_gun_dpad_down = "nul"\ninput_player1_gun_dpad_down_axis = "nul"\ninput_player1_gun_dpad_down_btn = "nul"\ninput_player1_gun_dpad_down_mbtn = "nul"\ninput_player1_gun_dpad_left = "nul"\ninput_player1_gun_dpad_left_axis = "nul"\ninput_player1_gun_dpad_left_btn = "nul"\ninput_player1_gun_dpad_left_mbtn = "nul"\ninput_player1_gun_dpad_right = "nul"\ninput_player1_gun_dpad_right_axis = "nul"\ninput_player1_gun_dpad_right_btn = "nul"\ninput_player1_gun_dpad_right_mbtn = "nul"\ninput_player1_gun_dpad_up = "nul"\ninput_player1_gun_dpad_up_axis = "nul"\ninput_player1_gun_dpad_up_btn = "nul"\ninput_player1_gun_dpad_up_mbtn = "nul"\ninput_player1_gun_offscreen_shot = "nul"\ninput_player1_gun_offscreen_shot_axis = "nul"\ninput_player1_gun_offscreen_shot_btn = "nul"\ninput_player1_gun_offscreen_shot_mbtn = "nul"\ninput_player1_gun_select = "nul"\ninput_player1_gun_select_axis = "nul"\ninput_player1_gun_select_btn = "nul"\ninput_player1_gun_select_mbtn = "nul"\ninput_player1_gun_start = "nul"\ninput_player1_gun_start_axis = "nul"\ninput_player1_gun_start_btn = "nul"\ninput_player1_gun_start_mbtn = "nul"\ninput_player1_gun_trigger = "nul"\ninput_player1_gun_trigger_axis = "nul"\ninput_player1_gun_trigger_btn = "nul"\ninput_player1_gun_trigger_mbtn = "nul"\ninput_player1_l2_axis = "nul"\ninput_player1_l2_btn = "nul"\ninput_player1_l2_mbtn = "nul"\ninput_player1_l3 = "nul"\ninput_player1_l3_axis = "nul"\ninput_player1_l3_mbtn = "nul"\ninput_player1_l_axis = "nul"\ninput_player1_l_btn = "nul"\ninput_player1_l_mbtn = "nul"\ninput_player1_l_x_minus_axis = "nul"\ninput_player1_l_x_minus_btn = "nul"\ninput_player1_l_x_minus_mbtn = "nul"\ninput_player1_l_x_plus_axis = "nul"\ninput_player1_l_x_plus_btn = "nul"\ninput_player1_l_x_plus_mbtn = "nul"\ninput_player1_l_y_minus_axis = "nul"\ninput_player1_l_y_minus_btn = "nul"\ninput_player1_l_y_minus_mbtn = "nul"\ninput_player1_l_y_plus_axis = "nul"\ninput_player1_l_y_plus_btn = "nul"\ninput_player1_l_y_plus_mbtn = "nul"\ninput_player1_left_axis = "nul"\ninput_player1_left_mbtn = "nul"\ninput_player1_r2_axis = "nul"\ninput_player1_r2_btn = "nul"\ninput_player1_r2_mbtn = "nul"\ninput_player1_r3 = "nul"\ninput_player1_r3_axis = "nul"\ninput_player1_r3_mbtn = "nul"\ninput_player1_r_axis = "nul"\ninput_player1_r_btn = "nul"\ninput_player1_r_mbtn = "nul"\ninput_player1_r_x_minus_axis = "nul"\ninput_player1_r_x_minus_btn = "nul"\ninput_player1_r_x_minus_mbtn = "nul"\ninput_player1_r_x_plus_axis = "nul"\ninput_player1_r_x_plus_btn = "nul"\ninput_player1_r_x_plus_mbtn = "nul"\ninput_player1_r_y_minus_axis = "nul"\ninput_player1_r_y_minus_btn = "nul"\ninput_player1_r_y_minus_mbtn = "nul"\ninput_player1_r_y_plus_axis = "nul"\ninput_player1_r_y_plus_btn = "nul"\ninput_player1_r_y_plus_mbtn = "nul"\ninput_player1_right_axis = "nul"\ninput_player1_right_mbtn = "nul"\ninput_player1_select_axis = "nul"\ninput_player1_select_btn = "nul"\ninput_player1_select_mbtn = "nul"\ninput_player1_start_axis = "nul"\ninput_player1_start_btn = "nul"\ninput_player1_start_mbtn = "nul"\ninput_player1_turbo = "nul"\ninput_player1_turbo_axis = "nul"\ninput_player1_turbo_btn = "nul"\ninput_player1_turbo_mbtn = "nul"\ninput_player1_up_axis = "nul"\ninput_player1_up_btn = "nul"\ninput_player1_up_mbtn = "nul"\ninput_player1_x_axis = "nul"\ninput_player1_x_btn = "nul"\ninput_player1_x_mbtn = "nul"\ninput_player1_y_axis = "nul"\ninput_player1_y_btn = "nul"\ninput_player1_y_mbtn = "nul"\ninput_poll_type_behavior = "nul"\ninput_recording_toggle = "nul"\ninput_recording_toggle_axis = "nul"\ninput_recording_toggle_btn = "nul"\ninput_recording_toggle_mbtn = "nul"\ninput_reset = "nul"\ninput_reset_axis = "nul"\ninput_reset_btn = "nul"\ninput_reset_mbtn = "nul"\ninput_rewind = "nul"\ninput_rewind_axis = "nul"\ninput_rewind_btn = "nul"\ninput_rewind_mbtn = "nul"\ninput_save_state_axis = "nul"\ninput_save_state_btn = "nul"\ninput_save_state_mbtn = "nul"\ninput_screenshot_axis = "nul"\ninput_screenshot_btn = "nul"\ninput_screenshot_mbtn = "nul"\ninput_send_debug_info = "nul"\ninput_send_debug_info_axis = "nul"\ninput_send_debug_info_btn = "nul"\ninput_send_debug_info_mbtn = "nul"\ninput_shader_next = "nul"\ninput_shader_next_axis = "nul"\ninput_shader_next_btn = "nul"\ninput_shader_next_mbtn = "nul"\ninput_shader_prev = "nul"\ninput_shader_prev_axis = "nul"\ninput_shader_prev_btn = "nul"\ninput_shader_prev_mbtn = "nul"\ninput_state_slot_decrease = "nul"\ninput_state_slot_decrease_axis = "nul"\ninput_state_slot_decrease_btn = "nul"\ninput_state_slot_decrease_mbtn = "nul"\ninput_state_slot_increase = "nul"\ninput_state_slot_increase_axis = "nul"\ninput_state_slot_increase_btn = "nul"\ninput_state_slot_increase_mbtn = "nul"\ninput_streaming_toggle = "nul"\ninput_streaming_toggle_axis = "nul"\ninput_streaming_toggle_btn = "nul"\ninput_streaming_toggle_mbtn = "nul"\ninput_toggle_fast_forward_axis = "nul"\ninput_toggle_fast_forward_btn = "nul"\ninput_toggle_fast_forward_mbtn = "nul"\ninput_toggle_fullscreen = "nul"\ninput_toggle_fullscreen_axis = "nul"\ninput_toggle_fullscreen_btn = "nul"\ninput_toggle_fullscreen_mbtn = "nul"\ninput_toggle_slowmotion_axis = "nul"\ninput_toggle_slowmotion_btn = "nul"\ninput_toggle_slowmotion_mbtn = "nul"\ninput_turbo_default_button = "nul"\ninput_turbo_mode = "nul"\ninput_turbo_period = "nul"\ninput_volume_down = "nul"\ninput_volume_down_axis = "nul"\ninput_volume_down_btn = "nul"\ninput_volume_down_mbtn = "nul"\ninput_volume_up = "nul"\ninput_volume_up_axis = "nul"\ninput_volume_up_btn = "nul"\ninput_volume_up_mbtn = "nul"\n';

// game_specific_options defaults to RA's own stock "true": without turning
// it off here, RA looks for a per-content options file first and, finding
// none, silently ignores core_options_path's file entirely instead of
// falling back to it - so every RETROARCH_CORE_OPTIONS key below is a no-op
// (core keeps its own compiled-in defaults) until this is set to "false".
// global_core_options ALSO defaults to stock "false", meaning RA still
// prefers a *per-core* options file/directory (keyed by core name) over
// core_options_path even with game_specific_options off - set "true" here
// to force every core onto the single shared file this project writes.
// autosave_interval is in SECONDS (RetroArch's autosave.c spins up a
// dedicated background thread on this timer that reads the core's battery-
// backed SRAM via retro_get_memory and rewrites the .srm file in place — a
// core-side mechanism, not something this app's JS drives). It defaults to
// "0" (disabled) in every RetroArch config this project writes, which is the
// root cause of native SaveRAM never actually persisting for worker-execution
// cores (PSX/N64): WorkerEmulatorClient.flushSaveRam() just re-reads whatever
// is currently in MEMFS, and without autosave_interval nothing ever rewrites
// that file during play — only a restoredSaves boot-time write (if any) ever
// touched it, so every "flush" read back the exact same boot-time bytes. 10s
// keeps saved progress fresh without autosaving so often it's a meaningful
// per-frame cost (2026-07-25 review, B4/P0-5).
// sort_savefiles_enable / sort_savestates_enable default to stock "true" in
// RetroArch 1.22, which makes RA redirect SRAM and save states into a
// per-core SUBDIRECTORY of the configured directory ("[Override] Redirecting
// save file to .../saves/Beetle PSX/<content>.srm"). EmulatorWorkerRuntime
// computes its own paths as `${SAVE_DIR}/${saveStem}.srm` /
// `${STATE_DIR}/${saveStem}.state` with no core-name segment, so every
// worker-core readSaveRam() read a path that never existed (returning null)
// and serializeState() polled for a state file the core was writing
// elsewhere, failing with "save state did not stabilize within 2s". Turning
// the sorting off puts RA's real paths back where the worker runtime looks
// (2026-07-26; found while root-causing the psx-testdisc rendering gap —
// this is why docs/PSX_TESTDISC.md recorded readSaveRam(1) === null).
// The ONE system/BIOS directory. Declared here, next to the cfg line that
// publishes it to RetroArch, and exported so nothing has to restate the literal.
//
// It used to be restated: EmulatorClient carried its own SYSTEM_DIR =
// '/home/web_user/retroarch/system' (no `userdata/`), wrote BIOS/Kickstart files
// there, and appended a SECOND `system_directory` line pointing at it. RetroArch
// keeps the FIRST occurrence of a duplicated key, so the appended line was inert
// and every file provisioned through `systemFiles` landed in a directory no core
// ever read — silently, because a core with no BIOS just falls back (PUAE boots
// its built-in AROS instead of the user's real Kickstart). Found 2026-08-15 when
// a WHDLoad game stopped with "DOS-Error #205 on reading
// devs:kickstarts/kick34005.a500": PUAE copies Kickstarts into its WHDLoad helper
// from retro_system_directory, which was the userdata path, while the ROM had
// been written to the other one. The worker runtime
// (src/runtime/EmulatorWorkerRuntime.js) had always used the userdata path, which
// is why worker-core BIOS provisioning (the PSX real-BIOS probe) worked and the
// main-thread path did not. scripts/test-retroarch-config.mjs now pins that the
// two agree and that the key is written exactly once.
export const RETROARCH_SYSTEM_DIR = '/home/web_user/retroarch/userdata/system';

const EXTRA_CONFIG = `sort_savefiles_enable = "false"
sort_savestates_enable = "false"
sort_savefiles_by_content_enable = "false"
sort_savestates_by_content_enable = "false"
rgui_show_start_screen = "false"
notification_show_remap_load = "false"
menu_mouse_enable = "true"
menu_pointer_enable = "true"
pause_nonactive = "false"
system_directory = "${RETROARCH_SYSTEM_DIR}"
savefile_directory = "/home/web_user/retroarch/userdata/saves"
savestate_directory = "/home/web_user/retroarch/userdata/states"
block_sram_overwrite = "true"
autosave_interval = "10"
core_options_path = "/home/web_user/retroarch/userdata/retroarch-core-options.cfg"
game_specific_options = "false"
global_core_options = "true"
`;

// Beetle's Lightrec dynarec is set to "disabled" (= Beetle's own CPU
// interpreter) DELIBERATELY, and this is currently the only setting real PSX
// content runs under in the shipped mednafen_psx_jit build.
//
// This used to be "execute" (Lightrec + the Wasm JIT backend that is the
// whole point of that core build — see docs/PSX_CORE_BUILD.md). Booting the
// repo's own CC0 disc (games/psx-testdisc) with any Lightrec mode enabled
// reproducibly kills the emulated machine ~2 s in, while the BIOS is copying
// the game executable out of the CD into RAM and jumping to it:
//
//   [Lightrec]: Segmentation fault in recompiled code:
//               invalid load/store at address PC 0x5ffffcfc
//   [Lightrec]: Was executing block PC 0x000036f8   (BIOS kernel RAM)
//   Segfault at cycle 0x00009023
//
// after which the core stops presenting frames entirely. Verified 2026-07-26
// against the real disc through the real worker path:
//   cpu_dynarec = "execute"                              -> segfault, dead
//   cpu_dynarec = "execute", dynarec_invalidate = "dma"   -> segfault, dead
//   cpu_dynarec = "run_interpreter" (Lightrec's own
//                 interpreter, no Wasm codegen at all)    -> segfault, dead
//   cpu_dynarec = "disabled"  (Beetle interpreter)        -> game boots and
//                                                           runs correctly
// dynarec_spgp_opt is already "disabled" by the core's own default, so the
// "sp/gp always hit RAM" hack is not what is faulting. Because Lightrec's
// plain interpreter fails identically to the recompiler, the bug is in the
// Lightrec layer's shared memory-map / block-invalidation path (the emitted
// Wasm is not implicated) — i.e. it is a bug in the core artifact, fixable
// only by rebuilding kblood/psx-wasm-jit-libretro, not from this repo.
//
// Flip these two back to "execute" to re-test once that core is rebuilt;
// nothing else here depends on the value.
//
// The renderer is forced to "software" for the same kind of reason. Beetle PSX
// HW defaults `renderer` to "hardware" (Hardware (Auto)) and defaults
// `renderer_software_fb` to "enabled" — i.e. it presents the OpenGL renderer's
// output while ALSO keeping a native-resolution software copy of VRAM in the
// background. In this project's worker/OffscreenCanvas GL context the OpenGL
// path presents only the framebuffer background fill: the screen shows one
// flat colour that tracks the running program's clear colour, and no polygons,
// sprites or text ever appear. That is exactly the symptom docs/PSX_TESTDISC.md
// recorded as "content-independent alternating colours"; the colours were the
// clear colours of whatever was running. Proof the emulation itself was fine:
// dumping GPURAM out of a save state showed the fully-rendered frames (cube,
// HUD text, both double buffers) at the same instant the canvas was flat — the
// software framebuffer had the picture, the presented GL surface did not.
// Selecting the software renderer makes the real frames reach the canvas.
// Both option prefixes are set because BEETLE_OPT() is "beetle_psx_hw_" in
// HAVE_HW builds and "beetle_psx_" otherwise; the unused one is ignored.
// Note this option is "Restart required" in the core, so it has to be in the
// core-options file before content loads (which is what this constant is for).
// dosbox_pure_voodoo_perf is the SAME class of fix as the Beetle PSX options
// above, found by reading dosbox_pure_libretro.cpp directly (2026-07-30/31).
// Its default "auto" (and "4") make retro_load_game() request an HW render
// context purely to support optional 3dfx Voodoo emulation — but once that
// context exists, DOSBox Pure's `dbp_opengl_draw` function pointer gets set
// in HWContext::Reset and from then on EVERY frame (Voodoo or not — plain
// VGA/text DOS content included) is submitted through its own internal GL
// blit-into-FBO path instead of the plain `video_cb(buf.video, ...)`
// software path. In this project's worker/OffscreenCanvas WebGL2 context
// that GL blit path produces a persistently solid-black presented frame
// (thousands of frames presented at full rate, zero core/worker errors,
// real content genuinely running underneath — confirmed via a real FreeDOS
// floppy mounting and DOSBox's own program dispatcher selecting it) even
// though DOSBox's software framebuffer (`buf.video`) itself is fine. Setting
// voodoo_perf to any non-auto/non-"4" value (e.g. "1" = Software Multi
// Threaded) skips HW render negotiation in retro_load_game() entirely, so
// dbp_opengl_draw never gets set and every frame takes the working
// video_cb(buf.video, ...) path — at the cost of 3dfx Voodoo emulation
// running in software instead of via host OpenGL, which nothing in this
// project currently depends on. Also a "Restart required" option per the
// core, so (like the Beetle options) it must be in the core-options file
// before content loads.
export const RETROARCH_CORE_OPTIONS = `beetle_psx_cpu_dynarec = "disabled"
beetle_psx_hw_cpu_dynarec = "disabled"
beetle_psx_renderer = "software"
beetle_psx_hw_renderer = "software"
dosbox_pure_voodoo_perf = "1"
`;

// Players 2-4 keyboard binds, generated from the same table GameInputMgr
// dispatches ([[src/ControllerMaps.js]]) so cfg and synthesized events can
// never drift. RetroArch ships no stock keyboard defaults for these players,
// so these binds are the only thing that makes ports 2-4 do anything. All
// players' keyboard binds are polled simultaneously regardless of device
// assignment, so a key bound to input_player3_a drives P3's A directly.
function playerKeybinds() {
  let out = '';
  for (const p of [2, 3, 4]) {
    const map = EXTRA_PLAYER_KEYS[p];
    for (const [btn, code] of Object.entries(map)) {
      const name = RA_KEY_NAME[code];
      out += `input_player${p}_${btn.toLowerCase()} = "${name}"\n`;
    }
  }
  return out;
}
export const PLAYER_KEYBINDS = playerKeybinds();

export const RETROARCH_CFG = NUL_KEYS + DEFAULT_KEYBINDS + PLAYER_KEYBINDS + EXTRA_CONFIG;
export const RETROARCH_CFG_DIR = '/home/web_user/retroarch/userdata';
export const RETROARCH_CFG_PATH = RETROARCH_CFG_DIR + '/retroarch.cfg';
// Legacy single-file libretro core options. We point RA at this explicitly
// (core_options_path) and write `<key> = "<value>"` lines into it for cores
// that need a non-default option — e.g. PUAE's `puae_kickstart = "aros"`, which
// selects the built-in AROS Kickstart so the Amiga boots with no proprietary BIOS.
export const RETROARCH_CORE_OPTIONS_PATH = RETROARCH_CFG_DIR + '/retroarch-core-options.cfg';

// Per-core input remap directory. RetroArch reads a controller-port device
// override (input_libretro_device_pN) from a core-specific remap file at
// <remap_dir>/<LibraryName>/<LibraryName>.rmp — and, critically, HONOURS it at
// boot when the main cfg's input_libretro_device_pN is ignored (verified during
// the light-gun bring-up; see docs/LIGHTGUN_SUPPORT.md). This is how a light gun
// gets its console to connect the Zapper / Super Scope / Light Phaser on a port.
// Worker-executed cores (PSX, N64) never had this plumbing before.
//
// Both execution backends used to declare their own copy of this path
// (EmulatorClient.js's REMAP_DIR and EmulatorWorkerRuntime.js's own literal); it
// lives here now for the same reason RETROARCH_SYSTEM_DIR does — one definition,
// so the two can no longer drift.
export const RETROARCH_REMAP_DIR = RETROARCH_CFG_DIR + '/config/remaps';

// libretro device-id classification. A device id carries its base class in the
// low byte plus an optional subclass above it, so the base class is what says
// "this port is a gun / a mouse".
const RETRO_DEVICE_MASK = 0xff, RETRO_DEVICE_MOUSE = 2, RETRO_DEVICE_LIGHTGUN = 4, RETRO_DEVICE_POINTER = 6;

// ⚠ THE BUILDER DOES NOT NORMALIZE `{}`. Both pre-extraction functions tested
// their maps with PLAIN TRUTHINESS (`if (this._coreOptions)`, `if
// (payload.inputDevices)`), and `{}` is truthy — so this builder does the same,
// verbatim. Whether an empty map means "nothing requested" is the CALLER's
// question, and at HEAD (c48db3d) the two backends answered it differently:
//
//   • EmulatorClient normalizes in start() (`normalizeBootMap`, still there),
//     so `{}` is already null by the time _writeRetroArchConfig runs. An empty
//     map emits nothing on the main thread.
//   • EmulatorWorkerRuntime forwards the raw start payload, so `{}` emits: the
//     two remap-header lines with no device line under them, the "inputDevices
//     set without remapName" log, and a bare newline on the core-options file.
//
// That difference is REAL and reached in production — systems.js hands out
// `coreOptions: tg.coreOptions || {}` and SYSTEMS.ps2.lightgun literally
// carries `coreOptions: {}` — and PSX / PS2 / N64 / Amiga guns and mice all run
// on the worker backend. An earlier draft of this extraction collapsed `{}`
// here, for both backends at once; that quietly changed the worker's emitted
// bytes and dropped a diagnostic log on the one code path this project keeps
// re-fixing, so it was reverted. If the worker's empty-map output should
// change, change it in the worker (or in the payload it is handed) as its own
// named fix — not as a side effect of two callers sharing a text assembler.
// scripts/test-retroarch-config.mjs pins BOTH answers, per backend, and treats
// `{}` and undefined as distinct inputs.

/**
 * Assemble everything a libretro launch needs written into the core's
 * filesystem — the retroarch.cfg body, the per-core .rmp remap, and the
 * core-options file — as PURE TEXT. No filesystem, no Emscripten Module, no
 * DOM: importable under plain node, which is what lets
 * scripts/test-retroarch-config.mjs golden-test the exact bytes.
 *
 * WHY THIS IS SHARED (CODEX ARC-2 (b)). This assembly used to exist twice, hand
 * copied line for line: src/EmulatorClient.js's `_writeRetroArchConfig` for
 * main-thread cores and src/runtime/EmulatorWorkerRuntime.js's `writeConfig` for
 * worker-execution cores (PSX, N64, DOS). Light-gun and mouse port binding is
 * the single area this project keeps re-fixing (the gun/mouse arming leak, the
 * Amiga beam fix, the GunCon2 port+1 key), and a fix applied to one copy left
 * every core on the other backend on the old binding — invisibly, because
 * nothing tested either backend's emitted text. The two callers keep only the
 * part that legitimately differs: writing these strings through their own FS
 * API (Emscripten `FS` on the main thread, the worker's own mount).
 *
 * @param {object}  opts
 * @param {object|null} opts.inputDevices  { player: libretroDeviceId }, player
 *        1-based (systems.js builds it as `gun.port + 1` — the GunCon2 "port+1"
 *        key). null/undefined mean "no port overrides"; `{}` does NOT — it is a
 *        present-but-empty map and emits the remap header plus `warning`, which
 *        is what the worker backend has always done. See the note above.
 * @param {string|null} opts.remapName     the core's RA library_name, which names
 *        the remap dir AND the .rmp inside it. Without it a port override cannot
 *        connect at boot, hence `warning` below.
 * @param {string|null} opts.libraryName   alias for remapName — the .rmp is named
 *        after the core's library_name and some callers know it by that name.
 *        `remapName` wins when both are given. Nothing in the app passes it today.
 * @param {object|null} opts.coreOptions   per-launch `<key> = "<value>"` core
 *        options, appended after `coreOptionsBaseline`. `{}` is present-but-
 *        empty and appends a bare newline, as both HEAD backends did with a
 *        truthy empty map; null/undefined append nothing.
 * @param {Array|null}  opts.systemFiles   BIOS/firmware descriptors. They do NOT
 *        appear in any emitted text — the cfg's `system_directory` is already in
 *        RETROARCH_CFG — so this is passed straight back next to `systemDir` for
 *        whichever FS writer provisions them.
 * @param {string}  opts.coreOptionsBaseline  text prepended to the core-options
 *        body. The worker runtime passes RETROARCH_CORE_OPTIONS (the PSX/DOS
 *        settings that must be in the file before content loads); the main-thread
 *        path passes nothing, which is what it has always written.
 * @param {boolean} opts.emitCoreOptionsPathLine  append a `core_options_path`
 *        line to the cfg when there are core options. Only the main-thread path
 *        has ever done this, and the line it appends is byte-identical to the one
 *        EXTRA_CONFIG already carries — RetroArch keeps the FIRST occurrence of a
 *        duplicated key, so it is inert. Kept verbatim rather than quietly
 *        dropped: this refactor changes no emitted byte it does not have to.
 * @returns {{cfgText:string, cfgPaths:Array<Array<string>>, rmpText:string|null,
 *            rmpPath:string|null, rmpDir:string|null, coreOptionsText:string|null,
 *            coreOptionsPath:string, systemDir:string, systemFiles:Array|null,
 *            warning:string|null}}
 */
export function buildRetroArchLaunchConfig({
  inputDevices = null,
  remapName = null,
  libraryName = null,
  coreOptions = null,
  systemFiles = null,
  coreOptionsBaseline = '',
  emitCoreOptionsPathLine = false,
} = {}) {
  // Plain truthiness, exactly as both HEAD functions had it — see the
  // "DOES NOT NORMALIZE `{}`" note above: `{}` is a PRESENT map here, and it is
  // each caller's job (not this builder's) to collapse it first if that is the
  // behaviour that backend shipped.
  const devices = inputDevices || null;
  const options = coreOptions || null;
  const remap = remapName || libraryName || null;

  // When the core needs non-default options, point RA at an explicit
  // single-file core-options path and write the requested key/values there.
  let coreOptionsText = coreOptionsBaseline || '';
  if (options) {
    coreOptionsText += Object.entries(options)
      .map(([k, v]) => `${k} = "${v}"`).join('\n') + '\n';
  }
  if (!coreOptionsText) coreOptionsText = null;

  // NOTE: no `system_directory` line here. RETROARCH_CFG already carries it,
  // and RetroArch keeps the FIRST occurrence of a duplicated key — an appended
  // second one is inert, which is exactly how BIOS provisioning was silently
  // broken until 2026-08-15 (see RETROARCH_SYSTEM_DIR's comment).
  let cfg = RETROARCH_CFG;
  if (options && emitCoreOptionsPathLine) {
    cfg += `core_options_path = "${RETROARCH_CORE_OPTIONS_PATH}"\n`;
  }

  let rmpText = null, rmpPath = null, rmpDir = null, warning = null;
  if (devices) {
    // Port device overrides + light-gun input wiring. RetroArch's libretro
    // lightgun reads its absolute aim from the MOUSE pointer (rwebinput maps
    // the canvas-relative cursor to gun X/Y — the rwebinput patch in
    // docs/patches/) and its buttons from mouse buttons, so for any gun port we
    // bind trigger→LMB and the off-screen/reload shot→RMB. sendLightgun() emits
    // those synthetic mouse events. A "gun" port is one whose device base class
    // is LIGHTGUN (4) — or POINTER (6), which covers nestopia's Zapper (id 262 =
    // SUBCLASS(POINTER,0)) that is nonetheless read via the LIGHTGUN path.
    const validPorts = Object.entries(devices)
      .filter(([player]) => Number.isInteger(Number(player)) && Number(player) >= 1);
    // Main cfg: enable the per-core remap dir (so the .rmp below is honoured at
    // boot) + the device line (belt-and-suspenders; ignored at boot but correct
    // for any runtime re-read) + the gun mouse-button binds.
    cfg += `input_remap_binds_enable = "true"\n`;
    cfg += `input_remapping_directory = "${RETROARCH_REMAP_DIR}"\n`;
    for (const [player, dev] of validPorts) {
      const p = Number(player);
      cfg += `input_libretro_device_p${p} = "${dev}"\n`;
      const base = Number(dev) & RETRO_DEVICE_MASK;
      if (base === RETRO_DEVICE_LIGHTGUN || base === RETRO_DEVICE_POINTER) {
        cfg += `input_player${p}_mouse_index = "0"\n`;
        cfg += `input_player${p}_gun_trigger_mbtn = "1"\n`;
        cfg += `input_player${p}_gun_offscreen_shot_mbtn = "2"\n`;
      } else if (base === RETRO_DEVICE_MOUSE) {
        // A MOUSE port reads its motion + buttons from a physical mouse index.
        // In a web build there is only one (index 0); sendMouse() feeds the
        // canvas-targeted DOM mouse events (movementX/Y + L/R buttons) the core
        // integrates. Two mice on one console reading distinct pointers needs a
        // multiport rwebinput patch (see sendMouse / docs/MOUSE_SUPPORT.md).
        cfg += `input_player${p}_mouse_index = "0"\n`;
      }
    }
    // The per-core remap FILE is what actually connects the device at boot.
    // <REMAP_DIR>/<LibraryName>/<LibraryName>.rmp with input_libretro_device_pN.
    if (remap && validPorts.length) {
      rmpText = validPorts.map(([p, dev]) => `input_libretro_device_p${Number(p)} = "${dev}"`).join('\n') + '\n';
      rmpDir = `${RETROARCH_REMAP_DIR}/${remap}`;
      rmpPath = `${rmpDir}/${remap}.rmp`;
    } else {
      // Returned, not logged: this module has no logger, and the two backends
      // report it differently (console.warn vs a posted 'log' event), so each
      // caller prefixes its own tag. Reachable with a non-empty device map and
      // no remapName, or with device keys that are all invalid (player < 1).
      warning = 'inputDevices set without remapName — port device will not connect at boot';
    }
  }

  return {
    cfgText: cfg,
    // Write the cfg to every path RA might consult: the webretro
    // userdata path (explicit -c target), and the three default paths
    // RA searches ($HOME/.config/retroarch/, $HOME/.retroarch.cfg, and
    // $XDG_CONFIG_HOME/retroarch/). $HOME is /home/web_user in
    // emscripten. We don't know which one this RA build will actually
    // honour, so we cover all of them.
    cfgPaths: [
      [RETROARCH_CFG_DIR, RETROARCH_CFG_PATH],
      ['/home/web_user/.config/retroarch', '/home/web_user/.config/retroarch/retroarch.cfg'],
      ['/home/web_user',                   '/home/web_user/.retroarch.cfg'],
    ],
    rmpText,
    rmpPath,
    rmpDir,
    coreOptionsText,
    coreOptionsPath: RETROARCH_CORE_OPTIONS_PATH,
    systemDir: RETROARCH_SYSTEM_DIR,
    systemFiles: (Array.isArray(systemFiles) && systemFiles.length) ? systemFiles : null,
    warning,
  };
}
