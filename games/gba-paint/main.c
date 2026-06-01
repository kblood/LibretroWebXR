// LWX Paint (GBA) -- a tiny CC0 Mode 3 paint toy for LibretroWebXR test content.
//
// This file is the ONLY part we author; it is released into the public domain
// under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/).
//
// GBA Mode 3 is a plain 240x160 linear framebuffer of 16-bit BGR555 pixels at
// VRAM (0x06000000), exposed by libtonc as m3_mem / vid_mem and the m3_* helpers.
// No tiles, palettes, OAM or DMA -- we just plot pixels. (See
// docs/research/gba-game-creation.md.)
//
// Controls (RetroPad -> GBA):
//   D-pad      move the cursor
//   A          paint (drop the current colour, leaving a trail)
//   B          erase (paint black)
//   L / R      previous / next colour from the palette
//   START      clear the whole canvas to black
//   SELECT     toggle a thicker brush (1px <-> 3x3)
//
// Built with devkitARM + libtonc; see scripts/make-gba-paint.mjs.

#include <tonc.h>

#define SCRW    240
#define SCRH    160

// libtonc's RGB15() is an inline function, so it can't initialise a static
// array. Use a constant-expression macro for the compile-time palette literals.
#define CRGB15(r, g, b) ((COLOR)((r) | ((g) << 5) | ((b) << 10)))

// A small fixed palette the player cycles through (BGR555).
static const COLOR g_palette[] = {
    CRGB15(31,  0,  0),  // red
    CRGB15(31, 20,  0),  // orange
    CRGB15(31, 31,  0),  // yellow
    CRGB15( 0, 31,  0),  // green
    CRGB15( 0, 24, 31),  // cyan
    CRGB15( 0,  0, 31),  // blue
    CRGB15(24,  0, 31),  // violet
    CRGB15(31, 31, 31),  // white
};
#define NCOLORS (int)(sizeof(g_palette) / sizeof(g_palette[0]))

// Draw a small swatch strip along the top so the chosen colour is always visible.
static void draw_palette_bar(int sel)
{
    const int sw = 12;     // swatch width
    const int sh = 8;      // swatch height
    for (int i = 0; i < NCOLORS; i++) {
        int x0 = 4 + i * (sw + 2);
        m3_rect(x0, 2, x0 + sw, 2 + sh, g_palette[i]);
        // outline the selected swatch in white
        COLOR edge = (i == sel) ? CLR_WHITE : RGB15(8, 8, 8);
        m3_rect(x0 - 1,      1,      x0 + sw + 1, 2,           edge); // top
        m3_rect(x0 - 1,      2 + sh, x0 + sw + 1, 3 + sh,      edge); // bottom
        m3_rect(x0 - 1,      1,      x0,          3 + sh,      edge); // left
        m3_rect(x0 + sw,     1,      x0 + sw + 1, 3 + sh,      edge); // right
    }
}

static inline void plot_clamped(int x, int y, COLOR c)
{
    if (x >= 0 && x < SCRW && y >= 0 && y < SCRH)
        m3_plot(x, y, c);
}

static void paint_brush(int x, int y, COLOR c, int big)
{
    if (!big) {
        plot_clamped(x, y, c);
        return;
    }
    for (int dy = -1; dy <= 1; dy++)
        for (int dx = -1; dx <= 1; dx++)
            plot_clamped(x + dx, y + dy, c);
}

// Draw the cursor as a hollow box so it never permanently destroys art.
static void draw_cursor(int x, int y, COLOR c)
{
    plot_clamped(x - 2, y,     c);
    plot_clamped(x + 2, y,     c);
    plot_clamped(x,     y - 2, c);
    plot_clamped(x,     y + 2, c);
}

int main(void)
{
    REG_DISPCNT = DCNT_MODE3 | DCNT_BG2;

    int x = SCRW / 2, y = SCRH / 2;
    int sel = 7;        // start on white
    int big = 0;        // brush size toggle
    int prev_x = x, prev_y = y;

    m3_fill(CLR_BLACK);
    draw_palette_bar(sel);

    while (1) {
        vid_vsync();
        key_poll();

        // Erase the previous cursor by repainting black where it was (the
        // palette bar is redrawn each frame anyway, so the top strip is safe).
        draw_cursor(prev_x, prev_y, CLR_BLACK);

        // Movement (tonc tribool: +1 right/down, -1 left/up).
        x += key_tri_horz();
        y += key_tri_vert();
        // Keep the cursor below the palette bar and on-screen.
        x = clamp(x, 2, SCRW - 3);
        y = clamp(y, 14, SCRH - 3);

        // Colour selection on shoulder-button press.
        if (key_hit(KEY_R)) sel = (sel + 1) % NCOLORS;
        if (key_hit(KEY_L)) sel = (sel + NCOLORS - 1) % NCOLORS;

        // Brush-size toggle.
        if (key_hit(KEY_SELECT)) big = !big;

        // Clear the canvas.
        if (key_hit(KEY_START)) {
            m3_fill(CLR_BLACK);
        }

        // Paint / erase while held.
        if (key_is_down(KEY_A)) paint_brush(x, y, g_palette[sel], big);
        if (key_is_down(KEY_B)) paint_brush(x, y, CLR_BLACK,      big);

        // Redraw HUD + cursor on top.
        draw_palette_bar(sel);
        draw_cursor(x, y, g_palette[sel]);

        prev_x = x;
        prev_y = y;
    }
    return 0;
}
