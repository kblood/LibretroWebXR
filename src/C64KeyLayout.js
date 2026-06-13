// C64 keyboard layout data + KeyboardEvent mapping for the VICE/x64 libretro
// core. Pure module: no THREE, no DOM. Safe to import in Node for unit tests.
//
// ------------------------------------------------------------------
// LAYOUT MODEL
// ------------------------------------------------------------------
// The physical C64 keyboard has 66 keys arranged in 8 rows, but the
// top "function" column and the right-side cursor cluster overlap
// those rows. For the VR panel we model the keyboard as a uniform
// grid of cells (COLS × ROWS). Each key occupies one or more cells
// via its `col`, `row`, `w` (width in cells), `h` (height in cells)
// fields. The reference grid is:
//
//   COLS = 20  (max physical columns, with wide keys using w > 1)
//   ROWS = 5   (rows 0-4, top to bottom)
//
// Row layout matches the physical C64:
//   row 0 : ← 1 2 3 4 5 6 7 8 9 0 + - £ CLR/HOME DEL   [F1] [F3] [F5] [F7]
//   row 1 : CTRL Q W E R T Y U I O P @ * ↑  RESTORE
//   row 2 : RUN/STOP LOCK A S D F G H J K L : ; = RETURN
//   row 3 : C= LSHIFT Z X C V B N M , . /  RSHIFT  [↑][↓]
//   row 4 : (gap) SPACE (gap)               [←][→]
//
// Function keys are placed in a separate column block on the right
// side (cols 17-19), spanning rows 0-3 (F1/F3/F5/F7 in pairs).
//
// ------------------------------------------------------------------
// KEYEVENT MAPPING NOTES
// ------------------------------------------------------------------
// The VICE/x64 libretro web core receives KeyboardEvent objects via
// document.dispatchEvent() (see [[src/EmulatorClient.js]]). It maps
// these to C64 keyboard matrix entries. The browser `code` field is
// positional; `key` and `keyCode` carry the character value.
//
// Standard alphanumeric keys use their natural browser codes.
// C64-specific keys and symbols are mapped to browser keys that
// VICE's default keyboard mapping (positional/symbolic) interprets:
//
//   C64 key        → browser code         notes
//   ─────────────────────────────────────────────────────────────────
//   RUN/STOP       → Escape               VICE maps Esc → RESTORE too
//                                          in some configs, so we use
//                                          Escape as the common default.
//                                          **UNCERTAIN** — some VICE
//                                          configs map Esc→RESTORE and
//                                          Tab→RUN/STOP. If RUN/STOP
//                                          doesn't work, try Tab.
//   CLR/HOME       → Home                 standard
//   DEL (C64 del)  → Backspace            C64 "DEL" is really backspace
//   RESTORE        → PageUp               VICE default
//   RETURN         → Enter                standard
//   CURSOR UP      → ArrowUp              standard (shifted cursor down)
//   CURSOR DOWN    → ArrowDown            standard
//   CURSOR LEFT    → ArrowLeft            standard (shifted cursor right)
//   CURSOR RIGHT   → ArrowRight           standard
//   £ (pound)      → Backslash            VICE positional: BracketRight
//                                          **UNCERTAIN** — varies by
//                                          VICE keyboard map (symbolic
//                                          vs positional). Backslash is
//                                          the safest single-byte code.
//   ↑ (up-arrow/   → BracketRight         positional for ^
//      power sign)
//   ← (left-arrow/ → Backquote            positional for ←
//      back arrow)
//   @ symbol       → BracketLeft          VICE positional
//   * symbol       → Quote (')            VICE positional: shift-@
//                                          **UNCERTAIN** — depends on
//                                          VICE keyboard layout setting.
//   + symbol       → Equal                standard US keyboard
//   - symbol       → Minus                standard
//   : colon        → Semicolon            VICE positional
//   ; semicolon    → Quote (')            **UNCERTAIN** — VICE positional
//                                          maps ; to left of : — we
//                                          approximate with Backslash.
//   = equals       → Equal                **UNCERTAIN** — C64 = is a
//                                          separate key; using Equal;
//                                          may conflict with + mapping.
//   LSHIFT         → ShiftLeft            standard
//   RSHIFT         → ShiftRight           standard
//   CTRL           → Tab                  VICE default positional
//                                          **UNCERTAIN** — some maps
//                                          use LeftControl or Tab.
//   C= (Commodore) → LeftAlt              VICE default
//                                          **UNCERTAIN** — VICE's
//                                          positional map uses LeftAlt
//                                          but this can vary.
//   LOCK (shift    → CapsLock             standard
//      lock)
//   F1             → F1                   (F2 is Shift+F1 on C64)
//   F3             → F3
//   F5             → F5
//   F7             → F7
//   SPACE          → Space                standard
//
// Where a C64 symbol key has `shifted: true` in its entry, a
// Shift modifier must be held in the event — the caller is
// responsible for dispatching the ShiftLeft keydown before the
// key and releasing it after (C64Keyboard.press() handles this).
// **CURRENTLY** the shifted flag is informational only — the panel
// dispatches the bare key code and lets the user manage shift state
// from the keyboard. This avoids accidental modifier injection during
// normal typing.

// Grid dimensions.
export const COLS = 20;
export const ROWS = 5;

// Cell size in normalised [0,1] UV space.
const CELL_W = 1 / COLS;
const CELL_H = 1 / ROWS;

// ------------------------------------------------------------------
// ROW DEFINITIONS
// Each entry: { id, label, col, row, w?, h?, code, key, keyCode,
//               location?, shifted? }
// w/h default to 1 if omitted.
// `id` is a stable string used as the hit-test key and for
// press()/release() calls. Labels are display strings.
// ------------------------------------------------------------------

// Row 0 — number row + function keys
const ROW0 = [
  { id: 'back_arrow', label: '←',       col: 0,  row: 0, code: 'Backquote',    key: '`',  keyCode: 192 },
  { id: '1',          label: '1',        col: 1,  row: 0, code: 'Digit1',       key: '1',  keyCode: 49  },
  { id: '2',          label: '2',        col: 2,  row: 0, code: 'Digit2',       key: '2',  keyCode: 50  },
  { id: '3',          label: '3',        col: 3,  row: 0, code: 'Digit3',       key: '3',  keyCode: 51  },
  { id: '4',          label: '4',        col: 4,  row: 0, code: 'Digit4',       key: '4',  keyCode: 52  },
  { id: '5',          label: '5',        col: 5,  row: 0, code: 'Digit5',       key: '5',  keyCode: 53  },
  { id: '6',          label: '6',        col: 6,  row: 0, code: 'Digit6',       key: '6',  keyCode: 54  },
  { id: '7',          label: '7',        col: 7,  row: 0, code: 'Digit7',       key: '7',  keyCode: 55  },
  { id: '8',          label: '8',        col: 8,  row: 0, code: 'Digit8',       key: '8',  keyCode: 56  },
  { id: '9',          label: '9',        col: 9,  row: 0, code: 'Digit9',       key: '9',  keyCode: 57  },
  { id: '0',          label: '0',        col: 10, row: 0, code: 'Digit0',       key: '0',  keyCode: 48  },
  { id: 'plus',       label: '+',        col: 11, row: 0, code: 'Equal',        key: '+',  keyCode: 187 },
  { id: 'minus',      label: '-',        col: 12, row: 0, code: 'Minus',        key: '-',  keyCode: 189 },
  { id: 'pound',      label: '£',        col: 13, row: 0, code: 'Backslash',    key: '\\', keyCode: 220 },
  { id: 'clr_home',   label: 'CLR\nHOM', col: 14, row: 0, code: 'Home',         key: 'Home', keyCode: 36 },
  { id: 'del',        label: 'DEL',      col: 15, row: 0, code: 'Backspace',    key: 'Backspace', keyCode: 8 },
  // Function keys — right block, col 17-19, rows 0-3 (two per column, F1/F3/F5/F7)
  { id: 'f1',         label: 'F1',       col: 17, row: 0, code: 'F1',           key: 'F1', keyCode: 112 },
  { id: 'f3',         label: 'F3',       col: 18, row: 0, code: 'F3',           key: 'F3', keyCode: 114 },
  { id: 'f5',         label: 'F5',       col: 19, row: 0, code: 'F5',           key: 'F5', keyCode: 116 },
];

// Row 1 — QWERTY row
const ROW1 = [
  { id: 'ctrl',    label: 'CTRL',  col: 0,  row: 1, w: 2, code: 'Tab',          key: 'Tab',        keyCode: 9  },
  { id: 'q',       label: 'Q',     col: 2,  row: 1,       code: 'KeyQ',         key: 'q',          keyCode: 81 },
  { id: 'w',       label: 'W',     col: 3,  row: 1,       code: 'KeyW',         key: 'w',          keyCode: 87 },
  { id: 'e',       label: 'E',     col: 4,  row: 1,       code: 'KeyE',         key: 'e',          keyCode: 69 },
  { id: 'r',       label: 'R',     col: 5,  row: 1,       code: 'KeyR',         key: 'r',          keyCode: 82 },
  { id: 't',       label: 'T',     col: 6,  row: 1,       code: 'KeyT',         key: 't',          keyCode: 84 },
  { id: 'y',       label: 'Y',     col: 7,  row: 1,       code: 'KeyY',         key: 'y',          keyCode: 89 },
  { id: 'u',       label: 'U',     col: 8,  row: 1,       code: 'KeyU',         key: 'u',          keyCode: 85 },
  { id: 'i',       label: 'I',     col: 9,  row: 1,       code: 'KeyI',         key: 'i',          keyCode: 73 },
  { id: 'o',       label: 'O',     col: 10, row: 1,       code: 'KeyO',         key: 'o',          keyCode: 79 },
  { id: 'p',       label: 'P',     col: 11, row: 1,       code: 'KeyP',         key: 'p',          keyCode: 80 },
  { id: 'at',      label: '@',     col: 12, row: 1,       code: 'BracketLeft',  key: '[',          keyCode: 219 },
  { id: 'asterisk',label: '*',     col: 13, row: 1,       code: 'BracketRight', key: ']',          keyCode: 221 },
  // UNCERTAIN: C64 ↑ (power/up-arrow sign) has no direct US key. IntlBackslash
  // is the ISO-keyboard key between LShift and Z; positional VICE maps it here.
  // If your VICE build uses a symbolic map, this may need a different binding.
  { id: 'up_arrow',label: '↑',     col: 14, row: 1,       code: 'IntlBackslash', key: '\\',        keyCode: 220 },
  { id: 'restore', label: 'RSTR',  col: 15, row: 1, w: 2, code: 'PageUp',       key: 'PageUp',     keyCode: 33  },
  // F7 is in the right function-key block at col 19 row 1 (paired with row 0's F5 slot)
  { id: 'f7',      label: 'F7',    col: 19, row: 1,       code: 'F7',           key: 'F7',         keyCode: 118 },
];

// Row 2 — home row (A S D F ...)
const ROW2 = [
  { id: 'run_stop',label: 'RUN\nSTP', col: 0, row: 2, w: 2, code: 'Escape',    key: 'Escape',     keyCode: 27  },
  { id: 'lock',    label: 'LOCK',  col: 2,  row: 2,       code: 'CapsLock',    key: 'CapsLock',   keyCode: 20  },
  { id: 'a',       label: 'A',     col: 3,  row: 2,       code: 'KeyA',        key: 'a',          keyCode: 65  },
  { id: 's',       label: 'S',     col: 4,  row: 2,       code: 'KeyS',        key: 's',          keyCode: 83  },
  { id: 'd',       label: 'D',     col: 5,  row: 2,       code: 'KeyD',        key: 'd',          keyCode: 68  },
  { id: 'f',       label: 'F',     col: 6,  row: 2,       code: 'KeyF',        key: 'f',          keyCode: 70  },
  { id: 'g',       label: 'G',     col: 7,  row: 2,       code: 'KeyG',        key: 'g',          keyCode: 71  },
  { id: 'h',       label: 'H',     col: 8,  row: 2,       code: 'KeyH',        key: 'h',          keyCode: 72  },
  { id: 'j',       label: 'J',     col: 9,  row: 2,       code: 'KeyJ',        key: 'j',          keyCode: 74  },
  { id: 'k',       label: 'K',     col: 10, row: 2,       code: 'KeyK',        key: 'k',          keyCode: 75  },
  { id: 'l',       label: 'L',     col: 11, row: 2,       code: 'KeyL',        key: 'l',          keyCode: 76  },
  { id: 'colon',   label: ':',     col: 12, row: 2,       code: 'Semicolon',   key: ';',          keyCode: 186 },
  { id: 'semicolon',label: ';',    col: 13, row: 2,       code: 'Quote',       key: "'",          keyCode: 222 },
  // UNCERTAIN: C64 = (equals) is a standalone key with no US-keyboard positional
  // equivalent. IntlYen is the JIS ¥/| key; some VICE builds accept it here.
  // If VICE ignores this, wire the key to Shift+Minus or use a custom retroarch
  // bind. This is the hardest C64 key to map portably.
  { id: 'equals',  label: '=',     col: 14, row: 2,       code: 'IntlYen',     key: '\\',         keyCode: 220 },
  { id: 'return',  label: 'RET',   col: 15, row: 2, w: 2, code: 'Enter',       key: 'Enter',      keyCode: 13  },
];

// Row 3 — bottom letter row
const ROW3 = [
  { id: 'cbm',     label: 'C=',    col: 0,  row: 3,       code: 'LeftAlt',     key: 'Alt',        keyCode: 18, location: 1 },
  { id: 'lshift',  label: 'SHFT',  col: 1,  row: 3, w: 2, code: 'ShiftLeft',   key: 'Shift',      keyCode: 16, location: 1 },
  { id: 'z',       label: 'Z',     col: 3,  row: 3,       code: 'KeyZ',        key: 'z',          keyCode: 90  },
  { id: 'x',       label: 'X',     col: 4,  row: 3,       code: 'KeyX',        key: 'x',          keyCode: 88  },
  { id: 'c',       label: 'C',     col: 5,  row: 3,       code: 'KeyC',        key: 'c',          keyCode: 67  },
  { id: 'v',       label: 'V',     col: 6,  row: 3,       code: 'KeyV',        key: 'v',          keyCode: 86  },
  { id: 'b',       label: 'B',     col: 7,  row: 3,       code: 'KeyB',        key: 'b',          keyCode: 66  },
  { id: 'n',       label: 'N',     col: 8,  row: 3,       code: 'KeyN',        key: 'n',          keyCode: 78  },
  { id: 'm',       label: 'M',     col: 9,  row: 3,       code: 'KeyM',        key: 'm',          keyCode: 77  },
  { id: 'comma',   label: ',',     col: 10, row: 3,       code: 'Comma',       key: ',',          keyCode: 188 },
  { id: 'period',  label: '.',     col: 11, row: 3,       code: 'Period',      key: '.',          keyCode: 190 },
  { id: 'slash',   label: '/',     col: 12, row: 3,       code: 'Slash',       key: '/',          keyCode: 191 },
  { id: 'rshift',  label: 'SHFT',  col: 13, row: 3, w: 2, code: 'ShiftRight',  key: 'Shift',      keyCode: 16, location: 2 },
  // Cursor keys — right side of row 3 / row 4 (physical C64 layout)
  { id: 'cursor_up',   label: '↑', col: 15, row: 3,       code: 'ArrowUp',    key: 'ArrowUp',    keyCode: 38  },
  { id: 'cursor_down', label: '↓', col: 15, row: 4,       code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40  },
];

// Row 4 — spacebar row + cursor left/right
const ROW4 = [
  { id: 'space',        label: 'SPACE', col: 4, row: 4, w: 8, code: 'Space',      key: ' ',          keyCode: 32  },
  { id: 'cursor_left',  label: '←',     col: 16, row: 4,      code: 'ArrowLeft',  key: 'ArrowLeft',  keyCode: 37  },
  { id: 'cursor_right', label: '→',     col: 17, row: 4,      code: 'ArrowRight', key: 'ArrowRight', keyCode: 39  },
];

// All rows concatenated into a flat array.
export const C64_ROWS = [ROW0, ROW1, ROW2, ROW3, ROW4];

// Flat list of every key definition, for iteration.
export const C64_KEYS = C64_ROWS.flat();

// ------------------------------------------------------------------
// BUILD A FAST LOOKUP MAP: id → key definition
// ------------------------------------------------------------------
const KEY_MAP = new Map(C64_KEYS.map((k) => [k.id, k]));

/**
 * Return the KeyboardEvent fields for a key id, or null if unknown.
 *
 *   { code, key, keyCode, location? }
 *
 * `location` is only present for modifier keys (Shift, Alt, etc.).
 * The caller passes these directly to client.sendInput(eventType,
 * code, key, keyCode, location).
 *
 * @param {string} keyId
 * @returns {{ code: string, key: string, keyCode: number, location?: number } | null}
 */
export function keyEventFor(keyId) {
  const k = KEY_MAP.get(keyId);
  if (!k) return null;
  const ev = { code: k.code, key: k.key, keyCode: k.keyCode };
  if (k.location !== undefined) ev.location = k.location;
  return ev;
}

// ------------------------------------------------------------------
// BUILD SPATIAL INDEX FOR HIT-TESTING
// ------------------------------------------------------------------
// We build a flat list of { id, x0, y0, x1, y1 } bounding boxes in
// normalised [0,1] UV space (U = left→right, V = top→bottom).
//
// A key at grid position (col, row) with width w and height h spans:
//   x0 = col / COLS,     x1 = (col + w) / COLS
//   y0 = row / ROWS,     y1 = (row + h) / ROWS
//
// Partial coverage (empty grid cells) is intentional — gaps between
// keys register as no-hit.

const KEY_BOXES = C64_KEYS.map((k) => {
  const w = k.w ?? 1;
  const h = k.h ?? 1;
  return {
    id:  k.id,
    x0:  k.col / COLS,
    y0:  k.row / ROWS,
    x1: (k.col + w) / COLS,
    y1: (k.row + h) / ROWS,
  };
});

/**
 * Map normalised panel coordinates (u, v) to the key id at that
 * position, or null if no key covers the point.
 *
 * u: 0 = left edge, 1 = right edge
 * v: 0 = top edge,  1 = bottom edge
 *
 * Uses a linear scan over ~70 keys — fast enough for VR frame rates.
 * The scan order preserves declaration order (first match wins, which
 * matters for any overlapping bounding boxes, though there are none
 * in the default layout).
 *
 * @param {number} u  normalised X [0,1]
 * @param {number} v  normalised Y [0,1]
 * @returns {string | null}
 */
export function keyAt(u, v) {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  for (const box of KEY_BOXES) {
    if (u >= box.x0 && u < box.x1 && v >= box.y0 && v < box.y1) {
      return box.id;
    }
  }
  return null;
}

/**
 * Return the key definition object for an id, or null.
 * Exported for callers that need label / grid coords directly.
 *
 * @param {string} keyId
 * @returns {object | null}
 */
export function keyDef(keyId) {
  return KEY_MAP.get(keyId) ?? null;
}
