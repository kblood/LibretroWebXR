/*---------------------------------------------------------------------------------

    LWX Scope Range - a CC0 SNES Super Scope shooting gallery for LibretroWebXR.

    A position-based light-gun game (the companion to the NES Zapper "LWX Zap
    Gallery"): a bullseye target pops up at random spots on the field. Aim the
    Super Scope and pull the trigger - if the muzzle is over the target it's a
    HIT (+1 and a faster next target); fire on empty field, or let the per-target
    timer run out, and it's a MISS. Three misses ends the game.

    Why the Super Scope (and not the NES Zapper) for a clean position game: the
    snes9x core hands the ROM a STABLE latched coordinate. When the trigger is
    held the core latches the PPU H/V beam counters to the aimed pixel, so reading
    OPHCT/OPVCT ($213C/$213D) returns (screenX + 40, screenY + 1) on ANY frame -
    no whole-visible-frame photodiode polling like the Zapper needs. PVSnesLib
    wraps all of that: detectSuperScope(), the scope_* state, and scope_shoth /
    scope_shotv (the aimed position). A one-shot "shoot the centre" calibration
    sets scope_centerh/v so scope_shoth/v come out in screen pixels (it also
    cancels the core's +40 H offset) - exactly what a real Super Scope game does.

    Built with PVSnesLib (MIT) - only this game-logic file is authored by us; the
    SNES boot/init boilerplate lives in the SDK and the frozen hdr.asm / data.asm.
    The bundled console font is PVSnesLib's MIT example art (see README); the
    target/cursor sprite sheet is generated CC0 by scripts/make-snes-scope.mjs.

    Game logic + sprite art: CC0 (public domain), LibretroWebXR.

---------------------------------------------------------------------------------*/
#include <snes.h>

// Console font (background tile set + on-screen text), from PVSnesLib.
extern char tilfont, palfont;

// PVSnesLib's rand() seed words (library globals; no public srand() is exposed).
extern unsigned short snes_rand_seed1;
extern unsigned short snes_rand_seed2;

// Target/cursor sprite graphics + palette (gfx4snes from sprites.bmp).
//   sprite tile 0 = bullseye target (16x16)
//   sprite tile 1 = aim dot / cursor (16x16)
#include "sprites.inc"

// --- screen geometry (256x224, sprite is 16x16) ------------------------------
#define SCR_W      256
#define SCR_H      224
#define SPR        16
#define CENTER_X   0x80          // 128 - screen centre (calibration reference)
#define CENTER_Y   0x70          // 112 - screen centre

// --- game tuning (mirrors the NES gallery so the pair feel like siblings) -----
#define MAX_MISS    3
#define START_TIME  150          // frames a target stays before timing out (~2.5s)
#define MIN_TIME    54           // fastest target lifetime as you score
#define TIME_STEP   4            // shave this many frames off per hit
#define HIT_PAD     4            // grow the 16x16 hit box by this many px each side

// state machine
#define ST_CAL   0               // "shoot the centre dot" - calibrates + starts
#define ST_PLAY  1
#define ST_OVER  2

unsigned char state;
short  tx, ty;                   // target top-left (pixels)
unsigned char misses;
unsigned short score;
short  t_timer;                  // frames until the current target times out
short  cur_time;                 // current target lifetime (shrinks as you score)
unsigned short frame;            // free-running, seeds the RNG on the first shot
unsigned char enable_fire;       // debounce: require trigger release between shots
short  sx, sy;                   // last shot position (screen px, post-calibration)
unsigned char flash_timer;       // frames left of the hit/miss backdrop flash
unsigned char flash_kind;        // 0 none, 1 hit (green), 2 miss (red)

#define FLASH_FRAMES 18
#define COL_FIELD  RGB5(1, 1, 3)     // near-black play field
#define COL_HIT    RGB5(2, 26, 6)    // green hit flash
#define COL_MISS   RGB5(26, 3, 3)    // red miss flash

// Forward decls.
void enter_cal(void);
void enter_play(void);
void enter_over(void);

// 4-digit number to BG text at (x,y). consoleDrawText writes a NUL-terminated str.
char numbuf[6];
void draw_num(unsigned char x, unsigned char y, unsigned short v) {
    numbuf[0] = '0' + (v / 1000) % 10;
    numbuf[1] = '0' + (v / 100) % 10;
    numbuf[2] = '0' + (v / 10) % 10;
    numbuf[3] = '0' + v % 10;
    numbuf[4] = 0;
    consoleDrawText(x, y, numbuf);
}

// Refresh the HUD score + miss readouts.
void draw_hud(void) {
    consoleDrawText(2, 1, "SCORE");
    draw_num(8, 1, score);
    consoleDrawText(23, 1, "MISS");
    draw_num(28, 1, misses);
}

// Move the target to a fresh random spot, clear of the HUD row.
void relocate(void) {
    tx = 16 + (rand() % (SCR_W - 16 - 32));    // 16 .. 207
    ty = 40 + (rand() % (SCR_H - 40 - 24));    // 40 .. 175 (below HUD)
    oamSet(0, tx, ty, 0, 0, 0, 0, 0);          // sprite 0, tile 0 = bullseye
    oamSetEx(0, OBJ_SMALL, OBJ_SHOW);
}

// Hide every hardware sprite (call once at boot so unused OAM shows nothing).
void hide_all_sprites(void) {
    unsigned char i;
    for (i = 0; i < 128; i++) oamSetVisible(i << 2, OBJ_HIDE);
}

void clear_field_text(void) {
    consoleDrawText(2,  1, "                              ");
    consoleDrawText(4,  3, "                          ");
    consoleDrawText(4,  8, "                        ");
    consoleDrawText(4, 10, "                        ");
    consoleDrawText(4, 12, "                        ");
    consoleDrawText(4, 13, "                        ");
}

void enter_cal(void) {
    clear_field_text();
    oamSetVisible(0, OBJ_HIDE);          // hide target
    // Aim dot at screen centre (sprite tile 1), the calibration reference.
    oamSet(4, CENTER_X - 8, CENTER_Y - 8, 1, 0, 0, 0, 0);
    oamSetEx(4, OBJ_SMALL, OBJ_SHOW);
    consoleDrawText(8,  3, "LWX SCOPE RANGE");
    consoleDrawText(5, 12, "SHOOT THE CENTRE DOT");
    consoleDrawText(7, 13, "TO CALIBRATE + START");
    enable_fire = 0;
    state = ST_CAL;
}

void enter_play(void) {
    clear_field_text();
    oamSetVisible(4, OBJ_HIDE);          // hide the calibration dot
    score = 0;
    misses = 0;
    cur_time = START_TIME;
    draw_hud();
    snes_rand_seed1 = frame ? frame : 1; // entropy from how long the title was up
    snes_rand_seed2 = frame ^ 0x5a5a;
    relocate();
    t_timer = cur_time;
    enable_fire = 0;
    state = ST_PLAY;
}

void enter_over(void) {
    oamSetVisible(0, OBJ_HIDE);          // hide target
    consoleDrawText(11,  8, "GAME OVER");
    consoleDrawText(10, 10, "SCORE");
    draw_num(16, 10, score);
    consoleDrawText(8, 13, "SHOOT TO PLAY AGAIN");
    enable_fire = 0;
    state = ST_OVER;
}

void do_hit(void) {
    if (score < 9999) ++score;
    if (cur_time > MIN_TIME) cur_time -= TIME_STEP;
    flash_timer = FLASH_FRAMES; flash_kind = 1;   // green flash
    relocate();
    t_timer = cur_time;
    draw_hud();
}

void do_miss(void) {
    ++misses;
    flash_timer = FLASH_FRAMES; flash_kind = 2;    // red flash
    relocate();
    t_timer = cur_time;
    draw_hud();
    if (misses >= MAX_MISS) enter_over();
}

// Is the last shot (sx,sy) inside the current target box (with some padding)?
unsigned char on_target(void) {
    return (sx >= tx - HIT_PAD) && (sx < tx + SPR + HIT_PAD) &&
           (sy >= ty - HIT_PAD) && (sy < ty + SPR + HIT_PAD);
}

int main(void) {
    // Text console on BG layer 1 (doubles as the dark backdrop). Font tiles in
    // VRAM, map at 0x6800 - same layout the SNES demo uses.
    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0100);
    consoleInitText(0, 16 * 2, &tilfont, &palfont);

    bgSetGfxPtr(0, 0x2000);
    bgSetMapPtr(0, 0x6800, SC_32x32);

    // Target/cursor sprites (16x16).
    oamInitGfxSet(&sprites_til, (&sprites_tilend - &sprites_til),
                  &sprites_pal, (&sprites_palend - &sprites_pal),
                  0, 0x0000, OBJ_SIZE16_L32);
    hide_all_sprites();

    setMode(BG_MODE1, 0);
    bgSetDisable(1);
    bgSetDisable(2);

    setPaletteColor(0, RGB5(1, 1, 3));   // near-black field backdrop

    detectSuperScope();                  // sets snes_sscope when a scope is on port 2
    scope_holddelay = 30;
    scope_repdelay  = 12;

    frame = 0;
    enter_cal();
    setScreenOn();

    while (1) {
        ++frame;

        // Keep the scope alive across (dis)connects; harmless if already on.
        if (!snes_sscope) detectSuperScope();

        // Backdrop hit/miss flash (green/red), decaying back to the field colour.
        if (flash_timer) {
            setPaletteColor(0, flash_kind == 1 ? COL_HIT : COL_MISS);
            if (--flash_timer == 0) setPaletteColor(0, COL_FIELD);
        }

        // Require the trigger to be released before another shot counts (so a
        // held trigger fires once, not every frame).
        if ((scope_down & SSC_FIRE) == 0) enable_fire = 1;

        if (state == ST_PLAY) {
            if (enable_fire && (scope_down & SSC_FIRE)) {
                // A shot: latch the aimed position (screen px after calibration).
                sx = (short)scope_shoth;
                sy = (short)scope_shotv;
                enable_fire = 0;
                if (on_target()) do_hit(); else do_miss();
            } else if (t_timer > 0) {
                if (--t_timer == 0) do_miss();
            }
        } else {
            // ST_CAL / ST_OVER: a trigger pull (re)calibrates + starts.
            if (enable_fire && (scope_down & SSC_FIRE)) {
                // Calibrate so the spot the player shot maps to screen centre;
                // this also removes the core's fixed +40 H aim offset.
                scope_centerh = CENTER_X - scope_shothraw;
                scope_centerv = CENTER_Y - scope_shotvraw;
                enable_fire = 0;
                enter_play();
            }
        }

        WaitForVBlank();
    }
    return 0;
}
