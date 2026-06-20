// BindingsUI — the DESKTOP controls-remapping overlay (flat-screen only).
//
// A minimal modal panel listing each RetroPad button with its current keyboard
// key + PC-gamepad binding, a "Rebind" affordance per row, plus Save / Reset.
// It edits the SHARED [[src/Bindings.js]] instance, so a rebind takes effect on
// the very next physical input with no re-attach. Rebinds persist to localStorage
// (Bindings.save) immediately; "Save" is really "close" and "Reset" restores
// factory defaults.
//
// Styling is deliberately plain + scoped under #bindings-overlay (see index.html)
// so the look is easy to redirect later. The panel lives in index.html markup;
// this class only wires behaviour.
//
// Interplay with pointer-lock gameplay ([[src/DesktopControls.js]]): opening the
// panel exits pointer lock (so the user can move the cursor + the WASD/look
// listeners go quiet because they gate on lock), and the panel is hidden whenever
// presenting in VR. Capture mode listens for the NEXT keydown or gamepad input
// and stores it as that row's binding.
//
// MVP wires player 1 only; the Bindings model is per-player so adding a P2-4
// selector later is a UI-only change.

import { RETROPAD_BUTTONS, padSig } from './Bindings.js';

// Human label for a stored pad binding ({type:'button',index}|{type:'axis',...}).
function padLabel(pad) {
  if (!pad) return '—';
  if (pad.type === 'button') return `Btn ${pad.index}`;
  if (pad.type === 'axis') return `Axis ${pad.index}${pad.dir > 0 ? '+' : '-'}`;
  return '—';
}

// Friendly label for a KeyboardEvent.code ('KeyH' → 'H', 'ArrowUp' → '↑').
function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Space: 'Space', Enter: 'Enter', ShiftRight: 'RShift',
  };
  return map[code] || code;
}

const AXIS_CAPTURE_THRESHOLD = 0.6;  // a stick must clearly deflect to bind it

export class BindingsUI {
  // bindings: shared Bindings instance.
  // renderer: for the !xr.isPresenting gate (don't show the panel in VR).
  // exitPointerLock: callback to release pointer lock when opening (optional).
  // player: which player the UI edits (MVP: 1).
  constructor({ bindings, renderer, exitPointerLock, player = 1 } = {}) {
    this.bindings = bindings;
    this.renderer = renderer;
    this.exitPointerLock = exitPointerLock;
    this.player = player;

    this.overlay = document.getElementById('bindings-overlay');
    this.rowsEl = document.getElementById('bindings-rows');
    this.openBtn = document.getElementById('bindings-btn');
    this.closeBtn = document.getElementById('bindings-close');
    this.resetBtn = document.getElementById('bindings-reset');

    // Active capture state: { btn, kind:'key'|'pad', rowEl } or null.
    this._capturing = null;
    this._wire();
  }

  _wire() {
    this.openBtn?.addEventListener('click', () => this.open());
    this.closeBtn?.addEventListener('click', () => this.close());
    this.resetBtn?.addEventListener('click', () => {
      this.bindings.resetDefaults(this.player);
      this._render();
    });
    // Capture listeners are added only while capturing (see _beginCapture), so
    // they never interfere with gameplay input the rest of the time.
    this._onKeyCapture = (e) => this._captureKey(e);
  }

  isOpen() { return this.overlay && !this.overlay.hidden; }

  open() {
    if (!this.overlay) return;
    if (this.renderer?.xr?.isPresenting) return;   // no desktop panel in VR
    this.exitPointerLock?.();
    this.overlay.hidden = false;
    this._render();
  }

  close() {
    if (!this.overlay) return;
    this._cancelCapture();
    this.overlay.hidden = true;
  }

  // Build the rows for the current player's bindings.
  _render() {
    if (!this.rowsEl) return;
    this.rowsEl.innerHTML = '';
    for (const btn of RETROPAD_BUTTONS) {
      const b = this.bindings.get(this.player, btn) || { key: null, pad: null };
      const row = document.createElement('div');
      row.className = 'binding-row';
      row.dataset.btn = btn;

      const name = document.createElement('span');
      name.className = 'binding-name';
      name.textContent = btn;

      const keyCell = document.createElement('button');
      keyCell.className = 'binding-cell binding-key';
      keyCell.textContent = keyLabel(b.key);
      keyCell.title = 'Rebind keyboard key';
      keyCell.addEventListener('click', () => this._beginCapture(btn, 'key', keyCell));

      const padCell = document.createElement('button');
      padCell.className = 'binding-cell binding-pad';
      padCell.textContent = padLabel(b.pad);
      padCell.title = 'Rebind gamepad button/axis';
      padCell.addEventListener('click', () => this._beginCapture(btn, 'pad', padCell));

      row.append(name, keyCell, padCell);
      this.rowsEl.appendChild(row);
    }
  }

  // Enter capture mode for one row+kind. The next keydown (key) or gamepad
  // button/axis (pad) is captured and stored. Esc / clicking again cancels.
  _beginCapture(btn, kind, cellEl) {
    this._cancelCapture();
    this._capturing = { btn, kind, cellEl };
    cellEl.classList.add('capturing');
    cellEl.textContent = kind === 'key' ? 'Press a key…' : 'Press a button…';
    // Listen at capture phase on window so the keypress doesn't also reach the
    // game (the overlay is open and pointer-lock is released anyway).
    window.addEventListener('keydown', this._onKeyCapture, true);
    if (kind === 'pad') this._startPadCapture();
  }

  _captureKey(e) {
    if (!this._capturing) return;
    e.preventDefault();
    e.stopPropagation();
    const { btn, kind } = this._capturing;
    if (e.code === 'Escape') { this._cancelCapture(); this._render(); return; }
    if (kind === 'key') {
      this.bindings.setKey(this.player, btn, e.code);
      this._cancelCapture();
      this._render();
    }
    // If we're in pad-capture and the user hits Escape, handled above; other keys
    // are ignored so they can still reach a gamepad press.
  }

  // Poll gamepads for a press while capturing a pad binding. rAF loop, stops on
  // first detected button/axis or on cancel.
  _startPadCapture() {
    // Snapshot a neutral baseline so we only fire on a NEW press, not a button
    // already held when capture began.
    const baseline = this._padSnapshot();
    const poll = () => {
      if (!this._capturing || this._capturing.kind !== 'pad') return;
      const detected = this._detectPadPress(baseline);
      if (detected) {
        this.bindings.setPad(this.player, this._capturing.btn, detected);
        this._cancelCapture();
        this._render();
        return;
      }
      this._padRaf = requestAnimationFrame(poll);
    };
    this._padRaf = requestAnimationFrame(poll);
  }

  _padSnapshot() {
    const pads = (typeof navigator !== 'undefined' && navigator.getGamepads)
      ? navigator.getGamepads() : null;
    const snap = { buttons: {}, axes: {} };
    if (!pads) return snap;
    for (const gp of pads) {
      if (!gp) continue;
      if (gp.buttons) gp.buttons.forEach((bn, i) => { snap.buttons[i] = !!(bn?.pressed); });
      if (gp.axes) gp.axes.forEach((v, i) => { snap.axes[i] = v || 0; });
    }
    return snap;
  }

  // Return a pad binding object for the first NEW press vs `baseline`, else null.
  _detectPadPress(baseline) {
    const pads = (typeof navigator !== 'undefined' && navigator.getGamepads)
      ? navigator.getGamepads() : null;
    if (!pads) return null;
    for (const gp of pads) {
      if (!gp) continue;
      if (gp.buttons) {
        for (let i = 0; i < gp.buttons.length; i++) {
          const pressed = !!(gp.buttons[i]?.pressed) || (gp.buttons[i]?.value || 0) >= 0.6;
          if (pressed && !baseline.buttons[i]) return { type: 'button', index: i };
        }
      }
      if (gp.axes) {
        for (let i = 0; i < gp.axes.length; i++) {
          const v = gp.axes[i] || 0;
          const base = baseline.axes[i] || 0;
          if (v <= -AXIS_CAPTURE_THRESHOLD && base > -AXIS_CAPTURE_THRESHOLD) return { type: 'axis', index: i, dir: -1 };
          if (v >= AXIS_CAPTURE_THRESHOLD && base < AXIS_CAPTURE_THRESHOLD) return { type: 'axis', index: i, dir: 1 };
        }
      }
    }
    return null;
  }

  _cancelCapture() {
    window.removeEventListener('keydown', this._onKeyCapture, true);
    if (this._padRaf) { cancelAnimationFrame(this._padRaf); this._padRaf = null; }
    if (this._capturing?.cellEl) this._capturing.cellEl.classList.remove('capturing');
    this._capturing = null;
  }

  // --- headless / debug hook ---
  // The harness can't synthesize real pointer-lock or native gamepads, so expose
  // a thin API that opens/closes and stores bindings directly, mirroring what the
  // row buttons do, plus a way to read current state.
  debugApi() {
    return {
      open: () => this.open(),
      close: () => this.close(),
      isOpen: () => this.isOpen(),
      reset: () => { this.bindings.resetDefaults(this.player); this._render(); },
      // Programmatic rebind (what clicking a row + pressing a key/button does).
      rebindKey: (btn, code) => { this.bindings.setKey(this.player, btn, code); this._render(); },
      rebindPad: (btn, pad) => { this.bindings.setPad(this.player, btn, pad); this._render(); },
      get: (btn) => this.bindings.get(this.player, btn),
      sig: padSig,
    };
  }
}
