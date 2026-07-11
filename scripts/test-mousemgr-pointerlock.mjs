// Unit tests for MouseMgr.attachDesktop()'s pointer-lock gating ([[src/MouseMgr.js]]).
//
// Bug this guards against: a click anywhere on the app canvas used to call
// requestPointerLock() UNCONDITIONALLY, regardless of whether the console the
// desktop mouse is cabled to actually has a libretro MOUSE device wired on this
// boot. That silently switched the OS cursor to relative/hidden-cursor motion
// for games with no mouse at all (e.g. loading an SNES RPG right after an Amiga
// session), which reads as "the page crashed" — no error is thrown, the cursor
// just vanishes and moves differently. getWired() gates the click listener;
// releaseDesktopLock() force-exits a lock a stale boot left engaged.
//
// No real DOM here — a minimal EventTarget-backed fake stands in for
// `document`/the canvas element, which is all attachDesktop touches.
// Run: node scripts/test-mousemgr-pointerlock.mjs
import { MouseMgr } from '../src/MouseMgr.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error(`FAIL ${name}`); } };

function makeFakeDom() {
  const el = new EventTarget();
  el.requestPointerLock = () => { doc.pointerLockElement = el; };
  const doc = new EventTarget();
  doc.pointerLockElement = null;
  doc.exitPointerLock = () => { doc.pointerLockElement = null; };
  globalThis.document = doc;
  return { el, doc };
}

function click(el) { el.dispatchEvent(new Event('click')); }

// --- 1. getWired() false → click must NOT engage pointer lock -----------------
{
  const { el, doc } = makeFakeDom();
  const mgr = new MouseMgr({ getActiveMice: () => [] });
  mgr.attachDesktop({ getEl: () => el, getClient: () => null, getWired: () => false });
  click(el);
  ok('getWired=false: click does not lock', doc.pointerLockElement == null);
}

// --- 2. getWired() true → click engages pointer lock ---------------------------
{
  const { el, doc } = makeFakeDom();
  const mgr = new MouseMgr({ getActiveMice: () => [] });
  mgr.attachDesktop({ getEl: () => el, getClient: () => null, getWired: () => true });
  click(el);
  ok('getWired=true: click locks', doc.pointerLockElement === el);
}

// --- 3. getWired omitted → defaults to always-true (back-compat) --------------
{
  const { el, doc } = makeFakeDom();
  const mgr = new MouseMgr({ getActiveMice: () => [] });
  mgr.attachDesktop({ getEl: () => el, getClient: () => null });
  click(el);
  ok('no getWired passed: click still locks (default true)', doc.pointerLockElement === el);
}

// --- 4. getWired() can change between clicks (mirrors a live ROM switch) ------
{
  const { el, doc } = makeFakeDom();
  let wired = false;
  const mgr = new MouseMgr({ getActiveMice: () => [] });
  mgr.attachDesktop({ getEl: () => el, getClient: () => null, getWired: () => wired });
  click(el);
  ok('unwired boot: first click does not lock', doc.pointerLockElement == null);
  wired = true;
  click(el);
  ok('now wired: click locks', doc.pointerLockElement === el);
}

// --- 5. releaseDesktopLock() exits an active lock ------------------------------
{
  const { el, doc } = makeFakeDom();
  const mgr = new MouseMgr({ getActiveMice: () => [] });
  mgr.attachDesktop({ getEl: () => el, getClient: () => null, getWired: () => true });
  click(el);
  ok('precondition: locked', doc.pointerLockElement === el);
  mgr.releaseDesktopLock();
  ok('releaseDesktopLock exits the lock', doc.pointerLockElement == null);
}

// --- 6. releaseDesktopLock() is a no-op when not locked (must not throw) ------
{
  makeFakeDom();
  const mgr = new MouseMgr({ getActiveMice: () => [] });
  let threw = false;
  try { mgr.releaseDesktopLock(); } catch (_) { threw = true; }
  ok('releaseDesktopLock no-op when unlocked does not throw', !threw);
}

// --- 7. Regression: switching a ROM (getWired flips false) + releaseDesktopLock
//    together force the cursor back — the exact sequence main.js now runs on
//    every boot that doesn't want the mouse device.
{
  const { el, doc } = makeFakeDom();
  let wired = true;
  const mgr = new MouseMgr({ getActiveMice: () => [] });
  mgr.attachDesktop({ getEl: () => el, getClient: () => null, getWired: () => wired });
  click(el);
  ok('mouse-capable boot: click locks', doc.pointerLockElement === el);
  // Simulate loading an unrelated non-mouse ROM mid-session.
  wired = false;
  mgr.releaseDesktopLock();
  ok('switching to a non-mouse ROM releases the stale lock', doc.pointerLockElement == null);
  click(el);
  ok('and the canvas no longer re-locks on further clicks', doc.pointerLockElement == null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
