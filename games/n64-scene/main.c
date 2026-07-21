/* LWX N64 Orbit Cubes - CC0 libdragon homebrew.
 *
 * Real 3D content (not just a flat-fill smoke test): a hand-rolled
 * software transform pipeline projects a rotating cube each frame and
 * hands the RDP six flat-shaded faces (12 filled triangles) to rasterize.
 * Exists as this project's stand-in "representative 3D title" for N64
 * Phase N0 fps measurement (docs/research/n64-wasm-jit-plan.md) - no
 * commercial N64 ROM is available or sourced for this repo, so an authored
 * CC0 scene fills the same role, matching every other system here
 * (games/nes-gallery, games/snes-scope, games/ps2-guncon-range).
 *
 * Also exercises two of the other Phase N0 verification items in this ROM:
 *  - analog stick input (continuous x/y, not just digital direction)
 *  - EEPROM save (a persistent boot counter)
 *
 * Audio HLE: a continuous 220Hz sine tone, pumped via the polling
 * audio_can_write()/audio_write() model (the buffer-callback variant never
 * fired any events on this core). This used to crash the worker with a WASM
 * linear-memory OOB trap - root cause was a real core-side bug in
 * mupen64plus-core's ai_controller.c, which indexed RDRAM with a raw,
 * unmasked AI_DRAM_ADDR_REG value instead of wrapping it through
 * rdram_dram_address() the way si_controller.c already did. Fixed upstream
 * in the core; see docs/N64_CORE_BUILD.md for the full repro and fix.
 *
 * Note: this pinned libdragon build (anacierdem/libdragon, predates the
 * modern rdpq API) requires an explicit init_interrupts() call - see
 * docs/N64_CORE_BUILD.md's "Black-screen fix" section.
 */
#include <libdragon.h>
#include <math.h>
#include <stdlib.h>

typedef struct { float x, y, z; } vec3_t;

static const vec3_t cube_verts[8] = {
    {-1,-1,-1}, { 1,-1,-1}, { 1, 1,-1}, {-1, 1,-1},
    {-1,-1, 1}, { 1,-1, 1}, { 1, 1, 1}, {-1, 1, 1},
};

typedef struct { int v[4]; float r, g, b; } face_t;

static const face_t cube_faces[6] = {
    { {0,1,2,3}, 1.0f, 0.2f, 0.2f }, /* front  - red    */
    { {5,4,7,6}, 0.2f, 1.0f, 0.2f }, /* back   - green  */
    { {4,0,3,7}, 0.2f, 0.2f, 1.0f }, /* left   - blue   */
    { {1,5,6,2}, 1.0f, 1.0f, 0.2f }, /* right  - yellow */
    { {3,2,6,7}, 1.0f, 0.2f, 1.0f }, /* top    - magenta*/
    { {4,5,1,0}, 0.2f, 1.0f, 1.0f }, /* bottom - cyan   */
};

#define CUBE_SCALE  50.0f
#define CAM_DIST   250.0f
#define FOCAL      220.0f
#define SCREEN_CX  160.0f
#define SCREEN_CY  120.0f

static const eepfs_entry_t eeprom_files[] = {
    { "save", 8 },
};

#define AUDIO_FREQ 22050
static float audio_phase = 0.0f;

static void audio_fill(short *buf, int numsamples)
{
    for (int i = 0; i < numsamples; i++) {
        float s = sinf(audio_phase) * 6000.0f;
        audio_phase += 2.0f * (float)M_PI * 220.0f / (float)AUDIO_FREQ;
        if (audio_phase > 2.0f * (float)M_PI)
            audio_phase -= 2.0f * (float)M_PI;
        short sample = (short)s;
        buf[i * 2 + 0] = sample;
        buf[i * 2 + 1] = sample;
    }
}

int main(void)
{
    init_interrupts();
    display_init(RESOLUTION_320x240, DEPTH_16_BPP, 2, GAMMA_NONE, ANTIALIAS_RESAMPLE);
    rdp_init();
    controller_init();

    uint32_t boot_count = 0;
    if (eepfs_init(eeprom_files, 1) == EEPFS_ESUCCESS) {
        eepfs_read("save", &boot_count, sizeof(boot_count));
        boot_count++;
        eepfs_write("save", &boot_count, sizeof(boot_count));
    }

    audio_init(AUDIO_FREQ, 3);
    int audio_buflen = audio_get_buffer_length();
    short *audio_buf = malloc(sizeof(short) * 2 * audio_buflen);

    uint32_t face_color[6];
    for (int f = 0; f < 6; f++) {
        face_color[f] = graphics_make_color(
            (int)(cube_faces[f].r * 255.0f),
            (int)(cube_faces[f].g * 255.0f),
            (int)(cube_faces[f].b * 255.0f),
            255);
    }

    float yaw = 0.0f, pitch = 0.3f;

    while (1) {
        if (audio_can_write()) {
            audio_fill(audio_buf, audio_buflen);
            audio_write(audio_buf);
        }

        struct controller_data pad;
        controller_read(&pad);
        float ax = (float)pad.c[0].x / 80.0f;
        float ay = (float)pad.c[0].y / 80.0f;

        yaw   += 0.012f + ax * 0.03f;
        pitch += ay * 0.03f;
        if (pitch >  1.4f) pitch =  1.4f;
        if (pitch < -1.4f) pitch = -1.4f;

        float sy = sinf(yaw),   cy = cosf(yaw);
        float sp = sinf(pitch), cp = cosf(pitch);

        float sx[8], syy[8], wz[8];
        for (int i = 0; i < 8; i++) {
            float x = cube_verts[i].x * CUBE_SCALE;
            float y = cube_verts[i].y * CUBE_SCALE;
            float z = cube_verts[i].z * CUBE_SCALE;

            float x1 = x * cy + z * sy;
            float z1 = -x * sy + z * cy;

            float y2 = y * cp - z1 * sp;
            float z2 = y * sp + z1 * cp;

            float zc = z2 + CAM_DIST;
            float scale = FOCAL / zc;
            sx[i]  = SCREEN_CX + x1 * scale;
            syy[i] = SCREEN_CY - y2 * scale;
            wz[i]  = zc;
        }

        float face_z[6];
        int order[6] = {0, 1, 2, 3, 4, 5};
        for (int f = 0; f < 6; f++) {
            const face_t *face = &cube_faces[f];
            face_z[f] = (wz[face->v[0]] + wz[face->v[1]] + wz[face->v[2]] + wz[face->v[3]]) * 0.25f;
        }
        for (int a = 1; a < 6; a++) {
            int key = order[a];
            float kz = face_z[key];
            int b = a - 1;
            while (b >= 0 && face_z[order[b]] < kz) {
                order[b + 1] = order[b];
                b--;
            }
            order[b + 1] = key;
        }

        display_context_t disp = display_lock();
        if (!disp) continue;

        rdp_attach_display(disp);
        rdp_set_default_clipping();
        rdp_enable_primitive_fill();
        rdp_set_primitive_color(graphics_make_color(8, 10, 18, 255));
        rdp_draw_filled_rectangle(0, 0, 320, 240);

        for (int oi = 0; oi < 6; oi++) {
            const face_t *face = &cube_faces[order[oi]];
            rdp_set_primitive_color(face_color[order[oi]]);
            int a0 = face->v[0], a1 = face->v[1], a2 = face->v[2], a3 = face->v[3];
            rdp_draw_filled_triangle(sx[a0], syy[a0], sx[a1], syy[a1], sx[a2], syy[a2]);
            rdp_draw_filled_triangle(sx[a0], syy[a0], sx[a2], syy[a2], sx[a3], syy[a3]);
        }

        rdp_detach_display();
        display_show(disp);
    }
}
