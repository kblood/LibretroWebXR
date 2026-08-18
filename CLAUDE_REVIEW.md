# LibretroWebXR — code & architecture review

**Reviewer:** Claude (Opus 5), independent pass — 2026-08-13
**Scope:** whole repo at `cb29aa8` (clean tree, branch `main`)
**Method:** read the code; ran `npm test`; ran a live reproduction against
`server/log-server.mjs` for the two security findings below.

> **Cross-check note.** A parallel independent review (`CODEX_REVIEW.md`, GPT-5.6
> Sol) ran against the same revision. Sections marked *(added on cross-check)* —
> §4.6, §4.7, §5.2, §5.4 and the correction in §7 — are findings my own pass missed and I have since verified
> myself; §4.7 in particular is more severe than anything in my original pass,
> and §4.6 corrects an error in it. They are folded in here so this document
> stands on its own.

---

## 0. STATUS AS OF 2026-08-18 — read this before acting on anything below

**The review text below is left exactly as written on 2026-08-13. It is a
snapshot, not a to-do list.** This block is the current state. A remediation
pass ran 2026-08-17; where a finding is marked closed here, the finding's own
section is out of date and the code is right.

**Two findings are settled REJECTIONS. Do not re-litigate them** — both have
already been re-argued and reverted more than once, which is the whole reason
this block exists:

| Rejected | Why |
|---|---|
| **§4.7 / P0 item 0 — "the deploy can publish the private ROM library"** (ranked the #1 critical finding) | Publishing `public/roms/local/` to dionysus.dk is **deliberate**. It is the user's own box and the only practical way to test light guns on a real Quest; the redistributable light-gun game universe is essentially empty. A strip guard has been added and reverted **twice** (`0df8aeb` → `b192911`, and again 2026-08-14). `scripts/check-dist.mjs` *reports* the private tree on every build and refuses it only under `--strict`, which is for a genuinely public release. Read that file's header, `CLAUDE.md` and `README.md` before touching it. The rest of §4.7 — backup cores, credentials, scratch, symlinks, unlisted ROMs — **is** implemented and refused in both modes. |
| **§5.5 — "the host state watcher does redundant work"** | §10 of this same review answers it: a structural version counter reintroduces the "a new call site forgets to publish" bug the watcher was written to fix. §5.5 already calls it "genuinely a trade-off, not an obvious win". Treated as closed-by-decision, not as work. |

### Closed

| § | Finding | Closed by |
|---|---|---|
| 4.1 | Stored XSS in the log viewer | Every interpolation escaped (`esc()`, 19 call sites in `server/log-server.mjs`). |
| 4.2 | Remote crash of the room server via the log endpoint | Ingest validation + wrapped viewer handler + `uncaughtException` net; and 2026-08-17 the **aggregate** budget that the per-axis caps still left open — `MAX_STORE_BYTES` (64 MiB *accounted*, charging per JSON node, not per character), which is what stops ~52 GB of retainable heap turning into an OOM **abort** the exception net cannot catch. |
| 4.3 | Unauthenticated public read of all logs | `LOG_TOKEN` read gate, and — the actual gap — the **deployment** now switches it on: `deploy/libretrowebxr-room.service` carries `EnvironmentFile=-/etc/default/libretrowebxr-room`. `POST /log` stays ungated, so the Quest carries no secret. Recipe: `docs/HANDOFF.md` → "Reading headset logs (the token)". |
| 4.4 | Room server has no admission control | `maxPayload`, per-room peer cap, per-peer/-room/-total STATE budgets, message rate limit, **per-address** socket + upgrade caps, per-socket *and* aggregate outbound-buffer budgets with backpressure eviction, optional `Origin` allow-list, `ROOM_HOST` bind. Every knob has a row in `server/README.md` — `scripts/test-room-limits.mjs` fails the run if one doesn't. Plus a server-side **trust model** the review didn't reach: host-only `INPUT`, owner-only clears of `hold:*`/`gamepad:*` (see `docs/MULTIPLAYER.md`). |
| 4.6 | Dev-server dependency advisories | `vite@^7.3.5`; dev/preview bind loopback with an explicit `LAN=1` opt-in (`README.md`); plus a scheduled `npm audit` over both package trees (`.github/workflows/audit.yml`) that reports an unreachable registry as UNKNOWN, never clean, and monthly grouped Dependabot PRs. |
| 5.1 | Per-frame exceptions after leaving a room | `ba0426b`. The residual found on re-review — the host prop **baseline** staying suppressed after leave/rejoin, because the dual-purpose `_knownPropPayloads` map was never reset — was closed 2026-08-17 with a one-shot `_forcePropBaseline` republish per hosting stint. |
| 5.2 | The video `bye` teardown signal can never arrive | `'bye'` is in `NetProtocol.SIGNAL_KINDS`, with a round-trip test over every kind. |
| 5.3 | `SceneMgr` has no tick deregistration | `SceneMgr.removeTickCallback()`; `addTickCallback` returns its own remover. |
| 5.4 | Same-core cartridge swaps never attach the new peripheral | Boot configuration is part of runtime identity. 2026-08-17 closed the leftover bullet — `EmulatorClient.start()` now **throws** instead of resolving a failed boot into a "playing" state published to the room — and added `scripts/test-boot-config.mjs`, which is the first test that pins any of this. |
| 6 | There is no CI | `.github/workflows/ci.yml`: an **app** job (`npm ci` / `npm test` / `npm run build`, uploads `dist/`) and a **server** job (locked `server/` install, `node --check`, `npm run test:servers`). A suite that runs but asserts nothing now declares itself INERT rather than reporting a green. |
| 7 | Unconditional TV texture uploads | PERF-1, shipped. Worker-side frame/audio costs were re-measured 2026-08-17: see CODEX_REVIEW PERF-3/PERF-4. |
| 8 | Doc drift | `README.md`, `CLAUDE.md`, `DEBUGGING.md`, `docs/ROADMAP.md`, `server/README.md` and the source comments were reconciled 2026-08-17/18. **Still open from §8:** there is no `docs/README.md` index marking which of the files in `docs/` are current vs. historical. |
| 9 | P0 1-4 | All four done (see 4.1, 4.2, the `uncaughtException` net, and 6). |
| 9 | P1 5-11 | All seven done: 5 → 5.1/5.3; 6 → 4.4; 7 → 4.3; 8 → 4.6; 9 → 5.2; 10 → 5.4; 11 → the README's system/gating text now defers to `src/systems.js` as the single source of truth. |
| 9 | P2 13-14 | 13 → `scripts/run-tests.mjs` discovers every suite and reports all failures (the `scripts/{test,probe,make}/` split was **not** done and is not planned). 14 → PERF-1. |

### Still open

| § | Finding | Note |
|---|---|---|
| 3.1 / 9 P2 12 | `src/main.js` is the one real structural problem | **It has grown**, 7,974 → 8,820 lines. Nothing was extracted. Read CODEX_REVIEW's ARC-1 and "P2 #12" notes first: three of P2's five size estimates and the whole proposed *order* are wrong, and "tests green between" is vacuous today because **no test imports `main.js`**. |
| 3.3 / 9 P2 15 | The peripherals are four copies of one idea | Untouched, and the duplication now reaches into `systems.js` too. Still the right call to do it *before* the next peripheral is added. |
| 3.4 / 9 P2 16 | Client/desktop duplication | Untouched — and it cost real work: the 2026-08-17 relay hardening had to be written twice, once in `src/net/NetMgr.js` and once in `src/desktop/DesktopNet.js`. |

---

## 1. Executive summary

This is an unusually **well-engineered hobby-scale project**. The parts that
usually rot in a project this size — the wire protocol, the host-election state
machine, the worker/emulator boundary — are the *cleanest* parts of the tree.
They're pure, unit-tested, and carry comments that explain **why** a decision was
made and what broke before it, which is rare and genuinely valuable.

`npm test` is green: **40 script suites + 26 `node:test` cases, 0 failures.**

Four things stand out as needing attention, in order:

1. **`npm run deploy` can publish your 3.7 GB private ROM library to the public
   web server.** `.gitignore` keeps commercial ROMs out of *git*; it has no
   effect on a *Vite build*, which copies all of `public/` — and `dist/roms/local/`
   in the current tree proves the path is live (§4.7). This is the most severe
   finding in the review and it is a legal/privacy issue, not a technical one.
2. **`server/log-server.mjs` is publicly exposed and has a stored XSS and a
   remote crash.** Both reproduced live (§4.1, §4.2). The crash takes the *room
   server* down with it, because they share a process.
3. **`src/main.js` is 7,974 lines and 190 top-level bindings** — 26% of all
   client code in one file. Everything else in `src/` is well-factored; this file
   is where all the coupling went (§3.1).
4. **There is no CI.** A strong, fast, deterministic test suite exists and
   nothing runs it automatically (§6) — which is also why 4 high-severity
   dependency advisories (§4.6) went unnoticed.

Everything else below is smaller.

---

## 2. Repo inventory

| Area | Files | Lines |
|---|---:|---:|
| `src/` (client) | 108 | 31,252 |
| — of which `src/main.js` | 1 | **7,974** (26%) |
| `server/` (own code) | 4 | 882 |
| `scripts/` (tests, probes, builders) | 111 | 25,798 |
| `docs/` | 21 | 8,240 |
| `games/` (authored CC0 test ROMs) | 19 projects | — |
| Tracked files total | 479 | — |

Dependencies: `three@0.179.1`, `vite@7.3.3`, `puppeteer-core@25.0.2`,
`ws@8.21.0` (server). `npm audit`: the **server** tree is clean; the **root**
tree has **5 advisories, 4 high** — see §4.6. `node_modules` correctly
untracked, cores and ROMs correctly excluded from git, deploy script with
credentials correctly gitignored. Licensing hygiene (`PROVENANCE.md`,
`THIRD_PARTY_LICENSES.md`, `docs/LICENSING.md`) is better than most commercial
repos — but see §4.7 for how the *build* undoes the git-level ROM exclusion.

Built bundle: `main` 288 KB + `three` 617 KB, split via `manualChunks` — a
deliberate, correct choice for Quest load time.

---

## 3. Architecture

### 3.1 `src/main.js` is the one real structural problem

`main.js` is a 7,974-line module holding, by its own section headers, at least
17 distinct responsibilities:

```
:240  MP presence + room roles          :1256 video patch cords
:371  the automation/test API surface   :1384 power/reset switches
:769  the MP header widget              :2035 controller patch cords
:857  ?session= auto-join               :2159 keyboard patch cord
:936  world building                    :4337 in-VR prop creation
:1004 the mouse peripheral              :4847 in-VR menus
:1227 gaze focus + audio mute           :5746 cartridge → load wiring
:7208 memory cards / save states        :7347 disc-swap panel
:7445 local ROM picker                  :7881 poster images
```

Concretely:

- **190 top-level `const`/`let` bindings** (`grep -c "^let \|^const " src/main.js`),
  many of them mutable cross-cutting state: `_displayOnlyLatch`,
  `_lightgunArmedConsole`, `_twoGunPorts`, `_pendingInsertMeta`,
  `_netSessionWired`, `_hostShelfCollections`, …
- **137 `window.__*` globals** assigned from this one file.
- Late-bound trampolines exist purely to break ordering cycles *inside the same
  file*: `let _wireNetSession = () => {}` (`src/main.js:330`),
  `_reconcileGamepadState`, `_reconcileGunState`, `_reconcileMouseState`,
  `_reconcilePropState`, `_applyLiveDrag`. These are a direct symptom — a
  module boundary would make them ordinary imports.
- The coupling leaks outward too: `GrabMgr`'s constructor takes **23 named
  options** (`src/GrabMgr.js:50`), 15 of them callbacks pointing back into
  `main.js`. That's a control-flow graph drawn in constructor arguments.

This isn't a style complaint. It has a measurable cost: the memory notes record
a TDZ bug in this file that broke *all* multiplayer auto-join, and a
`loadCartridge()` race fixed in the most recent commit. Both are the class of
bug that 190 shared mutable bindings in one scope produce.

**The good news:** the extraction targets are already obvious from the section
headers and mostly don't cross-reference each other. `PeripheralCords`
(`:1256`+`:2035`+`:2159`, ~700 lines), `PowerMgr` (`:1384`+`:1466`, ~650),
`SaveStateUI` (`:7208`+`:7347`, ~215), `LocalRomPicker` (`:7445`, ~430),
`PropCreation` (`:4337`+`:4684`, ~510) are each self-contained enough to move
behind a small explicit interface.

### 3.2 Everything else is well-factored — genuinely

`src/net/NetProtocol.js` and `server/Hub.js` are the model the rest should follow:
pure, no DOM, no `ws`, imported by *both* ends so client and server cannot drift
on the wire format, and unit-tested as a result. `server/room-server.mjs` is a
157-line adapter with zero logic. The `Hub` comments explaining *why* host
migration is deferred for `HOST_RECLAIM_MS` (`server/Hub.js:16-33`) document a
real failure mode ("each computer runs its own game") that would otherwise be
re-introduced by any future refactor. Keep writing comments like these.

### 3.3 The peripherals are four copies of one idea

Light gun, mouse, gamepad and cartridge each got their own parallel
implementation of the same "grabbable, cabled, port-bound, net-synced prop"
concept — and the comments say so out loud ("mirrors the light gun",
"mirrors the gamepad wiring immediately above").

Measured: normalize gun↔mouse naming in `GhostLightGunMgr.js` (167 lines) and
`GhostMouseMgr.js` (162 lines) and only **53 lines differ** — about two-thirds
identical, and much of the remainder is comment text.

The same shape repeats in `main.js`: `_lightGunObjs`/`_mouseObjs`,
`_lightGunObjsById`/`_mouseObjsById`, `_gunCableCount`/`_mouseCableCount`,
`_twoGunPorts`/`_twoMousePorts`, `_registerLightGun`/`_registerMouse`, and four
near-identical `armLightGunAndReload` / `armMouseAndReload` /
`disarmLightGunAndReload` / `disarmMouseAndReload` functions
(`main.js:5881, 5950, 6014, 6045`).

This is *earned* duplication — each device was de-risked separately, and copying
a working device was the right call at the time. But the next peripheral costs a
fifth copy, and a bug fixed in one (the arming-leak fix, the aim-align fix) has
to be hand-ported to the others. A `CabledPeripheral` descriptor —
`{ id, holdKeyPrefix, portFor(system), armKey, ghostFactory }` — would collapse
the ghost managers to one and the four arm/disarm functions to two.

### 3.4 Client/desktop duplication

`src/desktop/main.js` (812) + `DesktopNet.js` (405) re-implement a slice of the
VR app's netcode. `DesktopNet.js` and `net/NetMgr.js` share obvious shape
(identical `catch { /* mid-close */ }` send wrappers at `DesktopNet.js:110/208/378`
vs `NetMgr.js:124/150/205/532`). Not urgent — the split keeps `three` out of the
desktop chunk, which is worth something — but the *session/state* half could be
shared without dragging `three` in.

---

## 4. Security

### 4.1 Stored XSS in the public log viewer — **high**

`server/log-server.mjs:189-200`. Log entry `msg` is HTML-escaped. **`level`,
`nick`, `clientId`, and `sessionId` are not:**

```js
189  const msg = e.msg.replace(/&/g,'&amp;')…              // escaped
193  <td …>${e.level}</td>                                  // NOT escaped
194  <td …>${client}</td>          // client = `${e.nick}(${e.clientId})`  NOT escaped
200  `<option value="${s}">${s}</option>`   // s = sessionId  NOT escaped
207  <title>… ${targetSid}</title>                          // NOT escaped
```

Reachability: `deploy/log-proxy.conf` proxies `POST /log` and `GET /logs` to the
public root of `dionysus.dk` with `Access-Control-Allow-Origin: *` and **no
authentication**. Anyone on the internet can plant the payload; it fires in the
developer's browser the next time they open the log viewer.

The app's CSP (`public/.htaccess`) does **not** cover `/logs` — that path is
served by the proxy at the site root, outside the app directory — so there is no
second line of defence. Injected script runs on the `dionysus.dk` origin, i.e.
the same origin as the app's `localStorage`/IndexedDB/OPFS.

Reproduced:

```
XSS nick present   : true
XSS level present  : true
XSS session present: true
```

**Fix:** one `esc()` helper applied to every interpolation, not just `msg`.

### 4.2 Remote crash of the room server via the log endpoint — **high**

`server/log-server.mjs:189` assumes `e.msg` is a string. It isn't validated on
ingest (`handlePost` only checks `sessionId` and `Array.isArray(entries)`), so:

```
POST /log  {"sessionId":"boom","entries":[{"level":"log","ts":1}]}
GET  /logs?session=boom
→ TypeError: Cannot read properties of undefined (reading 'replace')
```

This is an unhandled exception in an HTTP handler, so **the process dies**. And
`room-server.mjs:23` does `import './log-server.mjs'` — they are the *same
process*. One unauthenticated POST + one GET takes multiplayer offline until
someone restarts the systemd unit. Reproduced live (stack trace above from a
real run).

**Fix (three, all cheap):** validate/coerce entries at ingest
(`String(e.msg ?? '')`, cap length, whitelist `level`); wrap the handler body in
try/catch; and add `process.on('uncaughtException')` — or better, stop coupling
the two servers' lifetimes.

### 4.3 Unauthenticated public read of all logs — **medium**

`GET /logs` and `/logs.json` expose every session's entries to anyone: room
names, nicknames, ROM filenames from the user's private library, and whatever
else `logger.event()` ships. Gate behind a token query param or basic auth, or
bind the proxy to an allowlisted IP.

### 4.4 Room server has no admission control — **medium**

`server/room-server.mjs` accepts every WebSocket:

- No `verifyClient` / `Origin` check. WebSocket connections are not subject to
  CORS, so any web page can open one.
- No connection limit, no per-connection rate limit. `POSE` is relayed at ~12 Hz
  per peer with no cap; `WIRE` is per-frame; a scripted client can flood a room.
- **No bound on `STATE`.** `NetProtocol.validate` checks `typeof key === 'string'`
  and `'value' in msg` — nothing about size or count. `ws`'s default
  `maxPayload` is 100 MB, and `Hub.setState` persists `{value, id}` per key per
  room indefinitely. A client can write thousands of distinct non-host-owned
  keys with megabyte values → unbounded server memory, and every one is
  broadcast to all peers. The host-key ACL (`isHostOwnedKey`) is good and
  correctly server-side; it just doesn't help here.
- Room ids come straight from `?room=` with no length/charset limit and become
  `Map` keys.

None of this matters for a private room with friends; all of it matters the day
the URL is shared. Cheapest meaningful fix: `maxPayload: 64 * 1024` on the
`WebSocketServer`, a per-key value-size cap and per-peer key-count cap in
`Hub.setState`, a `MAX_PEERS_PER_ROOM`, and a token bucket on inbound messages.

### 4.5 Things that are correctly handled — worth stating

- Server stamps `id`/`from` on every rebroadcast — peers cannot spoof identity
  (`Hub.pose/signal/input/wire`).
- Host-owned `tv`/`room`/`shelf:*` keys are enforced **server-side**, with the
  reasoning for why client-side would be worthless written down (`Hub.js:35-44`).
- The reclaim window correctly treats "hostless because a host is coming back"
  as "the absent host still owns these keys" (`Hub.setState`).
- Client DOM is clean: peer-supplied strings never reach `innerHTML`; the four
  `innerHTML` sites are static strings, and game titles go through `textContent`
  (`src/desktop/main.js:640,660`).
- CSP is narrow and deliberate: `wasm-unsafe-eval` without `unsafe-eval`.
- `vite.config.js` sets `server.fs.strict`.

### 4.6 Dev-server dependency advisories — **high** *(added on cross-check)*

My first pass ran `npm audit --omit=dev` and reported "0 vulnerabilities". That
flag excludes `devDependencies` — which is exactly where the problems are. The
full audit:

```
vite    7.0.0 - 7.3.3   high  server.fs.deny bypass on Windows alternate paths
                              (GHSA-fx2h-pf6j-xcff, patched in 7.3.5)
                              launch-editor NTLMv2 hash disclosure via UNC paths
esbuild 0.27.3 - 0.28.0       arbitrary file read via the dev server on Windows
postcss <=8.5.22        high  path traversal via sourceMappingURL
nanoid  <=3.3.16        high
ws      8.0.0 - 8.20.1  high  memory-exhaustion DoS  (root tree only, via
                              puppeteer-core; server/ has ws@8.21.0 — clean)
→ 5 vulnerabilities (1 low, 4 high)
```

The two Windows dev-server advisories are not theoretical here:
`vite.config.js:32-38` deliberately binds `server.host: '0.0.0.0'` (for Quest
LAN testing) and this is a Windows box — that's the precise precondition both
advisories describe. `server.fs.strict: true` does not mitigate
GHSA-fx2h-pf6j-xcff.

**Fix:** `npm audit fix` (vite ≥ 7.3.5), and default `server.host` to loopback
with an opt-in env flag for headset testing, so LAN exposure is a deliberate act
rather than the default.

### 4.7 `npm run deploy` can publish the private ROM library — **critical** *(added on cross-check)*

I checked git hygiene and stopped there; git is not the publishing boundary here.
Vite copies **all** of `public/` into `dist/` — `.gitignore` has no effect on a
build. `scripts/deploy.example.ps1:166` then uploads every top-level item of
`dist/`:

```powershell
Get-ChildItem -Path $Dist -Force | ForEach-Object { Invoke-Scp $_.FullName "$Staging/" }
```

Verified in the current tree: `dist/roms/` is **3.7 GB** and `dist/roms/local/`
holds commercial ROMs (`battle-clash.smc`, `assault-city.sms`, `amiga/`,
`dos/`…) — the same files `.gitignore:15-27` exists to keep out of the repo and
the README promises are not shipped.

The deploy script's own docstring already describes this ("A full deploy
re-uploads everything vite copied out of public/, which for this project means
cores/ and any local ROM/disc sideload") — but frames it as a *bandwidth*
problem justifying `-AppOnly`, not as a disclosure one. So the guard rail
exists and points the wrong way: `-AppOnly` is presented as the fast path, not
the safe path, and a plain `npm run deploy` is the dangerous default.

**Fix:** keep private media outside `public/` entirely (dev-only static mount),
and add a predeploy check that hard-fails on `roms/local`, `.bak`, or any
non-allowlisted large file in `dist/`.

---

## 5. Correctness

### 5.1 Per-frame exceptions after leaving a room — **medium, real**

Four tick callbacks registered inside `_wireNetSession` dereference `net`
unguarded:

```js
src/main.js:3554, 3568, 3592, 3613
  const presentIds = new Set(net.presence.peers().map((p) => p.id));
```

`disconnectFromRoom()` sets `net = null` (`src/main.js:748`), and
`SceneMgr.addTickCallback` has **no removal API** — `_tickCallbacks.push(fn)` at
`src/SceneMgr.js:418` is the only mutation. So after the user presses Leave,
these four run every frame and throw. They're caught by the per-callback
try/catch in `SceneMgr._render` (`:456-459`), so nothing visibly breaks — it just
burns ~288 thrown-and-caught exceptions/sec on a Quest plus a `console.warn`
each, which the remote logger then ships. Note the sibling callback at
`src/main.js:762` *does* guard (`net?.tick(dt)`), so the intent is clear.

**Fix:** `if (!net) return;` at the top of each, and give `SceneMgr` a
`removeTickCallback`.

### 5.2 The video `bye` teardown signal can never arrive — **medium, verified** *(added on cross-check)*

`VideoMgr` tells clients the host stopped broadcasting by sending
`{ kind: 'bye' }` (`src/net/VideoMgr.js:170`), and has a handler for it
(`src/net/VideoMgr.js:335`). But `SIGNAL_KINDS` is
`['offer', 'answer', 'ice']` (`NetProtocol.js:30`), so `validate()` rejects it
and `decode()` returns `null` — the room server's `if (!msg) return;` drops it
before `Hub.signal` ever sees it.

Reproduced:

```
encoded:  {"type":"signal","to":"peer1","kind":"bye","data":{"epoch":1},"channel":"video"}
validate: {"ok":false,"error":"signal.kind"}
decode:   null
```

So `VideoMgr.js:335` is unreachable code, and clean teardown always falls
through to the slower `track ended` / presence-TTL paths instead. **Fix:** add
`'bye'` to `SIGNAL_KINDS` — and note this is the exact failure mode the
"shared protocol so the ends can't drift" design was meant to prevent. It only
worked for the fields `validate()` actually checks; a kind added on one side
was silently dropped on the other. A `SIGNAL_KINDS` round-trip test would have
caught it.

### 5.3 `SceneMgr` has no tick deregistration — **low, latent**

Same root cause. Today `addTickCallback` is only called during a one-shot world
build, so it isn't a leak. It becomes one the moment anything rebuilds the world
without a page reload — which the rack/room-adoption work is heading toward.
Return a disposer from `addTickCallback` now, before it's needed.

### 5.4 Same-core cartridge swaps never attach the new peripheral — **high, verified** *(added on cross-check)*

The single most user-visible bug in either review, and I missed it entirely.

`handleCartridgeInserted` splits on core identity (`src/main.js:5806-5841`):
a **cross-core** swap does `location.reload()`, so the new core boots fresh with
the right devices; a **same-core** swap falls through to `loadCartridge()` as a
hot swap. In `EmulatorClient.start()`:

```js
205  if (opts.inputDevices && Object.keys(opts.inputDevices).length) this._inputDevices = opts.inputDevices;
…
219  if (!this._coreLoaded) { await this._loadCore(); … }
220  else {
222    this._writeRom(romBuffer);              // same core, different ROM:
223    this._getModule()._cmd_reset?.();       // reset and swap rom.bin
225    this.dispatchEvent(new CustomEvent('ready'));
226    return;                                 // ← returns BEFORE line 231
227  }
231  this._writeRetroArchConfig();             // the ONLY consumer of _inputDevices (:678)
```

Two consequences:

1. **Devices set but never applied.** `_inputDevices` is consumed only inside
   `_writeRetroArchConfig()` (`EmulatorClient.js:678`), which the same-core path
   returns before reaching. Insert a SNES Super Scope game while already playing
   a normal SNES game (both `snes9x`) and the gun device never reaches the core —
   while `main.js:6414-6425` still marks the console lightgun-armed, so the UI
   says armed and the game sees a plain pad.
2. **Config is sticky in the other direction.** The guards at `:205-208` only
   assign when the incoming object is *non-empty*, so going gun-game → normal
   game leaves the previous `_inputDevices`/`_coreOptions`/`_remapName` in place.

This is almost certainly why it hasn't been caught: `armLightGunAndReload()`
forces a page reload, and every verified gun title in the project history was
booted cross-core or from cold — both of which take the reload path. The
plain "swap to a gun cartridge on the same system" path is the broken one.

**Fix:** make the full launch config part of runtime identity — reuse the loaded
core only when core *and* boot config match, else reload/rebuild. And replace
rather than conditionally-merge the per-launch fields at `:205-208`.

### 5.5 Host state watcher does redundant work — **low**

`_syncHostRoomState` (`src/main.js:2566`) runs `serializeRoom()` +
`JSON.stringify` every 2 s and `_publishHostShelf` stringifies the whole
collection+locals set on the same cadence, purely to diff against the last
value. The dedupe is the right call; the cost is a periodic multi-KB
allocate-and-hash on the XR thread. A cheap structural version counter bumped by
the mutation sites would remove it — though that reintroduces the
"a new call site forgets to publish" failure the watcher was written to fix, so
this is genuinely a trade-off, not an obvious win.

---

## 6. Testing & CI

The test discipline here is real: 40 script suites plus 26 `node:test` cases,
all passing, covering the pure logic (protocol, hub, routing, placement, snap,
content bundles, disc identity, worker protocol) plus a large body of Puppeteer
probes for the emulator paths.

**But `.github/` does not exist.** Nothing runs any of it automatically. For a
repo with concurrent agent sessions editing it (per the project's own notes),
that's the single highest-leverage missing piece: a 10-line workflow running
`npm ci && npm test` on push would have caught regressions in a suite that
already exists and takes seconds.

Secondary gaps:

- The `npm test` script is a 40-command `&&` chain in `package.json`. It's
  brittle (one file rename breaks it silently at the end), gives no summary, and
  stops at the first failure so you only ever see one break at a time. A tiny
  runner that globs `scripts/test-*.mjs` and reports pass/fail per file would be
  strictly better.
- 111 files in `scripts/` mixing three genres — unit tests (`test-*`), headless
  probes (`probe-*`, `smoke-*`), and content builders (`make-*`). Three
  subdirectories would make it obvious what `npm test` is allowed to run.
- No coverage of the log server at all — which is where both security findings
  are.

---

## 7. Performance

- **`TV.markNeedsUpdate()` uploads unconditionally every frame, and the escape
  hatch is not wired up.** `SceneMgr.js:435` marks every TV's texture dirty each
  tick; `TV.markNeedsUpdate()` (`TV.js:152`) gates only on `this._active`.

  I first wrote that `_active` "correctly skips paused/out-of-view TVs". It
  doesn't — `_active` is set `true` at construction (`TV.js:41`) and
  **`setActive()` is never called anywhere in production code**:

  ```
  $ grep -rn "setActive" src --include=*.js
  src/SceneMgr.js:435:  // tv.setActive). This per-TV texture upload …   ← comment
  src/TV.js:15:         // … can be told to skip uploads (setActive)      ← comment
  src/TV.js:147:  setActive(on) { this._active = !!on; }                  ← definition
  ```

  Only the definition and two comments describing the intent. So *every* TV
  re-uploads at display rate regardless of whether its core produced a frame, is
  paused, powered off, or behind the viewer. On top of the frame-rate mismatch
  waste (a 50 Hz PAL core on a 72 Hz display is ~30% redundant), the rack's
  multi-TV case pays full texture bandwidth for screens showing nothing new.

  **Fix:** have the emulator client publish a monotonic frame id; upload only
  when it advances *and* the surface is powered/visible — and actually call
  `setActive()` from the focus/power/budget paths that already know the answer.
- `_render` calls `performance.now()` three times per frame and allocates
  nothing else — the hot loop is otherwise clean.
- Bundle split (`three` separate from `main`) is correct and already done.
- `setFoveation(0.7)` + `setFramebufferScaleFactor(1.0)` with the reasoning
  written inline (`SceneMgr.js:64-67`) — good.

---

## 8. Maintainability

- **Almost no debt markers.** Three `TODO`/`FIXME`/`HACK` hits across all of
  `src/`, and two of them are false positives (`DiscIdentity.js` doc examples).
  The one real one records that it's *done*. That is genuinely uncommon.
- **Empty `catch` blocks are all annotated** with why swallowing is correct
  (`/* mid-close */`, `/* autoplay may defer */`). No silent swallows found.
- **README has drifted.** It says "**17 systems**" and that "DOS (VirtualXT) is
  registered … but has **no working core** yet". `src/systems.js` now registers
  **20** systems, DOS defaults to `dosbox_pure` with a pinned `buildHash`
  (`systems.js:227,366`), PlayStation is un-gated and playable
  (`systems.js:485,554`), and PlayStation 2 runs on the `play` core
  (`systems.js:381`). N64 is the only remaining `experimental: true`
  (`systems.js:662`). The front page understates the project by three systems and
  two major cores.
- `docs/` at 8,240 lines is thorough but has accumulated point-in-time artefacts
  (`handoff-2026-06-14-rack-feedback.md`, `HANDOFF.md`, `PROJECT_HISTORY.md`,
  `ROADMAP.md`, `docs/research/`) whose relationship to each other isn't stated.
  One `docs/README.md` index saying which are current vs. historical would stop
  the next reader guessing.

---

## 9. Recommended changes, prioritized

**P0 — do these first (hours, not days)**

0. **Stop the deploy from shipping private ROMs** (§4.7). Until this is fixed,
   treat `npm run deploy` as unsafe and use `npm run deploy-app` only. Move
   `public/roms/local/` out of `public/`, and add a predeploy check that fails
   the build on any non-allowlisted large file in `dist/`.
1. **Escape every interpolation in the log viewer** (`log-server.mjs:189-207`).
   One `esc()` helper. Closes §4.1.
2. **Validate log entries on ingest and wrap the viewer handler in try/catch**
   (`handlePost`, `handleGetHtml`). Closes §4.2 — currently a one-request kill
   switch on the multiplayer server.
3. **Decouple the log server from the room server**, or at minimum add
   `process.on('uncaughtException')`. A logging bug should never be able to take
   netplay down.
4. **Add `.github/workflows/ci.yml`**: `npm ci && npm test` on push/PR. The suite
   already exists and is green — wire it up.

**P1 — worth a focused session each**

5. **Guard the four `net.` tick callbacks** and add `SceneMgr.removeTickCallback`
   (§5.1, §5.3).
6. **Put admission limits on the room server**: `maxPayload`, per-room peer cap,
   per-peer STATE key/value caps, inbound rate limit, optional `Origin` check
   (§4.4).
7. **Gate `/logs` behind a token** (§4.3).
8. **`npm audit fix`** (vite ≥ 7.3.5) and default `server.host` to loopback with
   an opt-in flag for headset testing (§4.6).
9. **Add `'bye'` to `SIGNAL_KINDS`** plus a round-trip test over every signal
   kind (§5.2).
10. **Fix same-core peripheral swaps** — make boot config part of runtime
    identity, and replace rather than merge the per-launch fields (§5.4).
11. **Update the README** to the actual 20-system / PSX / PS2 reality (§8).

**P2 — the structural work**

12. **Carve `main.js` down.** Not a rewrite — extract in the order the sections
   already suggest, one PR each, tests green between: `PeripheralCords`
   (~700 lines) → `PowerMgr` (~650) → `PropCreation` (~510) →
   `LocalRomPicker` (~430) → `SaveStateUI` (~215). That's ~2,500 lines out and,
   more importantly, ~40 module-level bindings turned into explicit parameters.
   Target: no file over 1,500 lines.
13. **Replace the `&&` chain in `npm test`** with a globbing runner that reports
    all failures, and split `scripts/` into `scripts/{test,probe,make}/`.
14. **Gate texture uploads on new emulator frames** (§7) — measurable on the rack
    budget.
15. **Collapse the four peripheral implementations** into one `CabledPeripheral`
    descriptor + one ghost manager (§3.3). Do this *before* the next peripheral
    is added, not after.
16. **Share the session/state layer between `net/NetMgr.js` and
    `desktop/DesktopNet.js`** without pulling `three` into the desktop chunk
    (§3.4).

---

## 10. What not to change

Some of what looks unusual here is load-bearing, and a future refactor should be
told so explicitly:

- The **deferred host migration window** (`HOST_RECLAIM_MS`) looks like an
  over-complication and is not. Its comment already explains the failure it
  prevents; leave both alone.
- The **server-side host-key ACL** must stay server-side — an older deployed
  client still writes `tv` on every boot.
- The **`_syncHostRoomState` watcher** looks wasteful and is deliberately a
  watcher rather than N publish call-sites; §5.5's optimization reintroduces the
  bug it fixed if done carelessly.
- The **density of "why" comments** across `src/net/`, `server/Hub.js`, and
  `src/systems.js` is the project's best asset. Whoever splits `main.js` should
  carry the comments across intact, not summarize them.
