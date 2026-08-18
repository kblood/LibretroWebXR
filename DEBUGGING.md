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

Two core styles live in the `CORES` map, which is exported from
**`src/systems.js`** (`main.js` only imports it — it was defined inline in
`main.js` until the R.1 registry refactor, and this line still said so long
afterwards):

- `style: 'classic'` — older WebEmu-era cores that auto-init against
  `window.Module` when their `<script>` tag loads. Cheap, but the
  classic-script parser rejects newer Emscripten output that uses
  `import.meta.url`.
- `style: 'module'` — modern libretro-buildbot cores (MODULARIZE=1) that
  `export default <factory>`. Loaded via dynamic `import()` and
  instantiated with `mod.default(moduleArg)` — exactly how upstream
  `retroarch/libretro.js` does it.

`style` is about how the core module is *loaded*. A separate axis, `execution`,
is about where it *runs*: the heavy cores (`mednafen_psx_hw`, `play`,
`mupen64plus_next`, `dosbox_pure`) carry `execution: 'worker'` and run in a
dedicated execution worker via `RuntimeEmulatorClient` /
`src/runtime/EmulatorWorkerRuntime.js`, not on the main thread like everything
else. When a symptom is "no frames" rather than "wrong frames", check which of
the two topologies you are in first — see "Architectural lesson learned the hard
way" below.

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

The live deploy is **`/webxr/libretrowebxr2/`**; `/webxr/libretrowebxr/` is the
older prototype, deliberately left untouched. Point every command at the `2`.

```bash
# Headers actually being served?
curl -sI https://dionysus.dk/webxr/libretrowebxr2/ | grep -iE 'cross-origin|cache-control'
curl -sI https://dionysus.dk/webxr/libretrowebxr2/cores/snes9x_libretro.wasm | grep -i content-type

# Apache error log on the box
ssh -i <your-ssh-key> <user>@<host> \
    "sudo tail -n 50 /var/log/apache2/error.log"

# What's actually deployed
ssh -i <your-ssh-key> <user>@<host> \
    "ls -la /var/www/html/webxr/libretrowebxr2/ /var/www/html/webxr/libretrowebxr2/cores/"

# The room/log server unit (multiplayer + the log receiver share one process)
ssh -i <your-ssh-key> <user>@<host> \
    "sudo systemctl status libretrowebxr-room; sudo journalctl -u libretrowebxr-room -n 50"
```

The .htaccess in `dist/.htaccess` is the source of truth for headers. If
COOP/COEP aren't applied after deploy, the most likely cause is Apache's
default `AllowOverride None` swallowing the .htaccess — `deploy/libretrowebxr2.conf`
fixes that by scope-enabling `AllowOverride FileInfo Indexes` for this
project's dir. It must be present in `/etc/apache2/conf-available/` and
enabled with `a2enconf libretrowebxr2`. (`deploy/libretrowebxr.conf` is the same
snippet for the old prototype folder — enabling one does **not** cover the
other; `AllowOverride` is per-`<Directory>`.)

### The headset log viewer needs a token

`https://dionysus.dk/logs?session=<room>` is still the headset debugging loop,
but **reads are token-gated in production**: append `&token=<yours>`, or send
`X-Log-Token`. `POST /log` is *not* gated, so the app and the Quest are
unaffected — only the reader needs the secret. It lives in
`/etc/default/libretrowebxr-room` on the box (`sudo cat` it), is pulled in by the
systemd unit's `EnvironmentFile=-…`, and is not in the repo. Without it,
`GET /logs.json?tail=0` handed every session's room names, nicks and
private-library ROM filenames to anyone on the internet. Bookmark the URL
**with** the token — the viewer's 5 s meta-refresh and its filter form both carry
whatever was in the query string. Full recipe: `docs/HANDOFF.md` → "Reading
headset logs (the token)".

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

> **Scope note (still true, no longer universal).** This section describes the
> **main-thread** topology, which is how 16 of the 20 systems still boot. The
> four heavy cores flagged `execution: 'worker'` in `src/systems.js` (PSX, PS2,
> N64, DOS) *do* run in a dedicated worker — a purpose-built one
> (`src/runtime/EmulatorWorkerRuntime.js` + `RuntimeEmulatorClient`) with its own
> frame/audio/ACK protocol, not webretro's broken `emulator-worker.js`. The
> lesson below is about that file, and it stands.

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

## Probes must be validated against a negative control

**The standard: a check is not evidence until you have seen it go RED when the
thing it tests is broken.** A green probe proves nothing on its own — it proves
something only once someone has broken the feature and watched the probe fail.
Until then it is a print statement with an exit code.

Two checks in this repo were found on 2026-07-29 passing while proving nothing,
and both were being quoted as proof a feature worked:

1. **`probe:psx-guncon`'s old `[GUNCON END-TO-END SIGNAL]`** compared a post-shot
   frame against the **boot baseline** and gated on `maxDiff > 0`. Run with **no
   gun connected at all** it passed at `maxDiff=407` — *larger* than the `287` a
   genuine run produces. The difference came from elapsed time and a different
   on-screen message, not from the shot.
2. **Both gun probes set `window.__allowBrokenLightgun`**, so they produced
   identical results whether the registry gate was up or down — they could not
   regression-guard the very flag they were cited to justify.

An absolute before/after diff silently measures elapsed time, animation and
state drift alongside the effect. On an animated screen it measures nothing else:
`probe:psx-timecrisis` printed idle attract-mode diffs of **56.41 / 107.77 /
41.72 / 28.90** next to a comment claiming a "noise floor of ~0-3", against a
gate of `> 10`.

### The fix shape that works: a within-run relative comparison

Two arms **at the same instant on the same screen**, differing only in the single
variable under test, each measured **against its own immediately-prior frame**.
The control arm must be **exactly 0** — not "small", not "below a threshold".

- `probe:psx-guncon`'s replacement: an off-screen control shot vs an on-target
  shot. Passes **0 / 287** on a working core; fails **411 / 345** when the gun
  never seats. The `offMax === 0` clause is what does the work — do not relax it.
- `probe:psx-twogun`'s ISOLATION check always had this shape (same shot, same
  point, differing only in `port`) and was never in doubt.

Corollaries from the sweep:

- Prefer a **counter the code under test increments** (`metrics.inputs`,
  `nextAudioTime`, a spy's exact argument) over pixels; only sample it *after*
  the call so a stale reading can't pass.
- A **state-toggle** feature must be asserted on the *transition set* across the
  toggle, paired with a restate-the-same-value control arm that moves exactly 0.
- `window.__thing?.doIt()` on the object under test converts "feature absent"
  into "feature works". Grep for `window.__[a-zA-Z]*?\.` and treat every hit as
  a suspect.
- A script that prints JSON and always exits 0 is not a check. If a computed
  boolean isn't wired to the exit code, it will be read as a pass anyway.
- `video.lit > 0` (5 sample points, `r+g+b > 30`) is **discredited** as rendering
  evidence: the N64 scene's own background `(8,8,16)` sums to 32, and a healthy
  PSX run reads the same flat colour at all five points.

### Building a negative control safely

`public/cores/` is gitignored and expensive to regenerate — never break the
feature in the real tree. Make a scratch checkout, junction the heavy dirs:

```powershell
robocopy C:\LLM\LibretroWebXR C:\LLM\_scratch /E /XD node_modules public .git tmp dist
cmd /c mklink /J C:\LLM\_scratch\node_modules C:\LLM\LibretroWebXR\node_modules
cmd /c mklink /J C:\LLM\_scratch\public       C:\LLM\LibretroWebXR\public
```

Then break the feature **in the scratch copy only**, and run the *unmodified*
probe against it. Pick a break that leaves the app booting and every unrelated
assertion green — a break that only trips a boot or metrics assertion has not
tested the headline claim. Tear down with the reparse point, never a recursive
delete:

```powershell
foreach ($l in 'node_modules','public') {
  $p = "C:\LLM\_scratch\$l"
  if ((Get-Item $p -Force -EA 0).LinkType -eq 'Junction') { cmd /c rmdir $p }
}
Remove-Item C:\LLM\_scratch -Recurse -Force   # only after both junctions are gone
```

Afterwards verify the real tree is intact. **Take the fingerprint before you
start, not from this file** — it was written down here once as "52 files /
122,547,567 bytes / 40 passed" and every one of those three numbers is now wrong
(the tree grows whenever a core is fetched or rebuilt), which makes a hardcoded
figure a false alarm rather than a check:

```powershell
(Get-ChildItem public/cores -File | Measure-Object Length -Sum) |
  Select-Object Count, Sum        # run BEFORE and AFTER; they must match
node scripts/test-patched-cores.mjs   # must report 0 failed, and must NOT
                                      # print SUITE-STATUS: inert (that means
                                      # it found no cores to inspect at all)
```

### Two harness hazards that void a run entirely

- **Foreign dev server.** Probes spawn `npx vite --strictPort` and then
  `waitForServer()` accepts *any* HTTP 200 on the port. If a stale or concurrent
  server already holds it, the spawn dies and the probe grades **someone else's
  checkout** while reporting a clean pass. This was observed producing false
  greens in three separate audits. Add a pre-flight that refuses to run when the
  port is taken, and fetch a source sentinel (e.g. `curl /src/main.js | grep
  <break marker>`) before believing a negative control.
- **Leaked vite.** `vite.kill()` does not reach through `shell: true` on Windows;
  the node child survives and holds the port for the next run. Kill by
  port→PID via `netstat` + `taskkill /PID /T /F` in a `finally`. **Never** kill by
  image name — `taskkill /IM node.exe` takes down the agent harness itself.

**Probe flakiness is real.** One probe returned 11/23 with the core never
starting, then ran clean on an identical re-run; another flaked 1 run in 3 on a
palette threshold. Leave a few seconds between runs and **re-run before believing
any red result**. Never report a flake as a finding — and never *lower* a
threshold that has been demonstrated to go red.
