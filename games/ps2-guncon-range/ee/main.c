/*
 * LWX GunCon Range -- a minimal CC0 PS2 homebrew shooting gallery for
 * LibretroWebXR, following this project's "author our own small test game"
 * pattern (see games/nes-gallery, games/snes-scope).
 *
 * Boot + gun-polling plumbing (SIF RPC to the bundled guncon2_ldd IOP
 * module) is reused verbatim from ~/ps2-guncon2-test's proven real-USB-LDD-
 * driver harness -- see iop/guncon2_ldd/guncon2_ldd.c and
 * docs/PS2_CORE_BUILD.md's "GunCon2 input polling" section. That harness
 * only ever painted the whole screen one flat color per state; this game
 * adds actual gameplay on top using draw_clear()'s (x, y, width, height)
 * parameters (ps2sdk's draw.h) to draw a positioned target box and a
 * crosshair, not just full-screen fills.
 *
 * Gameplay: a target box appears at a random position on a dark field.
 * Aim (the crosshair follows the gun) and pull the trigger. On target =
 * HIT (green flash, +1 score, target respawns); off target = MISS (red
 * flash). 5 misses ends the round with a brief flash, then score/misses
 * reset and a new round starts immediately -- no menu, always replayable.
 */
#include <kernel.h>
#include <tamtypes.h>
#include <sifrpc.h>
#include <loadfile.h>
#include <string.h>

#include <gif_tags.h>
#include <gs_gp.h>
#include <gs_psm.h>
#include <dma.h>
#include <dma_tags.h>
#include <draw.h>
#include <graph.h>
#include <packet.h>

#include "../guncon2_rpc.h"

extern unsigned char guncon2_ldd_irx[];
extern unsigned int size_guncon2_ldd_irx;

#define SCREEN_W 640
#define SCREEN_H 448
#define TARGET_SIZE 64
#define CROSSHAIR_SIZE 10
#define MAX_MISSES 5
#define BUTTON_TRIGGER_BIT (1 << 13)

/* Exposed at a fixed EE-RAM location (via retro_get_memory_data on the host
 * side, same technique as ~/ps2-guncon2-test's g_probe) so a headless
 * verify script can read authoritative game state, not just pixels. */
typedef struct
{
    unsigned int magic;
    unsigned int connected;
    unsigned int score;
    unsigned int misses;
    int target_x;
    int target_y;
} probe_t;

#define PROBE_MAGIC 0x6a20a2e5u

volatile probe_t g_probe = { PROBE_MAGIC, 0, 0, 0, 0, 0 };

/* Small xorshift PRNG seeded from a fixed constant -- no real entropy
 * source is needed, just to spread target spawns around the field. */
static unsigned int g_rng_state = 0x12345678u;
static unsigned int next_rand(void)
{
    g_rng_state ^= g_rng_state << 13;
    g_rng_state ^= g_rng_state >> 17;
    g_rng_state ^= g_rng_state << 5;
    return g_rng_state;
}

static void respawn_target(void)
{
    g_probe.target_x = TARGET_SIZE / 2 + (int)(next_rand() % (SCREEN_W - TARGET_SIZE));
    g_probe.target_y = TARGET_SIZE / 2 + (int)(next_rand() % (SCREEN_H - TARGET_SIZE));
}

static void init_gs(framebuffer_t *frame, zbuffer_t *z)
{
    frame->width = SCREEN_W;
    frame->height = SCREEN_H;
    frame->mask = 0;
    frame->psm = GS_PSM_32;
    frame->address = graph_vram_allocate(frame->width, frame->height, frame->psm, GRAPH_ALIGN_PAGE);

    z->enable = 0;
    z->address = 0;
    z->mask = 0;
    z->zsm = 0;

    graph_initialize(frame->address, frame->width, frame->height, frame->psm, 0, 0);
}

static void init_drawing_environment(packet_t *packet, framebuffer_t *frame, zbuffer_t *z)
{
    qword_t *q = packet->data;
    q = draw_setup_environment(q, 0, frame, z);
    q = draw_finish(q);
    dma_channel_send_normal(DMA_CHANNEL_GIF, packet->data, q - packet->data, 0, 0);
    draw_wait_finish();
}

static void fill_screen(packet_t *packet, framebuffer_t *frame, int r, int g, int b)
{
    qword_t *q;
    dma_wait_fast();
    q = packet->data;
    q = draw_clear(q, 0, 0.0f, 0.0f, (float)frame->width, (float)frame->height, r, g, b);
    q = draw_finish(q);
    dma_channel_send_normal(DMA_CHANNEL_GIF, packet->data, q - packet->data, 0, 0);
    draw_wait_finish();
    graph_wait_vsync();
}

/* Background + (optionally) the target box + the crosshair, all in one DMA
 * packet/frame. bg_r/g/b flashes the backdrop on a hit/miss/game-over. */
static void draw_frame(packet_t *packet, framebuffer_t *frame, int bg_r, int bg_g, int bg_b,
                        int gun_x, int gun_y, int show_target)
{
    qword_t *q;
    int cx, cy;

    dma_wait_fast();
    q = packet->data;
    q = draw_clear(q, 0, 0.0f, 0.0f, (float)frame->width, (float)frame->height, bg_r, bg_g, bg_b);

    if(show_target)
    {
        q = draw_clear(q, 0,
                        (float)(g_probe.target_x - TARGET_SIZE / 2),
                        (float)(g_probe.target_y - TARGET_SIZE / 2),
                        (float)TARGET_SIZE, (float)TARGET_SIZE,
                        255, 200, 0);
    }

    cx = gun_x - CROSSHAIR_SIZE / 2;
    cy = gun_y - CROSSHAIR_SIZE / 2;
    if(cx < 0) cx = 0;
    if(cy < 0) cy = 0;
    if(cx > frame->width - CROSSHAIR_SIZE) cx = frame->width - CROSSHAIR_SIZE;
    if(cy > frame->height - CROSSHAIR_SIZE) cy = frame->height - CROSSHAIR_SIZE;
    q = draw_clear(q, 0, (float)cx, (float)cy, (float)CROSSHAIR_SIZE, (float)CROSSHAIR_SIZE, 255, 255, 255);

    q = draw_finish(q);
    dma_channel_send_normal(DMA_CHANNEL_GIF, packet->data, q - packet->data, 0, 0);
    draw_wait_finish();
    graph_wait_vsync();
}

int main(void)
{
    framebuffer_t frame;
    zbuffer_t z;
    packet_t *packet = packet_init(128, PACKET_NORMAL);
    int mod_res;
    SifRpcClientData_t rpc_client;
    guncon2_state_t send_dummy;
    guncon2_state_t recv_state;
    unsigned int prev_buttons = 0xffff;
    int flash_frames = 0;
    int flash_r = 20, flash_g = 20, flash_b = 40;
    int gameover_frames = 0;

    dma_channel_initialize(DMA_CHANNEL_GIF, NULL, 0);
    dma_channel_fast_waits(DMA_CHANNEL_GIF);

    init_gs(&frame, &z);
    init_drawing_environment(packet, &frame, &z);

    /* Blue: bringing SIF / the driver module up (same boot-feedback
     * convention as the driver-test harness this reuses). */
    fill_screen(packet, &frame, 0, 0, 255);

    sceSifInitRpc(0);
    SifExecModuleBuffer(guncon2_ldd_irx, size_guncon2_ldd_irx, 0, NULL, &mod_res);

    memset(&rpc_client, 0, sizeof(rpc_client));
    memset(&send_dummy, 0, sizeof(send_dummy));
    do
    {
        SifBindRpc(&rpc_client, GUNCON2_RPC_NUMBER, 0);
    } while(rpc_client.server == NULL);

    respawn_target();

    while(1)
    {
        unsigned int buttons;
        int trigger_now, trigger_edge;

        memset(&recv_state, 0, sizeof(recv_state));
        SifCallRpc(&rpc_client, 0, 0, &send_dummy, sizeof(send_dummy), &recv_state, sizeof(recv_state), NULL, NULL);

        g_probe.connected = recv_state.connected;

        if(!recv_state.connected)
        {
            fill_screen(packet, &frame, 255, 255, 0); /* yellow: waiting for the gun */
            prev_buttons = 0xffff;
            continue;
        }

        buttons = recv_state.buttons;
        trigger_now = (buttons & BUTTON_TRIGGER_BIT) == 0; /* active-low */
        trigger_edge = trigger_now && ((prev_buttons & BUTTON_TRIGGER_BIT) != 0);
        prev_buttons = buttons;

        if(gameover_frames > 0)
        {
            gameover_frames--;
            draw_frame(packet, &frame, (gameover_frames & 4) ? 255 : 0, 0, 0, recv_state.x, recv_state.y, 0);
            if(gameover_frames == 0)
            {
                g_probe.score = 0;
                g_probe.misses = 0;
                respawn_target();
            }
            continue;
        }

        if(trigger_edge)
        {
            int dx = recv_state.x - g_probe.target_x;
            int dy = recv_state.y - g_probe.target_y;
            int hit = (dx > -TARGET_SIZE / 2 && dx < TARGET_SIZE / 2 && dy > -TARGET_SIZE / 2 && dy < TARGET_SIZE / 2);
            if(hit)
            {
                g_probe.score++;
                flash_r = 0; flash_g = 255; flash_b = 0;
                flash_frames = 12;
                respawn_target();
            }
            else
            {
                g_probe.misses++;
                flash_r = 255; flash_g = 0; flash_b = 0;
                flash_frames = 12;
                if(g_probe.misses >= MAX_MISSES)
                    gameover_frames = 90;
            }
        }

        if(flash_frames > 0)
        {
            flash_frames--;
            draw_frame(packet, &frame, flash_r, flash_g, flash_b, recv_state.x, recv_state.y, 1);
        }
        else
        {
            draw_frame(packet, &frame, 20, 20, 40, recv_state.x, recv_state.y, 1);
        }
    }

    return 0;
}
