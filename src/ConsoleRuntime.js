// ConsoleRuntime — one running console: an EmulatorClient + its own video
// canvas + the loaded ROM/system + lifecycle (load / pause / resume / dispose)
// + per-instance input (canvas-targeted, so keys reach only THIS core).
//
// This is the unit the multi-console rack ([[src/RackMgr.js]]) multiplies. The
// Phase-0 spike proved N module cores can run isolated in their own canvases;
// ConsoleRuntime is that, productionised: a stable handle with a weight (for the
// [[src/RackBudget.js]] admission policy) and a clean pause/resume the budget
// drives.
//
// Two construction modes:
//   • own   — creates its own offscreen <canvas> + a fresh EmulatorClient
//             (the normal case for spawned consoles).
//   • adopt — wraps an EXISTING { client, canvas } (the primary console main.js
//             already wired to #canvas / the main TV), so the established
//             single-console path becomes console0 of the rack with no behaviour
//             change and no second WebGL context.
//
// Cores can't cleanly unload (they pin a WebGL context that survives callMain),
// so dispose() pauses + detaches rather than truly freeing — RackBudget's
// maxLive cap is what bounds live contexts.

import { EmulatorClient } from './EmulatorClient.js';
import { coreWeight } from './systems.js';

export class ConsoleRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.id                    stable console id (Patchbay key)
   * @param {object} [opts.adopt]               { client, canvas } to wrap instead of creating
   * @param {Document} [opts.document]          DOM document (for tests/headless)
   * @param {number} [opts.width]  canvas width  (own mode, default 640)
   * @param {number} [opts.height] canvas height (own mode, default 480)
   */
  constructor({ id, adopt = null, document: doc = (typeof document !== 'undefined' ? document : null), width = 640, height = 480 } = {}) {
    this.id = id;
    this.adopted = !!adopt;
    this.coreName = null;
    this.system = null;
    this.title = null;
    this.weight = 1;
    this.loaded = false;
    this._disposed = false;

    if (adopt) {
      this.client = adopt.client;
      this.canvas = adopt.canvas;
    } else {
      if (!doc) throw new Error('ConsoleRuntime: no document to create a canvas');
      this.canvas = doc.createElement('canvas');
      this.canvas.id = `console-canvas-${id}`;
      this.canvas.width = width;
      this.canvas.height = height;
      // Kept in the DOM (some cores need an attached canvas for WebGL) but out
      // of the page flow; the scene textures it onto a TV mesh.
      this.canvas.style.cssText = 'position:absolute;left:-9999px;top:0;width:320px;height:240px;';
      (doc.body || doc.documentElement).appendChild(this.canvas);
      this.client = new EmulatorClient();
    }
  }

  /** True once a ROM has booted (or, in adopt mode, if the client is ready). */
  isLoaded() { return this.loaded || (this.adopted && !!this.client?.ready); }

  /** Whether the core's main loop is currently running (not paused). */
  isLive() { return !this.client?.paused; }

  /**
   * Boot a ROM into this console's core. `core` is the systems.js core info
   * ({ name, url, style }); `meta` carries system/title for labelling.
   * @param {ArrayBuffer} romBuffer
   * @param {{name:string,url:string,style:string}} core
   * @param {{system?:string,title?:string}} [meta]
   */
  async load(romBuffer, core, meta = {}) {
    await this.client.start(this.canvas, romBuffer, {
      coreUrl: core.url, coreName: core.name, moduleStyle: core.style,
    });
    this.coreName = core.name;
    this.system = meta.system ?? null;
    this.title = meta.title ?? null;
    this.weight = coreWeight(core.name);
    this.loaded = true;
    return this;
  }

  // Adopt-mode helper: when the wrapped client is booted externally (main.js
  // drives the primary console's boot directly), record what it loaded so the
  // budget knows this console's real weight/system without load() owning boot.
  noteLoaded(coreName, meta = {}) {
    this.coreName = coreName;
    this.system = meta.system ?? this.system;
    this.title = meta.title ?? this.title;
    this.weight = coreWeight(coreName);
    this.loaded = true;
  }

  pause() { try { this.client?.pause?.(); } catch (e) { console.warn('[ConsoleRuntime] pause', e); } }
  resume() { try { this.client?.resume?.(); } catch (e) { console.warn('[ConsoleRuntime] resume', e); } }

  /** Dispatch a synthetic key event to THIS console's core (canvas-targeted). */
  sendInput(eventType, code, key, keyCode, location) {
    this.client?.sendInput?.(eventType, code, key, keyCode, location);
  }

  /** Pause + detach. Never frees the WebGL context (cores can't unload). */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.pause();
    if (!this.adopted) {
      try { this.canvas?.remove?.(); } catch (_) {}
    }
  }
}
