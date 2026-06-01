/*---------------------------------------------------------------------------------

    LWX SNES Demo - a tiny CC0 "move the sprite" demo for LibretroWebXR.

    A single player sprite sits on a tiled/colored background. The D-pad moves
    the sprite around the screen (clamped to the visible area); A and B cycle the
    background backdrop colour. Built with PVSnesLib (MIT) - only this game-logic
    file is authored by us; all SNES boot/init boilerplate lives in the SDK
    library and the frozen hdr.asm / data.asm template files.

    Game logic: CC0 (public domain), LibretroWebXR.
    SDK + bundled font/sprite art: PVSnesLib examples (MIT, alekmaul) - see README.

---------------------------------------------------------------------------------*/
#include <snes.h>

// Font (used as the background tile set + on-screen text), from PVSnesLib.
extern char tilfont, palfont;

// Player sprite graphics + palette (converted from sprites.bmp by gfx4snes).
#include "sprites.inc"

unsigned short pad0;

// Player sprite position (top-left of the 16x16 sprite, in pixels).
short px = 120;
short py = 104;

// Screen bounds for a 16x16 sprite on a 256x224 display.
#define X_MIN 0
#define X_MAX (256 - 16)
#define Y_MIN 0
#define Y_MAX (224 - 16)
#define SPEED 2

// A small palette of pleasant backdrop colours to cycle through.
#define NUM_BG 6
const unsigned short bgColors[NUM_BG] = {
    RGB5(3, 6, 12),   // deep blue
    RGB5(4, 12, 4),   // forest green
    RGB5(14, 6, 4),   // warm red
    RGB5(14, 12, 3),  // gold
    RGB5(10, 4, 14),  // purple
    RGB5(2, 2, 2),    // near black
};
unsigned char bgIndex = 0;

//---------------------------------------------------------------------------------
static void drawTiledBackground(void)
{
    unsigned char x, y;
    // Fill the visible text layer with a simple repeating pattern so the
    // background reads as "tiled" rather than empty. Using the bundled font as
    // the tile set keeps the demo self-contained (no custom map asset needed).
    for (y = 0; y < 28; y++)
    {
        for (x = 0; x < 32; x++)
        {
            // Checkerboard of '.' and ' ' gives a subtle tiled texture.
            if (((x ^ y) & 1) == 0)
                consoleDrawText(x, y, ".");
        }
    }
}

//---------------------------------------------------------------------------------
int main(void)
{
    // Initialize text console with the bundled font. The console renders on a
    // background layer, which doubles as our tiled backdrop.
    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0100);
    consoleInitText(0, 16 * 2, &tilfont, &palfont);

    // Init background layer 0 for the font/console.
    bgSetGfxPtr(0, 0x2000);
    bgSetMapPtr(0, 0x6800, SC_32x32);

    // Init the player sprite graphics + palette (16x16 sprites).
    oamInitGfxSet(&sprites_til, (&sprites_tilend - &sprites_til),
                  &sprites_pal, (&sprites_palend - &sprites_pal),
                  0, 0x0000, OBJ_SIZE16_L32);

    // Mode 1: 16-colour backgrounds + sprites. Disable unused BG layers.
    setMode(BG_MODE1, 0);
    bgSetDisable(1);
    bgSetDisable(2);

    // Paint the tiled background and a little HUD.
    drawTiledBackground();
    consoleDrawText(7, 1, "LWX SNES DEMO");
    consoleDrawText(3, 26, "D-PAD MOVE   A/B COLOR");

    // Place the player sprite and show it.
    oamSet(0, px, py, 3, 0, 0, 0, 0);
    oamSetEx(0, OBJ_SMALL, OBJ_SHOW);

    // Set the initial backdrop colour (palette entry 0 = backdrop).
    setPaletteColor(0, bgColors[bgIndex]);

    setScreenOn();

    while (1)
    {
        pad0 = padsCurrent(0);

        // Move the sprite with the D-pad, clamped to the screen.
        if (pad0 & KEY_LEFT)
        {
            px -= SPEED;
            if (px < X_MIN) px = X_MIN;
        }
        if (pad0 & KEY_RIGHT)
        {
            px += SPEED;
            if (px > X_MAX) px = X_MAX;
        }
        if (pad0 & KEY_UP)
        {
            py -= SPEED;
            if (py < Y_MIN) py = Y_MIN;
        }
        if (pad0 & KEY_DOWN)
        {
            py += SPEED;
            if (py > Y_MAX) py = Y_MAX;
        }

        // A / B cycle the backdrop colour (edge-triggered via padsDown).
        if (padsDown(0) & KEY_A)
        {
            bgIndex = (bgIndex + 1) % NUM_BG;
            setPaletteColor(0, bgColors[bgIndex]);
        }
        if (padsDown(0) & KEY_B)
        {
            bgIndex = (bgIndex + NUM_BG - 1) % NUM_BG;
            setPaletteColor(0, bgColors[bgIndex]);
        }

        oamSetXY(0, px, py);

        WaitForVBlank();
    }
    return 0;
}
