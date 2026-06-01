/*
 * LWX Snake - a tiny original Snake game for the Game Boy (DMG).
 *
 * Part of LibretroWebXR test content. Written from scratch against the
 * documented GBDK-2020 API (<gb/gb.h>). No third-party code or assets.
 *
 * License: CC0 1.0 (public domain dedication). Authored by LibretroWebXR.
 *
 * Build:  C:\gbdk-2020\bin\lcc -Wm-yn"LWX SNAKE" -o lwx-gb-snake.gb main.c
 *  (or just: node scripts/make-gb-snake.mjs  from the repo root)
 *
 * Controls:
 *   D-pad      steer the snake (no 180-degree reversals)
 *   START      start a game / restart after game over
 *
 * Gameplay: eat the food to grow and score; hitting a wall or yourself
 * ends the game. The score is drawn as digit tiles in the top row.
 */

#include <gb/gb.h>
#include <stdint.h>

/* ------------------------------------------------------------------ *
 * Tile graphics.  Each tile is 8x8 pixels, 2 bits per pixel, encoded
 * as 16 bytes (two bytes per row: low bit-plane, high bit-plane).
 * DMG palette indices: 0 = lightest ... 3 = darkest.
 * ------------------------------------------------------------------ */

/* Tile indices in our tileset. */
#define T_BLANK  0   /* empty play cell                */
#define T_WALL   1   /* border wall                    */
#define T_BODY   2   /* snake body / head              */
#define T_FOOD   3   /* food pellet                    */
#define T_DIGIT0 4   /* digits 0..9 occupy 4..13       */

/* Helper: build a tile from an 8-row bitmap where each row is 8 chars
 * '.', '#', etc. -- but to keep things compile-time we hand-encode below. */

static const uint8_t tiles[] = {
    /* 0: BLANK - all palette 0 */
    0x00,0x00, 0x00,0x00, 0x00,0x00, 0x00,0x00,
    0x00,0x00, 0x00,0x00, 0x00,0x00, 0x00,0x00,

    /* 1: WALL - solid dark (palette 3) with a light hatch */
    0xFF,0xFF, 0xAA,0xFF, 0xFF,0xFF, 0xAA,0xFF,
    0xFF,0xFF, 0xAA,0xFF, 0xFF,0xFF, 0xAA,0xFF,

    /* 2: BODY - filled rounded block (palette 3 core, palette 1 edges) */
    0x00,0x00, 0x7E,0x7E, 0x7E,0x7E, 0x7E,0x7E,
    0x7E,0x7E, 0x7E,0x7E, 0x7E,0x7E, 0x00,0x00,

    /* 3: FOOD - a small diamond (palette 3) */
    0x00,0x00, 0x18,0x18, 0x3C,0x3C, 0x7E,0x7E,
    0x7E,0x7E, 0x3C,0x3C, 0x18,0x18, 0x00,0x00,

    /* 4: '0' */
    0x00,0x00, 0x3C,0x3C, 0x66,0x66, 0x66,0x66,
    0x66,0x66, 0x66,0x66, 0x3C,0x3C, 0x00,0x00,
    /* 5: '1' */
    0x00,0x00, 0x18,0x18, 0x38,0x38, 0x18,0x18,
    0x18,0x18, 0x18,0x18, 0x3C,0x3C, 0x00,0x00,
    /* 6: '2' */
    0x00,0x00, 0x3C,0x3C, 0x66,0x66, 0x0C,0x0C,
    0x18,0x18, 0x30,0x30, 0x7E,0x7E, 0x00,0x00,
    /* 7: '3' */
    0x00,0x00, 0x7E,0x7E, 0x0C,0x0C, 0x18,0x18,
    0x0C,0x0C, 0x66,0x66, 0x3C,0x3C, 0x00,0x00,
    /* 8: '4' */
    0x00,0x00, 0x0C,0x0C, 0x1C,0x1C, 0x3C,0x3C,
    0x6C,0x6C, 0x7E,0x7E, 0x0C,0x0C, 0x00,0x00,
    /* 9: '5' */
    0x00,0x00, 0x7E,0x7E, 0x60,0x60, 0x7C,0x7C,
    0x06,0x06, 0x66,0x66, 0x3C,0x3C, 0x00,0x00,
    /* 10: '6' */
    0x00,0x00, 0x3C,0x3C, 0x60,0x60, 0x7C,0x7C,
    0x66,0x66, 0x66,0x66, 0x3C,0x3C, 0x00,0x00,
    /* 11: '7' */
    0x00,0x00, 0x7E,0x7E, 0x06,0x06, 0x0C,0x0C,
    0x18,0x18, 0x18,0x18, 0x18,0x18, 0x00,0x00,
    /* 12: '8' */
    0x00,0x00, 0x3C,0x3C, 0x66,0x66, 0x3C,0x3C,
    0x66,0x66, 0x66,0x66, 0x3C,0x3C, 0x00,0x00,
    /* 13: '9' */
    0x00,0x00, 0x3C,0x3C, 0x66,0x66, 0x66,0x66,
    0x3E,0x3E, 0x06,0x06, 0x3C,0x3C, 0x00,0x00,
};
#define N_TILES 14

/* ------------------------------------------------------------------ *
 * Play field geometry (in tiles). The GB background is 20x18 visible.
 * Row 0 is the score bar; rows 1..17 are the arena (with a wall border).
 * ------------------------------------------------------------------ */
#define SCREEN_W 20
#define SCREEN_H 18

#define ARENA_TOP    1            /* first arena row                   */
#define ARENA_BOTTOM (SCREEN_H-1) /* last arena row (=17)              */
#define ARENA_LEFT   0
#define ARENA_RIGHT  (SCREEN_W-1) /* =19                               */

/* Walkable interior cells: x in [1..18], y in [ARENA_TOP+1 .. ARENA_BOTTOM-1] */
#define CELL_MIN_X 1
#define CELL_MAX_X (SCREEN_W-2)        /* 18 */
#define CELL_MIN_Y (ARENA_TOP+1)       /* 2  */
#define CELL_MAX_Y (ARENA_BOTTOM-1)    /* 16 */

#define MAX_SNAKE 200

/* Snake body stored as arrays of cell coordinates; index 0 = head. */
static uint8_t snake_x[MAX_SNAKE];
static uint8_t snake_y[MAX_SNAKE];
static uint16_t snake_len;

static int8_t dir_x, dir_y;   /* current heading */
static uint8_t food_x, food_y;
static uint16_t score;

/* Simple LCG pseudo-random; seeded from the frame counter at game start. */
static uint16_t rng_state = 1u;
static uint8_t rnd(void) {
    rng_state = (uint16_t)(rng_state * 25173u + 13849u);
    return (uint8_t)(rng_state >> 8);
}

/* Draw a single tile at background cell (x,y). */
static void put(uint8_t x, uint8_t y, uint8_t tile) {
    set_bkg_tiles(x, y, 1, 1, &tile);
}

/* Render the score (0..999) as up to 3 digit tiles at top-right. */
static void draw_score(void) {
    uint16_t s = score;
    uint8_t d0 = (uint8_t)(s % 10); s /= 10;
    uint8_t d1 = (uint8_t)(s % 10); s /= 10;
    uint8_t d2 = (uint8_t)(s % 10);
    put(SCREEN_W - 3, 0, (uint8_t)(T_DIGIT0 + d2));
    put(SCREEN_W - 2, 0, (uint8_t)(T_DIGIT0 + d1));
    put(SCREEN_W - 1, 0, (uint8_t)(T_DIGIT0 + d0));
}

/* Clear the screen to blanks, draw the arena border + score bar. */
static void draw_frame(void) {
    uint8_t x, y;
    for (y = 0; y < SCREEN_H; y++) {
        for (x = 0; x < SCREEN_W; x++) {
            uint8_t t = T_BLANK;
            if (y == ARENA_TOP || y == ARENA_BOTTOM ||
                x == ARENA_LEFT || x == ARENA_RIGHT) {
                if (y != 0) t = T_WALL;       /* row 0 stays clear for score */
            }
            put(x, y, t);
        }
    }
    draw_score();
}

/* Place food on a random free interior cell (not on the snake). */
static void place_food(void) {
    uint8_t ok;
    uint16_t i;
    do {
        food_x = (uint8_t)(CELL_MIN_X + (rnd() % (CELL_MAX_X - CELL_MIN_X + 1)));
        food_y = (uint8_t)(CELL_MIN_Y + (rnd() % (CELL_MAX_Y - CELL_MIN_Y + 1)));
        ok = 1;
        for (i = 0; i < snake_len; i++) {
            if (snake_x[i] == food_x && snake_y[i] == food_y) { ok = 0; break; }
        }
    } while (!ok);
    put(food_x, food_y, T_FOOD);
}

static void init_game(void) {
    uint16_t i;
    draw_frame();

    snake_len = 4;
    /* Start centred, heading right. */
    for (i = 0; i < snake_len; i++) {
        snake_x[i] = (uint8_t)(9 - i);
        snake_y[i] = 9;
        put(snake_x[i], snake_y[i], T_BODY);
    }
    dir_x = 1; dir_y = 0;
    score = 0;
    draw_score();
    place_food();
}

/* Wait for START, advancing the RNG so the food placement varies. */
static void wait_start(void) {
    while (!(joypad() & J_START)) {
        rng_state++;          /* entropy from how long the player waits */
        wait_vbl_done();
    }
    /* debounce */
    while (joypad() & J_START) wait_vbl_done();
}

void main(void) {
    uint8_t step, frame_ctr;

    set_bkg_data(0, N_TILES, tiles);
    SHOW_BKG;
    DISPLAY_ON;

    for (;;) {
        /* ---- title / ready screen: just an empty arena ---- */
        draw_frame();
        wait_start();

        init_game();

        /* movement speed: lower = faster. ~9 frames per step (~6.6 cells/s) */
        step = 9;
        frame_ctr = 0;

        /* ---- main game loop ---- */
        for (;;) {
            uint8_t keys = joypad();

            /* Steering: forbid reversing directly onto the neck. */
            if      ((keys & J_LEFT)  && dir_x != 1)  { dir_x = -1; dir_y = 0; }
            else if ((keys & J_RIGHT) && dir_x != -1) { dir_x = 1;  dir_y = 0; }
            else if ((keys & J_UP)    && dir_y != 1)  { dir_x = 0;  dir_y = -1; }
            else if ((keys & J_DOWN)  && dir_y != -1) { dir_x = 0;  dir_y = 1; }

            wait_vbl_done();
            if (++frame_ctr < step) continue;
            frame_ctr = 0;

            /* Compute new head position. */
            int8_t nx = (int8_t)snake_x[0] + dir_x;
            int8_t ny = (int8_t)snake_y[0] + dir_y;

            /* Wall collision. */
            if (nx < CELL_MIN_X || nx > CELL_MAX_X ||
                ny < CELL_MIN_Y || ny > CELL_MAX_Y) {
                break; /* game over */
            }

            /* Self collision (skip the tail tip if not growing — it moves). */
            uint8_t grew = (uint8_t)(nx == (int8_t)food_x && ny == (int8_t)food_y);
            uint16_t check_len = grew ? snake_len : (snake_len - 1);
            uint16_t i;
            uint8_t hit = 0;
            for (i = 0; i < check_len; i++) {
                if (snake_x[i] == (uint8_t)nx && snake_y[i] == (uint8_t)ny) { hit = 1; break; }
            }
            if (hit) break; /* game over */

            if (grew) {
                /* Grow: shift body down by one, insert new head. */
                if (snake_len < MAX_SNAKE) snake_len++;
                for (i = snake_len - 1; i > 0; i--) {
                    snake_x[i] = snake_x[i-1];
                    snake_y[i] = snake_y[i-1];
                }
                snake_x[0] = (uint8_t)nx;
                snake_y[0] = (uint8_t)ny;
                put((uint8_t)nx, (uint8_t)ny, T_BODY);

                score++;
                if (score > 999) score = 999;
                draw_score();
                if (step > 4) step--;   /* speed up as you grow */
                place_food();
            } else {
                /* Move: erase old tail, shift, draw new head. */
                uint8_t tx = snake_x[snake_len - 1];
                uint8_t ty = snake_y[snake_len - 1];
                put(tx, ty, T_BLANK);
                for (i = snake_len - 1; i > 0; i--) {
                    snake_x[i] = snake_x[i-1];
                    snake_y[i] = snake_y[i-1];
                }
                snake_x[0] = (uint8_t)nx;
                snake_y[0] = (uint8_t)ny;
                put((uint8_t)nx, (uint8_t)ny, T_BODY);
            }
        }

        /* ---- game over: flash the snake, then wait for START ---- */
        {
            uint8_t f, i;
            for (f = 0; f < 6; f++) {
                uint8_t t = (f & 1) ? T_BLANK : T_BODY;
                for (i = 0; i < (uint8_t)((snake_len > 255) ? 255 : snake_len); i++)
                    put(snake_x[i], snake_y[i], t);
                {
                    uint8_t w;
                    for (w = 0; w < 12; w++) wait_vbl_done();
                }
            }
        }
        /* loop back to the ready screen */
    }
}
