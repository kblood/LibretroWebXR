// Tap-to-toggle checklist for headset-test.html, with per-device persistence.
//
// WHY THIS IS A SEPARATE FILE (2026-08-15, CODEX_REVIEW SEC-6):
// this used to be an inline <script> at the bottom of headset-test.html. The
// project's own committed CSP is `script-src 'self' 'wasm-unsafe-eval'` — no
// nonce, no hash, no 'unsafe-inline' — so the browser BLOCKED it and the
// checklist silently did nothing on the very device (a Quest, where you cannot
// open a console) the page exists to serve. Same-origin external module = the
// policy allows it, and it stays allowed if the policy is ever tightened
// further. Do NOT move this back inline.
//
// The behaviour is unchanged from the inline version: each <li> in an
// `ol.checks` gets a stable id from its position so saved state survives
// reloads (and re-reads in VR); state lives in localStorage on that device.
//
// DOM contract with headset-test.html (both halves must move together):
//   • `ol.checks > li`     — the checklist items this toggles
//   • `#progress`          — the "N / M done" readout in the fixed bottom bar
//   • `#reset`             — the "Reset progress" button in that bar
//   • class `done`         — the CSS hook that paints a ticked item green
// Loaded as `<script type="module" src="./headset-test.js"></script>`, i.e.
// deferred until after parsing, so every element above already exists and no
// DOMContentLoaded wrapper is needed.

const items = [...document.querySelectorAll('ol.checks > li')];
items.forEach((li, i) => { li.dataset.k = 'lwx-test-' + i; });
const progress = document.getElementById('progress');

function render() {
  let done = 0;
  for (const li of items) {
    const on = localStorage.getItem(li.dataset.k) === '1';
    li.classList.toggle('done', on);
    if (on) done++;
  }
  progress.textContent = done + ' / ' + items.length + ' done';
}
for (const li of items) {
  li.addEventListener('click', () => {
    const on = localStorage.getItem(li.dataset.k) === '1';
    if (on) localStorage.removeItem(li.dataset.k);
    else localStorage.setItem(li.dataset.k, '1');
    render();
  });
}
document.getElementById('reset').addEventListener('click', () => {
  for (const li of items) localStorage.removeItem(li.dataset.k);
  render();
});
render();
