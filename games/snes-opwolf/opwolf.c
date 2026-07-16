/*---------------------------------------------------------------------------------

    LWX Frontline Fury - a CC0 "Operation Wolf"-style two-gun on-rails light-gun
    shooter for the SNES, built for LibretroWebXR.

    Genre, authored fresh (no copyrighted Operation Wolf assets, levels or art):
    you advance through STAGES of an on-rails firefight. Enemy soldiers march in
    from the sides of the screen toward the bottom (the "front line"); aim your
    gun and pull the trigger to drop them before they reach you. Each stage has a
    quota of enemies to clear; clear it and you ADVANCE to the next (tougher) stage.
    Enemies that reach the front line cost you health; run out of health and it's
    GAME OVER. Co-op for two players, each with an independent crosshair, score and
    a shared health bar - true "two guns, one battlefield" Operation Wolf feel.

    Off-screen shot = RELOAD (Operation Wolf's iconic "shoot off-screen to reload"):
    a gun starts with a magazine; firing on-screen spends a round; firing OFF-screen
    (gun pointed away / OFFSCREEN flag) refills the magazine. An empty magazine can't
    shoot, so you must reload at the right moment - the on-rails tension.

    --- Two guns on the SNES: the Konami Justifier -------------------------------

    The SNES light gun that supports TWO simultaneous guns is the Konami Justifier
    (Lethal Enforcers). snes9x device ids: 516 (Justifier, gun 1) / 772 (Justifier2,
    gun 2), both on controller port 2 (the Justifier daisy-chains both guns on one
    port). Like the Super Scope it is POSITION-LATCHED, not beam-timed: when a gun's
    SELECT line is active, snes9x latches that gun's aimed pixel into the PPU H/V
    counters (OPHCT/OPVCT $213C/$213D - the same gun-latch the Super Scope uses), so
    the ROM reads a STABLE coordinate, no whole-frame photodiode polling.

    The Justifier read protocol (verified against snes9x controls.cpp, the core we
    ship): each $4016 strobe TOGGLES the core's internal SELECT line, choosing which
    gun (0/1) latches its aimed pixel into the PPU H/V counters at the NEXT frame's
    end (S9xControlEOF -> DoGunLatch). After the strobe, 32 serial bit-reads of $4017
    return a 24-bit signature (0xaa7000, present iff a Justifier is connected) then 8
    button bits carrying the SELECTED gun's TRIGGER/START plus the SELECT bit itself.

    HARDWARE LIMIT (important): there is exactly ONE pair of PPU gun-latch counters
    and ONE serial button byte, both multiplexed by SELECT. So BOTH the position AND
    the trigger are inherently 30 Hz-per-gun: one frame we select+read gun 0, the
    next gun 1, ping-ponging - exactly how real Lethal Enforcers does it. Reading
    BOTH guns' fresh state in a SINGLE frame is physically impossible on this
    hardware (and in snes9x). Each gun's last reading is HELD in jf_x/jf_y/jf_trig
    between its updates, so co-op scoring uses both guns continuously; a gun's data
    is just up to one frame stale, which is imperceptible for a rail shooter.

    PVSnesLib has NO Justifier driver (only Super Scope), so the Justifier path here
    is hand-written raw 65816-via-C register I/O (jf_* below). To keep the game both
    Operation-Wolf-correct AND verifiable TODAY, the input layer is abstracted behind
    read_gun(p) -> Gun{x,y,trigger,offscreen} with TWO backends, chosen at boot by
    which device the frontend attached:

      * SUPER SCOPE backend (GUN_SCOPE): PVSnesLib's proven detectSuperScope()/scope_*
        path on port 2. This is the path the headless snes9x harness drives today
        (tmp/verify-opwolf-snes9x.mjs) and what makes single-gun hit logic verifiable
        right now, because the shipped rwebinput feeds ONE mouse pointer to the gun
        port.
      * JUSTIFIER backend (GUN_JUST): the raw two-gun reader above, for two-player
        co-op. The per-port "multiport" rwebinput patch
        (docs/patches/rwebinput-lightgun-multiport.diff) has LANDED and is verified:
        tmp/verify-twogun-opwolf-snes9x.mjs drives gun A (libretro port 1, device
        516) and gun B (port 2, device 772) to two distinct points and confirms the
        core's blue/magenta crosshairs each follow their OWN port (independent aim),
        AND that each gun scores an in-game kill through this reader. Per the
        hardware limit above the two guns are read 30 Hz each (multiplexed by
        SELECT), not both-fresh-per-frame; that's the faithful maximum.

    Built with PVSnesLib (MIT) - only this game-logic file is authored by us; the
    SNES boot/init boilerplate is the SDK + the frozen hdr.asm / data.asm. The
    bundled console font is PVSnesLib's MIT example art; the sprite sheet is
    generated CC0 by scripts/make-snes-opwolf.mjs.

    Game logic + sprite art: CC0 (public domain), LibretroWebXR.

---------------------------------------------------------------------------------*/
#include <snes.h>

// Console font (background tile set + on-screen text), from PVSnesLib.
extern char tilfont, palfont;

// PVSnesLib's rand() seed words (library globals; no public srand() is exposed).
extern unsigned short snes_rand_seed1;
extern unsigned short snes_rand_seed2;

// Sprite graphics + palette (gfx4snes from sprites.bmp):
//   tile 0 = enemy soldier (16x16)
//   tile 1 = player-1 crosshair (cyan)
//   tile 2 = player-2 crosshair (pink)
//   tile 3 = muzzle flash / hit burst
#include "sprites.inc"

// --- raw SNES registers we need for the Justifier reader ----------------------
// (PVSnesLib doesn't expose these; standard volatile-pointer idiom.)
#define REG_JOYSER0 (*(volatile unsigned char *)0x4016)  // strobe (write) / port-1 serial (read)
#define REG_JOYSER1 (*(volatile unsigned char *)0x4017)  // port-2 serial data (read)
#define REG_OPHCT   (*(volatile unsigned char *)0x213C)  // horizontal beam latch (read twice)
#define REG_OPVCT   (*(volatile unsigned char *)0x213D)  // vertical   beam latch (read twice)
#define REG_SLHV    (*(volatile unsigned char *)0x2137)  // software latch H/V (read to latch)
#define REG_STAT78  (*(volatile unsigned char *)0x213F)  // PPU2 status (clears H/V latch read flip-flop)

// --- screen geometry (256x224, sprite is 16x16) ------------------------------
#define SCR_W      256
#define SCR_H      224
#define SPR        16
#define CENTER_X   0x80          // 128 - screen centre (calibration reference)
#define CENTER_Y   0x70          // 112

// --- game tuning --------------------------------------------------------------
#define MAX_HEALTH    12
#define HUD_BOTTOM    200        // enemies that cross this y reach the front line
#define MAG_SIZE      8          // rounds per magazine before a reload is needed
#define MAX_ENEMIES   6          // simultaneous enemies on screen (sprite slots 0..5)
#define HIT_PAD       6          // grow the 16x16 hit box by this many px each side
#define FLASH_FRAMES  10

// gun input backends
#define GUN_SCOPE  0             // PVSnesLib Super Scope (port 2, single gun, verifiable now)
#define GUN_JUST   1             // raw Konami Justifier (two guns, needs multiport to verify)

// state machine
#define ST_CAL   0               // "shoot the centre" - calibrates aim + starts
#define ST_PLAY  1
#define ST_OVER  2
#define ST_CLEAR 3               // brief "STAGE CLEAR" banner before next stage

// backdrop colours
#define COL_FIELD  RGB5(2, 4, 6)     // dim battlefield blue-grey
#define COL_HIT    RGB5(2, 26, 6)    // green hit flash
#define COL_HURT   RGB5(26, 3, 3)    // red "you got hit" flash

unsigned char state;
unsigned char gun_backend;        // GUN_SCOPE or GUN_JUST (set at boot)
unsigned char num_players;        // 1 or 2

// per-enemy state (sprite OAM slots 0..MAX_ENEMIES-1)
short  ex[MAX_ENEMIES], ey[MAX_ENEMIES];
signed char evx[MAX_ENEMIES];     // horizontal drift
unsigned char espeed[MAX_ENEMIES];// vertical advance per frame (x16 fixed point low byte)
unsigned char esub[MAX_ENEMIES];  // sub-pixel accumulator
unsigned char ealive[MAX_ENEMIES];

// per-player state
unsigned short score[2];
unsigned char  mag[2];            // rounds left in magazine
unsigned char  px_aim[2], py_aim[2];   // last crosshair position (screen px)
unsigned char  fire_armed[2];     // trigger-release debounce

unsigned char health;
unsigned char stage;
unsigned char quota;              // enemies left to clear this stage
unsigned char spawn_timer;
unsigned short frame;
unsigned char flash_timer;
unsigned char flash_kind;         // 1 hit (green), 2 hurt (red)
unsigned char clear_timer;

// Super Scope calibration centre (only used by the GUN_SCOPE backend).
// (raw, captured at the "shoot the centre" step so scope_shoth/v read in px.)

// crosshair OAM slots live above the enemy slots.
#define XHAIR0_OAM  (MAX_ENEMIES + 0)
#define XHAIR1_OAM  (MAX_ENEMIES + 1)
#define FLASH_OAM   (MAX_ENEMIES + 2)

// -----------------------------------------------------------------------------
// Gun input abstraction. read_gun(p) fills g with this frame's aim + trigger for
// player p. Returns 1 if a usable reading exists (gun connected), else 0.
// -----------------------------------------------------------------------------
typedef struct {
    short x, y;                   // aimed position, screen px
    unsigned char trigger;        // trigger DOWN this frame (edge handled by caller)
    unsigned char offscreen;      // gun pointed off-screen (reload gesture)
} Gun;

Gun gview[2];

// --- Justifier backend (raw) --------------------------------------------------
// We ping-pong: even frames latch+read gun 0, odd frames gun 1, matching the
// hardware where each $4016 strobe toggles which gun latches to the PPU counters.
//
// IMPORTANT timing subtlety (this WAS a bug — cross-wired guns): a strobe's
// trigger byte is read via immediate serial shift, so it reflects whichever
// gun is selected AFTER this toggle. But the PPU H/V latch it also toggles
// only lands "at the next frame's end" (see the file header) — so reading
// OPHCT/OPVCT in the SAME poll actually returns the position latched by the
// *previous* toggle, i.e. the OTHER gun. Storing it under `gun`'s index paired
// gun A's fresh trigger with gun B's stale position every single frame, so a
// hit registered by whichever gun's TRIGGER read happened to land, using the
// WRONG gun's aimed position — in practice the two players' input streams
// were cross-wired, not just each other's slightly-stale co-op partner.
//
// Fix: track which gun the LAST toggle actually selected (jf_latch_owner) and
// read its now-ready position BEFORE issuing a new toggle, tagging it with
// the correct (previous) gun index. Position then trails its own gun's
// trigger by one poll (~1 frame) — expected and imperceptible, same as the
// file header's documented "up to one frame stale" tolerance — but the two
// data streams are no longer swapped between players.
unsigned char jf_present;         // 1 once we have seen the 0xaa7000 signature
unsigned short jf_x[2], jf_y[2];  // latched position per gun (screen px)
unsigned char jf_trig[2];         // trigger bit per gun
unsigned char jf_select;          // which gun we strobed last (0/1)
unsigned char jf_latch_owner = 0xFF; // gun whose position is ready to read (0xFF = none yet)

// Read the latched PPU beam position (OPHCT/OPVCT are read low-then-high; STAT78
// read resets the high/low flip-flop). Returns position scaled to screen px.
void jf_read_latch(unsigned char gun) {
    unsigned short h, v;
    unsigned char dummy;
    dummy = REG_STAT78;           // reset latch flip-flop
    (void)dummy;
    h = REG_OPHCT; h |= ((unsigned short)(REG_OPHCT & 1)) << 8;   // 9-bit H
    v = REG_OPVCT; v |= ((unsigned short)(REG_OPVCT & 1)) << 8;   // 9-bit V
    // snes9x latches the aimed pixel directly (already in screen space).
    jf_x[gun] = h;
    jf_y[gun] = v;
}

// Strobe the port and shift in 32 serial bits from $4017. The first 24 are the
// 0xaa7000 signature (presence test); the last 8 carry the two guns' buttons.
void jf_strobe_and_read(void) {
    unsigned long sig = 0;
    unsigned char btn = 0;
    unsigned char i, b;

    REG_JOYSER0 = 1;              // latch high  (toggles JUSTIFIER_SELECT in core)
    REG_JOYSER0 = 0;              // latch low   ('plug in' / arm the serial shift)

    for (i = 0; i < 24; i++) {
        b = REG_JOYSER1 & 1;
        sig = (sig << 1) | b;
    }
    for (i = 0; i < 8; i++) {
        b = REG_JOYSER1 & 1;
        btn = (btn << 1) | b;
    }

    if ((sig & 0xFFFFFF) == 0xaa7000) jf_present = 1;

    // Button byte layout (snes9x, bits 24..31): trigger/start/select for the two
    // guns interleaved. We treat the high bits as gun-0 then gun-1 trigger; only
    // the trigger matters for the game. Robust to either gun ordering: store the
    // selected gun's trigger.
    jf_trig[jf_select] = (btn & 0x80) ? 1 : 0;
}

void jf_poll(unsigned char gun) {
    // Read the position owed from the PREVIOUS toggle first, tagged under the
    // gun that toggle actually selected — BEFORE we issue a new toggle and
    // change what's latched. See the jf_latch_owner comment above.
    if (jf_latch_owner != 0xFF) jf_read_latch(jf_latch_owner);
    jf_select = gun;
    jf_strobe_and_read();         // toggles select inside the core, reads buttons
    jf_latch_owner = gun;         // this toggle's position will be ready next poll
}

// --- the abstraction the game logic uses --------------------------------------
unsigned char read_gun(unsigned char p, Gun *g) {
    if (gun_backend == GUN_SCOPE) {
        // Single Super Scope on port 2; player 0 only has a real gun, player 1
        // mirrors it (so 2P logic stays exercised under single-mouse rwebinput).
        if (!snes_sscope) return 0;
        g->x = (short)scope_shoth;
        g->y = (short)scope_shotv;
        g->trigger  = (scope_down & SSC_FIRE) ? 1 : 0;
        g->offscreen = (scope_down & SSC_OFFSCREEN) ? 1 : 0;
        return 1;
    } else {
        if (!jf_present) return 0;
        g->x = (short)jf_x[p];
        g->y = (short)jf_y[p];
        g->trigger = jf_trig[p];
        // OFFSCREEN: snes9x stops latching when a gun is off-screen, so a position
        // outside the active area is the reload gesture.
        g->offscreen = (g->x < 0 || g->x >= SCR_W || g->y < 0 || g->y >= SCR_H) ? 1 : 0;
        return 1;
    }
}

// 4-digit number to BG text at (x,y).
char numbuf[6];
void draw_num(unsigned char x, unsigned char y, unsigned short v) {
    numbuf[0] = '0' + (v / 1000) % 10;
    numbuf[1] = '0' + (v / 100) % 10;
    numbuf[2] = '0' + (v / 10) % 10;
    numbuf[3] = '0' + v % 10;
    numbuf[4] = 0;
    consoleDrawText(x, y, numbuf);
}

void draw_hud(void) {
    consoleDrawText(1, 1, "P1");
    draw_num(4, 1, score[0]);
    if (num_players == 2) { consoleDrawText(24, 1, "P2"); draw_num(27, 1, score[1]); }
    consoleDrawText(12, 1, "ST");
    draw_num(15, 1, stage);
    consoleDrawText(1, 26, "HP");
    draw_num(4, 26, health);
    consoleDrawText(11, 26, "MAG");
    draw_num(15, 26, mag[0]);
    if (num_players == 2) draw_num(24, 26, mag[1]);
}

void hide_all_sprites(void) {
    unsigned char i;
    for (i = 0; i < 128; i++) oamSetVisible(i << 2, OBJ_HIDE);
}

void clear_text(void) {
    unsigned char y;
    for (y = 8; y <= 16; y++) consoleDrawText(2, y, "                            ");
}

void spawn_enemy(void) {
    unsigned char i;
    for (i = 0; i < MAX_ENEMIES; i++) if (!ealive[i]) break;
    if (i >= MAX_ENEMIES) return;
    // enter from a random top edge x, drifting toward the centre-bottom.
    ex[i] = 16 + (rand() % (SCR_W - 48));
    ey[i] = 24 + (rand() % 16);
    evx[i] = (ex[i] < CENTER_X) ? 1 : -1;
    espeed[i] = 12 + stage * 4 + (rand() & 7);   // faster each stage
    esub[i] = 0;
    ealive[i] = 1;
    oamSet(i << 2, ex[i], ey[i], 2, 0, 0, 0, 0);  // tile 0 = soldier, prio 2
    oamSetEx(i << 2, OBJ_SMALL, OBJ_SHOW);
}

void kill_enemy(unsigned char i, unsigned char by_player) {
    ealive[i] = 0;
    oamSetVisible(i << 2, OBJ_HIDE);
    if (score[by_player] < 9999) score[by_player] += 10;
    if (quota) quota--;
    flash_timer = FLASH_FRAMES; flash_kind = 1;
    // muzzle/hit burst on the enemy's last spot
    oamSet(FLASH_OAM << 2, ex[i], ey[i], 2, 0, 0, 0, 3);
    oamSetEx(FLASH_OAM << 2, OBJ_SMALL, OBJ_SHOW);
}

void enemy_reached_front(unsigned char i) {
    ealive[i] = 0;
    oamSetVisible(i << 2, OBJ_HIDE);
    if (quota) quota--;
    if (health) health--;
    flash_timer = FLASH_FRAMES; flash_kind = 2;
}

// Did a shot at (sx,sy) hit enemy i?
unsigned char shot_hits(unsigned char i, short sx, short sy) {
    return ealive[i] &&
           sx >= ex[i] - HIT_PAD && sx < ex[i] + SPR + HIT_PAD &&
           sy >= ey[i] - HIT_PAD && sy < ey[i] + SPR + HIT_PAD;
}

void enter_cal(void);
void enter_play(void);
void enter_over(void);

void start_stage(unsigned char s) {
    unsigned char i;
    stage = s;
    quota = 8 + s * 4;            // more enemies to clear each stage
    spawn_timer = 0;
    for (i = 0; i < MAX_ENEMIES; i++) { ealive[i] = 0; oamSetVisible(i << 2, OBJ_HIDE); }
    draw_hud();
}

void enter_cal(void) {
    clear_text();
    hide_all_sprites();
    consoleDrawText(8, 8, "LWX FRONTLINE FURY");
    consoleDrawText(6, 11, "ON-RAILS GUN ASSAULT");
    consoleDrawText(7, 14, "SHOOT CENTRE TO START");
    // aim dot at centre (player-1 crosshair tile) as the calibration target.
    oamSet(XHAIR0_OAM << 2, CENTER_X - 8, CENTER_Y - 8, 1, 0, 0, 0, 1);
    oamSetEx(XHAIR0_OAM << 2, OBJ_SMALL, OBJ_SHOW);
    fire_armed[0] = 0; fire_armed[1] = 0;
    state = ST_CAL;
}

void enter_play(void) {
    clear_text();
    score[0] = 0; score[1] = 0;
    mag[0] = MAG_SIZE; mag[1] = MAG_SIZE;
    health = MAX_HEALTH;
    snes_rand_seed1 = frame ? frame : 1;
    snes_rand_seed2 = frame ^ 0x5a5a;
    start_stage(1);
    fire_armed[0] = 0; fire_armed[1] = 0;
    draw_hud();
    state = ST_PLAY;
}

void enter_clear(void) {
    consoleDrawText(11, 12, "STAGE CLEAR");
    clear_timer = 70;
    state = ST_CLEAR;
}

void enter_over(void) {
    unsigned char i;
    for (i = 0; i < MAX_ENEMIES; i++) oamSetVisible(i << 2, OBJ_HIDE);
    consoleDrawText(11, 11, "GAME OVER");
    consoleDrawText(9, 13, "P1 SCORE");
    draw_num(18, 13, score[0]);
    if (num_players == 2) { consoleDrawText(9, 14, "P2 SCORE"); draw_num(18, 14, score[1]); }
    consoleDrawText(7, 16, "SHOOT TO PLAY AGAIN");
    fire_armed[0] = 0; fire_armed[1] = 0;
    state = ST_OVER;
}

// Process one player's gun for this frame in PLAY.
void play_player(unsigned char p) {
    Gun *g = &gview[p];
    if (!read_gun(p, g)) return;

    // crosshair sprite follows the aim.
    {
        unsigned char slot = (p == 0) ? XHAIR0_OAM : XHAIR1_OAM;
        unsigned char tile = (p == 0) ? 1 : 2;
        short cx = g->x - 8, cy = g->y - 8;
        if (cx < 0) cx = 0; if (cx > SCR_W - SPR) cx = SCR_W - SPR;
        if (cy < 0) cy = 0; if (cy > SCR_H - SPR) cy = SCR_H - SPR;
        oamSet(slot << 2, cx, cy, 1, 0, 0, 0, tile);
        oamSetEx(slot << 2, OBJ_SMALL, OBJ_SHOW);
    }

    // trigger-release debounce so a held trigger fires once.
    if (!g->trigger) { fire_armed[p] = 1; return; }
    if (!fire_armed[p]) return;
    fire_armed[p] = 0;

    if (g->offscreen) {                 // OFF-screen shot = RELOAD
        mag[p] = MAG_SIZE;
        draw_hud();
        return;
    }
    if (mag[p] == 0) return;            // empty - must reload (off-screen) first
    mag[p]--;
    draw_hud();

    // resolve the on-screen shot against the enemies.
    {
        unsigned char i;
        for (i = 0; i < MAX_ENEMIES; i++) {
            if (shot_hits(i, g->x, g->y)) { kill_enemy(i, p); break; }
        }
    }
}

void advance_enemies(void) {
    unsigned char i;
    for (i = 0; i < MAX_ENEMIES; i++) {
        if (!ealive[i]) continue;
        // horizontal drift (bounce off the edges).
        ex[i] += evx[i];
        if (ex[i] < 8) { ex[i] = 8; evx[i] = 1; }
        if (ex[i] > SCR_W - SPR - 8) { ex[i] = SCR_W - SPR - 8; evx[i] = -1; }
        // vertical advance (fixed point: espeed is 1/16 px per frame units).
        esub[i] += espeed[i];
        while (esub[i] >= 16) { esub[i] -= 16; ey[i]++; }
        if (ey[i] >= HUD_BOTTOM) { enemy_reached_front(i); continue; }
        oamSet(i << 2, ex[i], ey[i], 2, 0, 0, 0, 0);
        oamSetEx(i << 2, OBJ_SMALL, OBJ_SHOW);
    }
}

int main(void) {
    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0100);
    consoleInitText(0, 16 * 2, &tilfont, &palfont);

    bgSetGfxPtr(0, 0x2000);
    bgSetMapPtr(0, 0x6800, SC_32x32);

    oamInitGfxSet(&sprites_til, (&sprites_tilend - &sprites_til),
                  &sprites_pal, (&sprites_palend - &sprites_pal),
                  0, 0x0000, OBJ_SIZE16_L32);
    hide_all_sprites();

    setMode(BG_MODE1, 0);
    bgSetDisable(1);
    bgSetDisable(2);

    setPaletteColor(0, COL_FIELD);

    // Pick the gun backend. The frontend attaches EITHER a Super Scope (260) or a
    // Justifier (516/772) on port 2. detectSuperScope() sets snes_sscope iff the
    // Super Scope answered; otherwise we strobe for the Justifier signature.
    detectSuperScope();
    jf_present = 0;
    if (snes_sscope) {
        gun_backend = GUN_SCOPE;
        num_players = 1;                 // single mouse / single Super Scope
        scope_holddelay = 30;
        scope_repdelay  = 12;
    } else {
        gun_backend = GUN_JUST;
        jf_poll(0);                      // probe for the 0xaa7000 signature
        num_players = jf_present ? 2 : 1;
    }

    frame = 0;
    enter_cal();
    setScreenOn();

    while (1) {
        ++frame;

        // Justifier needs us to ping-pong the gun select every frame so each gun's
        // position latches in turn (gun 0 on even frames, gun 1 on odd).
        if (gun_backend == GUN_JUST) {
            jf_poll(frame & 1);
        } else if (!snes_sscope) {
            detectSuperScope();          // keep the scope alive across reconnects
        }

        // backdrop flash decays back to the field colour.
        if (flash_timer) {
            setPaletteColor(0, flash_kind == 1 ? COL_HIT : COL_HURT);
            if (--flash_timer == 0) {
                setPaletteColor(0, COL_FIELD);
                oamSetVisible(FLASH_OAM << 2, OBJ_HIDE);   // clear the hit burst
            }
        }

        if (state == ST_PLAY) {
            play_player(0);
            if (num_players == 2) play_player(1);

            // spawn cadence (faster each stage), capped at MAX_ENEMIES.
            if (spawn_timer) spawn_timer--;
            else { spawn_enemy(); spawn_timer = 60 - stage * 6; if (spawn_timer > 60) spawn_timer = 12; }

            advance_enemies();

            if (health == 0) { enter_over(); }
            else if (quota == 0) {
                unsigned char i, any = 0;
                for (i = 0; i < MAX_ENEMIES; i++) any |= ealive[i];
                if (!any) enter_clear();   // stage cleared once the field is empty
            }
        } else if (state == ST_CLEAR) {
            if (clear_timer && --clear_timer == 0) {
                consoleDrawText(11, 12, "           ");
                start_stage(stage + 1);
                state = ST_PLAY;
            }
        } else {
            // ST_CAL / ST_OVER: a trigger pull (re)starts. Calibrate the Super Scope
            // on the way in so scope_shoth/v read in screen pixels.
            unsigned char p, fired = 0;
            for (p = 0; p < num_players; p++) {
                Gun *g = &gview[p];
                if (!read_gun(p, g)) continue;
                if (!g->trigger) { fire_armed[p] = 1; continue; }
                if (!fire_armed[p]) continue;
                fire_armed[p] = 0;
                if (gun_backend == GUN_SCOPE && state == ST_CAL) {
                    scope_centerh = CENTER_X - scope_shothraw;
                    scope_centerv = CENTER_Y - scope_shotvraw;
                }
                fired = 1;
            }
            if (fired) enter_play();
        }

        WaitForVBlank();
    }
    return 0;
}
