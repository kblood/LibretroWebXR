# M2 Rollback Feasibility — Bare libretro cores in the browser

Research spike for **Phase M2 (rollback game sync)**. Answers: *can we get a
libretro core running in the browser that supports (1) deterministic per-frame
stepping and (2) fast synchronous savestates, and how much work is it?*

Cited sources at the bottom. Honest about uncertainty: I have not yet built a
bare core, so size/perf numbers are from emulator docs/forums and the RetroArch
netplay+runahead design, not from our own measurements.

---

## TL;DR recommendation (top)

- **M2-as-rollback IS technically feasible** in this architecture, but only by
  swapping the RetroArch-bundled `_libretro.js` cores for **bare libretro cores**
  compiled to wasm and driven by a new JS frame loop. Our current cores
  genuinely cannot do it (free-running `emscripten_set_main_loop`, async VFS
  savestate).
- **It is a real rewrite, not a slice.** Realistic effort: **3–6 weeks** for a
  single-core proof of concept (bare-core build + new `EmulatorClient` that owns
  the loop + netplayjs-style rollback wrapper), more to generalize.
- **Prototype core first: `fceumm` (NES)** — smallest savestate, simplest build,
  rock-solid determinism. `gambatte` (GB/GBC) is the close second.
- **Cheaper interim (recommended near-term):** keep **M1 host-authoritative
  video streaming as the default** for all games, and treat rollback as an
  *opt-in experiment for one hand-picked deterministic core*, not a replacement.
  M1 already ships and works for every core; rollback only pays off for
  twitch/fighting/co-op latency-sensitive titles. **Do not rewrite the working
  core path wholesale.**

---

## 1. Bare libretro core vs RetroArch-wrapped

**What we ship now.** Our cores are `*_libretro.js` + `.wasm` from the libretro
buildbot / webretro. These are **the whole RetroArch frontend** compiled to wasm
with the core statically linked in. The core is built first to LLVM bitcode
(`emmake make -f Makefile.libretro platform=emscripten` → `libretro_emscripten.bc`),
then that bitcode is **linked into the RetroArch emscripten build** to produce the
final module ([RetroArch pkg/emscripten README], [EmulatorJS buildingraw]). The
JS entry point is RetroArch's `main()`, which installs its own
`emscripten_set_main_loop` and runs `retro_run` internally. That is exactly why
`EmulatorClient.start()` calls `callMain([...])` and then can only
`pauseMainLoop`/`resumeMainLoop` the whole loop — the bare libretro symbols
(`retro_run`, `retro_serialize`) are *inside* RetroArch and not exported to JS.

**What the buildbot publishes.** Only the RetroArch-bundled builds (the
`_libretro.js` modules we already use). **The buildbot does NOT publish bare,
JS-callable cores** — there is no "core-only emscripten" artifact. So we'd have
to produce them ourselves.

**Can a bare core be compiled to wasm and called directly from JS? Yes —
proven.** A bare libretro core is just a `.so`/`.dylib`/`.dll` that exports the
libretro C ABI (`retro_init`, `retro_load_game`, `retro_run`,
`retro_serialize_size`, `retro_serialize`, `retro_unserialize`,
`retro_get_system_av_info`, the `retro_set_*` callback setters, etc. —
[Core Development Overview]). Compile that translation unit with emscripten
exporting those symbols (`-s EXPORTED_FUNCTIONS=['_retro_init','_retro_run',...]`
plus `cwrap`/`ccall` in JS) and **JS owns the frame loop**.

Precedent: **`matthewbauer/retrojs`** does exactly this — "compiles some libretro
projects into nice CommonJS modules using Emscripten… the API closely follows
libretro.h," exposing `run`, `serialize`, `unserialize`, `set_video_refresh`,
`set_audio_sample(_batch)`, `set_input_state`, `set_input_poll`,
`get_system_av_info`, `get_memory_data` ([retrojs]). Its working core list is
telling: **snes9x-next, gambatte, vba-next, nestopia, gw, vecx** all worked
(picodrive/mupen64/jaguar were broken). It's old/unmaintained, so we'd modernize
the emscripten flags, but it's a direct existence proof and a reference build.

**Easiest cores to build bare.** Dependency-light, pure-C/C++, software-rendered:
- **`fceumm`** (NES) — tiny, trivial build, the canonical "hello world" libretro
  emscripten example in the RetroArch README.
- **`gambatte`** (GB/GBC) — small, clean, software-rendered.
- **`nestopia`** (NES) — also small.
- **`snes9x` / `snes9x2010`** — bigger but self-contained and software-rendered;
  retrojs ran snes9x-next.

All four are software-rendered (write a framebuffer), which is the *easy* case for
us — no WebGL context juggling.

## 2. Synchronous savestate

With a bare core the path is the synchronous libretro contract:

```
size = retro_serialize_size();          // call FIRST, sizes the buffer
buf   = _malloc(size);                   // emscripten heap
retro_serialize(buf, size);              // fills buf synchronously, returns now
// later, to roll back:
retro_unserialize(buf, size);            // restores state synchronously
```

`retro_serialize` is a plain synchronous C call that returns the bytes
immediately — no task queue, no VFS, no polling. Read them straight out of
`Module.HEAPU8`. This is **the rollback snapshot**.

Contrast with **our current async path** (`EmulatorClient.serializeState`): we
fire `_cmd_save_state`, RetroArch's *task system* writes a `.state` file to the
Emscripten VFS asynchronously, and we **poll `FS.stat` in 33 ms ticks for a
stable size** — hundreds of ms, completely unusable as a per-frame snapshot.

**Is it fast enough (<~16 ms)? Yes, for these systems.** The strongest evidence:
RetroArch's own **netplay and run-ahead features use this exact
serialize/unserialize-and-replay mechanism every frame on the main thread**, and
they're smooth for NES/SNES/GB ([RetroArch netplay], [Netplay docs],
[netplay-faq]). The libretro per-core flag
**`CORE_INFO_SAVESTATE_DETERMINISTIC` is the prerequisite for both Netplay and
Runahead** — i.e. the cores we care about already advertise it. Typical sizes:
- **NES (fceumm/nestopia):** single-digit KB.
- **GB/GBC (gambatte):** ~**59 KB** (a reported GBC savestate; [serialize size discussions]).
- **SNES (snes9x):** larger, multi-block, gzip-compressed format; on the order of
  ~**100–300 KB** uncompressed (exact value is `retro_serialize_size()` at
  runtime; netplay-tuned cores deliberately trim non-essential data — [netplay-faq]).

Copying tens-to-hundreds of KB out of the wasm heap is sub-millisecond;
`retro_serialize` itself for these cores is well under a frame. Run-ahead (which
saves+loads+re-runs every frame) being usable on a Raspberry Pi is the proof.

## 3. Frame-stepping driver (the rewrite)

An alternative `EmulatorClient` that owns the loop, roughly:

```js
// setup
const core = await loadBareCore();                 // emscripten Module
core._retro_set_environment(envCb);
core._retro_set_video_refresh(onVideo);            // (data,w,h,pitch) -> blit to canvas
core._retro_set_audio_sample_batch(onAudio);       // (ptr,frames) -> Web Audio ring
core._retro_set_input_poll(()=>{});                // we push inputs, so no-op
core._retro_set_input_state(onInputState);         // (port,device,idx,id) -> our merged input
core._retro_init();
core._retro_load_game(gameInfoPtr);
const av = readSystemAvInfo();                      // fps, sample rate, geometry

// OUR loop (driven by rAF or the rollback scheduler, NOT the core)
function frame(inputs) {
  currentInputs = inputs;        // read back by onInputState during the call
  core._retro_run();             // exactly one video frame
}
```

This is the model netplayjs needs: **one `retro_run()` == one `tick()`**, inputs
fed via the `retro_set_input_state` callback (we return whatever the merged/
predicted input for this frame is), video pulled in `retro_set_video_refresh`,
audio in `retro_set_audio_sample_batch`.

**Size of the rewrite vs today: large.** The whole "let RetroArch drive itself"
model is replaced. What changes / what breaks:
- **Video.** Bare software cores hand us a raw framebuffer (RGB565/XRGB8888) per
  frame. We must blit it to a canvas ourselves (ImageData / a small WebGL texture
  upload) instead of letting RetroArch own the WebGL context. Net simpler than the
  current GL-context dance, *but it's all new code*. (Three.js still samples that
  canvas as a `CanvasTexture` — unchanged downstream.)
- **Audio.** Today RetroArch schedules audio. We'd own a Web Audio ring buffer fed
  from `audio_sample_batch`. During **rollback we re-run frames at faster-than-
  realtime and must MUTE the re-simulated frames** (only the final, confirmed frame
  produces audio) — this is the fiddliest part and a classic source of clicks.
- **Pacing.** rAF (or netplayjs's fixed-timestep accumulator) calls `retro_run`
  at the core's `av_info.fps` (usually ~60). We must decouple from display rate.
- **Threading / COOP-COEP.** Build the bare core **single-threaded** for the
  prototype — much simpler, and rollback wants deterministic single-thread anyway.
  We already serve COOP/COEP so `SharedArrayBuffer` is available if a core ever
  needs `pthreads`, but avoid it for M2. ASYNC/asyncify is **not** wanted (it
  conflicts with synchronous re-simulation) — keep the core synchronous.
- **Input.** Our existing logical-RetroPad mapping feeds the input-state callback
  directly — cleaner than today's synthetic-`KeyboardEvent`-on-`document` hack in
  `sendInput`.

This is a parallel `EmulatorClient` (e.g. `BareEmulatorClient`) selectable
per-core, **not** a rip-and-replace of the working one.

## 4. netplayjs adaptation

netplayjs ([rameshvarun/netplayjs]) structures a game as a `Game` subclass with:
- `tick(playerInputs: Map<Player, Input>)` — advance simulation one fixed step.
- `serialize(): JsonValue` / `deserialize(value)` — snapshot & restore state.
- `draw(canvas)` — render current state.
- static `timestep` (e.g. `1000/60`) and `canvasSize`.

`RollbackWrapper` + `RollbackNetcode` then: each frame **serialize → store
snapshot**, predict remote inputs, `tick` forward; when authoritative remote
input arrives late, **`deserialize` back to the last agreed snapshot and re-`tick`
forward** with corrected inputs. The docs explicitly note serialization "must
execute synchronously and efficiently each frame." Transport is WebRTC
DataChannel; lockstep is offered as a fallback for non-serializable games.

**libretro → netplayjs mapping (clean):**

| netplayjs | libretro bare core |
|---|---|
| `tick(inputs)` | set merged input → `retro_run()` once |
| `serialize()` | `retro_serialize(buf, size)` → return `Uint8Array` |
| `deserialize(b)` | write bytes to heap → `retro_unserialize(buf, size)` |
| `draw(canvas)` | last `video_refresh` framebuffer (already on our canvas) |
| `Input` | RetroPad button bitfield (we already model this) |
| `timestep` | `1000 / av_info.timing.fps` |

We would **not** use netplayjs's JSON autoserializer (state is a binary blob);
we override `serialize`/`deserialize` to move bytes. We can either depend on
netplayjs directly or lift just its rollback loop (it's small) to avoid its
WebRTC/matchmaking layer, since we already have signaling (`NetMgr`/`NetProtocol`,
the `INPUT` message) and STUN/TURN to wire. Reusing our transport and only
adopting netplayjs's rollback *algorithm* is probably the better fit.

## 5. Determinism

Rollback requires that `retro_run` from a restored savestate with the same input
sequence reproduces the *exact* same state. The per-core
`CORE_INFO_SAVESTATE_DETERMINISTIC` flag advertises this, and it's the gate for
RetroArch's own netplay/run-ahead.

- **NES — `fceumm`, `nestopia`:** deterministic, tiny state. Best candidates.
- **GB/GBC — `gambatte`:** deterministic, well-tested in netplay. Strong.
- **SNES — `snes9x` / `snes9x2010`:** generally deterministic and netplay-used;
  caveats around some special chips (SuperFX/SA-1/CX4) and that the threaded/
  hi-res or "next" variants can differ — build single-threaded and pin one core
  variant + one ROM hash (we already track `sha1`).
- **Avoid for M2:** PSX/N64/Saturn and anything heavy or with non-deterministic
  timing — large states, weaker determinism, threading, JIT. (N64 rollback exists
  now in some emulators, but that's far beyond a spike.)

General caveat: determinism must hold **across machines/builds** — same core
binary, same ROM, single-threaded, no host-RNG/time leakage. Pin the exact core
build alongside the ROM hash check we already do.

## 6. Effort + recommendation

**Effort tiers (single deterministic core PoC):**
1. **Build a bare core** (fceumm) to wasm exporting the libretro symbols, callable
   via `cwrap`. Modernize retrojs-style flags. *~3–7 days* (build-system spelunking
   is the risk; first one is the hardest).
2. **`BareEmulatorClient`** that owns the loop: input-state callback, framebuffer
   blit to canvas, Web Audio ring, sync `retro_serialize`/`retro_unserialize`
   wrappers. *~1–2 weeks.*
3. **Rollback layer**: adopt netplayjs's rollback loop over our existing WebRTC
   `INPUT` transport; snapshot/rollback via the sync savestate; mute re-simulated
   audio. *~1–2 weeks*, plus tuning (input delay, max rollback frames, desync
   detection via state-hash compare).

→ **~3–6 weeks for a believable 2-player NES rollback demo.** Generalizing to
SNES/GB and to crossplay (M3) is additional.

**Bottom line.** Feasible, well-trodden (retrojs proves the build; RetroArch
netplay/runahead prove the runtime), but it is a genuine new core-driving stack,
not an incremental M2 slice — consistent with the HANDOFF/ROADMAP "blocked as
scoped" flag.

**Recommended path:**
- **Keep M1 host-authoritative streaming as the shipped default for all games.**
  It already works for every core, deterministic or not, and is "good enough" for
  co-op/party/turn-based — which is most of the EmuVR-style social use case.
- **Do the bare-core spike on `fceumm` only**, as an opt-in proof of concept, to
  validate sync savestate + frame stepping + a netplayjs rollback loop end-to-end.
  Decide on full M2 *after* the PoC, with real perf numbers.
- **Don't** convert the whole core library to bare cores. Reserve rollback for the
  handful of latency-sensitive deterministic titles where it actually beats
  streaming; everything else stays on M1.

---

## Sources

- RetroArch emscripten build: <https://github.com/libretro/RetroArch/blob/master/pkg/emscripten/README.md>
- EmulatorJS — building raw cores: <https://emulatorjs.org/docs4devs/buildingraw/>
- libretro Core Development Overview (the libretro C ABI): <https://docs.libretro.com/development/cores/developing-cores/>
- retrojs (bare cores → JS modules; existence proof): <https://github.com/matthewbauer/retrojs>
- netplayjs (rollback Game/serialize/deserialize/tick model): <https://github.com/rameshvarun/netplayjs>
- RetroArch netplay (rewind+replay mechanism): <https://www.retroarch.com/?page=netplay>
- libretro Netplay docs: <https://docs.libretro.com/development/retroarch/netplay/>
- libretro Netplay FAQ (serialization requirement, trimmed savestates): <https://docs.libretro.com/guides/netplay-faq/>
- Save state / serialize-size discussions (sizes, gzip blocks): NESDev forum <https://forums.nesdev.org/viewtopic.php?t=16081>, snes9x savestate format <https://www.romhacking.net/documents/383/>, Gambatte savestate size (RetroArch issue) <https://github.com/libretro/RetroArch/issues/6795>
- Determinism context: `CORE_INFO_SAVESTATE_DETERMINISTIC` required for netplay/runahead (per netplay docs above)

*Local context read: `docs/MULTIPLAYER.md`, `docs/HANDOFF.md` (Phase M2 note),
`docs/ROADMAP.md` (M2 entry), `src/EmulatorClient.js`, `src/SaveState.js`,
`src/net/NetProtocol.js`, `src/net/NetMgr.js`.*
