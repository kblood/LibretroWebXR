// Keeps WebAssembly compilation, instantiation and Emscripten function-table
// publication in the emulator's execution-worker realm. This mirrors Play!'s
// proven MemoryFunction lifecycle while giving the C/C++ adapter a stable
// pre-js hook (`globalThis.__libretroWebXRJit`).
export class JitRuntimeBridge {
  constructor() {
    this.module = null;
    this._nextId = 1;
    this._published = new Map();
    this.metrics = { compiled: 0, compileMs: 0, instantiated: 0, instantiateMs: 0, published: 0, invalidated: 0 };
    this.api = Object.freeze({
      compile: (bytes) => this.compile(bytes),
      instantiate: (compiled, imports) => this.instantiate(compiled, imports),
      publish: (options) => this.publish(options),
      invalidate: (id) => this.invalidate(id),
      snapshot: () => this.snapshot(),
    });
  }

  attachModule(module) {
    this.module = module;
    return this.api;
  }

  compile(bytes) {
    const start = performance.now();
    const compiled = new WebAssembly.Module(bytes);
    this.metrics.compiled++;
    this.metrics.compileMs += performance.now() - start;
    return compiled;
  }

  instantiate(compiled, imports = {}) {
    const start = performance.now();
    const instance = new WebAssembly.Instance(compiled, imports);
    this.metrics.instantiated++;
    this.metrics.instantiateMs += performance.now() - start;
    return instance;
  }

  publish({ bytes, compiled, imports = {}, exportName = 'block', signature = 'vi' }) {
    const wasmModule = compiled || this.compile(bytes);
    const instance = this.instantiate(wasmModule, imports);
    const fn = instance.exports[exportName];
    if (typeof fn !== 'function') throw new Error(`JIT module has no function export '${exportName}'`);
    const addFunction = this.module?.addFunction || globalThis.addFunction;
    if (typeof addFunction !== 'function') {
      throw new Error('Emscripten addFunction unavailable; build with -sALLOW_TABLE_GROWTH=1 and export addFunction');
    }
    const tableIndex = addFunction(fn, signature);
    const id = this._nextId++;
    this._published.set(id, { wasmModule, instance, fn, tableIndex });
    this.metrics.published++;
    return { id, tableIndex };
  }

  invalidate(id) {
    const record = this._published.get(id);
    if (!record) return false;
    const removeFunction = this.module?.removeFunction || globalThis.removeFunction;
    if (typeof removeFunction === 'function') removeFunction(record.tableIndex);
    this._published.delete(id);
    this.metrics.invalidated++;
    return true;
  }

  clear() {
    for (const id of [...this._published.keys()]) this.invalidate(id);
  }

  snapshot() {
    return { ...this.metrics, liveBlocks: this._published.size };
  }
}

