/* LWX Pong -- a tiny CC0 PC Engine / TurboGrafx-16 game for LibretroWebXR
 * test content.
 *
 * Single screen, plain HuCard (.pce). Left paddle = player 1 (D-pad up/down on
 * joypad 1, which the WebXR frontend's RetroPad maps to). Right paddle is either
 * player 2 (D-pad up/down on joypad 2 -- matching the repo's two-hand RetroPad
 * mapping) or, until pad 2 moves, a simple CPU that tracks the ball. First side
 * to 9 wins; press RUN to serve / play again.
 *
 * Everything is drawn on the character grid using HuC's documented text library
 * (put_char / put_string / put_number / cls). No raw VDC banging, no sprite/VRAM
 * juggling, no hand-written HuCard header -- HuC's startup code and library do
 * all the hardware bring-up. That batteries-included split is the AI-friendly
 * path the project's research doc recommends.
 *
 * Built with HuC (pce-devel/huc). Our source + the resulting .pce are CC0.
 */

#include "huc.h"

/* The visible play area is 32 characters across and ~28 tall; keep all play
 * inside that window of the larger virtual screen HuC's startup sets up. */
#define COLS      32
#define ROWS      28

#define TOP        2          /* top wall row (inclusive)            */
#define BOT       25          /* bottom wall row (inclusive)         */
#define PADH       4          /* paddle height in character cells    */
#define LX         2          /* left paddle column                  */
#define RX        29          /* right paddle column                 */
#define WIN        9          /* score needed to win                 */
#define MID       (COLS / 2)

#define BLOCK   '#'           /* paddle glyph (always in default font) */
#define BALLCH  'O'           /* ball glyph                            */
#define NETCH   ':'           /* centre-net glyph                      */
#define BLANK   ' '

static char lpY, rpY;          /* paddle top row */
static char bx, by;            /* ball column / row */
static char dx, dy;            /* ball velocity (-1 / +1) */
static char lScore, rScore;
static char i;
static char p1, p2;            /* joypad reads */
static char cpu;               /* 1 = right paddle is CPU, 0 = human took over */
static char tick;              /* frame counter, used to slow the ball */
static int  seed;

static void draw_paddle(char col, char topRow)
{
    for (i = 0; i < PADH; ++i)
        put_char(BLOCK, col, topRow + i);
}

static void clear_paddle(char col, char topRow)
{
    for (i = 0; i < PADH; ++i)
        put_char(BLANK, col, topRow + i);
}

/* Move a paddle one row toward delta (-1 up, +1 down), redrawing it. */
static void move_paddle(char col, char *topRow, char delta)
{
    if (delta < 0) { if (*topRow <= TOP)               return; }
    else           { if (*topRow + PADH - 1 >= BOT)    return; }
    clear_paddle(col, *topRow);
    *topRow += delta;
    draw_paddle(col, *topRow);
}

static void draw_field(void)
{
    cls();
    for (i = 0; i < COLS; ++i) {            /* top + bottom walls */
        put_char('-', i, TOP - 1);
        put_char('-', i, BOT + 1);
    }
    for (i = TOP; i <= BOT; i += 2)         /* dashed centre net */
        put_char(NETCH, MID, i);
    put_string("LWX PONG", (COLS - 8) / 2, 0);
}

static void draw_score(void)
{
    put_number(lScore, 1, 8, 0);
    put_number(rScore, 1, COLS - 9, 0);
}

static void serve(char dir)
{
    bx = MID;
    by = (TOP + BOT) / 2;
    dx = dir;
    dy = (rand() & 1) ? 1 : -1;
    put_char(BALLCH, bx, by);
}

static void erase_ball(void)
{
    /* Restore the net glyph if the ball was sitting on a net cell. */
    if (bx == MID && ((by - TOP) & 1) == 0)
        put_char(NETCH, bx, by);
    else
        put_char(BLANK, bx, by);
}

/* Wait until RUN is pressed (and released-then-pressed is not required). */
static void wait_run(void)
{
    for (;;) {
        vsync();
        ++seed;
        if (joy(0) & JOY_RUN) return;
    }
}

/* Play one full match to WIN points. Returns when someone wins. */
static void play_match(void)
{
    lpY = (ROWS - PADH) / 2;
    rpY = (ROWS - PADH) / 2;
    lScore = 0;
    rScore = 0;
    cpu = 1;
    tick = 0;

    draw_field();
    draw_paddle(LX, lpY);
    draw_paddle(RX, rpY);
    draw_score();
    serve(-1);

    for (;;) {
        vsync();
        p1 = joy(0);
        p2 = joy(1);

        /* left paddle: player 1 */
        if (p1 & JOY_UP)   move_paddle(LX, &lpY, -1);
        if (p1 & JOY_DOWN) move_paddle(LX, &lpY,  1);

        /* right paddle: player 2 once they touch the d-pad, else CPU */
        if (p2 & (JOY_UP | JOY_DOWN)) cpu = 0;
        if (cpu) {
            if ((tick & 1) == 0) {              /* CPU is half-speed so it can miss */
                if (by < rpY + (PADH / 2))      move_paddle(RX, &rpY, -1);
                else if (by > rpY + (PADH / 2)) move_paddle(RX, &rpY,  1);
            }
        } else {
            if (p2 & JOY_UP)   move_paddle(RX, &rpY, -1);
            if (p2 & JOY_DOWN) move_paddle(RX, &rpY,  1);
        }

        /* ball advances every other frame for a playable speed */
        ++tick;
        if (tick & 1) continue;

        erase_ball();
        bx += dx;
        by += dy;

        if (by <= TOP)      { by = TOP; dy = -dy; }
        else if (by >= BOT) { by = BOT; dy = -dy; }

        if (dx < 0 && bx <= LX + 1) {           /* left paddle bounce */
            if (by >= lpY && by <= lpY + PADH - 1) { bx = LX + 1; dx = -dx; }
        }
        if (dx > 0 && bx >= RX - 1) {           /* right paddle bounce */
            if (by >= rpY && by <= rpY + PADH - 1) { bx = RX - 1; dx = -dx; }
        }

        if (bx <= LX) {                         /* right scores */
            if (rScore < WIN) ++rScore;
            draw_score();
            if (rScore >= WIN) return;
            serve(1);
        } else if (bx >= RX) {                  /* left scores */
            if (lScore < WIN) ++lScore;
            draw_score();
            if (lScore >= WIN) return;
            serve(-1);
        } else {
            put_char(BALLCH, bx, by);
        }
    }
}

main()
{
    disp_off();
    cls();
    set_color_rgb(0, 0, 0, 1);     /* backdrop: near-black */
    set_color_rgb(1, 7, 7, 7);     /* font colour 1: white */
    set_font_color(1, 0);
    set_font_pal(0);
    load_default_font();
    disp_on();

    seed = 0;
    draw_field();
    put_string("P1 D-PAD: LEFT PADDLE",  (COLS - 21) / 2, (TOP + BOT) / 2 - 2);
    put_string("P2 D-PAD: RIGHT (OR CPU)", (COLS - 24) / 2, (TOP + BOT) / 2);
    put_string("PRESS RUN", (COLS - 9) / 2, BOT + 2);
    wait_run();
    srand(seed);

    for (;;) {
        play_match();

        if (lScore >= WIN) put_string("LEFT WINS!",  (COLS - 10) / 2, (TOP + BOT) / 2);
        else               put_string("RIGHT WINS!", (COLS - 11) / 2, (TOP + BOT) / 2);
        put_string("PRESS RUN", (COLS - 9) / 2, BOT + 2);
        wait_run();
    }
}
