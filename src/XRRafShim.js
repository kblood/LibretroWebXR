// While a WebXR session is presenting, the browser pauses the page's
// `window.requestAnimationFrame` queue — only the session's own
// `XRSession.requestAnimationFrame` fires (which Three.js uses internally
// via `renderer.setAnimationLoop`). Anything else relying on window-level
// rAF freezes: in our case the libretro core, whose Emscripten main loop
// is driven by `Browser.requestAnimationFrame` → `window.rAF`.
//
// Symptom: the emulator runs fine in a browser tab, but the instant the
// user enters VR the game pauses (last frame stays on the TV mesh, no
// audio, no input) and resumes the moment they exit XR.
//
// Fix: while presenting, fulfil window.rAF callbacks via setTimeout. The
// 16 ms interval gives the core ~60 Hz scheduling; setTimeout's actual
// granularity is finer than that. Three.js's render loop is not affected
// because it doesn't call window.rAF — it uses the session loop directly.
//
// We restore the originals on sessionend so the desktop path stays on
// real rAF (better with vsync).

export function installXRRafShim(renderer) {
  if (typeof window === 'undefined') return;
  const origRAF = window.requestAnimationFrame.bind(window);
  const origCAF = window.cancelAnimationFrame.bind(window);
  let active = false;
  const fakeIds = new Set();

  window.requestAnimationFrame = (cb) => {
    if (!active) return origRAF(cb);
    const id = setTimeout(() => {
      fakeIds.delete(id);
      try { cb(performance.now()); } catch (e) { console.warn('[xr-raf-shim] cb threw:', e); }
    }, 16);
    fakeIds.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (fakeIds.has(id)) {
      clearTimeout(id);
      fakeIds.delete(id);
      return;
    }
    origCAF(id);
  };

  renderer.xr.addEventListener('sessionstart', () => {
    active = true;
    console.info('[xr-raf-shim] active — window.rAF routed through setTimeout for libretro core');
  });
  renderer.xr.addEventListener('sessionend', () => {
    active = false;
    for (const id of fakeIds) clearTimeout(id);
    fakeIds.clear();
    console.info('[xr-raf-shim] inactive — window.rAF restored');
  });
}
