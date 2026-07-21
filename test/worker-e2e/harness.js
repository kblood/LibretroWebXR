import { WorkerEmulatorClient } from '../../src/runtime/WorkerEmulatorClient.js';

const bytes = (...values) => new Uint8Array(values);
const text = (value) => new TextEncoder().encode(value);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, description, timeoutMs = 7000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

export async function runWorkerE2E() {
  assert(crossOriginIsolated, 'test page is not cross-origin isolated');
  const output = document.querySelector('#output');
  const client = new WorkerEmulatorClient({ requestTimeoutMs: 10000 });
  const audio = [];
  const errors = [];
  client.addEventListener('audio', ({ detail }) => audio.push(detail));
  client.addEventListener('error', ({ detail }) => errors.push(String(detail)));

  const content = {
    entryPath: 'discs/game.m3u',
    dependencies: ['discs/game.m3u', 'discs/disc1.cue', 'discs/disc1.bin', 'discs/disc2.cue', 'discs/disc2.bin'],
    files: new Map([
      ['discs/game.m3u', text('disc1.cue\ndisc2.cue\n')],
      ['discs/disc1.cue', text('FILE "disc1.bin" BINARY\n')],
      ['discs/disc1.bin', bytes(1, 2, 3, 4)],
      ['discs/disc2.cue', text('FILE "disc2.bin" BINARY\n')],
      ['discs/disc2.bin', bytes(5, 6, 7, 8)],
    ]),
  };

  try {
    await client.start(output, content, {
      coreName: 'deterministic_fake_psx',
      coreUrl: new URL('./fake-modular-core.js', import.meta.url).href,
      moduleStyle: 'module',
      entrypoint: 'adapter',
      requiresThreads: true,
      width: 64,
      height: 48,
      frameIntervalMs: 8,
      firmware: { name: 'scph5501.bin', data: bytes(0x55, 0xaa) },
      restoredSaves: { slot: 1, data: bytes(0x10, 0x20, 0x30) },
    });

    await waitFor(() => audio.length >= 1, 'audio bridge event');
    await waitFor(() => client.frameBridge.framesPresented > 0, 'presented worker frame');
    await waitFor(() => client.metrics?.launchValidationMask === 127, 'hydration metrics');

    assert(client.ready, 'client did not become ready');
    assert(client.canSerialize(), 'save-state capability was not detected');
    assert(client.capabilities.saveRam, 'SaveRAM capability was not detected');
    assert(client.capabilities.discControl, 'disc-control capability was not detected');
    assert(client.capabilities.jit, 'JIT capability was not detected');
    assert(client.capabilities.audioBridge, 'audio bridge capability was not detected');
    assert(client.capabilities.frameBridge, 'frame bridge capability was not detected');

    const samples = new Float32Array(audio[0].samples);
    assert(audio[0].format === 'f32' && audio[0].channels === 2 && audio[0].sampleRate === 44100, 'audio metadata changed');
    assert(samples.length === 4 && samples[0] === 0.25 && samples[3] === -0.5, 'audio samples changed in transit');

    const pixel = output.getContext('2d').getImageData(1, 1, 1, 1).data;
    assert(pixel[2] > 200 && pixel[0] < 40, `unexpected frame pixel ${[...pixel]}`);

    const saveRam = await client.readSaveRam(1);
    assert([...saveRam].join(',') === '161,178,195,212', 'restored SaveRAM was not mounted and mutated');

    await client.reset();
    await client.pause();
    await client.resume();
    client.sendInput('keydown', 'Enter', 'Enter', 13, 0);

    const savedState = await client.serializeState();
    assert([...savedState].join(',') === '83,8,1', `unexpected serialized state ${[...savedState]}`);
    await client.unserializeState(bytes(0x53, 42, 9));

    const initialDisc = await client.discStatus();
    assert(initialDisc.discCount === 2 && initialDisc.index === 0 && !initialDisc.ejected, 'initial disc status is wrong');
    const selectedDisc = await client.setDisc(1);
    assert(selectedDisc.index === 1 && !selectedDisc.ejected, 'disc selection did not restore tray state');
    const ejectedDisc = await client.setDiscEjected(true);
    assert(ejectedDisc.ejected, 'disc eject failed');
    const insertedDisc = await client.setDiscEjected(false);
    assert(!insertedDisc.ejected, 'disc insert failed');

    await waitFor(() => {
      const current = client.metrics;
      return current?.resetCalls === 1
        && current?.pauseCalls === 2
        && current?.lastInputWasStart === 1
        && current?.loadedStateValue === 42
        && current?.lastDiscIndex === 1;
    }, 'control and state metrics');

    assert(client.metrics.jitResult === 42100, `JIT block returned ${client.metrics.jitResult}`);
    assert(client.metrics.jitFixtureInvalidated === 1, 'JIT invalidation did not succeed');
    assert(client.metrics.jit.compiled === 2, 'JIT did not compile both fixture blocks');
    assert(client.metrics.jit.instantiated === 2, 'JIT did not instantiate both fixture blocks');
    assert(client.metrics.jit.published === 2, 'JIT did not publish both fixture blocks');
    assert(client.metrics.jit.invalidated === 1 && client.metrics.jit.liveBlocks === 1, 'JIT lifecycle counts are wrong');
    assert(client.metrics.inputs === 1, 'input RPC count is wrong');
    assert(errors.length === 0, `worker emitted errors: ${errors.join('; ')}`);

    return {
      crossOriginIsolated,
      capabilities: client.capabilities,
      hydrationMask: client.metrics.launchValidationMask,
      framesPresented: client.frameBridge.framesPresented,
      framesProduced: client.metrics.framesProduced,
      framesSkipped: client.metrics.framesSkipped,
      audio: { events: audio.length, format: audio[0].format, channels: audio[0].channels, sampleRate: audio[0].sampleRate, samples: [...samples] },
      saveRam: [...saveRam],
      saveState: [...savedState],
      disc: insertedDisc,
      controls: {
        resetCalls: client.metrics.resetCalls,
        pauseCalls: client.metrics.pauseCalls,
        inputs: client.metrics.inputs,
        loadedStateValue: client.metrics.loadedStateValue,
      },
      jit: client.metrics.jit,
      errors,
    };
  } finally {
    await client.stop();
  }
}

globalThis.runWorkerE2E = runWorkerE2E;
