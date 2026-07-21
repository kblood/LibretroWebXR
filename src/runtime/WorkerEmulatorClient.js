import { FrameBridge } from './FrameBridge.js';
import { coreAssetBase } from './assetUrls.js';
import { readBytes } from '../ContentBundle.js';
import {
  WorkerMessage,
  assertProtocolMessage,
  deserializeError,
  requestMessage,
} from './protocol.js';

export class WorkerEmulatorClient extends EventTarget {
  constructor({ workerUrl = null, workerFactory = null, requestTimeoutMs = 60000 } = {}) {
    super();
    this.workerUrl = workerUrl;
    this.workerFactory = workerFactory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.ready = false;
    this.paused = false;
    this.capabilities = {};
    this.metrics = null;
    this._requestId = 0;
    this._pending = new Map();
  }

  async start(outputCanvas, content, opts = {}) {
    if (!outputCanvas) throw new Error('worker runtime requires an output canvas');
    if (!globalThis.crossOriginIsolated && opts.requiresThreads !== false) {
      throw new Error('worker core requires COOP/COEP cross-origin isolation');
    }
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas is unavailable in this browser');
    }

    if (this.worker) {
      // A loaded libretro core can retain file handles and content-global
      // state across reset. Restart for every content swap so a new CUE/M3U
      // entry can never keep the prior disc mounted.
      await this.stop();
    }

    const baseUrl = opts.baseUrl || document.baseURI;
    const urls = coreAssetBase(opts.coreUrl, baseUrl);
    this.coreName = opts.coreName || 'unknown';
    this.outputCanvas = outputCanvas;
    this.frameBridge = new FrameBridge(outputCanvas, {
      onPresented: () => this.worker?.postMessage({ protocol: 1, type: WorkerMessage.FRAME_ACK }),
    });

    this.worker = this._createWorker();
    this.worker.addEventListener('message', (event) => this._onMessage(event.data));
    this.worker.addEventListener('error', (event) => this._fatal(event.message || 'execution worker failed'));
    this.worker.addEventListener('messageerror', () => this._fatal('execution worker sent an unreadable message'));

    const prepared = await prepareLaunchPayload(content, opts);
    const result = await this._request('start', {
      ...urls,
      coreName: this.coreName,
      moduleStyle: opts.moduleStyle || 'module',
      entrypoint: opts.entrypoint || 'retroarch',
      width: opts.width || outputCanvas.width || 640,
      height: opts.height || outputCanvas.height || 480,
      ...prepared.payload,
      arguments: opts.arguments || null,
      frameIntervalMs: opts.frameIntervalMs || 16,
    }, prepared.transfer);
    this.capabilities = result?.capabilities || {};
    this.ready = true;
    this.dispatchEvent(new CustomEvent('ready'));
  }

  reset() {
    return this._request('reset').catch((error) => this._fatal(error.message));
  }

  pause() {
    this.paused = true;
    return this._request('pause');
  }

  resume() {
    this.paused = false;
    return this._request('resume');
  }

  setDisc(index) { return this._request('set-disc', { index }); }
  setDiscEjected(ejected) { return this._request('set-disc-ejected', { ejected: !!ejected }); }
  discStatus() { return this._request('disc-status'); }

  readSaveRam(slot = 1) {
    return this._request('read-save-ram', { slot }).then((result) => result ? new Uint8Array(result) : null);
  }

  flushSaveRam(slot = 1) { return this.readSaveRam(slot); }

  canSerialize() {
    return this.ready && !!this.capabilities.saveState;
  }

  serializeState() {
    if (!this.canSerialize()) return Promise.reject(new Error('core has no save-state support'));
    return this._request('serialize-state').then((result) => new Uint8Array(result));
  }

  unserializeState(data) {
    if (!this.canSerialize()) return Promise.reject(new Error('core has no save-state support'));
    const copy = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
    return this._request('unserialize-state', { data: copy.buffer }, [copy.buffer]);
  }

  sendInput(eventType, code, key, keyCode, location) {
    if (!this.worker) return;
    this.worker.postMessage(requestMessage(0, 'input', { eventType, code, key, keyCode, location }));
  }

  async stop() {
    if (!this.worker) return;
    try { await this._request('stop'); } catch (_) {}
    this.worker.terminate();
    this.worker = null;
    this.ready = false;
    this.frameBridge?.dispose();
    this.frameBridge = null;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error('execution worker stopped'));
    }
    this._pending.clear();
  }

  _request(method, payload = null, transfer = []) {
    if (!this.worker) return Promise.reject(new Error('execution worker is not running'));
    const id = ++this._requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.worker.postMessage(requestMessage(id, method, payload), transfer);
    });
  }

  _createWorker() {
    if (this.workerFactory) {
      // Tests/custom hosts own their worker URL. Keeping the canonical URL
      // literal solely in the real Worker constructor avoids Vite emitting a
      // second duplicate worker asset for this injection branch.
      return this.workerFactory(this.workerUrl);
    }
    if (this.workerUrl) return new Worker(this.workerUrl, { type: 'module', name: 'libretro-execution' });
    // Keep the canonical Vite worker form literal so production builds bundle
    // this module and its RetroArchConfig dependency into a worker chunk.
    return new Worker(new URL('./EmulatorWorkerRuntime.js', import.meta.url), {
      type: 'module',
      name: 'libretro-execution',
    });
  }

  _onMessage(raw) {
    let message;
    try { message = assertProtocolMessage(raw); } catch (error) { this._fatal(error.message); return; }
    if (message.type === WorkerMessage.RESPONSE) {
      const pending = this._pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(message.id);
      if (message.error) pending.reject(deserializeError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === WorkerMessage.FRAME) {
      try { this.frameBridge?.receive(message.bitmap, message.width, message.height); }
      catch (error) {
        message.bitmap?.close?.();
        this.worker?.postMessage({ protocol: 1, type: WorkerMessage.FRAME_ACK });
        this._fatal(`frame bridge failed: ${error.message}`);
      }
      return;
    }
    if (message.type !== WorkerMessage.EVENT) return;
    if (message.event === 'metrics') this.metrics = message.detail;
    if (message.event === 'log') {
      const fn = message.detail?.level === 'error' ? console.warn : console.debug;
      fn('[worker-core]', message.detail?.text);
    }
    if (message.event === 'error') this._fatal(message.detail?.message || String(message.detail));
    this.dispatchEvent(new CustomEvent(message.event, { detail: message.detail }));
  }

  _fatal(message) {
    console.error('[WorkerEmulatorClient]', message);
    this.dispatchEvent(new CustomEvent('error', { detail: message }));
  }
}

async function prepareLaunchPayload(content, opts) {
  const transfer = [];
  let contentPayload;
  if (content?.files instanceof Map && content.entryPath) {
    const files = [];
    for (const [path, source] of content.files) {
      const data = (await readBytes(source)).slice();
      files.push({ path, data: data.buffer });
      transfer.push(data.buffer);
    }
    contentPayload = { entryPath: content.entryPath, files };
  } else {
    const data = (await readBytes(content)).slice();
    contentPayload = { entryPath: 'rom.bin', files: [{ path: 'rom.bin', data: data.buffer }] };
    transfer.push(data.buffer);
  }

  const firmware = await prepareRecords(opts.firmware, transfer, true);
  const restoredSaves = await prepareRecords(opts.restoredSaves, transfer, false);
  return {
    payload: {
      content: contentPayload,
      firmware,
      restoredSaves,
      discCount: opts.discCount || countDiscs(content),
    },
    transfer,
  };
}

async function prepareRecords(records, transfer, requireName) {
  if (!records) return [];
  const result = [];
  for (const record of Array.isArray(records) ? records : [records]) {
    if (!record?.data || (requireName && !record.name)) continue;
    const data = (await readBytes(record.data)).slice();
    result.push({ name: record.name || null, slot: record.slot || 1, data: data.buffer });
    transfer.push(data.buffer);
  }
  return result;
}

function countDiscs(content) {
  if (!content?.entryPath?.toLowerCase().endsWith('.m3u')) return 1;
  return Math.max(1, (content.dependencies || []).filter((path) => /\.(cue|chd|ccd|pbp)$/i.test(path)).length);
}
