// LWX N64 Smoke Test — minimal CC0 libdragon homebrew used to boot-verify the
// mupen64plus_next core through this repo's worker execution runtime. Fills
// the screen with a shifting solid color so a headless probe can assert
// non-blank rendered frames.
//
// Drawn via the legacy RDP command interface (rdp.h - this pinned libdragon
// build predates the modern rdpq API), not libdragon's CPU-side graphics.h
// framebuffer writes: GLideN64 (this core's GPU plugin) is a pure RSP/RDP
// command-list translator - it has no visibility into pixels written
// directly to RDRAM by the CPU, only into real RDP draw commands. A
// CPU-drawn frame boots and "presents" without error but renders fully
// black on this core, since GLideN64's HW-render FBO never receives any
// draw commands to translate.

#include <libdragon.h>

int main(void) {
    init_interrupts();
    display_init(RESOLUTION_320x240, DEPTH_16_BPP, 2, GAMMA_NONE, ANTIALIAS_RESAMPLE);
    rdp_init();

    uint32_t frame = 0;
    while (1) {
        display_context_t disp = display_lock();
        if (!disp) continue;

        rdp_attach_display(disp);
        rdp_set_default_clipping();
        rdp_enable_primitive_fill();
        rdp_set_primitive_color(graphics_make_color(
            (frame * 3) & 0xFF,
            (frame * 5) & 0xFF,
            (frame * 7) & 0xFF,
            0xFF));
        rdp_draw_filled_rectangle(0, 0, 320, 240);
        rdp_detach_display();

        display_show(disp);
        frame++;
    }
}
