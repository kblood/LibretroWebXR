// KeyboardLayout — pure multi-layout keyboard descriptor module.
//
// Provides named keyboard layouts for the physical Keyboard device
// ([[src/Keyboard.js]]). Each layout exports a grid of key definitions
// (col, row, w, h, label, code, key, keyCode, location?) plus hit-test and
// event-mapping helpers, unified under the `getLayout(name)` API.
//
// ------------------------------------------------------------------
// LAYOUT MODEL (shared across all layouts)
// ------------------------------------------------------------------
// Keys sit in a uniform COLS × ROWS grid. Each key:
//   col, row  — top-left grid cell (0-based)
//   w, h      — width/height in cells (defaults to 1)
//   id        — stable string key used for press()/release() and hit-test
//   label     — display string (may contain '\n' for two-line caps)
//   code      — KeyboardEvent.code (positional, US QWERTY layout)
//   key       — KeyboardEvent.key (character / special value)
//   keyCode   — KeyboardEvent.keyCode (legacy; required by VICE/libretro cores)
//   location  — KeyboardEvent.location (1=left, 2=right; only on modifiers)
//
// ------------------------------------------------------------------
// PUBLIC API
// ------------------------------------------------------------------
//   export function getLayout(name: LayoutName) -> LayoutObject
//   export const LAYOUT_NAMES: string[]
//
//   LayoutObject {
//     name   : string
//     COLS   : number
//     ROWS   : number
//     keys   : KeyDef[]
//     keyAt(u: number, v: number): string | null
//     keyEventFor(id: string): { code, key, keyCode, location? } | null
//     keyDef(id: string): KeyDef | null
//   }
//
// ------------------------------------------------------------------
// C64 LAYOUT NOTE
// ------------------------------------------------------------------
// The 'c64' layout re-uses C64KeyLayout.js data verbatim (same ids,
// same codes) so that existing C64Keyboard consumers can migrate to
// KeyboardLayout without changing any key ids or event mappings.
//
// Pure module: no THREE, no DOM — importable in Node for unit tests.

// ---------------------------------------------------------------------------
// Re-export C64 data for callers that need the raw arrays.
// ---------------------------------------------------------------------------
export {
  C64_KEYS,
  C64_ROWS,
  COLS as C64_COLS,
  ROWS as C64_ROWS_COUNT,
  keyAt as c64KeyAt,
  keyEventFor as c64KeyEventFor,
  keyDef as c64KeyDef,
} from './C64KeyLayout.js';

import {
  C64_KEYS,
  COLS as C64_COLS,
  ROWS as C64_ROWS_COUNT,
  keyAt as _c64KeyAt,
  keyEventFor as _c64KeyEventFor,
  keyDef as _c64KeyDef,
} from './C64KeyLayout.js';

// ---------------------------------------------------------------------------
// Standard PC keyboard layout (full 104-key US ANSI)
// ---------------------------------------------------------------------------
//
// Grid: STANDARD_COLS × STANDARD_ROWS
//
//   COLS = 22  (main block 14 cols + navigation cluster 3 + numpad 4 + gaps)
//   ROWS = 6   (function row + 5 main rows)
//
// Row 0  : Esc  F1 F2 F3 F4   F5 F6 F7 F8   F9 F10 F11 F12   [PrtSc/ScrLk/Pause]
// Row 1  : ` 1 2 3 4 5 6 7 8 9 0 - =  Backspace   Ins Home PgUp
// Row 2  : Tab Q W E R T Y U I O P [ ] \          Del End  PgDn
// Row 3  : CapsLk A S D F G H J K L ; '  Enter
// Row 4  : LShift Z X C V B N M , . / RShift          ↑
// Row 5  : LCtrl  LAlt       Space       RAlt RCtrl   ← ↓ →
//
// Navigation cluster occupies cols 17-19 (Ins/Home/PgUp / Del/End/PgDn / ↑/↓/←/→).
// Numpad is omitted for device size; a compact 104-style is close enough.

const STD_COLS = 22;
const STD_ROWS = 6;

// Row 0 — Esc + function keys
const STD_ROW0 = [
  { id: 'std_escape', label: 'Esc',  col: 0,  row: 0, code: 'Escape',  key: 'Escape',  keyCode: 27  },
  { id: 'std_f1',     label: 'F1',   col: 2,  row: 0, code: 'F1',      key: 'F1',      keyCode: 112 },
  { id: 'std_f2',     label: 'F2',   col: 3,  row: 0, code: 'F2',      key: 'F2',      keyCode: 113 },
  { id: 'std_f3',     label: 'F3',   col: 4,  row: 0, code: 'F3',      key: 'F3',      keyCode: 114 },
  { id: 'std_f4',     label: 'F4',   col: 5,  row: 0, code: 'F4',      key: 'F4',      keyCode: 115 },
  { id: 'std_f5',     label: 'F5',   col: 7,  row: 0, code: 'F5',      key: 'F5',      keyCode: 116 },
  { id: 'std_f6',     label: 'F6',   col: 8,  row: 0, code: 'F6',      key: 'F6',      keyCode: 117 },
  { id: 'std_f7',     label: 'F7',   col: 9,  row: 0, code: 'F7',      key: 'F7',      keyCode: 118 },
  { id: 'std_f8',     label: 'F8',   col: 10, row: 0, code: 'F8',      key: 'F8',      keyCode: 119 },
  { id: 'std_f9',     label: 'F9',   col: 12, row: 0, code: 'F9',      key: 'F9',      keyCode: 120 },
  { id: 'std_f10',    label: 'F10',  col: 13, row: 0, code: 'F10',     key: 'F10',     keyCode: 121 },
  { id: 'std_f11',    label: 'F11',  col: 14, row: 0, code: 'F11',     key: 'F11',     keyCode: 122 },
  { id: 'std_f12',    label: 'F12',  col: 15, row: 0, code: 'F12',     key: 'F12',     keyCode: 123 },
];

// Row 1 — number row
const STD_ROW1 = [
  { id: 'std_backtick',   label: '`',  col: 0,  row: 1,       code: 'Backquote',   key: '`',         keyCode: 192 },
  { id: 'std_1',          label: '1',  col: 1,  row: 1,       code: 'Digit1',      key: '1',         keyCode: 49  },
  { id: 'std_2',          label: '2',  col: 2,  row: 1,       code: 'Digit2',      key: '2',         keyCode: 50  },
  { id: 'std_3',          label: '3',  col: 3,  row: 1,       code: 'Digit3',      key: '3',         keyCode: 51  },
  { id: 'std_4',          label: '4',  col: 4,  row: 1,       code: 'Digit4',      key: '4',         keyCode: 52  },
  { id: 'std_5',          label: '5',  col: 5,  row: 1,       code: 'Digit5',      key: '5',         keyCode: 53  },
  { id: 'std_6',          label: '6',  col: 6,  row: 1,       code: 'Digit6',      key: '6',         keyCode: 54  },
  { id: 'std_7',          label: '7',  col: 7,  row: 1,       code: 'Digit7',      key: '7',         keyCode: 55  },
  { id: 'std_8',          label: '8',  col: 8,  row: 1,       code: 'Digit8',      key: '8',         keyCode: 56  },
  { id: 'std_9',          label: '9',  col: 9,  row: 1,       code: 'Digit9',      key: '9',         keyCode: 57  },
  { id: 'std_0',          label: '0',  col: 10, row: 1,       code: 'Digit0',      key: '0',         keyCode: 48  },
  { id: 'std_minus',      label: '-',  col: 11, row: 1,       code: 'Minus',       key: '-',         keyCode: 189 },
  { id: 'std_equal',      label: '=',  col: 12, row: 1,       code: 'Equal',       key: '=',         keyCode: 187 },
  { id: 'std_backspace',  label: 'BS', col: 13, row: 1, w: 2, code: 'Backspace',   key: 'Backspace', keyCode: 8   },
  // Nav cluster col 17-19
  { id: 'std_insert',     label: 'Ins',   col: 17, row: 1, code: 'Insert',   key: 'Insert',   keyCode: 45  },
  { id: 'std_home',       label: 'Home',  col: 18, row: 1, code: 'Home',     key: 'Home',     keyCode: 36  },
  { id: 'std_pageup',     label: 'PgUp',  col: 19, row: 1, code: 'PageUp',   key: 'PageUp',   keyCode: 33  },
];

// Row 2 — QWERTY row
const STD_ROW2 = [
  { id: 'std_tab',      label: 'Tab', col: 0,  row: 2, w: 2, code: 'Tab',          key: 'Tab',        keyCode: 9   },
  { id: 'std_q',        label: 'Q',   col: 2,  row: 2,       code: 'KeyQ',         key: 'q',          keyCode: 81  },
  { id: 'std_w',        label: 'W',   col: 3,  row: 2,       code: 'KeyW',         key: 'w',          keyCode: 87  },
  { id: 'std_e',        label: 'E',   col: 4,  row: 2,       code: 'KeyE',         key: 'e',          keyCode: 69  },
  { id: 'std_r',        label: 'R',   col: 5,  row: 2,       code: 'KeyR',         key: 'r',          keyCode: 82  },
  { id: 'std_t',        label: 'T',   col: 6,  row: 2,       code: 'KeyT',         key: 't',          keyCode: 84  },
  { id: 'std_y',        label: 'Y',   col: 7,  row: 2,       code: 'KeyY',         key: 'y',          keyCode: 89  },
  { id: 'std_u',        label: 'U',   col: 8,  row: 2,       code: 'KeyU',         key: 'u',          keyCode: 85  },
  { id: 'std_i',        label: 'I',   col: 9,  row: 2,       code: 'KeyI',         key: 'i',          keyCode: 73  },
  { id: 'std_o',        label: 'O',   col: 10, row: 2,       code: 'KeyO',         key: 'o',          keyCode: 79  },
  { id: 'std_p',        label: 'P',   col: 11, row: 2,       code: 'KeyP',         key: 'p',          keyCode: 80  },
  { id: 'std_bracketl', label: '[',   col: 12, row: 2,       code: 'BracketLeft',  key: '[',          keyCode: 219 },
  { id: 'std_bracketr', label: ']',   col: 13, row: 2,       code: 'BracketRight', key: ']',          keyCode: 221 },
  { id: 'std_backslash',label: '\\',  col: 14, row: 2,       code: 'Backslash',    key: '\\',         keyCode: 220 },
  // Nav cluster
  { id: 'std_delete',   label: 'Del',    col: 17, row: 2, code: 'Delete',   key: 'Delete',   keyCode: 46  },
  { id: 'std_end',      label: 'End',    col: 18, row: 2, code: 'End',      key: 'End',      keyCode: 35  },
  { id: 'std_pagedown', label: 'PgDn',   col: 19, row: 2, code: 'PageDown', key: 'PageDown', keyCode: 34  },
];

// Row 3 — home row
const STD_ROW3 = [
  { id: 'std_capslock', label: 'Caps', col: 0,  row: 3, w: 2, code: 'CapsLock',  key: 'CapsLock',  keyCode: 20  },
  { id: 'std_a',        label: 'A',    col: 2,  row: 3,       code: 'KeyA',      key: 'a',          keyCode: 65  },
  { id: 'std_s',        label: 'S',    col: 3,  row: 3,       code: 'KeyS',      key: 's',          keyCode: 83  },
  { id: 'std_d',        label: 'D',    col: 4,  row: 3,       code: 'KeyD',      key: 'd',          keyCode: 68  },
  { id: 'std_f',        label: 'F',    col: 5,  row: 3,       code: 'KeyF',      key: 'f',          keyCode: 70  },
  { id: 'std_g',        label: 'G',    col: 6,  row: 3,       code: 'KeyG',      key: 'g',          keyCode: 71  },
  { id: 'std_h',        label: 'H',    col: 7,  row: 3,       code: 'KeyH',      key: 'h',          keyCode: 72  },
  { id: 'std_j',        label: 'J',    col: 8,  row: 3,       code: 'KeyJ',      key: 'j',          keyCode: 74  },
  { id: 'std_k',        label: 'K',    col: 9,  row: 3,       code: 'KeyK',      key: 'k',          keyCode: 75  },
  { id: 'std_l',        label: 'L',    col: 10, row: 3,       code: 'KeyL',      key: 'l',          keyCode: 76  },
  { id: 'std_semicolon',label: ';',    col: 11, row: 3,       code: 'Semicolon', key: ';',          keyCode: 186 },
  { id: 'std_quote',    label: "'",    col: 12, row: 3,       code: 'Quote',     key: "'",          keyCode: 222 },
  { id: 'std_enter',    label: 'Ret',  col: 13, row: 3, w: 2, code: 'Enter',     key: 'Enter',      keyCode: 13  },
];

// Row 4 — bottom letter row
const STD_ROW4 = [
  { id: 'std_shiftl',   label: 'Shift', col: 0,  row: 4, w: 3, code: 'ShiftLeft',  key: 'Shift', keyCode: 16, location: 1 },
  { id: 'std_z',        label: 'Z',     col: 3,  row: 4,       code: 'KeyZ',       key: 'z',     keyCode: 90  },
  { id: 'std_x',        label: 'X',     col: 4,  row: 4,       code: 'KeyX',       key: 'x',     keyCode: 88  },
  { id: 'std_c',        label: 'C',     col: 5,  row: 4,       code: 'KeyC',       key: 'c',     keyCode: 67  },
  { id: 'std_v',        label: 'V',     col: 6,  row: 4,       code: 'KeyV',       key: 'v',     keyCode: 86  },
  { id: 'std_b',        label: 'B',     col: 7,  row: 4,       code: 'KeyB',       key: 'b',     keyCode: 66  },
  { id: 'std_n',        label: 'N',     col: 8,  row: 4,       code: 'KeyN',       key: 'n',     keyCode: 78  },
  { id: 'std_m',        label: 'M',     col: 9,  row: 4,       code: 'KeyM',       key: 'm',     keyCode: 77  },
  { id: 'std_comma',    label: ',',     col: 10, row: 4,       code: 'Comma',      key: ',',     keyCode: 188 },
  { id: 'std_period',   label: '.',     col: 11, row: 4,       code: 'Period',     key: '.',     keyCode: 190 },
  { id: 'std_slash',    label: '/',     col: 12, row: 4,       code: 'Slash',      key: '/',     keyCode: 191 },
  { id: 'std_shiftr',   label: 'Shift', col: 13, row: 4, w: 3, code: 'ShiftRight', key: 'Shift', keyCode: 16, location: 2 },
  // Up arrow in nav cluster
  { id: 'std_arrowup',  label: '↑',    col: 18, row: 4,       code: 'ArrowUp',    key: 'ArrowUp',   keyCode: 38  },
];

// Row 5 — bottom modifier + spacebar + arrow cluster
const STD_ROW5 = [
  { id: 'std_ctrll',    label: 'Ctrl', col: 0,  row: 5, w: 2, code: 'ControlLeft',  key: 'Control', keyCode: 17, location: 1 },
  { id: 'std_altl',     label: 'Alt',  col: 2,  row: 5, w: 2, code: 'AltLeft',      key: 'Alt',     keyCode: 18, location: 1 },
  { id: 'std_space',    label: 'Space',col: 4,  row: 5, w: 8, code: 'Space',        key: ' ',       keyCode: 32  },
  { id: 'std_altr',     label: 'Alt',  col: 12, row: 5, w: 2, code: 'AltRight',     key: 'Alt',     keyCode: 18, location: 2 },
  { id: 'std_ctrlr',    label: 'Ctrl', col: 14, row: 5, w: 2, code: 'ControlRight', key: 'Control', keyCode: 17, location: 2 },
  // Arrow keys in nav cluster
  { id: 'std_arrowl',   label: '←',   col: 17, row: 5,       code: 'ArrowLeft',  key: 'ArrowLeft',  keyCode: 37  },
  { id: 'std_arrowd',   label: '↓',   col: 18, row: 5,       code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40  },
  { id: 'std_arrowr',   label: '→',   col: 19, row: 5,       code: 'ArrowRight', key: 'ArrowRight', keyCode: 39  },
];

const STANDARD_KEYS = [
  ...STD_ROW0, ...STD_ROW1, ...STD_ROW2,
  ...STD_ROW3, ...STD_ROW4, ...STD_ROW5,
];

// ---------------------------------------------------------------------------
// Internal layout builder — given a flat keys array + grid dims, build
// the lookup map and spatial index, and return a LayoutObject.
// ---------------------------------------------------------------------------

function buildLayout(name, cols, rows, keys) {
  // id → key definition
  const keyMap = new Map(keys.map((k) => [k.id, k]));

  // Spatial bounding boxes in normalised UV [0,1] space.
  const boxes = keys.map((k) => {
    const w = k.w ?? 1;
    const h = k.h ?? 1;
    return {
      id:  k.id,
      x0:  k.col / cols,
      y0:  k.row / rows,
      x1: (k.col + w) / cols,
      y1: (k.row + h) / rows,
    };
  });

  /**
   * Map normalised panel coordinates to a key id.
   * u: 0 = left, 1 = right; v: 0 = top, 1 = bottom.
   * Returns null when no key covers the point or coords are out of range.
   *
   * @param {number} u
   * @param {number} v
   * @returns {string | null}
   */
  function keyAt(u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    for (const box of boxes) {
      if (u >= box.x0 && u < box.x1 && v >= box.y0 && v < box.y1) {
        return box.id;
      }
    }
    return null;
  }

  /**
   * Return { code, key, keyCode, location? } for a key id, or null.
   *
   * @param {string} id
   * @returns {{ code: string, key: string, keyCode: number, location?: number } | null}
   */
  function keyEventFor(id) {
    const k = keyMap.get(id);
    if (!k) return null;
    const ev = { code: k.code, key: k.key, keyCode: k.keyCode };
    if (k.location !== undefined) ev.location = k.location;
    return ev;
  }

  /**
   * Return the raw key definition object for an id, or null.
   *
   * @param {string} id
   * @returns {object | null}
   */
  function keyDef(id) {
    return keyMap.get(id) ?? null;
  }

  return Object.freeze({ name, COLS: cols, ROWS: rows, keys, keyAt, keyEventFor, keyDef });
}

// ---------------------------------------------------------------------------
// Instantiate layouts (lazy-singleton: built once on first getLayout() call)
// ---------------------------------------------------------------------------

let _standardLayout = null;
let _c64Layout = null;

/**
 * The set of valid layout names.
 * @type {readonly string[]}
 */
export const LAYOUT_NAMES = Object.freeze(['standard', 'c64']);

/**
 * Return the LayoutObject for the given name. Returns the 'standard' layout
 * for unknown names (with a console.warn).
 *
 * A LayoutObject is frozen and reused across calls (singleton per name).
 *
 * @param {'standard'|'c64'|string} name
 * @returns {{
 *   name: string,
 *   COLS: number,
 *   ROWS: number,
 *   keys: object[],
 *   keyAt(u: number, v: number): string | null,
 *   keyEventFor(id: string): { code: string, key: string, keyCode: number, location?: number } | null,
 *   keyDef(id: string): object | null,
 * }}
 */
export function getLayout(name) {
  switch (name) {
    case 'standard':
      if (!_standardLayout) {
        _standardLayout = buildLayout('standard', STD_COLS, STD_ROWS, STANDARD_KEYS);
      }
      return _standardLayout;

    case 'c64':
      if (!_c64Layout) {
        // Re-wrap C64KeyLayout data under the unified LayoutObject API.
        _c64Layout = buildLayout('c64', C64_COLS, C64_ROWS_COUNT, C64_KEYS);
      }
      return _c64Layout;

    default:
      if (typeof console !== 'undefined') {
        console.warn(`[KeyboardLayout] unknown layout "${name}" — falling back to "standard"`);
      }
      return getLayout('standard');
  }
}
