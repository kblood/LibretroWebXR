# Debugging LibretroWebXR

The principle here: **don't ask the user to copy/paste devtools output**. Drive
a real browser yourself, capture everything, and decide what's healthy.

## Quick reference

| What you want to check | Command |
| --- | --- |
| Production deploy healthy at idle | `npm run debug` |
| Local Vite preview healthy at idle | `npm run debug -- --url=http://localhost:4173/` |
| Worker boot path (no real ROM needed) | `npm run debug -- --rom=scripts/junk.smc` |
| Visually verify the 3D scene reads correctly | `npm run debug -- --screenshot=out.png` and Read out.png |
| Watch the page interactively | `npm run debug -- --headed` |
| Run for longer (capture late errors) | `npm run debug -- --timeout=20000` |

Exit code: `0` = healthy, `1` = errors observed (any console.error, page
error, request failure, or `crossOriginIsolated === false`), `2` = setup
failure (no Chrome found).

## What the harness captures

`scripts/debug.js` launches the system Chrome via `puppeteer-core` (no
Playwright/Chromium download needed) and subscribes to:

- `console` — every log/info/warn/error from the page **and any workers**.
  Worker `console.log` shows up as `[console:log] [worker] …` because the
  worker forwards via `postMessage({type:'log',...})` and the main thread
  re-logs.
- `pageerror` — uncaught exceptions on the main thread.
- `requestfailed` — network failures (CORS, ERR_CONNECTION_REFUSED, etc).
- `response` — 4xx/5xx responses.

It also evaluates a few sanity probes after `load`:

- `self.crossOriginIsolated` — must be `true`, otherwise SharedArrayBuffer
  is unavailable and any pthread-built libretro core will silently refuse
  to spin up its worker pool.
- `#stage canvas` exists and has non-zero size — proves Three.js attached.
- `window.__scene.scene.children.length` — proves `SceneMgr` actually built
  the scene graph (we expose `__scene` for exactly this kind of poking).

## Selecting a libretro core

`--core=<name>` appends `?core=<name>` to the page URL so the bundled core
selection overrides ROM-extension auto-detection. Useful when:

- The extension is ambiguous (`.bin` → Atari 2600 by default, but the same
  byte stream could be a Mega Drive ROM).
- Multiple cores can run the same system and you want to A/B them
  (e.g. `picodrive` vs `genesis_plus_gx` for SMS — picodrive wins).

Two core styles live in `src/main.js`'s `CORES` map:

- `style: 'classic'` — older WebEmu-era cores that auto-init against
  `window.Module` when their `<script>` tag loads. Cheap, but the
  classic-script parser rejects newer Emscripten output that uses
  `import.meta.url`.
- `style: 'module'` — modern libretro-buildbot cores (MODULARIZE=1) that
  `export default <factory>`. Loaded via dynamic `import()` and
  instantiated with `mod.default(moduleArg)` — exactly how upstream
  `retroarch/libretro.js` does it.

Adding a new core means downloading from
`https://buildbot.libretro.com/nightly/emscripten/RetroArch.7z` (760MB
bundle — there is no per-core download URL), extracting the two files
with `7z e RetroArch.7z -o<dest> retroarch/<core>_libretro.{js,wasm}`,
copying into `public/cores/`, and adding a `CORES` entry. Style is
`module` for anything from the modern bundle.

## The "junk ROM" trick

`scripts/junk.smc` is 512 KiB of `0xAA`. It is **not a valid SNES ROM** and
the core will explode trying to interpret it. That's the point: we use it
to verify the **boot path**, not gameplay. A healthy boot looks like:

```
[onmessage] received type=start
Core URL: …/cores/snes9x_libretro.js, CoreName: snes9x
Emulator Canvas received: Yes (512x448)
Importing core script: …/cores/snes9x_libretro.js
WASM Runtime Initialized in Worker.
```

If any of those lines is missing, the failure is in **infrastructure**
(wrong file shipped, COOP/COEP missing, syntax error in the core, etc.),
not in game logic. After "WASM Runtime Initialized" the spam of
`null function` errors is the core dying on garbage bytes — **expected**
with this fixture, and a sign the pipeline is fundamentally working.

To regenerate the fixture:
```bash
node -e "require('fs').writeFileSync('scripts/junk.smc', Buffer.alloc(512*1024, 0xAA))"
```

## How to inject a real ROM in CI/local testing

The harness uses a synthetic file-picker change event so you don't need a
real file dialog. Any path passed to `--rom` is read, base64'd, dropped
into a `DataTransfer`, and assigned to `#rom-input.files`. Same code path
as a user-initiated upload. **Never check ROMs into the repo** — keep them
out of version control and pass them explicitly per invocation.

## Server-side checks (when the harness suggests an infra problem)

```bash
# Headers actually being served?
curl -sI https://dionysus.dk/webxr/libretrowebxr/ | grep -iE 'cross-origin|cache-control'
curl -sI https://dionysus.dk/webxr/libretrowebxr/cores/snes9x_libretro.wasm | grep -i content-type

# Apache error log on the box
ssh -i <your-ssh-key> <user>@<host> \
    "sudo tail -n 50 /var/log/apache2/error.log"

# What's actually deployed
ssh -i <your-ssh-key> <user>@<host> \
    "ls -la /var/www/html/webxr/libretrowebxr/ /var/www/html/webxr/libretrowebxr/cores/"
```

The .htaccess in `dist/.htaccess` is the source of truth for headers. If
COOP/COEP aren't applied after deploy, the most likely cause is Apache's
default `AllowOverride None` swallowing the .htaccess — `deploy/libretrowebxr.conf`
fixes that by scope-enabling `AllowOverride FileInfo Indexes` for this
project's dir. It must be present in `/etc/apache2/conf-available/` and
enabled with `a2enconf libretrowebxr`.

## Things the harness cannot debug

- **Real ROM gameplay**: provide a `--rom=path/to/real.smc` to exercise it.
- **Quest VR**: headless Chrome has no XR runtime — the harness will log
  `VR NOT SUPPORTED` in the page. Real VR testing needs the headset (and
  the page served over HTTPS, which production already is).
- **Audio**: puppeteer can capture audio events via CDP but we don't yet.
- **Controller input mapping**: synthesised `selectstart`/`squeezestart`
  events would need a fake XR session; out of scope today.
- **`canvas.captureStream()` video frames (WebRTC netplay).** Headless
  Chrome's software-GL renderer doesn't reliably produce real, sampleable
  frames from `captureStream()` — a headless smoke test can get as far as
  "the peer connection reached ice=connected" without ever proving a
  non-host client actually *sees* live pixels. When a bug (or a claim of
  "verified") depends on real video content, launch **headed** Chrome
  (`headless: false`, real GPU) instead — see
  `scripts/verify-desktop-netplay.mjs` for the pattern (sample host-canvas
  pixel data + assert `<video>.currentTime` advances over a sleep).

## Common failure modes seen so far

| Symptom | Root cause | Fix |
| --- | --- | --- |
| Worker boots but `start` message produces no logs | webretro's `emulator-worker.js` had two `self.onmessage =` assignments; the second was a placeholder stub overwriting the real handler | Abandoned worker entirely — webretro itself runs the core on the main thread (see below); we now do the same |
| `SyntaxError: Cannot use 'import.meta' outside a module` from `importScripts(coreUrl)` | Modern Emscripten cores (MODULARIZE + ES module output) can't be loaded by a classic Worker | Use a classic-script core build (e.g. `source-projects/WebEmu/public/cores/`) |
| Endless `RuntimeError: null function` spam in main loop after `WASM Runtime Initialized` | webretro's "aggressive WASM patches" hardcode wasm-function indices (1698/7222/…) from their specific core build; with any other core they corrupt the function table and replace `Browser_mainLoop_runner` with a broken wrapper | Disable `applySNES9xDirectWasmPatches()` and `patchEmscriptenRuntimeFunctions()` — vanilla Emscripten works fine |
| `TypeError: Cannot read properties of null (reading 'addEventListener')` from `registerOrRemoveHandler` → `_emscripten_set_mousedown_callback_on_thread` | RetroArch's web input driver hardcodes `querySelector('#canvas')` to attach DOM listeners; if the emulator canvas has any other id, the call dereferences null | The emulator canvas **must** have `id="canvas"` |
| Scene reads as 2D | Camera was on-axis, room had no side walls/ceiling, no parallax | Off-axis camera + full enclosed room + slow desktop sway in `SceneMgr._render` |
| `crossOriginIsolated: false` on the deployed site | `AllowOverride None` in Apache's default config swallows the project's `.htaccess` | Enable `AllowOverride FileInfo Indexes` for the project dir via `conf-available/libretrowebxr.conf` |

## Architectural lesson learned the hard way

The libretro core runs on the **main thread** via a `<script>` tag, not in a
Web Worker. This matches webretro's own working pattern (see
`source-projects/webretro/assets/base.js` ~line 2043). The
`emulator-worker.js` in webretro's tree is experimental WebXR-integration
code that nobody uses and is full of bugs. Trying to make it work cost
several debug cycles.

Architecture:
1. `EmulatorClient` injects `<script src="cores/snes9x_libretro.js">` into
   the document; the core auto-inits against `window.Module`.
2. `Module.canvas` is the **dedicated** emulator canvas (id="canvas", as
   above). The libretro core grabs WebGL on it directly.
3. After `onRuntimeInitialized` fires, we write the ROM to the in-memory
   FS at `/rom/rom.bin` and call `Module.callMain(['/rom/rom.bin'])`.
4. The placeholder lives on a **separate** `#placeholder-canvas` because
   a canvas can only host one context type — once 2D is bound, WebGL is
   refused. `SceneMgr.setScreenSource()` swaps which canvas the TV mesh
   samples when the emulator becomes ready.

## Adding new probes

When a new class of bug appears, prefer adding a one-line probe in
`scripts/debug.js`'s `page.evaluate` block over leaving devtools breadcrumbs
in the source. The probe pays for itself the next time the bug recurs in CI.
