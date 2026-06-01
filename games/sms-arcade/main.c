/* LWX Catch - a tiny one-screen arcade game for the Sega Master System and
 * Game Gear, written for LibretroWebXR test content.
 *
 * Move the basket left/right (D-pad) to catch fruit falling from the top.
 * Each catch scores a point and the next fruit falls faster; a miss costs a
 * life. Three misses ends the round - press button 1 / Start to play again.
 *
 * This file is ORIGINAL and released into the public domain under CC0 1.0.
 * It is built with devkitSMS (SMSlib, public domain / Unlicense) + SDCC.
 * Only this game logic is "ours"; the crt0 startup, SMSlib runtime and the
 * ROM header/checksum tooling are the frozen, known-good devkitSMS templates.
 *
 * One source -> two ROMs: compiled plain it targets the SMS; compiled with
 * -DTARGET_GG and linked against SMSlib_GG.lib it targets the Game Gear. All
 * gameplay is kept inside the central 160x144 region so it is fully visible on
 * the smaller Game Gear screen as well as the full SMS screen.
 */

#include "SMSlib.h"

/* ----- play field, expressed in 8x8 tiles --------------------------------
 * The GG only shows the central 20x18 tiles of the SMS 32x24 tilemap, so the
 * playfield is centred: columns FIELD_L..FIELD_R, rows FIELD_T..FIELD_B all
 * sit inside the GG window.
 */
#define FIELD_L   7        /* left wall column   */
#define FIELD_R   24       /* right wall column  */
#define FIELD_T   6        /* top row (fruit spawns here)   */
#define FIELD_B   19       /* basket row (bottom of field)  */
#define HUD_ROW   3        /* score/lives row (inside GG window) */

/* ----- tile indices ------------------------------------------------------
 * The auto text renderer loads its font into tiles 0..95 and sets up the
 * palette/border. We place our own tiles starting at 96 so they don't clash.
 */
#define TILE_BLANK   0     /* space char from the font = empty background */
#define TILE_WALL    96
#define TILE_BASKET  97
#define TILE_FRUIT   98

/* Each tile is 8x8 px, 4 bitplanes, stored row-interleaved: for every one of
 * the 8 rows, 4 bytes (plane0..plane3). A set bit selects a palette colour.
 * We only use colours 0 (transparent/bg) and 1, so only plane0 carries data;
 * planes 1..3 stay 0. Building the arrays by hand keeps the ROM tiny and
 * avoids any asset-conversion / compression dependency.
 */
#define ROW(b)  (b),0,0,0          /* one pixel row: plane0=b, planes1-3=0 */

/* solid 8x8 block (the side walls) */
const unsigned char tile_wall[32] = {
  ROW(0xFF), ROW(0xFF), ROW(0xFF), ROW(0xFF),
  ROW(0xFF), ROW(0xFF), ROW(0xFF), ROW(0xFF)
};

/* a basket: open cup shape */
const unsigned char tile_basket[32] = {
  ROW(0x00), ROW(0x00), ROW(0x00),
  ROW(0x81), ROW(0x81), ROW(0x81),
  ROW(0xFF), ROW(0x7E)
};

/* a round fruit */
const unsigned char tile_fruit[32] = {
  ROW(0x18), ROW(0x3C), ROW(0x7E), ROW(0x7E),
  ROW(0x7E), ROW(0x7E), ROW(0x3C), ROW(0x18)
};

/* Background palette: entry0 = backdrop (dark), entry1 = our pixel colour.
 * The text renderer overwrites entries 0/1 with black/white, so we re-load our
 * own afterwards. Sprites are not used (everything is tilemap) which keeps the
 * code identical across SMS and GG apart from the palette load format.
 */
static void setup_palette(void) {
#ifdef TARGET_GG
  GG_setBGPaletteColor(0, RGBHTML(0x102040));   /* deep blue backdrop */
  GG_setBGPaletteColor(1, RGBHTML(0xF0E060));   /* warm yellow pixels */
#else
  SMS_setBGPaletteColor(0, RGBHTML(0x102040));
  SMS_setBGPaletteColor(1, RGBHTML(0xF0E060));
#endif
}

/* draw one tile at (x,y) */
static void put(unsigned char x, unsigned char y, unsigned char tile) {
  SMS_setNextTileatXY(x, y);
  SMS_setTile(tile);
}

/* ----- tiny RNG ---------------------------------------------------------- */
static unsigned int rng;
static unsigned char rnd_col(void) {
  /* xorshift, then map into [FIELD_L+1 .. FIELD_R-1] */
  rng ^= rng << 7;
  rng ^= rng >> 9;
  rng ^= rng << 8;
  return (unsigned char)(FIELD_L + 1 + (rng % (FIELD_R - FIELD_L - 1)));
}

/* ----- game state -------------------------------------------------------- */
static unsigned char basket_x;
static unsigned char fruit_x, fruit_y;
static unsigned char lives;
static unsigned int  score;
static unsigned char fall_delay;   /* frames between fruit drops (speed)     */
static unsigned char fall_count;

static void draw_walls(void) {
  unsigned char y;
  for (y = FIELD_T; y <= FIELD_B; y++) {
    put(FIELD_L, y, TILE_WALL);
    put(FIELD_R, y, TILE_WALL);
  }
}

/* Format an unsigned int as a fixed 4-digit, space-padded decimal string.
 * SMSlib has no number printer, so we roll a tiny one and feed SMS_print. */
static unsigned char numbuf[6];
static const unsigned char *fmt_num(unsigned int v) {
  signed char i;
  for (i = 0; i < 4; i++) numbuf[i] = ' ';
  numbuf[4] = 0;
  i = 3;
  do {
    numbuf[i--] = (unsigned char)('0' + (v % 10));
    v /= 10;
  } while (v && i >= 0);
  return numbuf;
}

static void draw_hud(void) {
  SMS_printatXY(FIELD_L, HUD_ROW, "SC");
  SMS_printatXY(FIELD_L + 2, HUD_ROW, fmt_num(score));
  SMS_printatXY(FIELD_R - 5, HUD_ROW, "LV");
  SMS_printatXY(FIELD_R - 3, HUD_ROW, fmt_num(lives));
}

static void new_fruit(void) {
  fruit_x = rnd_col();
  fruit_y = FIELD_T;
  fall_count = 0;
}

static void reset_game(void) {
  /* clear the interior of the field */
  unsigned char x, y;
  for (y = FIELD_T; y <= FIELD_B; y++)
    for (x = FIELD_L + 1; x < FIELD_R; x++)
      put(x, y, TILE_BLANK);

  basket_x  = (FIELD_L + FIELD_R) / 2;
  lives     = 3;
  score     = 0;
  fall_delay = 24;
  draw_walls();
  draw_hud();
  new_fruit();
}

void main(void) {
  unsigned int keys;
  unsigned char prev_bx, prev_fx, prev_fy;

  SMS_VRAMmemsetW(0x0000, 0x0000, 16384);   /* clear all VRAM */
  SMS_autoSetUpTextRenderer();              /* font into tiles 0..95, display config */

  /* load our three game tiles after the font */
  SMS_loadTiles(tile_wall,   TILE_WALL,   32);
  SMS_loadTiles(tile_basket, TILE_BASKET, 32);
  SMS_loadTiles(tile_fruit,  TILE_FRUIT,  32);

  setup_palette();

  rng = 0xACE1;
  reset_game();

  SMS_displayOn();

  prev_bx = basket_x;
  prev_fx = fruit_x;
  prev_fy = fruit_y;
  put(basket_x, FIELD_B, TILE_BASKET);
  put(fruit_x,  fruit_y, TILE_FRUIT);

  for (;;) {
    SMS_waitForVBlank();
    rng++;                                  /* stir RNG with frame timing */

    keys = SMS_getKeysStatus();

    /* move basket within walls */
    if ((keys & PORT_A_KEY_LEFT)  && basket_x > FIELD_L + 1) basket_x--;
    if ((keys & PORT_A_KEY_RIGHT) && basket_x < FIELD_R - 1) basket_x++;

    /* advance fruit on its timer */
    if (++fall_count >= fall_delay) {
      fall_count = 0;
      fruit_y++;

      if (fruit_y >= FIELD_B) {
        /* reached basket row: catch if aligned, else lose a life */
        if (fruit_x == basket_x) {
          score++;
          if (fall_delay > 4) fall_delay--;       /* speed up a little */
        } else {
          if (lives) lives--;
        }
        draw_hud();

        if (lives == 0) {
          /* game over: wait for a button, then restart */
          SMS_printatXY((FIELD_L + FIELD_R) / 2 - 4, (FIELD_T + FIELD_B) / 2,
                        "GAME OVER");
          do {
            SMS_waitForVBlank();
            keys = SMS_getKeysStatus();
          } while (!(keys & (PORT_A_KEY_1 | PORT_A_KEY_2)));
          reset_game();
          prev_bx = basket_x;
          prev_fx = fruit_x;
          prev_fy = fruit_y;
          put(basket_x, FIELD_B, TILE_BASKET);
          put(fruit_x,  fruit_y, TILE_FRUIT);
          continue;
        }
        new_fruit();
      }
    }

    /* redraw moved objects (erase old cell, draw new) */
    if (prev_bx != basket_x) {
      put(prev_bx, FIELD_B, TILE_BLANK);
      put(basket_x, FIELD_B, TILE_BASKET);
      prev_bx = basket_x;
    }
    if (prev_fx != fruit_x || prev_fy != fruit_y) {
      put(prev_fx, prev_fy, TILE_BLANK);
      /* keep basket drawn if fruit erased its row's basket cell */
      if (prev_fy == FIELD_B && prev_fx == basket_x)
        put(basket_x, FIELD_B, TILE_BASKET);
      put(fruit_x, fruit_y, TILE_FRUIT);
      prev_fx = fruit_x;
      prev_fy = fruit_y;
    }
  }
}

/* ROM headers. The SEGA header (TMR SEGA signature + checksum slot near the end
 * of the ROM) is emitted for SMS builds; for GG the macro adapts automatically.
 * ihx2sms fills in the real size and checksum at pack time. */
SMS_EMBED_SEGA_ROM_HEADER(9999, 0);
SMS_EMBED_SDSC_HEADER_AUTO_DATE(1, 0, "LibretroWebXR", "LWX Catch",
                                "Catch the falling fruit. CC0.");
