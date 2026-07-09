/*---------------------------------------------------------------------------------

    LWX Frontline Fury (NES) - a CC0 "Operation Wolf"-style on-rails light-gun
    wave shooter for the NES Zapper, built for LibretroWebXR.

    This is a DESIGN reference-port, not a code port, of our own SNES "LWX
    Frontline Fury" (games/snes-opwolf/opwolf.c): same idea (soldiers march in
    from the sides toward a "front line," clear each stage's quota before they
    reach you, magazine + reload, shared health, per-player score, 2-player
    co-op) reworked from scratch for what the real NES Zapper protocol can
    actually tell a ROM.

    --- Why this can't just be the SNES game's logic, ported -------------------

    SNES's Super Scope / Justifier latch a real screen X/Y into the PPU H/V
    counters, so opwolf.c can hit-test the aim point against several enemies'
    bounding boxes independently. The NES Zapper (nestopia core, device 262,
    hardcoded to port index 1 - see docs/LIGHTGUN_SUPPORT.md) gives the ROM
    NEITHER an X nor a Y: only a light-sensed bit and a trigger bit on $4017,
    exactly like real Zapper hardware (the core, fed the frontend's mouse
    position, checks brightness of that one pixel internally - the ROM never
    sees the coordinate). With only a light/no-light signal, the ROM can never
    tell WHICH of several bright things was hit; it can only tell whether the
    ONE thing it is currently rendering bright was hit. (This is exactly the
    constraint games/nes-gallery/main.c already works within, and why real Duck
    Hunt needs a whole multi-frame flash-index scheme to pick one of several
    ducks - out of scope here.)

    The design that follows from that: several soldiers are visible and
    advancing at once (for the "wave" feel), but only the FRONTMOST alive one -
    the one closest to breaching the front line - is ever drawn in the bright
    sprite palette (palette 0) and is therefore the only one the Zapper can
    register a hit on. Every other soldier renders in a dark palette (palette
    1) that stays below nestopia's light-sense threshold (same proven-safe
    "row $3x is bright / row $0x is dark" NES palette split gallery already
    verified against the real core). Killing the active soldier promotes the
    next-frontmost to active.

    Reload, mapped onto the same 2-bit protocol: since only the active soldier
    is ever bright, "the shot didn't land on it" (trigger pulled, no light) is
    the only notion of "disengaged" the hardware can express - so THAT is what
    reloads the magazine, standing in for Operation Wolf's classic "shoot
    off-screen to reload" without needing any signal the protocol doesn't have.

    2-player co-op (no true second aiming gun is possible - nestopia only ever
    reads the Zapper from port index 1): reuses games/nes-gallery's already-
    shipped, already-verified pattern almost verbatim -
      * SHARE: two players alternate turns with the one Zapper, handing off at
        each stage-clear (rather than gallery's per-shot waves, since a stage
        here runs for a variable number of kills).
      * DUEL: P2 aims + fires the real Zapper; P1 "fires" via port-1 pad A
        (pad_trigger(0) & PAD_A), both resolved against the same shared light
        read each frame. A `hit_claimed` guard stops one real light-sense event
        from crediting both players in the same frame (see play_duel below).

    Built with cc65 + Shiru's neslib (the frozen boilerplate copied from
    games/nes-gallery/). The CHR (font + soldier + hit-poof tiles) is generated
    by scripts/make-nes-opwolf.mjs. The Zapper $4017 read loop (POLL_READS
    spin-read spanning the whole visible frame, D3=light/D4=trigger, real-HW
    polarity light = D3 clear) is reused near-verbatim from
    games/nes-gallery/main.c - that technique is already proven against the
    real core; nothing about it changes here.

    Game logic + tile art: CC0 (public domain), LibretroWebXR.

---------------------------------------------------------------------------------*/
#include "neslib.h"

typedef unsigned char u8;
typedef unsigned int  u16;

// Port-2 controller/Zapper register. D3 = light sense (0 = light detected, 1 =
// no light - real-HW polarity), D4 = trigger (1 = held).
#define CTRL_PORT2 (*(volatile u8*)0x4017)

// Spin-read $4017 across one whole visible frame so a read is guaranteed to
// coincide with the beam crossing the muzzle's scanline (see the file header
// and games/nes-gallery/main.c's header for why this must NOT be vblank-only).
#define POLL_READS 1500

#pragma bss-name (push,"ZEROPAGE")
#pragma data-name (push,"ZEROPAGE")
u8 oam_off;
#pragma data-name(pop)
#pragma bss-name (pop)

// --- tile ids (must match scripts/make-nes-opwolf.mjs) -----------------------
#define T_BLANK   0
#define T_SOLDIER 2        // 2..5 = 16x16 soldier metasprite (TL,TR,BL,BR)
#define T_BURST   6         // 6..9 = 16x16 dim hit-poof metasprite
#define T_DIGIT   16        // 16..25 = '0'..'9'
#define T_ALPHA   32        // 32..57 = 'A'..'Z'

// sprite palette slots (attr byte 0..3)
#define PAL_ACTIVE 0        // bright - the one soldier the Zapper can hit
#define PAL_DIM    1        // dark   - every other soldier, and the hit poof

// --- screen geometry (256x240, sprite is 16x16) ------------------------------
#define SCR_W      256
#define SPR        16

// --- game tuning --------------------------------------------------------------
#define MAX_HEALTH    10
#define HUD_BOTTOM    200        // enemies that cross this y reach the front line
#define MAG_SIZE      6          // rounds per magazine before a reload is needed
#define MAX_ENEMIES   4          // simultaneous soldiers on screen
#define FLASH_FRAMES  8
#define BURST_FRAMES  10
#define NONE          0xff

// state machine
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
#define ST_CLEAR 3

// co-op mode (chosen at the title, then fixed for the run)
#define MODE_SOLO  0        // 1 player, Zapper only
#define MODE_SHARE 1        // 2 players, alternating turns (hand off at stage-clear)
#define MODE_DUEL  2        // 2 players, simultaneous (P1=port-1 A, P2=Zapper)

// backdrop palette entries (NES hex, row $3x = brightest, row $0x = darkest -
// the same proven-safe split games/nes-gallery/main.c already verified against
// the real core: $0f field / $30 bright target).
#define COL_FIELD  0x0f
#define COL_HIT    0x2a          // green flash
#define COL_HURT   0x16          // red flash

// bg palettes 0-3: black field, white text, blue, red (same family as gallery).
// spr palette 0 (PAL_ACTIVE): bright white body + red accent - senses light.
// spr palette 1 (PAL_DIM): dark body, same tone for the "accent" slot too, so
// no pixel of a dim soldier (or the hit poof, which also uses this palette) can
// ever cross the light threshold.
static const u8 PALETTE[32] = {
  0x0f,0x30,0x21,0x16,  0x0f,0x30,0x21,0x16,  0x0f,0x30,0x21,0x16,  0x0f,0x30,0x21,0x16,
  0x0f,0x30,0x16,0x0f,  0x0f,0x0c,0x0c,0x0f,  0x0f,0x0c,0x0c,0x0f,  0x0f,0x30,0x16,0x0f,
};

// 16x16 metasprite templates (xoff,yoff,tile,attr; x=128 terminates). attr is
// patched per-draw so the SAME shape renders bright (active) or dim (queued).
static u8 soldier_meta[] = {
  0,0, T_SOLDIER+0, PAL_ACTIVE,
  8,0, T_SOLDIER+1, PAL_ACTIVE,
  0,8, T_SOLDIER+2, PAL_ACTIVE,
  8,8, T_SOLDIER+3, PAL_ACTIVE,
  128
};
static u8 burst_meta[] = {
  0,0, T_BURST+0, PAL_DIM,
  8,0, T_BURST+1, PAL_DIM,
  0,8, T_BURST+2, PAL_DIM,
  8,8, T_BURST+3, PAL_DIM,
  128
};

static u8  state;
static u8  mode;
static u8  num_players;
static u8  cur;             // SHARE: whose turn it is (0/1). Unused in SOLO/DUEL.

// per-enemy state (sprite slots 0..MAX_ENEMIES-1)
static u8  ex[MAX_ENEMIES], ey[MAX_ENEMIES];
static signed char evx[MAX_ENEMIES];
static u8  espeed[MAX_ENEMIES], esub[MAX_ENEMIES];
static u8  ealive[MAX_ENEMIES];
static u8  active_idx;      // index into the arrays above, or NONE

// per-player state
static u16 score[2];
static u8  mag[2];

static u8  health;
static u8  stage;
static u8  quota;
static u8  spawn_timer;
static u16 frame;
static u8  flash_timer, flash_kind;   // 1 hit (green), 2 hurt (red)
static u8  clear_timer;

static u8  burst_x, burst_y, burst_timer;   // dim kill-poof (single slot)

static u8  trig2, trig2Prev;   // port-2 Zapper trigger edge
static u8  pad1, pad1Trig;     // port-1 controller (P1 in DUEL; menu nav)
static u8  light, z;            // this frame's Zapper light-sense result, spin-read scratch
static u16 pr;                 // $4017 spin-read counter

static u8  vbuf[32];           // HUD vram-update buffer (worst case 2P: index 28)

// ASCII -> tile id.
static u8 chr_of(u8 c) {
  if (c >= '0' && c <= '9') return T_DIGIT + (c - '0');
  if (c >= 'A' && c <= 'Z') return T_ALPHA + (c - 'A');
  return T_BLANK;
}

static void put_str(u8 x, u8 y, const char *s) {
  vram_adr(NAMETABLE_A | (((u16)y << 5) | x));
  while (*s) { vram_put(chr_of(*s)); ++s; }
}

static void put_num(u8 x, u8 y, u16 v, u8 digits) {
  u8 buf[4], i;
  for (i = digits; i > 0; i--) { buf[i - 1] = T_DIGIT + (v % 10); v /= 10; }
  vram_adr(NAMETABLE_A | (((u16)y << 5) | x));
  for (i = 0; i < digits; i++) vram_put(buf[i]);
}

static void clear_screen(void) {
  vram_adr(NAMETABLE_A);
  vram_fill(T_BLANK, 32 * 30);
  vram_adr(0x23c0);
  vram_fill(0, 64);
}

// Pack a 4-digit score run into vbuf at offset o, vram low-byte adrLo.
static u8 hud_score(u8 o, u8 adrLo, u16 sc) {
  vbuf[o + 0] = 0x20 | NT_UPD_HORZ; vbuf[o + 1] = adrLo; vbuf[o + 2] = 4;
  vbuf[o + 6] = T_DIGIT + (sc % 10); sc /= 10;
  vbuf[o + 5] = T_DIGIT + (sc % 10); sc /= 10;
  vbuf[o + 4] = T_DIGIT + (sc % 10); sc /= 10;
  vbuf[o + 3] = T_DIGIT + (sc % 10);
  return o + 7;
}

// Rebuild the live HUD buffer: P1 score (+P2 score if 2P) row 1; HEALTH,
// STAGE, MAG row 2 (both rows share page 0x20 - see enter_play()). set_vram_
// update() consumes this every NMI.
static void update_hud(void) {
  u8 o = 0;
  // SOLO's "SCORE" label (5 chars, cols 2..6) needs the digit run to start at
  // col 8, clear of the label; 2P's "P1" label (2 chars, cols 2..3) fits
  // before col 4 instead.
  o = hud_score(o, (num_players == 2) ? 0x24 : 0x28, score[0]); // NTADR_A(4|8,1)
  if (num_players == 2) o = hud_score(o, 0x30, score[1]); // NTADR_A(16,1)

  // row 2 base = NAMETABLE_A | (2<<5) = 0x2040, high byte 0x20 - same page as
  // the SCORE chunk above (see the enter_play() comment for why that matters).
  vbuf[o + 0] = 0x20 | NT_UPD_HORZ; vbuf[o + 1] = 0x44; vbuf[o + 2] = 2; // NTADR_A(4,2)
  vbuf[o + 3] = T_DIGIT + (health / 10); vbuf[o + 4] = T_DIGIT + (health % 10);

  vbuf[o + 5] = 0x20 | NT_UPD_HORZ; vbuf[o + 6] = 0x50; vbuf[o + 7] = 2; // NTADR_A(16,2)
  vbuf[o + 8] = T_DIGIT + (stage / 10); vbuf[o + 9] = T_DIGIT + (stage % 10);

  vbuf[o + 10] = 0x20 | NT_UPD_HORZ; vbuf[o + 11] = 0x5c; vbuf[o + 12] = 1; // NTADR_A(28,2)
  vbuf[o + 13] = T_DIGIT + mag[cur];

  vbuf[o + 14] = NT_UPD_EOF;
}

static void hide_all_sprites(void) {
  oam_clear();
  oam_hide_rest(0);
}

// Pick the frontmost (largest y) alive soldier as the active/shootable one.
static void pick_active(void) {
  u8 i, best = NONE, besty = 0;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (ealive[i] && (best == NONE || ey[i] >= besty)) { best = i; besty = ey[i]; }
  }
  active_idx = best;
}

static void spawn_enemy(void) {
  u8 i;
  for (i = 0; i < MAX_ENEMIES; i++) if (!ealive[i]) break;
  if (i >= MAX_ENEMIES) return;
  ex[i] = 16 + (rand8() % 201);        // 16..217, clear of the bounce edges below
  ey[i] = 24 + (rand8() % 16);
  evx[i] = (ex[i] < 120) ? 1 : -1;
  espeed[i] = 10 + stage * 3 + (rand8() & 6);
  esub[i] = 0;
  ealive[i] = 1;
  pick_active();
}

static void start_stage(u8 s) {
  u8 i;
  stage = s;
  quota = 6 + s * 3;
  spawn_timer = 0;
  for (i = 0; i < MAX_ENEMIES; i++) ealive[i] = 0;
  active_idx = NONE;
  update_hud();
}

static void enter_title(void) {
  ppu_off();
  set_vram_update(NULL);
  clear_screen();
  put_str(6, 4, "LWX FRONTLINE FURY");
  put_str(4, 8, "STOP THE FRONT LINE");
  put_str(8, 16, "SHOOT  START 1P");
  put_str(8, 18, "START  2P SHARED GUN");
  put_str(3, 20, "2ND GUN PORT1  2P DUEL");
  hide_all_sprites();
  state = ST_TITLE;
  ppu_on_all();
}

static void enter_play(void) {
  ppu_off();
  set_vram_update(NULL);
  clear_screen();
  score[0] = 0; score[1] = 0;
  mag[0] = MAG_SIZE; mag[1] = MAG_SIZE;
  health = MAX_HEALTH;
  cur = 0;
  set_rand(frame ? frame : 1);
  start_stage(1);
  burst_timer = 0; flash_timer = 0;
  if (num_players == 2) { put_str(2, 1, "P1"); put_str(14, 1, "P2"); } else { put_str(2, 1, "SCORE"); }
  // HP/ST/MAG live on row 2 (not the bottom row) so every dynamic HUD chunk
  // shares nametable A's page 0x20 (rows 0..7) with the SCORE chunk above —
  // set_vram_update()'s buffer only reliably applies chunks that share the
  // FIRST chunk's high byte; a row-27 (page 0x23) chunk in the same buffer as
  // a row-1 (page 0x20) chunk silently never reaches VRAM after the initial
  // draw (confirmed via tmp/_diag7.mjs / tmp/_diag8.mjs against the real core).
  put_str(0, 2, "HP");
  put_str(12, 2, "ST");
  put_str(24, 2, "MAG");
  update_hud();
  set_vram_update(vbuf);
  state = ST_PLAY;
  ppu_on_all();
}

static void enter_clear(void) {
  ppu_off();
  set_vram_update(NULL);
  put_str(10, 12, "STAGE CLEAR");
  clear_timer = 70;
  state = ST_CLEAR;
  ppu_on_all();
}

static void enter_over(void) {
  ppu_off();
  set_vram_update(NULL);
  hide_all_sprites();
  put_str(11, 11, "GAME OVER");
  if (num_players == 2) {
    put_str(9, 13, "P1"); put_num(13, 13, score[0], 4);
    put_str(9, 14, "P2"); put_num(13, 14, score[1], 4);
    if (score[0] > score[1]) put_str(10, 16, "P1 WINS");
    else if (score[1] > score[0]) put_str(10, 16, "P2 WINS");
    else put_str(11, 16, "A TIE");
  } else {
    put_str(11, 13, "SCORE"); put_num(17, 13, score[0], 4);
  }
  put_str(9, 20, "SHOOT TO RETRY");
  state = ST_OVER;
  ppu_on_all();
}

static void reload(u8 p) { mag[p] = MAG_SIZE; update_hud(); }

// Kill the current active soldier, crediting player `p`. Callers only invoke
// this once they've confirmed light was sensed (so an active soldier exists)
// AND mag[p] > 0 (so this shot was actually fireable).
static void kill_active(u8 p) {
  u8 i = active_idx;
  ealive[i] = 0;
  if (score[p] < 9999) score[p] += 10;
  if (quota) quota--;
  mag[p]--;
  flash_timer = FLASH_FRAMES; flash_kind = 1;
  burst_x = ex[i]; burst_y = ey[i]; burst_timer = BURST_FRAMES;
  pick_active();
  update_hud();
}

static void advance_enemies(void) {
  u8 i;
  u8 breached = 0;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!ealive[i]) continue;
    ex[i] += evx[i];
    if (ex[i] < 8) { ex[i] = 8; evx[i] = 1; }
    if (ex[i] > SCR_W - SPR - 8) { ex[i] = SCR_W - SPR - 8; evx[i] = -1; }
    esub[i] += espeed[i];
    while (esub[i] >= 16) { esub[i] -= 16; ey[i]++; }
    if (ey[i] >= HUD_BOTTOM) {
      ealive[i] = 0;
      if (quota) quota--;
      if (health) health--;
      flash_timer = FLASH_FRAMES; flash_kind = 2;
      breached = 1;
    }
  }
  if (breached) pick_active();
}

// SOLO / SHARE: the single Zapper resolves against the active soldier. An
// empty magazine can't fire — the trigger pull is a dry-fire no-op (must
// reload, i.e. fire while nothing is lit, first).
static void play_single(void) {
  if (!(trig2 && !trig2Prev)) return;
  if (!light) { reload(cur); return; }
  if (mag[cur]) kill_active(cur);
}

// DUEL: P1 (port-1 A) and P2 (Zapper) both check this frame's shared light
// read. hit_claimed stops one real light-sense event from crediting both
// players in the same frame. If P1 fires first but is out of ammo, nothing is
// claimed and P2's shot (if any, and if THEY have ammo) can still land.
static void play_duel(void) {
  u8 hit_claimed = 0;
  if (pad1Trig & PAD_A) {
    if (!light) reload(0);
    else if (mag[0]) { kill_active(0); hit_claimed = 1; }
  }
  if (trig2 && !trig2Prev && !hit_claimed) {
    if (!light) reload(1);
    else if (mag[1]) kill_active(1);
  }
}

static void draw_play_sprites(void) {
  u8 i, sid = 0;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!ealive[i]) continue;
    soldier_meta[3] = soldier_meta[7] = soldier_meta[11] = soldier_meta[15] =
      (i == active_idx) ? PAL_ACTIVE : PAL_DIM;
    sid = oam_meta_spr(ex[i], ey[i], sid, soldier_meta);
  }
  if (burst_timer) sid = oam_meta_spr(burst_x, burst_y, sid, burst_meta);
  oam_hide_rest(sid);
}

void main(void) {
  ppu_off();
  pal_all(PALETTE);
  oam_clear();
  frame = 0;
  mode = MODE_SOLO;
  num_players = 1;
  enter_title();

  while (1) {
    ppu_wait_nmi();
    ++frame;

    pad1Trig = pad_trigger(0);
    pad1     = pad_state(0);

    // Spin-read $4017 across a full visible frame (see file header). light =
    // any read with D3 clear; trig2 = any read with D4 set.
    light = 0; trig2 = 0;
    for (pr = 0; pr < POLL_READS; ++pr) {
      z = CTRL_PORT2;
      if (!(z & 0x08)) light = 1;
      if (z & 0x10)    trig2 = 1;
    }

    if (state == ST_PLAY) {
      if (mode == MODE_DUEL) play_duel(); else play_single();

      if (burst_timer) --burst_timer;
      if (flash_timer) {
        pal_col(0, flash_kind == 1 ? COL_HIT : COL_HURT);
        if (--flash_timer == 0) pal_col(0, COL_FIELD);
      }

      if (spawn_timer) spawn_timer--;
      else {
        spawn_enemy();
        spawn_timer = (stage * 6 < 60) ? 60 - stage * 6 : 12;
      }

      advance_enemies();
      draw_play_sprites();

      if (health == 0) enter_over();
      else if (quota == 0) {
        u8 i, any = 0;
        for (i = 0; i < MAX_ENEMIES; i++) any |= ealive[i];
        if (!any) enter_clear();
      }
    } else if (state == ST_CLEAR) {
      hide_all_sprites();
      if (clear_timer && --clear_timer == 0) {
        ppu_off();
        put_str(10, 12, "           ");
        if (mode == MODE_SHARE) cur ^= 1;
        start_stage(stage + 1);
        set_vram_update(vbuf);
        state = ST_PLAY;
        ppu_on_all();
      }
    } else {
      // ST_TITLE / ST_OVER: pick a mode and (re)start.
      hide_all_sprites();
      if (trig2 && !trig2Prev)        { mode = MODE_SOLO;  num_players = 1; enter_play(); }
      else if (pad1Trig & PAD_START)  { mode = MODE_SHARE; num_players = 2; enter_play(); }
      else if (pad1Trig & PAD_A)      { mode = MODE_DUEL;  num_players = 2; enter_play(); }
    }

    trig2Prev = trig2;
  }
}
