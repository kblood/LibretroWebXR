// Per-system Quest controller → libretro RetroPad mapping.
//
// Each system has a `holding` map (applied to whichever Quest controller
// currently holds the gamepad mesh) and a `free` map (applied to the
// other controller). For simple 4-button systems both maps are identical
// — redundancy doesn't hurt. For systems with more than 4 buttons (SNES,
// Genesis, GBA) the maps split the buttons across both hands so the user
// can press multiple inputs simultaneously — e.g. SNES "run and jump"
// needs B (face A on holding hand) + Y (trigger on holding hand) +
// movement (stick on free hand), which is impossible on one hand alone.
//
// `RETROPAD_KEYS` is the lower half: each logical RetroPad button maps
// to a list of KeyboardEvent.code strings. We send BOTH the webretro
// cfg-key AND the RA-stock-default key for each button so the controller
// works regardless of whether retroarch.cfg loaded — see [[src/
// RetroArchConfig.js]] and the resilience comment in [[src/
// EmulatorClient.js]].

// Logical RetroPad button → list of key codes to dispatch (both webretro
// cfg-aware and RA stock defaults, where they differ).
export const RETROPAD_KEYS = {
  A:      ['KeyH', 'KeyX'],          // cfg: h, stock: x
  B:      ['KeyG', 'KeyZ'],          // cfg: g, stock: z
  X:      ['KeyY', 'KeyS'],          // cfg: y, stock: s
  Y:      ['KeyT', 'KeyA'],          // cfg: t, stock: a
  L:      ['KeyE', 'KeyQ'],          // cfg: e, stock: q
  R:      ['KeyP', 'KeyW'],          // cfg: p, stock: w
  L2:     ['KeyR'],                  // cfg only
  R2:     ['KeyO'],                  // cfg only
  Start:  ['Enter'],
  Select: ['Space', 'ShiftRight'],
  Up:     ['ArrowUp'],
  Down:   ['ArrowDown'],
  Left:   ['ArrowLeft'],
  Right:  ['ArrowRight'],
};

// A 4-button mapping: trigger=A, faceA=B, faceB=Start, stickClick=Select.
// Both hands send the same — for NES / GB / SMS-class systems where one
// controller is plenty.
const NES_LIKE = {
  holding: { trigger: 'A', faceA: 'B', faceB: 'Start', stickClick: 'Select' },
  free:    { trigger: 'A', faceA: 'B', faceB: 'Start', stickClick: 'Select' },
};

// 6-button mapping for SNES (and SNES-style GBA games). Holding hand
// owns the four primary face buttons; free hand owns shoulders + Start/
// Select. With this layout you can hold the gamepad in your right hand
// (trigger=Y for run, face A=B for jump, both pressable at once) while
// the left hand handles the d-pad and shoulder buttons.
const SNES_LIKE = {
  holding: { trigger: 'Y', faceA: 'A', faceB: 'B',     stickClick: 'R'      },
  free:    { trigger: 'L', faceA: 'X', faceB: 'Start', stickClick: 'Select' },
};

// GBA: 4 face-ish + L/R. Reuses the SNES layout but moves Start onto the
// holding hand's faceB (GBA games tend to press Start mid-action less).
const GBA_LIKE = {
  holding: { trigger: 'L', faceA: 'A', faceB: 'B',     stickClick: 'Select' },
  free:    { trigger: 'R', faceA: 'A', faceB: 'Start', stickClick: 'Select' },
};

// PC Engine: I, II, Select, Run. RetroPad mapping for PCE is A=II, B=I,
// Start=Run, Select=Select. We put I (jump-equivalent) on faceA and II on
// the trigger so the user can press both.
const PCE_LIKE = {
  holding: { trigger: 'A', faceA: 'B', faceB: 'Start', stickClick: 'Select' },
  free:    { trigger: 'A', faceA: 'B', faceB: 'Start', stickClick: 'Select' },
};

// Atari 2600: single fire button + Reset/Select switches. NES-like is
// fine — the cores accept RetroPad A for Fire and Start for Reset.
const ATARI_LIKE = NES_LIKE;

// Virtual Boy: A, B, L, R, Start, Select, two D-pads. We treat it as
// SNES-like; the second D-pad sits on the free-hand stick if anyone
// actually uses it.
const VB_LIKE = {
  holding: { trigger: 'B', faceA: 'A', faceB: 'Start', stickClick: 'Select' },
  free:    { trigger: 'L', faceA: 'R', faceB: 'Start', stickClick: 'Select' },
};

// Sega Master System / Game Gear: 2 face buttons + Pause. Per libretro
// docs, Button 1 = RetroPad B (jump in Alex Kidd), Button 2 = RetroPad A.
// Default NES_LIKE binds trigger→A (Button 2) and faceA→B (Button 1) so
// jump is on the X/A face button. That feels backwards in VR — the
// trigger is the natural "do the thing" finger — so swap them here so
// trigger→B (jump) and faceA→A (secondary action).
const SMS_LIKE = {
  holding: { trigger: 'B', faceA: 'A', faceB: 'Start', stickClick: 'Select' },
  free:    { trigger: 'B', faceA: 'A', faceB: 'Start', stickClick: 'Select' },
};

// Genesis / Mega Drive: A, B, C, X, Y, Z, Start, Mode. The 3-button
// classic layout (A/B/C) is what most users will want; we put C on the
// trigger (primary attack in Sonic), B on faceA, A on faceB.
const GENESIS_LIKE = {
  holding: { trigger: 'A', faceA: 'B', faceB: 'Start', stickClick: 'Select' },
  free:    { trigger: 'X', faceA: 'Y', faceB: 'L',     stickClick: 'Select' },
};

// C64: joystick + space + F1/F7. Treat joystick fire as B (jump in C64
// platformers), Run/Stop on faceB.
const C64_LIKE = NES_LIKE;

// Keys here MUST match the lowercase `system` values in
// public/roms/manifest.json. Any unmapped system falls back to NES_LIKE.
export const SYSTEM_MAPS = {
  nes:       NES_LIKE,
  gb:        NES_LIKE,
  gbc:       NES_LIKE,
  atari2600: ATARI_LIKE,
  sms:       SMS_LIKE,
  gg:        SMS_LIKE,
  vb:        VB_LIKE,
  snes:      SNES_LIKE,
  genesis:   GENESIS_LIKE,
  gba:       GBA_LIKE,
  pce:       PCE_LIKE,
  c64:       C64_LIKE,
  default:   NES_LIKE,
};

export function mapForSystem(system) {
  return SYSTEM_MAPS[system] || SYSTEM_MAPS.default;
}
