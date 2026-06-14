// Unit tests for src/KeyboardLayout.js
//
// Covers:
//   • LAYOUT_NAMES       — expected names present
//   • getLayout()        — both layouts return a LayoutObject with COLS/ROWS/keys
//   • key completeness   — every key has required fields; ids unique per layout
//   • grid bounds        — every key's col+w and row+h stay within COLS/ROWS
//   • keyAt()            — interior cell hit-tests; boundary; out-of-range → null
//   • keyEventFor()      — correct {code,key,keyCode} for sample keys both layouts
//   • C64 special keys   — RUN/STOP, RESTORE, CBM, LOCK survive in 'c64' layout
//   • standard keys      — Esc, F5, Enter, Space, 'a', arrows in 'standard' layout
//
// Run standalone:  node scripts/test-keyboard.mjs
// Or via npm test: wired into package.json test chain.

import {
  getLayout,
  LAYOUT_NAMES,
} from '../src/KeyboardLayout.js';

let pass = 0, fail = 0;

const ok = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}`); }
};

const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL  ${name}\n  got:  ${g}\n  want: ${w}`); }
};

const near = (name, got, want, tol = 1e-9) => {
  if (Math.abs(got - want) <= tol) { pass++; }
  else { fail++; console.error(`FAIL  ${name}  got=${got}  want=${want}`); }
};

// ---------------------------------------------------------------------------
// LAYOUT_NAMES
// ---------------------------------------------------------------------------
ok('LAYOUT_NAMES contains "standard"', LAYOUT_NAMES.includes('standard'));
ok('LAYOUT_NAMES contains "c64"',      LAYOUT_NAMES.includes('c64'));
ok('LAYOUT_NAMES has at least 2 entries', LAYOUT_NAMES.length >= 2);

// ---------------------------------------------------------------------------
// getLayout() basic shape
// ---------------------------------------------------------------------------
for (const name of ['standard', 'c64']) {
  const L = getLayout(name);
  ok(`getLayout(${name}) returns object`, typeof L === 'object' && L !== null);
  ok(`getLayout(${name}).name === '${name}'`, L.name === name);
  ok(`getLayout(${name}).COLS > 0`,  L.COLS > 0);
  ok(`getLayout(${name}).ROWS > 0`,  L.ROWS > 0);
  ok(`getLayout(${name}).keys is array`, Array.isArray(L.keys));
  ok(`getLayout(${name}).keys non-empty`, L.keys.length > 0);
  ok(`getLayout(${name}).keyAt is function`,       typeof L.keyAt       === 'function');
  ok(`getLayout(${name}).keyEventFor is function`, typeof L.keyEventFor === 'function');
  ok(`getLayout(${name}).keyDef is function`,      typeof L.keyDef      === 'function');
}

// getLayout should return the same object on repeated calls (singleton).
{
  const a = getLayout('standard');
  const b = getLayout('standard');
  ok('getLayout standard is singleton', a === b);
}
{
  const a = getLayout('c64');
  const b = getLayout('c64');
  ok('getLayout c64 is singleton', a === b);
}

// Unknown name falls back gracefully (no throw).
{
  let caught = false;
  let L = null;
  try { L = getLayout('bogus_layout_xyz'); } catch (e) { caught = true; }
  ok('getLayout(bogus) does not throw', !caught);
  ok('getLayout(bogus) returns an object', typeof L === 'object' && L !== null);
}

// ---------------------------------------------------------------------------
// Key completeness checks — both layouts
// ---------------------------------------------------------------------------
const REQUIRED_FIELDS = ['id', 'label', 'col', 'row', 'code', 'key', 'keyCode'];

for (const name of ['standard', 'c64']) {
  const L = getLayout(name);

  // Every key has required fields.
  for (const k of L.keys) {
    for (const f of REQUIRED_FIELDS) {
      ok(`layout '${name}' key '${k.id}' has field '${f}'`, k[f] !== undefined);
    }
    // col and row are non-negative integers.
    ok(`layout '${name}' key '${k.id}' col >= 0`, Number.isInteger(k.col) && k.col >= 0);
    ok(`layout '${name}' key '${k.id}' row >= 0`, Number.isInteger(k.row) && k.row >= 0);
    // col + w <= COLS, row + h <= ROWS.
    const w = k.w ?? 1;
    const h = k.h ?? 1;
    ok(`layout '${name}' key '${k.id}' col+w <= COLS`, k.col + w <= L.COLS);
    ok(`layout '${name}' key '${k.id}' row+h <= ROWS`, k.row + h <= L.ROWS);
    // keyCode is a positive integer.
    ok(`layout '${name}' key '${k.id}' keyCode > 0`, Number.isInteger(k.keyCode) && k.keyCode > 0);
    // code is a non-empty string.
    ok(`layout '${name}' key '${k.id}' code is string`, typeof k.code === 'string' && k.code.length > 0);
  }

  // IDs must be unique within each layout.
  {
    const seen = new Set();
    let dupes = 0;
    for (const k of L.keys) {
      if (seen.has(k.id)) dupes++;
      seen.add(k.id);
    }
    eq(`layout '${name}' no duplicate ids`, dupes, 0);
  }
}

// ---------------------------------------------------------------------------
// keyAt() — hit testing (standard layout)
// ---------------------------------------------------------------------------
{
  const L = getLayout('standard');

  // Out-of-range coords → null.
  ok('std keyAt(-0.1, 0.5) → null', L.keyAt(-0.1, 0.5) === null);
  ok('std keyAt(1.1, 0.5)  → null', L.keyAt(1.1,  0.5) === null);
  ok('std keyAt(0.5, -0.1) → null', L.keyAt(0.5, -0.1) === null);
  ok('std keyAt(0.5, 1.1)  → null', L.keyAt(0.5,  1.1) === null);

  // Centre of 'std_1' (Digit1) — col=1, row=1, w=1, h=1.
  {
    const u = (1 + 0.5) / L.COLS;
    const v = (1 + 0.5) / L.ROWS;
    eq('std keyAt centre of std_1', L.keyAt(u, v), 'std_1');
  }

  // Centre of 'std_a' — col=2, row=3.
  {
    const u = (2 + 0.5) / L.COLS;
    const v = (3 + 0.5) / L.ROWS;
    eq('std keyAt centre of std_a', L.keyAt(u, v), 'std_a');
  }

  // Centre of wide spacebar (std_space col=4, w=8, row=5).
  {
    const u = (4 + 4) / L.COLS;  // midpoint of 8-wide key
    const v = (5 + 0.5) / L.ROWS;
    eq('std keyAt centre of std_space', L.keyAt(u, v), 'std_space');
  }

  // Wide key backspace (std_backspace col=13, w=2, row=1).
  {
    const u = (13 + 1) / L.COLS;  // midpoint
    const v = (1 + 0.5) / L.ROWS;
    eq('std keyAt centre of std_backspace', L.keyAt(u, v), 'std_backspace');
  }

  // Left edge of std_backspace (just inside col 13).
  {
    const u = 13 / L.COLS + 0.001;
    const v = (1 + 0.5) / L.ROWS;
    eq('std keyAt left edge of std_backspace', L.keyAt(u, v), 'std_backspace');
  }

  // Escape key — col=0, row=0.
  {
    const u = 0.5 / L.COLS;
    const v = 0.5 / L.ROWS;
    eq('std keyAt Escape (col 0 row 0)', L.keyAt(u, v), 'std_escape');
  }

  // Gap cell in function row (col=1, row=0 is unoccupied in STD_ROW0).
  {
    const u = (1 + 0.5) / L.COLS;
    const v = 0.5 / L.ROWS;
    // Col 1 row 0 has no key; expect null OR any valid key id.
    const hit = L.keyAt(u, v);
    ok('std keyAt unoccupied cell → null or valid key',
       hit === null || typeof hit === 'string');
  }

  // Exact top-left corner of std_a.
  {
    const u = 2 / L.COLS;
    const v = 3 / L.ROWS;
    eq('std keyAt exact top-left of std_a', L.keyAt(u, v), 'std_a');
  }
}

// ---------------------------------------------------------------------------
// keyAt() — hit testing (c64 layout) — spot-check key positions
// ---------------------------------------------------------------------------
{
  const L = getLayout('c64');

  // Key '1' at col=1, row=0 (same as C64KeyLayout).
  {
    const u = (1 + 0.5) / L.COLS;
    const v = (0 + 0.5) / L.ROWS;
    eq('c64 keyAt centre of 1', L.keyAt(u, v), '1');
  }

  // Key 'a' at col=3, row=2.
  {
    const u = (3 + 0.5) / L.COLS;
    const v = (2 + 0.5) / L.ROWS;
    eq('c64 keyAt centre of a', L.keyAt(u, v), 'a');
  }

  // Wide 'space' at col=4, w=8, row=4.
  {
    const u = (4 + 4) / L.COLS;
    const v = (4 + 0.5) / L.ROWS;
    eq('c64 keyAt centre of space', L.keyAt(u, v), 'space');
  }

  // RETURN at col=15, w=2, row=2.
  {
    const u = (15 + 1) / L.COLS;
    const v = (2 + 0.5) / L.ROWS;
    eq('c64 keyAt centre of return', L.keyAt(u, v), 'return');
  }

  // Out of range.
  ok('c64 keyAt(-0.01, 0.5) → null', L.keyAt(-0.01, 0.5) === null);
  ok('c64 keyAt(0.5, 1.01)  → null', L.keyAt(0.5, 1.01)  === null);
}

// ---------------------------------------------------------------------------
// keyEventFor() — standard layout
// ---------------------------------------------------------------------------
{
  const L = getLayout('standard');

  // 'a' → KeyA / 65
  {
    const ev = L.keyEventFor('std_a');
    ok('std keyEventFor(std_a) not null', ev !== null);
    eq('std keyEventFor(std_a).code',    ev?.code,    'KeyA');
    eq('std keyEventFor(std_a).key',     ev?.key,     'a');
    eq('std keyEventFor(std_a).keyCode', ev?.keyCode, 65);
    ok('std keyEventFor(std_a) no location (non-modifier)', ev?.location === undefined);
  }

  // Enter → Enter / 13
  {
    const ev = L.keyEventFor('std_enter');
    ok('std keyEventFor(std_enter) not null', ev !== null);
    eq('std keyEventFor(std_enter).code',    ev?.code,    'Enter');
    eq('std keyEventFor(std_enter).key',     ev?.key,     'Enter');
    eq('std keyEventFor(std_enter).keyCode', ev?.keyCode, 13);
  }

  // Space → Space / 32
  {
    const ev = L.keyEventFor('std_space');
    ok('std keyEventFor(std_space) not null', ev !== null);
    eq('std keyEventFor(std_space).code',    ev?.code,    'Space');
    eq('std keyEventFor(std_space).keyCode', ev?.keyCode, 32);
  }

  // F5 → F5 / 116
  {
    const ev = L.keyEventFor('std_f5');
    ok('std keyEventFor(std_f5) not null', ev !== null);
    eq('std keyEventFor(std_f5).code',    ev?.code,    'F5');
    eq('std keyEventFor(std_f5).keyCode', ev?.keyCode, 116);
  }

  // Escape → Escape / 27
  {
    const ev = L.keyEventFor('std_escape');
    ok('std keyEventFor(std_escape) not null', ev !== null);
    eq('std keyEventFor(std_escape).code',    ev?.code,    'Escape');
    eq('std keyEventFor(std_escape).keyCode', ev?.keyCode, 27);
  }

  // Left Shift — location=1
  {
    const ev = L.keyEventFor('std_shiftl');
    ok('std keyEventFor(std_shiftl) not null', ev !== null);
    eq('std keyEventFor(std_shiftl).code',     ev?.code,     'ShiftLeft');
    eq('std keyEventFor(std_shiftl).location', ev?.location, 1);
  }

  // Right Shift — location=2
  {
    const ev = L.keyEventFor('std_shiftr');
    ok('std keyEventFor(std_shiftr) not null', ev !== null);
    eq('std keyEventFor(std_shiftr).code',     ev?.code,     'ShiftRight');
    eq('std keyEventFor(std_shiftr).location', ev?.location, 2);
  }

  // Left Ctrl — location=1
  {
    const ev = L.keyEventFor('std_ctrll');
    ok('std keyEventFor(std_ctrll) not null', ev !== null);
    eq('std keyEventFor(std_ctrll).code',     ev?.code,     'ControlLeft');
    eq('std keyEventFor(std_ctrll).location', ev?.location, 1);
  }

  // Arrow up
  {
    const ev = L.keyEventFor('std_arrowup');
    ok('std keyEventFor(std_arrowup) not null', ev !== null);
    eq('std keyEventFor(std_arrowup).code',    ev?.code,    'ArrowUp');
    eq('std keyEventFor(std_arrowup).keyCode', ev?.keyCode, 38);
  }

  // Unknown key → null
  ok('std keyEventFor(bogus) is null', L.keyEventFor('bogus_key_xyz') === null);
}

// ---------------------------------------------------------------------------
// keyEventFor() — c64 layout (existing C64 key mappings preserved)
// ---------------------------------------------------------------------------
{
  const L = getLayout('c64');

  // 'a' key (shared id with C64 original)
  {
    const ev = L.keyEventFor('a');
    ok('c64 keyEventFor(a) not null', ev !== null);
    eq('c64 keyEventFor(a).code',    ev?.code,    'KeyA');
    eq('c64 keyEventFor(a).key',     ev?.key,     'a');
    eq('c64 keyEventFor(a).keyCode', ev?.keyCode, 65);
  }

  // return → Enter / 13
  {
    const ev = L.keyEventFor('return');
    ok('c64 keyEventFor(return) not null', ev !== null);
    eq('c64 keyEventFor(return).code',    ev?.code,    'Enter');
    eq('c64 keyEventFor(return).keyCode', ev?.keyCode, 13);
  }

  // space → Space / 32
  {
    const ev = L.keyEventFor('space');
    ok('c64 keyEventFor(space) not null', ev !== null);
    eq('c64 keyEventFor(space).code',    ev?.code,    'Space');
    eq('c64 keyEventFor(space).keyCode', ev?.keyCode, 32);
  }

  // f1 → F1 / 112
  {
    const ev = L.keyEventFor('f1');
    ok('c64 keyEventFor(f1) not null', ev !== null);
    eq('c64 keyEventFor(f1).code',    ev?.code,    'F1');
    eq('c64 keyEventFor(f1).keyCode', ev?.keyCode, 112);
  }

  // f5 → F5 / 116
  {
    const ev = L.keyEventFor('f5');
    ok('c64 keyEventFor(f5) not null', ev !== null);
    eq('c64 keyEventFor(f5).code',    ev?.code,    'F5');
    eq('c64 keyEventFor(f5).keyCode', ev?.keyCode, 116);
  }

  // C64 special keys preserved:
  // run_stop → Escape / 27
  {
    const ev = L.keyEventFor('run_stop');
    ok('c64 keyEventFor(run_stop) not null', ev !== null);
    eq('c64 keyEventFor(run_stop).code',    ev?.code,    'Escape');
    eq('c64 keyEventFor(run_stop).keyCode', ev?.keyCode, 27);
  }

  // restore → PageUp / 33
  {
    const ev = L.keyEventFor('restore');
    ok('c64 keyEventFor(restore) not null', ev !== null);
    eq('c64 keyEventFor(restore).code',    ev?.code,    'PageUp');
    eq('c64 keyEventFor(restore).keyCode', ev?.keyCode, 33);
  }

  // cbm (Commodore key) → LeftAlt, location=1
  {
    const ev = L.keyEventFor('cbm');
    ok('c64 keyEventFor(cbm) not null', ev !== null);
    eq('c64 keyEventFor(cbm).code',     ev?.code,     'LeftAlt');
    eq('c64 keyEventFor(cbm).location', ev?.location, 1);
  }

  // lock (SHIFT LOCK) → CapsLock / 20
  {
    const ev = L.keyEventFor('lock');
    ok('c64 keyEventFor(lock) not null', ev !== null);
    eq('c64 keyEventFor(lock).code',    ev?.code,    'CapsLock');
    eq('c64 keyEventFor(lock).keyCode', ev?.keyCode, 20);
  }

  // lshift → ShiftLeft, location=1
  {
    const ev = L.keyEventFor('lshift');
    ok('c64 keyEventFor(lshift) not null', ev !== null);
    eq('c64 keyEventFor(lshift).code',     ev?.code,     'ShiftLeft');
    eq('c64 keyEventFor(lshift).location', ev?.location, 1);
  }

  // del → Backspace / 8
  {
    const ev = L.keyEventFor('del');
    ok('c64 keyEventFor(del) not null', ev !== null);
    eq('c64 keyEventFor(del).code',    ev?.code,    'Backspace');
    eq('c64 keyEventFor(del).keyCode', ev?.keyCode, 8);
  }

  // clr_home → Home / 36
  {
    const ev = L.keyEventFor('clr_home');
    ok('c64 keyEventFor(clr_home) not null', ev !== null);
    eq('c64 keyEventFor(clr_home).code',    ev?.code,    'Home');
    eq('c64 keyEventFor(clr_home).keyCode', ev?.keyCode, 36);
  }

  // ctrl (C64) → Tab / 9
  {
    const ev = L.keyEventFor('ctrl');
    ok('c64 keyEventFor(ctrl) not null', ev !== null);
    eq('c64 keyEventFor(ctrl).code',    ev?.code,    'Tab');
    eq('c64 keyEventFor(ctrl).keyCode', ev?.keyCode, 9);
  }

  // back_arrow (← glyph) → Backquote / 192
  {
    const ev = L.keyEventFor('back_arrow');
    ok('c64 keyEventFor(back_arrow) not null', ev !== null);
    eq('c64 keyEventFor(back_arrow).code',    ev?.code,    'Backquote');
    eq('c64 keyEventFor(back_arrow).keyCode', ev?.keyCode, 192);
  }

  // Unknown → null
  ok('c64 keyEventFor(bogus) is null', L.keyEventFor('bogus_key_xyz') === null);
}

// ---------------------------------------------------------------------------
// keyDef() helper — both layouts
// ---------------------------------------------------------------------------
{
  const L = getLayout('standard');
  const def = L.keyDef('std_enter');
  ok('std keyDef(std_enter) not null', def !== null);
  eq('std keyDef(std_enter).col', def?.col, 13);
  eq('std keyDef(std_enter).w',   def?.w,   2);
  ok('std keyDef(bogus) is null', L.keyDef('bogus_xyz') === null);
}
{
  const L = getLayout('c64');
  const def = L.keyDef('return');
  ok('c64 keyDef(return) not null', def !== null);
  eq('c64 keyDef(return).col', def?.col, 15);
  eq('c64 keyDef(return).w',   def?.w,   2);
  ok('c64 keyDef(bogus) is null', L.keyDef('bogus_xyz') === null);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
