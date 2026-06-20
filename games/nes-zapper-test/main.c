// LWX Zapper Test — a CC0 NES diagnostic ROM for LibretroWebXR light-gun support.
//
// NOT a game: a deliberately minimal target that makes the NES Zapper's two
// status bits directly observable, so we can verify the browser->core lightgun
// path (synthetic mouse position + click -> RetroArch lightgun -> $4017) without
// guessing bit polarity.
//
// The screen is black with a big WHITE box in the centre. The Zapper reports two
// things on port 2 ($4017): bit 3 = light sense (bright pixel under the muzzle?),
// bit 4 = trigger. Each frame we read $4017 and recolour the BACKDROP (the colour
// shown wherever a pixel is transparent, i.e. the black surround) from a 4-entry
// table keyed by (light, trigger):
//
//   00 none    -> black   muzzle off-target, not firing
//   01 light   -> blue    muzzle over the white box (light), not firing
//   10 trigger -> red     firing at the dark surround (no light)
//   11 both    -> green   firing at the white box (a "hit")
//
// The white box itself uses colour index 1 (always white) so the light sensor
// has a bright target regardless of the backdrop. Aim + click in the browser and
// watch the surround change colour: blue proves the muzzle POSITION reached the
// core, red/green prove the TRIGGER did. CC0.

#include "neslib.h"

typedef unsigned char u8;

// Port 2 controller/Zapper register. The Zapper's light (D3) and trigger (D4)
// bits are level signals (not part of the serial shift), so a plain read returns
// them — D0's controller-2 serial bit is simply masked away.
#define CTRL_PORT1 (*(volatile u8*)0x4016)
#define CTRL_PORT2 (*(volatile u8*)0x4017)

// display.sinc (vendored) references a C-side zeropage byte.
#pragma bss-name (push,"ZEROPAGE")
#pragma data-name (push,"ZEROPAGE")
u8 oam_off;
#pragma data-name(pop)
#pragma bss-name (pop)

// palette: index 0 = backdrop (recoloured at runtime), 1 = white target.
static const u8 PALETTE[32] = {
  0x0f, 0x30, 0x16, 0x2a,  0x0f, 0x30, 0x16, 0x2a,
  0x0f, 0x30, 0x16, 0x2a,  0x0f, 0x30, 0x16, 0x2a,
  0x0f, 0x30, 0x16, 0x2a,  0x0f, 0x30, 0x16, 0x2a,
  0x0f, 0x30, 0x16, 0x2a,  0x0f, 0x30, 0x16, 0x2a,
};

// backdrop colour per state: index = lightBit | (triggerBit << 1)
static const u8 STATE_COL[4] = {
  0x0f,   // 00 none    black
  0x12,   // 01 light   blue
  0x16,   // 10 trigger red
  0x2a,   // 11 both    green
};

static u8 cx, cy, z, idx, light, trig, i;

void main(void) {
  ppu_off();
  pal_all(PALETTE);

  // Black field with a white box (cols 8..23, rows 6..21) for the light sensor.
  vram_adr(NAMETABLE_A);
  for (cy = 0; cy < 30; ++cy)
    for (cx = 0; cx < 32; ++cx)
      vram_put((cx >= 8 && cx < 24 && cy >= 6 && cy < 22) ? 1 : 0);
  vram_adr(0x23c0);
  vram_fill(0, 64);            // whole screen uses bg palette 0

  ppu_on_all();

  while (1) {
    // The Zapper photodiode only senses light while the bright pixel is being
    // actively scanned out, so a single read during vblank always sees dark.
    // Poll $4017 many times across the visible frame, latching any light (D3)
    // or trigger (D4) seen; the trigger is a level bit so it latches regardless
    // of timing. (Port 2 = $4017 for a port-2 Zapper.)
    light = 0;
    trig = 0;
    for (i = 0; i < 250; ++i) {
      z = CTRL_PORT2;
      light |= (z >> 3) & 1;
      trig  |= (z >> 4) & 1;
    }
    ppu_wait_nmi();
    idx = light | (trig << 1);
    pal_col(0, STATE_COL[idx]);
  }
}
