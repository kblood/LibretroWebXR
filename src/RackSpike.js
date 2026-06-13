// RackSpike — THROWAWAY Phase-0 de-risk harness (behind ?rack=N).
//
// The multi-console rack's two existential unknowns are settled here BEFORE we
// commit to the full build (ConsoleRuntime/RackMgr/multi-TV):
//
//   1. Multi-instance safety — can N `module` (MODULARIZE=1) libretro cores run
//      at once, each in its own WebGL canvas, each rendering, with isolated
//      Emscripten FS + main loop? (Headless-checkable on desktop Chrome.)
//   2. Input isolation — does a synthetic key dispatched to canvas[i] drive ONLY
//      core[i]? (The per-canvas sendInput fix is what makes this possible.)
//   3. Perf — does it hold framerate on a standalone Quest? (Headset only; this
//      harness emits the telemetry via logger.event, read back from the logs.)
//
// This module is deliberately standalone and disposable: it does NOT touch the
// real single-console wiring. main.js only imports it when ?rack is present and
// exposes window.__rackSpike(n) so scripts/debug.js --rack=N can drive it.
// Delete this file (and its main.js gate + debug.js block) once Phase 2 lands.

// 64×64 pixel checksum of a source canvas — same hash debug.js uses, so a
// "changed" checksum means that core's video advanced (these test games are
// static without input). Returns { h, nonblack } or null.
function canvasChecksum(srcCanvas) {
  const t = document.createElement('canvas');
  t.width = 64; t.height = 64;
  const ctx = t.getContext('2d');
  try { ctx.drawImage(srcCanvas, 0, 0, 64, 64); } catch (e) { return { h: 0, nonblack: 0, err: String(e) }; }
  const d = ctx.getImageData(0, 0, 64, 64).data;
  let h = 0, nonblack = 0;
  for (let i = 0; i < d.length; i += 4) {
    h = (h * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2]) >>> 0;
    if (d[i] || d[i + 1] || d[i + 2]) nonblack++;
  }
  return { h, nonblack };
}

const ARROW = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Enter: 13, Space: 32, KeyX: 88, KeyZ: 90 };

// Boot up to n module cores, each into its own offscreen canvas + EmulatorClient.
// Picks games across DISTINCT systems (realistic: different cores, not n copies
// of one) from the loaded collection. Returns a live handle with isolation +
// perf probes for debug.js / the headset to call.
// Systems whose test games boot fast and are visually STATIC without input —
// the only ones that make a clean isolation probe (a changed checksum then
// means input reached the core, not a self-animating boot screen). VICE cores
// (c64/vic20) animate their boot screen and are excluded from the auto-pick.
const PREFER_SYSTEMS = ['nes', 'gb', 'snes', 'genesis', 'sms', 'pce', 'gba'];

export async function runRackSpike({ n = 2, games, CORES, resolveRom, EmulatorClient, mount, logger, onCanvas, settleMs = 2500 } = {}) {
  const pool = (games || []).filter((g) => CORES[g.core]?.style === 'module');
  // Order the pool by PREFER_SYSTEMS, then everything else, so the auto-pick
  // favours static fast-boot games for a clean isolation read.
  const rank = (s) => { const i = PREFER_SYSTEMS.indexOf(s); return i < 0 ? 999 : i; };
  pool.sort((a, b) => rank(a.system) - rank(b.system));
  const picks = [];
  const seenSystem = new Set();
  for (const g of pool) {
    if (seenSystem.has(g.system)) continue;
    seenSystem.add(g.system);
    picks.push(g);
    if (picks.length >= n) break;
  }

  const host = mount || document.body;
  const instances = [];
  const boot = [];
  for (let i = 0; i < picks.length; i++) {
    const meta = picks[i];
    const core = CORES[meta.core];
    const canvas = document.createElement('canvas');
    canvas.id = `rack-canvas-${i}`;
    canvas.width = 640; canvas.height = 480;
    // Keep it in the DOM (some cores need an attached canvas for WebGL) but out
    // of the way; the caller may texture it onto a mesh via onCanvas.
    canvas.style.cssText = 'position:absolute;left:-9999px;top:0;width:320px;height:240px;';
    host.appendChild(canvas);
    const rec = { i, meta, canvas, client: null, booted: false, error: null };
    instances.push(rec);
    boot.push((async () => {
      try {
        const buf = await resolveRom(meta);
        const client = new EmulatorClient();
        await client.start(canvas, buf, { coreUrl: core.url, coreName: meta.core, moduleStyle: core.style });
        rec.client = client;
        rec.booted = true;
        onCanvas?.(i, canvas, meta);
        logger?.event?.('rack-boot', { i, system: meta.system, core: meta.core, title: meta.title });
      } catch (e) {
        rec.error = String(e?.message || e);
        logger?.event?.('rack-boot-error', { i, system: meta.system, core: meta.core, error: rec.error });
      }
    })());
  }
  await Promise.all(boot);
  // Let every core finish booting to a stable, painted frame before any probe —
  // otherwise the render check reads a not-yet-presented (black) canvas and the
  // isolation baseline is taken mid-boot.
  if (settleMs > 0) await new Promise((res) => setTimeout(res, settleMs));

  const handle = {
    count: instances.length,
    info: () => instances.map((r) => ({ i: r.i, system: r.meta.system, core: r.meta.core, booted: r.booted, error: r.error })),

    // Idle drift: with NO input, does each core's frame change on its own over
    // `ms`? A clean isolation test needs all-stable cores; any "drift:true" core
    // is self-animating and its isolation row is unreliable.
    async idleDrift(ms = 1200) {
      const before = instances.map((r) => canvasChecksum(r.canvas));
      await new Promise((res) => setTimeout(res, ms));
      const after = instances.map((r) => canvasChecksum(r.canvas));
      return instances.map((r, j) => ({
        i: j, system: r.meta.system,
        drift: JSON.stringify(before[j]) !== JSON.stringify(after[j]),
      }));
    },

    // Per-instance render check: nonblack pixel count (0 = black screen = core
    // booted but not presenting).
    render: () => instances.map((r) => ({ i: r.i, system: r.meta.system, ...(canvasChecksum(r.canvas) || {}) })),

    // Input-isolation probe: hold `code` on instance `target` for ms, return
    // every instance's before/after checksum + a changed flag. Isolation holds
    // iff only the target changed.
    async holdKey(target, code = 'ArrowRight', ms = 1200) {
      const before = instances.map((r) => canvasChecksum(r.canvas));
      const rec = instances[target];
      const K = ARROW[code] || 0;
      const timer = setInterval(() => {
        rec?.client?.sendInput('keydown', code, code, K, 0);
      }, 50);
      await new Promise((res) => setTimeout(res, ms));
      clearInterval(timer);
      rec?.client?.sendInput('keyup', code, code, K, 0);
      const after = instances.map((r) => canvasChecksum(r.canvas));
      return instances.map((r, j) => ({
        i: j, system: r.meta.system,
        changed: JSON.stringify(before[j]) !== JSON.stringify(after[j]),
      }));
    },

    // Event-level isolation proof (deterministic, game-independent): wrap every
    // instance's canvas.dispatchEvent, fire ONE input through instance
    // `target`'s real client.sendInput, and report which canvases received a key
    // event. Clean isolation = only canvas[target] has hits>0. This proves the
    // per-canvas routing regardless of whether the game reacts to that key.
    dispatchTrace(target, code = 'ArrowRight') {
      const hits = instances.map(() => 0);
      const orig = instances.map((r) => r.canvas.dispatchEvent.bind(r.canvas));
      instances.forEach((r, j) => {
        r.canvas.dispatchEvent = (e) => { if (e instanceof KeyboardEvent) hits[j]++; return orig[j](e); };
      });
      const K = ARROW[code] || 0;
      instances[target]?.client?.sendInput('keydown', code, code, K, 0);
      instances[target]?.client?.sendInput('keyup', code, code, K, 0);
      instances.forEach((r, j) => { r.canvas.dispatchEvent = orig[j]; });
      return instances.map((r, j) => ({ i: j, system: r.meta.system, hits: hits[j] }));
    },

    // Crude throughput proxy: mean requestAnimationFrame interval (ms) over a
    // window while all cores run. On a headset, SceneMgr's own dtMs telemetry is
    // the real signal; this is the headless stand-in.
    async sampleRaf(ms = 2000) {
      const ts = [];
      let stop = false;
      const tick = (t) => { ts.push(t); if (!stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      await new Promise((res) => setTimeout(res, ms));
      stop = true;
      let sum = 0;
      for (let i = 1; i < ts.length; i++) sum += ts[i] - ts[i - 1];
      const mean = ts.length > 1 ? sum / (ts.length - 1) : 0;
      return { frames: ts.length, meanMs: +mean.toFixed(2), fps: mean ? +(1000 / mean).toFixed(1) : 0 };
    },

    dispose() {
      for (const r of instances) {
        try { r.client?.pause?.(); } catch (_) {}
        try { r.canvas?.remove(); } catch (_) {}
      }
    },
    _instances: instances,
  };
  return handle;
}
