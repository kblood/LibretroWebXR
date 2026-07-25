/*
 * LWX PSX Test Disc -- a minimal CC0 PlayStation 1 homebrew for
 * LibretroWebXR, following this project's "author our own small test game"
 * pattern (see games/nes-gallery, games/snes-scope, games/ps2-guncon-range,
 * games/n64-scene). This is the first PSX title in the repo: unlike
 * scripts/cores/psx/test-content/generate-smoke-exe.js (a bare hand-written
 * MIPS .exe that never touches CD-ROM/BIOS/memory-card paths), this ships
 * as a real bootable CD image (CUE+BIN, built with mkpsxiso via
 * PSn00bSDK) so it exercises the actual disc-boot path.
 *
 * Content: a real GTE-projected, lit, rotating 3D cube (six flat-shaded
 * faces, backface-culled, depth-sorted through the ordering table -- not a
 * flat 2D fill), driven by the digital pad (D-pad speeds up/reverses spin),
 * with an on-screen text HUD. On boot the game reads a small save block
 * from memory card slot 1 (raw low-level sector I/O -- BIOS functions
 * InitCARD/StartCARD/_bu_init/_card_read/_card_write/_card_wait) and shows
 * the save counter it finds. Pressing CROSS (or, automatically, once after
 * ~3 seconds so an unattended/headless boot still exercises the path)
 * writes an updated counter back to the card. Rebooting re-reads it --
 * proving the memory-card round trip works for real authored content, not
 * just synthetic test harnesses.
 *
 * No copyrighted Sony/game assets of any kind -- geometry, palette and text
 * are all original to this file. CC0 / public domain; see docs/LICENSING.md
 * for this repo's licensing conventions.
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <psxgpu.h>
#include <psxgte.h>
#include <psxpad.h>
#include <psxapi.h>
#include <inline_c.h>

/* ------------------------------------------------------------------ */
/* Display / double-buffer setup                                       */
/* ------------------------------------------------------------------ */

#define OT_LEN     256
#define PACKET_LEN 2048

#define SCREEN_XRES 320
#define SCREEN_YRES 240
#define CENTERX (SCREEN_XRES / 2)
#define CENTERY (SCREEN_YRES / 2)

typedef struct {
	DISPENV  disp;
	DRAWENV  draw;
	uint32_t ot[OT_LEN];
	char     p[PACKET_LEN];
} DB;

static DB   db[2];
static int  db_active = 0;
static char *db_nextpri;

/* ------------------------------------------------------------------ */
/* Cube geometry (original, hand-authored -- not from any SDK sample   */
/* asset; vertex/face layout only, which is generic cube topology)     */
/* ------------------------------------------------------------------ */

typedef struct { short v0, v1, v2, v3; } INDEX;

static SVECTOR cube_verts[] = {
	{ -100, -100, -100, 0 },
	{  100, -100, -100, 0 },
	{ -100,  100, -100, 0 },
	{  100,  100, -100, 0 },
	{  100, -100,  100, 0 },
	{ -100, -100,  100, 0 },
	{  100,  100,  100, 0 },
	{ -100,  100,  100, 0 }
};

static SVECTOR cube_norms[] = {
	{ 0, 0, -ONE, 0 },
	{ 0, 0,  ONE, 0 },
	{ 0, -ONE, 0, 0 },
	{ 0,  ONE, 0, 0 },
	{ -ONE, 0, 0, 0 },
	{  ONE, 0, 0, 0 }
};

static INDEX cube_indices[] = {
	{ 0, 1, 2, 3 },
	{ 4, 5, 6, 7 },
	{ 5, 4, 0, 1 },
	{ 6, 7, 3, 2 },
	{ 0, 2, 5, 7 },
	{ 3, 1, 6, 4 }
};

#define CUBE_FACES 6

/* Distinct base color per face so the rotation/backface-culling/depth
 * sort is easy to verify visually, then modulated per-pixel-free (flat)
 * by the GTE's single directional light term. */
static const uint8_t face_rgb[CUBE_FACES][3] = {
	{ 220,  60,  60 }, /* front  - red    */
	{  60, 220,  90 }, /* back   - green  */
	{  70,  90, 220 }, /* bottom - blue   */
	{ 220, 210,  60 }, /* top    - yellow */
	{ 210,  70, 220 }, /* left   - magenta*/
	{  60, 210, 210 }  /* right  - cyan   */
};

/* Light color matrix: one directional light, roughly white/neutral. */
static MATRIX color_mtx = {
	ONE, 0, 0,
	ONE, 0, 0,
	ONE, 0, 0
};

/* Light direction matrix: single light pointing from camera-ish angle. */
static MATRIX light_mtx = {
	-2048, -2048, -2048,
	    0,     0,     0,
	    0,     0,     0
};

/* ------------------------------------------------------------------ */
/* Memory card (slot 1) -- raw low-level sector I/O.                   */
/*                                                                      */
/* Deliberately uses the low-level _card_read/_card_write/_card_wait   */
/* BIOS protocol (raw 128-byte sectors) rather than the higher-level   */
/* open()/read()/write() file API: the low-level path maps directly    */
/* onto the documented SIO memory-card command set (R/S/W), which is   */
/* what the emulator core's own memory-card peripheral emulation       */
/* actually implements -- the BIOS (real or the bundled OpenBIOS HLE   */
/* fallback used when no user BIOS is supplied) only needs to be a     */
/* thin protocol driver over it, which is a much smaller compatibility */
/* surface than the full directory/FAT file abstraction.               */
/* ------------------------------------------------------------------ */

#define MC_CHAN       0   /* card slot 1 */
#define MC_SECTOR     16  /* first sector of the first 8KB save block  */
#define MC_MAGIC      0x31585754u /* 'TWX1' little-endian-ish marker   */

typedef struct {
	uint32_t magic;
	uint32_t save_count;
	uint32_t last_save_frame;
	uint32_t checksum; /* magic ^ save_count ^ last_save_frame */
} SaveBlock;

static int card_present = 0;

static void mc_init(void)
{
	InitCARD(1);
	StartCARD();
	_bu_init();
}

/* Returns 1 on a completed, successful transfer; 0 otherwise. buf must
 * be a 128-byte sector buffer. */
static int mc_read_sector(int sector, uint8_t *buf)
{
	if (!_card_read(MC_CHAN, sector, buf))
		return 0;
	return _card_wait(MC_CHAN) == 0x01;
}

static int mc_write_sector(int sector, uint8_t *buf)
{
	if (!_card_write(MC_CHAN, sector, buf))
		return 0;
	return _card_wait(MC_CHAN) == 0x01;
}

static uint32_t save_count       = 0;
static uint32_t save_flash_timer = 0; /* frames left to show "SAVED!" */
static int      card_had_valid_save = 0;

static void save_load(void)
{
	uint8_t sector[128];
	memset(sector, 0, sizeof(sector));

	if (!mc_read_sector(MC_SECTOR, sector)) {
		card_present = 0;
		return;
	}
	card_present = 1;

	SaveBlock block;
	memcpy(&block, sector, sizeof(block));
	if (block.magic == MC_MAGIC &&
	    block.checksum == (block.magic ^ block.save_count ^ block.last_save_frame)) {
		save_count = block.save_count;
		card_had_valid_save = 1;
	} else {
		save_count = 0;
		card_had_valid_save = 0;
	}
}

static void save_write(uint32_t frame_number)
{
	if (!card_present)
		return;

	save_count++;

	SaveBlock block;
	block.magic           = MC_MAGIC;
	block.save_count      = save_count;
	block.last_save_frame = frame_number;
	block.checksum        = block.magic ^ block.save_count ^ block.last_save_frame;

	uint8_t sector[128];
	memset(sector, 0, sizeof(sector));
	memcpy(sector, &block, sizeof(block));

	if (mc_write_sector(MC_SECTOR, sector)) {
		save_flash_timer = 90; /* ~1.5s at 60Hz */
		card_had_valid_save = 1;
	}
}

/* ------------------------------------------------------------------ */
/* Controller (BIOS pad driver, standard low-speed polling)            */
/* ------------------------------------------------------------------ */

static uint8_t pad_buff[2][34];

/* ------------------------------------------------------------------ */
/* Init / display helpers                                              */
/* ------------------------------------------------------------------ */

static void init(void)
{
	ResetGraph(0);

	SetDefDispEnv(&db[0].disp, 0, 0, SCREEN_XRES, SCREEN_YRES);
	SetDefDrawEnv(&db[0].draw, SCREEN_XRES, 0, SCREEN_XRES, SCREEN_YRES);
	setRGB0(&db[0].draw, 12, 14, 24);
	db[0].draw.isbg = 1;
	db[0].draw.dtd  = 1;

	SetDefDispEnv(&db[1].disp, SCREEN_XRES, 0, SCREEN_XRES, SCREEN_YRES);
	SetDefDrawEnv(&db[1].draw, 0, 0, SCREEN_XRES, SCREEN_YRES);
	setRGB0(&db[1].draw, 12, 14, 24);
	db[1].draw.isbg = 1;
	db[1].draw.dtd  = 1;

	PutDrawEnv(&db[0].draw);

	ClearOTagR(db[0].ot, OT_LEN);
	ClearOTagR(db[1].ot, OT_LEN);
	db_nextpri = db[0].p;

	InitGeom();
	gte_SetGeomOffset(CENTERX, CENTERY);
	gte_SetGeomScreen(CENTERX);
	gte_SetBackColor(24, 26, 40);
	gte_SetColorMatrix(&color_mtx);

	InitPAD(pad_buff[0], 34, pad_buff[1], 34);
	StartPAD();
	ChangeClearPAD(0);

	FntLoad(960, 0);
	FntOpen(8, 16, 300, 64, 0, 200);

	mc_init();
	save_load();
}

static void display(void)
{
	DrawSync(0);
	VSync(0);

	db_active ^= 1;
	db_nextpri = db[db_active].p;

	ClearOTagR(db[db_active].ot, OT_LEN);

	PutDrawEnv(&db[db_active].draw);
	PutDispEnv(&db[db_active].disp);
	SetDispMask(1);

	DrawOTag(db[1 - db_active].ot + (OT_LEN - 1));
	FntFlush(-1);
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

int main(void)
{
	SVECTOR rot = { 0 };
	VECTOR  pos = { 0, 0, 400 };
	MATRIX  mtx, lmtx;

	uint32_t frame       = 0;
	int      spin_speed  = 12;
	int      cross_prev  = 0;
	int      auto_saved  = 0;

	init();

	while (1) {
		frame++;

		/* --- input --- */
		PADTYPE *pad = (PADTYPE *)pad_buff[0];
		int cross_down = 0;
		int have_pad   = 0;
		if (pad->stat == 0 &&
		    (pad->type == PAD_ID_DIGITAL || pad->type == PAD_ID_ANALOG ||
		     pad->type == PAD_ID_ANALOG_STICK)) {
			have_pad = 1;
			cross_down = !(pad->btn & PAD_CROSS);
			if (!(pad->btn & PAD_LEFT))  spin_speed -= 1;
			if (!(pad->btn & PAD_RIGHT)) spin_speed += 1;
			if (spin_speed >  48) spin_speed =  48;
			if (spin_speed < -48) spin_speed = -48;
		}

		int cross_edge = cross_down && !cross_prev;
		cross_prev = cross_down;

		/* Trigger a memory-card save on a CROSS press, or once
		 * automatically at frame 180 (~3s) so a headless/unattended
		 * boot still exercises the save path without needing
		 * simulated input. */
		if (cross_edge) {
			save_write(frame);
		} else if (!auto_saved && frame == 180) {
			auto_saved = 1;
			save_write(frame);
		}

		if (save_flash_timer > 0)
			save_flash_timer--;

		/* --- rotate cube --- */
		rot.vx += spin_speed;
		rot.vz += (spin_speed * 2) / 3;

		RotMatrix(&rot, &mtx);
		TransMatrix(&mtx, &pos);
		MulMatrix0(&light_mtx, &mtx, &lmtx);

		gte_SetRotMatrix(&mtx);
		gte_SetTransMatrix(&mtx);
		gte_SetLightMatrix(&lmtx);

		POLY_F4 *pol4 = (POLY_F4 *)db_nextpri;

		for (int i = 0; i < CUBE_FACES; i++) {
			gte_ldv3(
				&cube_verts[cube_indices[i].v0],
				&cube_verts[cube_indices[i].v1],
				&cube_verts[cube_indices[i].v2]);
			gte_rtpt();

			gte_nclip();
			int p;
			gte_stopz(&p);
			if (p < 0)
				continue;

			gte_avsz4();
			gte_stotz(&p);
			if ((p >> 2) > OT_LEN)
				continue;

			setPolyF4(pol4);
			gte_stsxy0(&pol4->x0);
			gte_stsxy1(&pol4->x1);
			gte_stsxy2(&pol4->x2);

			gte_ldv0(&cube_verts[cube_indices[i].v3]);
			gte_rtps();
			gte_stsxy(&pol4->x3);

			setRGB0(pol4, face_rgb[i][0], face_rgb[i][1], face_rgb[i][2]);
			gte_ldrgb(&pol4->r0);
			gte_ldv0(&cube_norms[i]);
			gte_nccs();
			gte_strgb(&pol4->r0);

			addPrim(db[db_active].ot + (p >> 2), pol4);
			pol4++;
		}

		db_nextpri = (char *)pol4;

		/* --- HUD text --- */
		FntPrint(-1, "LWX PSX TEST DISC\n");
		FntPrint(-1, "SAVE COUNT: %lu%s\n",
			(unsigned long)save_count,
			save_flash_timer > 0 ? "  [SAVED]" : "");
		if (!card_present)
			FntPrint(-1, "MEMORY CARD SLOT 1: NOT DETECTED\n");
		else if (!card_had_valid_save && save_count == 0)
			FntPrint(-1, "MEMORY CARD SLOT 1: BLANK (WILL SAVE)\n");
		else
			FntPrint(-1, "MEMORY CARD SLOT 1: OK\n");
		FntPrint(-1, "%s  D-PAD L/R: SPIN SPEED\n", have_pad ? "X: SAVE" : "(NO PAD)");

		display();
	}

	return 0;
}
