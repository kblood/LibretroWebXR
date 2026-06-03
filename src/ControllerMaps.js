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

// --- Multiplayer key routing (players 2-4) ---------------------------------
//
// Player 1 keeps the historical double-dispatch above (webretro cfg key + RA
// stock key) for resilience. Players 2-4 are NEW: RetroArch ships no stock
// keyboard defaults for them, so we fully control their binds via
// retroarch.cfg (see [[src/RetroArchConfig.js]]). Each plugged controller
// drives the player number of the console port it's plugged into; the cable
// system ([[src/CableMgr.js]]) sets that index.
//
// EXTRA_PLAYER_KEYS maps each logical RetroPad button to ONE KeyboardEvent
// `code` per player. The allocation is deliberately collision-free against
// player 1's keys (letters a,d,e,g,h,i,j,k,l,o,p,q,r,s,t,w,x,y + comma +
// arrows/enter/space/rshift) and the f1-f4 hotkeys — a unit test asserts no
// overlaps. EXTRA_KEY_DEFS gives the DOM payload for each code; RA_KEY_NAME
// gives the retroarch.cfg key string. All three are the single source of
// truth shared by GameInputMgr (dispatch) and RetroArchConfig (binds).
export const EXTRA_PLAYER_KEYS = {
  2: {
    Up: 'Digit1', Down: 'Digit2', Left: 'Digit3', Right: 'Digit4',
    A: 'Digit5', B: 'Digit6', X: 'Digit7', Y: 'Digit8',
    L: 'KeyB', R: 'KeyC', Start: 'KeyF', Select: 'KeyM',
  },
  3: {
    Up: 'F5', Down: 'F6', Left: 'F7', Right: 'F8',
    A: 'F9', B: 'F10', X: 'F11', Y: 'F12',
    L: 'Digit9', R: 'Digit0', Start: 'KeyN', Select: 'KeyV',
  },
  4: {
    // Down is a keypad key, not KeyZ: 'z' is player 1's RA stock B button
    // (RETROPAD_KEYS.B = ['KeyG','KeyZ']) so KeyZ would fire P1's B too. Every
    // letter is already taken by P1/P2/P3, so P4 borrows the keypad here.
    Up: 'KeyU', Down: 'Numpad2', Left: 'Backquote', Right: 'Minus',
    A: 'Equal', B: 'BracketLeft', X: 'BracketRight', Y: 'Semicolon',
    L: 'Quote', R: 'Period', Start: 'Slash', Select: 'Backslash',
  },
};

// DOM KeyboardEvent payloads for every code used by players 2-4. (Player 1's
// codes live in GameInputMgr.KEY_TABLE — kept there so that proven path is
// untouched.) GameInputMgr merges these in at construction.
export const EXTRA_KEY_DEFS = {
  Digit1: { code: 'Digit1', key: '1', keyCode: 49 },
  Digit2: { code: 'Digit2', key: '2', keyCode: 50 },
  Digit3: { code: 'Digit3', key: '3', keyCode: 51 },
  Digit4: { code: 'Digit4', key: '4', keyCode: 52 },
  Digit5: { code: 'Digit5', key: '5', keyCode: 53 },
  Digit6: { code: 'Digit6', key: '6', keyCode: 54 },
  Digit7: { code: 'Digit7', key: '7', keyCode: 55 },
  Digit8: { code: 'Digit8', key: '8', keyCode: 56 },
  Digit9: { code: 'Digit9', key: '9', keyCode: 57 },
  Digit0: { code: 'Digit0', key: '0', keyCode: 48 },
  F5:  { code: 'F5',  key: 'F5',  keyCode: 116 },
  F6:  { code: 'F6',  key: 'F6',  keyCode: 117 },
  F7:  { code: 'F7',  key: 'F7',  keyCode: 118 },
  F8:  { code: 'F8',  key: 'F8',  keyCode: 119 },
  F9:  { code: 'F9',  key: 'F9',  keyCode: 120 },
  F10: { code: 'F10', key: 'F10', keyCode: 121 },
  F11: { code: 'F11', key: 'F11', keyCode: 122 },
  F12: { code: 'F12', key: 'F12', keyCode: 123 },
  KeyB: { code: 'KeyB', key: 'b', keyCode: 66 },
  KeyC: { code: 'KeyC', key: 'c', keyCode: 67 },
  KeyF: { code: 'KeyF', key: 'f', keyCode: 70 },
  KeyM: { code: 'KeyM', key: 'm', keyCode: 77 },
  KeyN: { code: 'KeyN', key: 'n', keyCode: 78 },
  KeyU: { code: 'KeyU', key: 'u', keyCode: 85 },
  KeyV: { code: 'KeyV', key: 'v', keyCode: 86 },
  Numpad2: { code: 'Numpad2', key: '2', keyCode: 98 },
  Minus:        { code: 'Minus',        key: '-',  keyCode: 189 },
  Equal:        { code: 'Equal',        key: '=',  keyCode: 187 },
  BracketLeft:  { code: 'BracketLeft',  key: '[',  keyCode: 219 },
  BracketRight: { code: 'BracketRight', key: ']',  keyCode: 221 },
  Semicolon:    { code: 'Semicolon',    key: ';',  keyCode: 186 },
  Quote:        { code: 'Quote',        key: "'",  keyCode: 222 },
  Period:       { code: 'Period',       key: '.',  keyCode: 190 },
  Slash:        { code: 'Slash',        key: '/',  keyCode: 191 },
  Backslash:    { code: 'Backslash',    key: '\\', keyCode: 220 },
  Backquote:    { code: 'Backquote',    key: '`',  keyCode: 192 },
};

// DOM code -> retroarch.cfg key string (input_playerN_<btn> = "<name>").
export const RA_KEY_NAME = {
  Digit1: 'num1', Digit2: 'num2', Digit3: 'num3', Digit4: 'num4', Digit5: 'num5',
  Digit6: 'num6', Digit7: 'num7', Digit8: 'num8', Digit9: 'num9', Digit0: 'num0',
  F5: 'f5', F6: 'f6', F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
  KeyB: 'b', KeyC: 'c', KeyF: 'f', KeyM: 'm', KeyN: 'n', KeyU: 'u', KeyV: 'v', Numpad2: 'keypad2',
  Minus: 'minus', Equal: 'equals', BracketLeft: 'leftbracket', BracketRight: 'rightbracket',
  Semicolon: 'semicolon', Quote: 'quote', Period: 'period', Slash: 'slash',
  Backslash: 'backslash', Backquote: 'backquote',
};
