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
const EXTRA_CONFIG = `sort_savefiles_enable = "false"
sort_savestates_enable = "false"
sort_savefiles_by_content_enable = "false"
sort_savestates_by_content_enable = "false"
rgui_show_start_screen = "false"
notification_show_remap_load = "false"
menu_mouse_enable = "true"
menu_pointer_enable = "true"
pause_nonactive = "false"
system_directory = "/home/web_user/retroarch/userdata/system"
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
export const RETROARCH_CORE_OPTIONS_PATH = RETROARCH_CFG_DIR + '/retroarch-core-options.cfg';
