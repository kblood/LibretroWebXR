// A deterministic, redistributable stand-in for a MODULARIZE Emscripten
// libretro core. It deliberately implements only the JS-facing contract used
// by EmulatorWorkerRuntime; no emulator or copyrighted firmware is involved.

const encoder = new TextEncoder();

class MemoryFs {
  constructor() {
    this.files = new Map();
    this.directories = new Set(['/']);
  }

  mkdirTree(path) {
    const parts = normalize(path).split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      this.directories.add(current);
    }
  }

  writeFile(path, source) {
    const clean = normalize(path);
    const slash = clean.lastIndexOf('/');
    if (slash > 0) this.mkdirTree(clean.slice(0, slash));
    const bytes = typeof source === 'string'
      ? encoder.encode(source)
      : source instanceof Uint8Array
        ? source.slice()
        : new Uint8Array(source).slice();
    this.files.set(clean, bytes);
  }

  readFile(path) {
    const clean = normalize(path);
    const bytes = this.files.get(clean);
    if (!bytes) throw new Error(`ENOENT: ${clean}`);
    return bytes.slice();
  }

  stat(path) {
    const bytes = this.files.get(normalize(path));
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return { size: bytes.byteLength };
  }

  unlink(path) {
    if (!this.files.delete(normalize(path))) throw new Error(`ENOENT: ${path}`);
  }
}

function normalize(path) {
  const value = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
  return value || '/';
}

function equals(actual, expected) {
  return actual?.length === expected.length && expected.every((value, index) => actual[index] === value);
}

// (module
//   (func (export "block") (param i32) (result i32)
//     local.get 0
//     i32.const 1
//     i32.add))
const JIT_INCREMENT_BLOCK = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x09, 0x01, 0x05, 0x62, 0x6c, 0x6f, 0x63, 0x6b, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x41, 0x01, 0x6a, 0x0b,
]);

export default async function createFakeModularCore(options) {
  const FS = new MemoryFs();
  const functions = new Map();
  let nextFunctionIndex = 100;
  let stateValue = 7;
  let resetCount = 0;
  let pauseCalls = 0;

  const report = (name, value) => options.webxrRuntime.reportMetric(name, value);

  const core = {
    FS,
    addFunction(fn, signature) {
      const index = nextFunctionIndex++;
      functions.set(index, { fn, signature });
      report('fakeAddFunctionCalls', functions.size);
      return index;
    },
    removeFunction(index) {
      functions.delete(index);
      report('fakeRemoveFunctionCalls', (core._removeCalls = (core._removeCalls || 0) + 1));
    },
    async webxrStart({ romPath }) {
      let launchMask = 0;
      if (romPath === '/content/discs/game.m3u') launchMask |= 1;
      if (new TextDecoder().decode(FS.readFile('/content/discs/game.m3u')) === 'disc1.cue\ndisc2.cue\n') launchMask |= 2;
      if (equals(FS.readFile('/content/discs/disc1.bin'), [1, 2, 3, 4])) launchMask |= 4;
      if (equals(FS.readFile('/content/discs/disc2.bin'), [5, 6, 7, 8])) launchMask |= 8;
      if (equals(FS.readFile('/home/web_user/retroarch/userdata/system/scph5501.bin'), [0x55, 0xaa])) launchMask |= 16;
      if (equals(FS.readFile('/home/web_user/retroarch/userdata/saves/game.srm'), [0x10, 0x20, 0x30])) launchMask |= 32;
      if (FS.stat('/home/web_user/retroarch/userdata/retroarch.cfg').size > 100) launchMask |= 64;
      report('launchValidationMask', launchMask);

      // Simulate the core dirtying a restored memory card.
      FS.writeFile('/home/web_user/retroarch/userdata/saves/game.srm', new Uint8Array([0xa1, 0xb2, 0xc3, 0xd4]));

      const context = options.canvas.getContext('2d');
      context.fillStyle = '#0c80e8';
      context.fillRect(0, 0, options.canvas.width, options.canvas.height);

      options.webxrRuntime.pushAudio(new Float32Array([0.25, -0.25, 0.5, -0.5]), 2, 44100);

      const first = options.webxrJit.publish({ bytes: JIT_INCREMENT_BLOCK, signature: 'ii' });
      const firstResult = functions.get(first.tableIndex).fn(41);
      const invalidated = options.webxrJit.invalidate(first.id);
      const second = options.webxrJit.publish({ bytes: JIT_INCREMENT_BLOCK, signature: 'ii' });
      const secondResult = functions.get(second.tableIndex).fn(99);
      report('jitResult', firstResult * 1000 + secondResult);
      report('jitFixtureInvalidated', invalidated ? 1 : 0);
    },
    webxrInputEvent(event) {
      report('lastInputWasStart', event.eventType === 'keydown' && event.code === 'Enter' ? 1 : 0);
    },
    _cmd_reset() {
      resetCount++;
      stateValue++;
      report('resetCalls', resetCount);
    },
    _cmd_pause() {
      pauseCalls++;
      report('pauseCalls', pauseCalls);
    },
    _cmd_save_state() {
      FS.writeFile('/home/web_user/retroarch/userdata/states/game.state', new Uint8Array([0x53, stateValue, resetCount]));
    },
    _cmd_load_state() {
      const state = FS.readFile('/home/web_user/retroarch/userdata/states/game.state');
      stateValue = state[1];
      report('loadedStateValue', stateValue);
    },
    _libretrowebxr_set_eject_state(ejected) {
      report('lastEjectState', ejected);
      return 1;
    },
    _libretrowebxr_set_disc_index(index) {
      report('lastDiscIndex', index);
      return 1;
    },
    _cmd_unload_core() {
      report('unloaded', 1);
    },
  };

  return core;
}

