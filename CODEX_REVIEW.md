# LibretroWebXR architecture and code review

Review date: 2026-08-13  
Reviewed revision: `cb29aa8` (`Guard loadCartridge() against a slower older request clobbering a newer one`)  
Scope: the tracked application, server, deployment configuration, documentation, authored games, tests, and the locally present ignored runtime/build assets. The pre-existing untracked `CLAUDE_REVIEW.md` was deliberately not used as input.

## Executive summary

LibretroWebXR has a stronger internal design than its 7,974-line entry point initially suggests. The pure state/protocol modules (`NetProtocol`, `Hub`, `PresenceState`, `RoomObjects`, `RackBudget`, `ContentBundle`), the main-thread/worker runtime facade, content-addressed saves, and the automation facade are useful seams. The default test command is unusually broad for a prototype and passed in this review.

The project is not ready for an unguarded public release, however. Two issues are release blockers:

1. **The build boundary can publish private commercial media.** `.gitignore` prevents commits, but Vite copies all of `public/`. The current working tree contains 3,969,934,493 bytes under `public/roms`, and the existing `dist/` contains the same commercial disc images. The full deploy uploads every item in `dist/`.
2. **The public remote-log service is an unauthenticated stored-HTML-injection and availability boundary in the same process as multiplayer.** Arbitrary callers can inject records that make `/logs` throw, inject markup through several unescaped fields, consume unbounded file streams/disk, and read all session logs.

The most important correctness findings are also concrete rather than theoretical:

- `VideoMgr` sends a `bye` signal that `NetProtocol` rejects, so clean video teardown never crosses the socket.
- Leave/rejoin is explicitly wired to stale first-session objects; after Leave, retained frame callbacks dereference `net === null`, and a rejoin cannot replace the captured managers.
- emulator boot authorization is checked before several awaits but not after them; a host demotion during a slow boot can be followed by a direct `client.resume()` that bypasses `ConsoleRuntime`'s run gate.
- same-core main-thread hot swaps do not rewrite launch configuration. A plain game -> light-gun/mouse/Four Score game using the same core resets the ROM but does not attach the requested device, while launch options remain sticky in the opposite direction.
- worker runtimes are terminable, but `ConsoleRuntime.dispose()` only pauses them. Reboots and failed boots can retain workers, Wasm memories, canvases, audio branches, timers, and WebGL contexts.

The server assumes trusted friends but is deployed as a public service: it has no authentication, origin check, room capability, connection/room limit, rate limit, explicit WebSocket payload cap, backpressure policy, or authoritative player assignment. Any room member can target any member with `INPUT`, including injecting player-1 input into the elected host.

Finally, verification is extensive but operationally manual. There are no CI workflows, no coverage, lint, formatting, type-check, build-size, header, asset-license, or security gates. The 18 smoke programs and 30 probe/measurement programs are not part of `npm test`; the roadmap itself records several assertions that can stay green when the mechanism is broken.

### Overall assessment

| Area | Assessment |
|---|---|
| Architecture | Good low-level seams, but orchestration/state ownership has collapsed into `src/main.js`. |
| Correctness | Several proven protocol/lifecycle races; strongest risk is role changes and runtime replacement. |
| Security | Not suitable for an open public server without the P0 changes below. |
| Testing | Strong pure/custom suite, weak automation of browser, deployment, abuse, and release boundaries. |
| Performance | Sensible worker backpressure and rack budgeting, undermined by leaked runtimes/audio branches and unconditional TV uploads. |
| Maintainability | High documentation effort, but duplicated boot/network/config code and non-hermetic core builds make drift likely. |

## Review method and limitations

- Read `CLAUDE.md`, `README.md`, both package manifests/lockfiles, Vite/deploy configuration, all source inventory, the largest source modules, the room/log server and `Hub`, the central architecture/testing/multiplayer documents, and the relevant build notes/recipes.
- Traced the primary and secondary boot paths, main-thread and worker runtimes, frame/audio paths, host election, reconnect/leave/rejoin, state/input/signaling relay, save persistence, room loading, and deployment flow.
- Ran `npm test` successfully: all 35 custom `scripts/test-*.mjs` runners and the three selected `node:test` files completed with zero failures; the latter reported 26 tests.
- Did **not** run `npm run build`: it would rewrite ignored `dist/`, contrary to the request to modify only this report, and the current public directory contains private media that Vite would copy. Existing build output was inspected read-only.
- `npm audit --json` could not reach the npm advisory endpoint in this environment. Dependency conclusions therefore use the lockfiles, installed metadata, and the official Vite advisory linked below; this is not a claim that the remaining dependency graph is vulnerability-free.
- No live production server, two-browser WebRTC session, or Quest hardware session was exercised. Those gaps are called out rather than inferred green.

Severity meanings: **Critical** = release blocker or remotely exploitable issue with major confidentiality/availability/legal impact; **High** = likely user-visible correctness/security/resource failure; **Medium** = bounded risk or material engineering debt; **Low** = drift/polish that still deserves cleanup.

## Repository map and inventory

### Tracked inventory

Physical line counts below were measured from the checked-out text files. Line counts are intentionally omitted for the binary-heavy tracked `public/` area.

| Area | Tracked files | Physical lines | Bytes | Role |
|---|---:|---:|---:|---|
| `src/` | 108 | 31,252 | 1,496,620 | WebXR/desktop app, emulation facade, room/rack/input/network code |
| `scripts/` | 130 | 28,604 | 1,391,343 | unit-style tests, Puppeteer probes/smokes, core fetch/build, deployment template |
| `docs/` | 40 | 15,361 | 945,484 | design, handoff, roadmap, build and test history |
| `games/` | 128 | 25,582 | 687,718 | authored test-game source/tooling |
| `test/` | 14 | 1,786 | 83,540 | `node:test` suites plus browser harness assets |
| `server/` | 7 | 1,044 | 44,941 | `Hub`, WebSocket adapter, log server, server smoke and manifest/lockfile |
| `public/` | 34 | binary-heavy | 5,200,542 | authored/free ROM output, manifests/rooms, headset test, `.htaccess` |
| Whole tracked repository | 479 | — | 9,974,897 | Includes configuration, docs and binary test ROMs |

Test-program inventory: 35 `scripts/test-*.mjs` files, 18 smoke programs (including `server/smoke.mjs`), 30 probe/measurement programs, three `*.test.js` files, and zero `.github/workflows` files.

### Locally present ignored/build inventory

These files are not tracked, but they materially affect actual builds and runtime memory:

| Path | Files | Bytes | Observation |
|---|---:|---:|---|
| `public/cores/` | 56 | 127,993,552 (122.1 MiB) | Core JS/Wasm/worker/build manifests plus several `.bak` duplicates |
| `public/roms/` | 96 | 3,969,934,493 (3.70 GiB) | Tracked freeware plus ignored local commercial media |
| `dist/` | 164 | 4,099,038,406 (3.82 GiB) | Existing build includes the ignored local ROM tree and core backups |

The largest observed private files are two 703.1 MiB PS2 images and PS1 CHDs between 162.7 and 501.3 MiB. Matching paths and sizes exist under `dist/roms/local/`. The existing minified JS in `dist/assets` totals 1,068,257 bytes: Three.js is 602.5 KiB, the main chunk 280.9 KiB, and the shared `Collection` chunk 100.7 KiB. This is an observation of the existing build, not a fresh build measurement.

### Source hotspots

| File | Lines | Bytes | Main responsibility |
|---|---:|---:|---|
| `src/main.js` | 7,974 | 423,385 | Entire WebXR composition root and most application workflows |
| `src/systems.js` | 1,191 | 83,496 | System/core registry and peripheral/build policy |
| `src/TestApi.js` | 1,053 | 49,474 | Browser automation facade |
| `src/runtime/EmulatorWorkerRuntime.js` | 939 | 47,609 | Worker-hosted Emscripten/libretro runtime |
| `src/GrabMgr.js` | 847 | 39,301 | XR grabbing/raycast/placement interaction |
| `src/desktop/main.js` | 812 | 37,191 | Desktop application orchestration |
| `src/EmulatorClient.js` | 808 | 44,042 | Main-thread Emscripten/libretro runtime |
| `src/net/NetMgr.js` | 607 | 29,204 | VR client WebSocket, state, host, voice/video integration |
| `src/RomResolver.js` | 526 | 21,822 | URL/FSA/picker/OPFS content resolution |
| `src/RoomBuilder.js` | 497 | 21,927 | Descriptor-to-Three.js room construction |
| `src/Keyboard.js` | 480 | 16,521 | Virtual keyboard model/input |
| `src/net/VideoMgr.js` | 473 | 23,828 | Host-to-client WebRTC game stream |
| `src/SceneMgr.js` | 463 | 19,896 | Three.js/WebXR scene and render loop |
| `src/C64Keyboard.js` | 413 | 14,466 | C64/VIC keyboard behavior |
| `src/desktop/DesktopNet.js` | 405 | 17,709 | Desktop duplicate of much of the net client lifecycle |

`src/main.js` alone is 25.5% of all `src/` lines. It has 72 imports, 148 top-level named function declarations, 73 top-level `let` declarations, 27 textual `addTickCallback` registrations, and 137 textual `window.__...` references. Those counts are not a quality score, but they accurately show where state and change risk concentrate.

The two longest documentation files are `docs/HANDOFF.md` (1,898 lines) and `docs/ROADMAP.md` (1,073); `server/Hub.js` is 338 lines, `server/log-server.mjs` 298, and the actual WebSocket adapter 157.

## Architecture map

### Browser application

- `src/main.js` creates and connects almost everything: logger, renderer/scene, audio interception, content resolution, room/editor, rack/patchbay, input/peripherals, networking, emulator boots, persistence, multiplayer role changes, UI, and test hooks.
- Pure or mostly pure modules sit underneath it: `Collection`, `RoomLoader`/`RoomSerializer`, `ContentBundle`, `DiscIdentity`, `Routing`, `RackBudget`, and the `net/*State` helpers.
- Scene objects are reasonably factored (`TV`, `Console`, `Cartridge`, `RoomBuilder`, `GrabMgr`), but lifetime ownership is inconsistent. The scene holds append-only tick callbacks; the rack owns runtime records but not all resources the runtime created; spatial audio keeps its own independent append-only branch registry.
- `src/desktop/main.js` is a second composition root. It reuses content and emulator modules but carries a parallel network client (`DesktopNet`).

### Emulator topology

- `RuntimeEmulatorClient` selects a main-thread `EmulatorClient` or `WorkerEmulatorClient` and normalizes input/save/disc methods (`src/RuntimeEmulatorClient.js:40-91`).
- Main-thread cores own page globals, a canvas WebGL context, and often their own Emscripten loop. The code treats them as non-unloadable.
- Worker cores use an `OffscreenCanvas`, transfer `ImageBitmap`s through `FrameBridge`, and push PCM back to the shared WebAudio graph. The ACK/watchdog design bounds in-flight frames (`src/runtime/EmulatorWorkerRuntime.js:379-435`), and Blob/File launch sources are transferred without first materializing large disc files on the main thread (`src/runtime/WorkerEmulatorClient.js:265-321`).
- `ConsoleRuntime` plus `RackMgr`/`RackBudget` is intended to own one emulator instance per console and enforce the display-only and XR performance gates.

### Multiplayer/server topology

- `NetProtocol` is shared between browsers and Node; `Hub` is pure state/election/relay logic; `room-server.mjs` maps sockets to `Hub` decisions. This is a sound boundary.
- The server elects the longest-present peer as host and protects `tv`, `room`, and `shelf:*` writes server-side (`server/Hub.js:35-46`, `server/Hub.js:185-225`). The host runs one core; WebRTC distributes video/audio; other peers send input over the WebSocket.
- Voice and video use separate peer-connection managers multiplexed over `SIGNAL`. Room state is persisted in memory; per-frame `WIRE` traffic is broadcast but not persisted.
- The HTTP log server is imported into the same Node process as the WebSocket server (`server/room-server.mjs:16-26`).

### What is already well designed

- The shared protocol plus pure `Hub` makes important spoofing/election behavior unit-testable.
- Host-owned state is enforced on the server rather than trusted to clients.
- Worker frame delivery replaces/drops stale bitmaps and closes them, with one-frame backpressure and a stalled-ACK watchdog.
- Content bundles validate paths/companions and use stable content identities; save metadata includes core build hashes.
- `RackBudget` and `ConsoleRuntime.runAllowed()` express the intended one-authoritative-core and Quest budget policies clearly.
- The testing documentation explicitly values positive evidence and negative controls; that discipline has found real false-green assertions.

## Findings: security and release boundaries

### SEC-1 — Critical — A full build/deploy can publish ignored private ROMs and backup cores

Evidence:

- Repository policy says commercial ROMs must never be committed and ignores `public/roms/*` (`.gitignore:15-27`); the README says the repository ships no ROMs/cores other than free test material (`README.md:37-47`).
- Vite uses the default public-directory behavior and has no copy allowlist/exclusion (`vite.config.js:27-65`). Git ignore rules do not participate in a Vite build.
- The deployment template explicitly says a full deploy uploads everything Vite copied from `public/`, including “any local ROM/disc sideload” (`scripts/deploy.example.ps1:31-39`), then recursively uploads every top-level `dist` item (`scripts/deploy.example.ps1:164-168`).
- The current `public/roms` is 3.70 GiB and the existing `dist/roms/local` contains matching commercial images. `.bak` core binaries are also copied.

Impact: a normal `npm run deploy` can disclose user-owned media, create a multi-gigabyte public release, incur transfer/storage costs, and violate the project's stated licensing boundary. This is not prevented by source control and the existing build proves the path is active.

Recommendation: move all private media outside `public/`; serve it in development through an explicit local-only mount/proxy. Generate a staging `public` tree from an allowlist of tracked/free assets and approved core artifacts. Add a prebuild/predeploy program that fails on `public/roms/local`, known commercial extensions outside approved freeware paths, `.bak` files, or any unapproved large file. Build into a freshly empty directory and run a license/size manifest check before upload. `AppOnly` is not a sufficient safety control because the full deploy remains dangerous.

### SEC-2 — Critical — The public log service permits stored injection, process crashes, log disclosure, and unbounded file handles

Evidence:

- `/log`, `/logs`, and `/logs.json` are publicly reverse-proxied with no authentication or access restriction (`deploy/log-proxy.conf:18-31`). The server permits any origin (`server/log-server.mjs:248-252`).
- POST validation only requires a truthy `sessionId` and an array; entry count and the types/lengths of `ts`, `level`, `msg`, `nick`, and `clientId` are not validated (`server/log-server.mjs:107-138`). Arbitrary fields are spread into stored records (`server/log-server.mjs:80-101`).
- The HTML renderer calls `new Date(e.ts).toISOString()` and `e.msg.replace(...)` without guards (`server/log-server.mjs:185-190`). A valid POST containing `entries:[{}]` is accepted; the next viewer GET throws a `RangeError` or `TypeError` from the HTTP request listener.
- Only `msg` is escaped. `level`, `nick`/`clientId`, raw session IDs in `<option>`, title/filter values, and the selected-session label are interpolated into HTML (`server/log-server.mjs:185-233`). An attacker can store same-origin markup/script payloads in the developer viewer; the committed proxy configuration applies no viewer-specific CSP.
- Memory sessions are capped at 100, but the per-session file-stream map is not. Eviction deletes only the in-memory session (`server/log-server.mjs:75-85`); a new raw session ID opens a persistent stream (`server/log-server.mjs:55-67`) that is closed only when the entire server closes (`server/log-server.mjs:287-295`). Sanitization collisions can also route distinct session IDs into the same file.
- Raw logs are readable without authentication. The browser logger captures all console output, uncaught errors, structured boot/input/net events, URLs and filenames (`src/Logger.js:1-31`, `src/Logger.js:266-299`).
- This HTTP server shares the room-server process (`server/room-server.mjs:20-26`), so an uncaught log-view exception can terminate multiplayer too.

Impact: remote attackers can disclose diagnostics, persist hostile content for developers, intentionally terminate the service when someone views logs, and exhaust disk/file descriptors. The same-process design expands a diagnostic failure into a multiplayer outage.

Recommendation: disable remote logging by default in production. Put ingestion and viewing behind separate authentication/authorization, restrict CORS, use opaque server-issued session tokens, and isolate the service in a separate process/user. Validate a strict entry schema and byte/count limits; render with DOM-safe escaping for **every** field (or return JSON to a static safe viewer); handle request exceptions at the boundary. Rotate/cap files and close streams on eviction. Add hostile-input tests for missing/invalid fields, markup, huge counts, session churn, and malformed dates.

### SEC-3 — High — The public room relay has no trust, abuse, or resource controls

Evidence:

- The WebSocket server is constructed with only a port (`server/room-server.mjs:28-36`). There is no explicit bind host, `maxPayload`, Origin check, authentication, upgrade authorization, per-IP/room connection cap, or rate limit. Despite deployment docs describing localhost, an omitted `host` binds beyond loopback on normal Node platforms.
- `room` and stable `sid` are accepted directly from query parameters without server-side normalization or length bounds (`server/room-server.mjs:40-50`). Client sanitization at `src/net/SessionUtils.js:14-21` does not protect a public server from custom clients.
- Protocol validation is shallow: nickname, state key, button and channel strings have no maximum; `STATE.value`, `WIRE.data`, and signaling data are arbitrary objects; `INPUT.player` need only be finite, not an integer/range; poses have finite tuple values but no spatial/quaternion bounds (`src/net/NetProtocol.js:184-243`).
- Rooms and state maps are created on demand (`server/Hub.js:41-57`). A client can keep arbitrary state alive by retaining a socket. State is replayed to every new peer (`server/room-server.mjs:91-98`). Large host `room`/`shelf` values can therefore force every joining browser to parse and instantiate large structures (`src/RoomLoader.js:73-96`).
- Broadcast loops have no slow-client/backpressure cutoff; `sendTo` calls `ws.send` without inspecting `bufferedAmount` (`server/room-server.mjs:53-60`).
- `Hub.input` verifies only that sender and target are room members (`server/Hub.js:306-314`). It does not require `target === hostOf(room)`, authorize a player slot, or bind one sender to one controller. The receiving client injects any such event whenever it believes it is host (`src/main.js:628-629`). Any member can therefore drive player 1-4 on the host, or flood arbitrary targets.
- `WIRE` is intentionally arbitrary and broadcast to every peer (`server/Hub.js:317-325`), while main applies several channels to host peripherals and room props (`src/main.js:630-655`).

Impact: anyone who knows/guesses a room can join, observe metadata, interfere with the game/room, allocate server and client memory, amplify traffic across room members, and queue data to slow sockets. The default `ws` payload ceiling is far larger than this protocol needs; relying on it is not a protocol limit.

Recommendation: use unguessable room capabilities or authenticated membership; validate Origin during upgrade; bind the backend to `127.0.0.1` behind Apache; set a small explicit `maxPayload`; cap rooms, peers, state keys and serialized value sizes; apply token-bucket rates by socket/IP/message class; enforce buffered-amount thresholds; and expire empty/inactive rooms. Make the server own player assignment and require `INPUT.to === electedHost`. Replace arbitrary `WIRE` with per-channel schemas and authorization rules.

### SEC-4 — High — The installed Vite version has a known high-severity Windows dev-server disclosure

Evidence:

- The lockfile installs Vite 7.3.3 (`package-lock.json:1535-1553`).
- The project explicitly exposes the dev server on `0.0.0.0` (`vite.config.js:32-38`), and this review environment is Windows.
- Official advisory [GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff) marks Vite `>=7.0.0, <=7.3.4` affected by a high-severity `server.fs.deny` bypass on Windows alternate paths and identifies 7.3.5 as patched. The advisory's affected condition is a network-exposed Vite dev server, which this configuration creates.

Impact: another device able to reach the development port can retrieve files that Vite's deny rules are meant to protect under the advisory's Windows/NTFS conditions. `server.fs.strict: true` is not a fix for the advisory.

Recommendation: upgrade and lock Vite to at least 7.3.5 immediately, then rerun unit/browser/build checks. Default `server.host` to loopback and require an explicit environment flag/CLI option for headset/LAN testing. Add automated dependency updates and a CI audit/advisory check.

### SEC-5 — Medium — Debug/TURN endpoints and credentials are controlled by shareable URL parameters

- `turnUser` and `turnCred` are read from the page query string (`src/main.js:543-550`), and the coturn example documents a URL containing static username/password values (`deploy/coturn.conf.example:22-46`). URLs leak through history, copied room links, screenshots and server/browser diagnostics. A shared static credential can be abused as a relay credential.
- `Logger` accepts an arbitrary `?log=<url>` and then ships all captured console/error/event data to it (`src/Logger.js:228-243`); `main` likewise accepts an arbitrary WebSocket `?server=` (`src/main.js:543-550`). A crafted link can opt a user into sending diagnostics/room metadata to an attacker-controlled endpoint without an in-app trust prompt.
- Stable host-reclaim IDs use `Math.random()` plus time (`src/net/SessionUtils.js:96-106`). They are carried in the WebSocket URL and act as a host-reclaim bearer value, yet are not generated with a cryptographic RNG.

Recommendation: mint short-lived TURN credentials from an authenticated same-origin endpoint; never put the password in a room URL. Production-disable or allowlist `log`/`server` overrides and require explicit user consent for remote diagnostics. Generate session IDs with `crypto.randomUUID()`/`getRandomValues`; treat them as opaque capabilities and avoid access logging them.

### SEC-6 — Medium — Header and service hardening is partial, and the committed CSP breaks a shipped page

- COOP/COEP is consistently set in Vite and `.htaccess` (`vite.config.js:3-25`, `public/.htaccess:1-17`), and the deploy directory enables `AllowOverride` for the app path (`deploy/libretrowebxr2.conf:7-12`). This is a good baseline.
- The CSP contains only `script-src` and `worker-src`; it omits `default-src`, `base-uri`, `object-src`, `frame-ancestors`, `connect-src`, `img-src`, and `media-src` (`vite.config.js:13-21`, `public/.htaccess:8-10`). It is not a comprehensive origin policy.
- `public/headset-test.html` contains an inline script (`public/headset-test.html:229-260`), which is blocked by the committed `script-src 'self' 'wasm-unsafe-eval'` policy because no nonce/hash/`unsafe-inline` is present.
- The systemd unit has no `NoNewPrivileges`, filesystem protections, private temp, memory/task limits, or restart throttling (`deploy/libretrowebxr-room.service:18-27`), and there is no SIGTERM drain/close path in `room-server.mjs`.

Recommendation: move the headset script into a same-origin external module, define a complete tested CSP at the vhost, and add a browser/header smoke against both preview and production. Bind both Node listeners to loopback, split logs into their own hardened service, add systemd sandbox/resource directives, and implement graceful shutdown.

### Secret scan result

A tracked-file pattern scan found no committed private-key block, cloud API token, OpenAI/GitHub-style token, or populated static secret. The only match was the deliberate `CHANGE_ME` coturn placeholder at `deploy/coturn.conf.example:46`. Gitignored local deployment files and user media were not treated as repository content. This is a point-in-time pattern scan, not a substitute for CI secret scanning or history scanning.

## Findings: correctness, lifecycle, and multiplayer

### COR-1 — High — Video hang-up messages are rejected by the shared protocol

`VideoMgr.stop()` sends `{ kind: "bye" }`, and the receiver has an explicit `bye` branch (`src/net/VideoMgr.js:156-172`, `src/net/VideoMgr.js:333-338`). However, the only accepted signaling kinds are `offer`, `answer`, and `ice` (`src/net/NetProtocol.js:29-30`, `src/net/NetProtocol.js:206-211`). The room server decodes every message through that validator and silently drops invalid messages (`server/room-server.mjs:103-105`). The protocol test even asserts that the signaling-kind set has exactly three members (`scripts/test-net.mjs:371-381`). A direct call during this review confirmed that a `bye` message returns `false` from validation and `null` from decoding.

Impact: explicit video teardown does not reach the remote peer. Cleanup depends on later ICE/track events and can leave a stale video surface or peer connection longer than intended.

Recommendation: define `bye` as a versioned signaling control message (or a separate validated control type), add it to protocol round-trip tests, and add a two-peer test that asserts immediate remote teardown.

### COR-2 — High — Leave/rejoin retains stale per-session callbacks and managers

The code documents this limitation itself: the first room connection creates session helpers, but rejoining does not rebuild them (`src/main.js:317-331`). `_wireNetSession()` is protected by a one-time guard and creates managers that retain the first `net.avatars` instance; its frame callbacks subsequently dereference the module-level `net` (`src/main.js:3538-3619`). Disconnect clears that global (`src/main.js:729-758`). `SceneMgr.addTickCallback()` only appends callbacks and provides no unsubscribe operation (`src/SceneMgr.js:415-419`); tick exceptions are caught and warned every frame (`src/SceneMgr.js:452-459`).

Impact: after leaving, stale callbacks can throw once per XR frame because `net` is null. On rejoin, the guard prevents reconstruction, while managers still refer to the previous avatar registry. This can cause warning/GC pressure and incorrect remote-avatar, laser, gun, camera, and video behavior.

Recommendation: introduce a disposable `RoomSession` scope. Every event subscription, tick callback, timer, media track, peer connection, and manager should register cleanup; make `addTickCallback` return an unsubscribe function. Dispose and clear that scope on leave, then create a fresh one on every join. Automate join → leave → join with assertions for callback count, warnings, tracks, and remote entities.

### COR-3 — High — Host authority can change while an asynchronous cartridge boot is in flight

`loadCartridge()` checks host authority before starting (`src/main.js:6300-6317`) and uses a generation to supersede newer *loads* (`src/main.js:6322-6338`, `src/main.js:6404`). It then awaits resolution, wrapping, options, and emulator boot before committing state and calling `client.resume()` directly (`src/main.js:6331-6474`). Host demotion pauses runtimes (`src/main.js:7094-7105`), but it neither increments that generation nor cancels the in-flight boot. Directly resuming the client also bypasses `ConsoleRuntime.resume()`'s run-gate check (`src/ConsoleRuntime.js:202-208`). A fresh secondary runtime is not registered until after its asynchronous load (`src/main.js:6679-6698`).

Impact: if election/demotion occurs during a slow fetch, archive wrap, or core initialization, the old host can resume and commit a game after losing authority. That creates two active emulators and divergent authoritative state.

Recommendation: use a single authority epoch/`AbortController` owned by the room session, incremented on host change, disconnect, game replacement, and disposal. Validate it after every `await` and immediately before state publication/resume; stop and discard stale runtimes. Route all resume operations through the runtime run gate. Cover slow boot + host demotion and slow secondary boot + rack removal in deterministic tests.

### COR-4 — High — Same-core hot swaps ignore new boot-time configuration and retain old configuration

On `EmulatorClient.start()`, core options, devices, remaps, and system are assigned only when the incoming objects/arrays are non-empty (`src/EmulatorClient.js:204-207`), so an empty next launch does not clear previous launch state. When the same core is already loaded, start merely rewrites the ROM, resets, pauses, marks ready, and returns (`src/EmulatorClient.js:220-226`). The RetroArch configuration is written only during initial core startup (`src/EmulatorClient.js:229-231`). Meanwhile, `main` deliberately treats a same-core change as a hot swap (`src/main.js:5806-5842`) and calculates lightgun, mouse, Four Score, remap, and option configuration per selected game (`src/main.js:6342-6371`). It can then mark the console as lightgun-armed based on the requested mode even though the already-running core never received it (`src/main.js:6414-6425`).

Impact: launching a gun game after a normal SNES game can present an armed gun UI with no lightgun device attached; launching normal content after configured content can inherit stale options/devices. Similar failures apply to multiplayer adapters, remaps, and system overrides.

Recommendation: make the complete immutable launch configuration part of runtime identity. Reuse only when core **and** all boot-time configuration match; otherwise create a fresh runtime. Always replace, rather than conditionally merge, per-launch fields. Make startup failures reject rather than converting them to resolved states (`src/EmulatorClient.js:212-214`). Test normal → gun → normal and 2-player → Four Score → 2-player sequences on the same core.

### COR-5 — High — Runtime replacement does not actually release most emulator and audio resources

`ConsoleRuntime` explicitly notes that traditional cores cannot be unloaded (`src/ConsoleRuntime.js:1-21`), but its `dispose()` only pauses and removes the canvas (`src/ConsoleRuntime.js:216-224`), even though the client facade has a stop operation (`src/RuntimeEmulatorClient.js:73-76`). Rack removal calls that limited dispose (`src/RackMgr.js:72-78`). A core-changing swap creates and fully loads the next runtime before removing the old one (`src/main.js:6679-6698`), and nearby comments acknowledge that the old Emscripten instance lingers (`src/main.js:6615-6621`, `src/main.js:6663-6669`). `RackMgr.maxLive` therefore limits registered consoles, not accumulated Wasm heaps/workers.

Additional leak/error paths reinforce the problem:

- `SpatialAudio.createBranch()` appends permanent branches (`src/SpatialAudio.js:26-62`); `ensureBranch()` is idempotent by ID, but there is no remove/dispose operation (`src/SpatialAudio.js:99-120`). Replacing a console keeps the old branch.
- Worker startup allocates the frame bridge and Worker before preparation/ready completes (`src/runtime/WorkerEmulatorClient.js:41-80`). Rejection paths do not clean them up; `_fatal()` rejects outstanding work without terminating or resetting the worker (`src/runtime/WorkerEmulatorClient.js:247-262`).
- Normal worker stop waits on a request whose default timeout is 60 seconds before terminating (`src/runtime/WorkerEmulatorClient.js:12-18`, `src/runtime/WorkerEmulatorClient.js:171-183`).
- The main-thread client injects a classic core script into the document and owns the global `window.Module`, has no stop, and waits for runtime initialization without a timeout (`src/EmulatorClient.js:632-651`).
- If `next.load()` fails, the partially created fresh runtime is not disposed in a `finally` path (`src/main.js:6679-6698`).

Impact: repeated core swaps can accumulate Wasm memories, workers, canvases, message handlers, media/audio nodes, and unresolved operations. This is especially dangerous on Quest: local core manifests show initial memories of 512 MiB for PSX and 256 MiB for N64 (`public/cores/mednafen_psx_jit_libretro.build.json:40`, `public/cores/mupen64plus_next_libretro.build.json:36`).

Recommendation: define an explicit asynchronous lifecycle (`new → starting → ready/paused/running → stopping → disposed/failed`) and make disposal idempotent. On worker runtimes, reject requests, detach listeners, close frame resources, terminate promptly, and remove the audio branch even when startup failed. Add timeouts to main-thread initialization. Since a main-thread Emscripten core is not safely unloadable, enforce a page-level policy: worker isolation where supported, and an explicit reload/restart boundary after incompatible main-thread swaps rather than pretending memory was freed. Test cumulative workers/listeners/audio branches after successful and failed swaps.

### COR-6 — High — Save RAM persistence is owned only by the primary global client

`flushCurrentSaveRam()` reads only global `currentMeta` and `client` (`src/main.js:7747-7770`). Secondary consoles restore saves through `ConsoleRuntime.start()` (`src/ConsoleRuntime.js:149-157`) but have no symmetric flush path. A secondary runtime can be removed during a core-changing swap without any save write (`src/main.js:6697-6698`). The only best-effort unload flush is asynchronous IndexedDB work initiated during page exit; the browser is not required to keep the page alive for it. The roadmap accurately calls persistence partial (`docs/ROADMAP.md:1056-1060`).

Impact: progress from rack/secondary consoles is lost, and even primary progress can be lost on crash, headset browser eviction, or fast navigation.

Recommendation: make persistence a per-runtime dependency keyed by content/save identity, not a primary-console global. Track dirtiness and perform debounced/periodic writes, flush before runtime replacement/removal and authority transitions, and use `visibilitychange`/freeze/pagehide as redundant triggers. Add fake-IndexedDB tests covering both worker and main-thread clients, both console slots, failed writes, and reload restore.

### COR-7 — Medium — Voice negotiation has no failed-connection recovery and can drop trickle ICE

Voice synchronization creates a peer connection only when the peer ID is absent (`src/net/VoiceMgr.js:54-67`). `_ensurePeer()` sets handlers but no `connectionstatechange`/`iceconnectionstatechange` recovery (`src/net/VoiceMgr.js:69-94`), so a failed connection remains in the map forever and cannot be recreated. Incoming ICE is applied immediately; if it arrives before the remote description, the exception is caught and the candidate is discarded (`src/net/VoiceMgr.js:96-111`). The video implementation already contains a connection-state grace/rebuild path that voice lacks (`src/net/VideoMgr.js:271-290`).

Recommendation: queue candidates until the relevant remote description is installed; delete/close and retry failed/disconnected peers with bounded backoff; attach a session/negotiation epoch; and use a documented perfect-negotiation role. Exercise offer collisions, ICE-before-SDP, transient disconnect, and rejoin in a mocked two-peer suite.

### COR-8 — Medium — Remote controller state is not owned per peer

The receiving path notes that peer departure clears **all** remote buttons, causing a multi-peer input blip (`src/main.js:698-708`). The underlying desired-state map is keyed by console/player/code, not sender (`src/GameInputMgr.js:119-124`, `src/GameInputMgr.js:307-318`). Consequently, if two permitted senders hold the same logical button, one sender's release deletes the shared state even while the other still holds it; transition-based senders may not reassert a continuously held button.

Recommendation: make remote input state `{sender, console, player, control}` and reduce it with OR semantics; clear only the leaving sender. Preferably, combine this with server-owned player assignment so only the authorized peer can control each slot.

### COR-9 — Medium — Separately deployed client/server protocol has no compatibility handshake

The server is deployed independently from the static app (`server/README.md:80-103`). The deploy template uploads selected server modules but not the server lockfile, then runs a floating `npm install` (`scripts/deploy.example.ps1:123-146`). WebSocket messages carry no protocol/build version, and the connection handshake cannot reject an incompatible client. A partially deployed or cached app/server pair therefore manifests as silently dropped fields/messages rather than an actionable error.

Recommendation: put a protocol version and app build ID in `HELLO`, reject incompatible major versions with a close code/reason, and report the mismatch in the UI. Deploy the server lockfile and use `npm ci`; smoke a production URL after an atomic/reversible app+server release.

## Findings: architecture and maintainability

### ARC-1 — High — `main.js` is the application, session, world, UI, and emulator state container

At 7,974 lines, `src/main.js` is 25.5% of all `src` lines. It has 72 import statements, 148 top-level named functions, 73 top-level `let` declarations, 117 top-level `const` declarations, 27 textual tick registrations, and 137 `window.__*` references. It owns, among other things, network connection/election (`src/main.js:585-758`), room/rack/video behavior (`src/main.js:1109-1757`), world/room construction, cartridge resolution and boot (`src/main.js:5746-7410`), and save persistence (`src/main.js:7747-7770`). State is distributed among mutable module globals, manager internals, DOM controls, room-state last-write-wins entries, and emulator instances.

This is not just a file-size concern: COR-2, COR-3, COR-5, and COR-6 are ownership bugs caused by callbacks and asynchronous transactions outliving global state changes. The many testing/debug globals also make invariants implicit rather than enforced by APIs.

Recommendation: first extract lifecycle boundaries, not cosmetic helpers:

1. `AppSession`: page/renderer/XR lifetime and global UI.
2. `RoomSession`: socket, election, avatars/media, room-state replication, subscriptions, and disposal.
3. `ConsoleSession`/`BootCoordinator`: one cancellable cartridge transaction, authority epoch, runtime, input, audio, and persistence.
4. `WorldSession`: room graph/rack/object lifetime and teardown.

Pass explicit dependencies and make every scope disposable. Model boot and connection state as small state machines rather than Boolean/global combinations. Keep `main.js` as composition and UI wiring once those boundaries exist.

### ARC-2 — Medium — Network, emulator configuration, and launch workflows are duplicated

- `DesktopNet` says it reuses the protocol but independently implements connection, reconnect, HELLO/election handling, and socket lifecycle (`src/desktop/DesktopNet.js:272-405`) alongside `NetMgr` (`src/net/NetMgr.js:365-559`). Behavioral fixes must be made twice.
- RetroArch config generation is mirrored between the worker runtime (`src/runtime/EmulatorWorkerRuntime.js:295-359`) and main-thread client (`src/EmulatorClient.js:654-752`). The two backends can silently diverge on device/remap/core-option semantics.
- Primary launch, secondary launch/swap, desktop launch, live reboot, and test launch each assemble overlapping state/configuration. The same-core special case is already inconsistent with fresh boot (COR-4).

Recommendation: extract a transport-independent `RoomConnection` for protocol/election/reconnect and compose desktop/XR presentation around it. Create a pure `buildRetroArchLaunchConfig(launch)` plus backend-specific filesystem writer, golden-test the exact output, and route every launch through one transactional `BootCoordinator`.

### ARC-3 — High — Core builds are not reproducible from a clean checkout

The DOS recipe expects a shared `~/amiga-build/RetroArch` worktree and describes local differences (`scripts/cores/dos/build.sh:68-79`); it detects but accepts a dirty tree (`scripts/cores/dos/build.sh:259-266`) and downloads a patch during the build (`scripts/cores/dos/build.sh:296-311`). The build guide says the critical LWX patch is local, not upstream, and not stored in this repository (`docs/DOS_CORE_BUILD.md:122-135`). Other large cores likewise rely on local toolchains/artifacts described outside a hermetic build. Core binaries and their local build manifests are ignored, so a clean clone cannot reproduce or authenticate deployed artifacts.

Impact: releases cannot be independently rebuilt, bisected, or supply-chain audited; uncommitted changes can become production cores without review.

Recommendation: commit every project patch and wrapper source; build from pinned clean worktrees/container images; fail on dirty input; pin and checksum downloaded tools/sources; and track signed/text build manifests (source commit, patch hashes, toolchain image, flags, output hash) even if binary cores remain release artifacts. Add at least one clean-room CI rebuild/smoke for representative threaded and non-threaded cores.

### ARC-4 — Medium — A large automation/debug API is eagerly shipped in production

`main` eagerly imports `TestApi` and constructs it on every build (`src/main.js:33`, `src/main.js:371-445`); `TestApi.js` is 1,053 lines. `EmulatorClient` also exposes raw config/file-injection hooks (`src/EmulatorClient.js:725-740`) used by diagnostics. Together with 137 `window.__*` references, this expands the production bundle and the surface reachable after any same-origin script compromise.

Recommendation: compile test/diagnostic APIs behind an explicit build-time mode and put browser automation on a separate test entry. Keep a deliberately small read-only support diagnostic in production; exclude raw configuration/file mutation and internal object references from normal builds. Preserve useful lazy loading already used for optional spike/editor code.

### ARC-5 — Low — Documentation and status comments have drifted from executable behavior

Examples:

- The README says there are 17 systems and presents DOS/VirtualXT as lacking a usable core (`README.md:21-26`), while the system table has 20 entries and the roadmap documents a working DOSBox path (`src/systems.js:1-1191`, `docs/ROADMAP.md:772-813`).
- Collection/main comments classify PSX and N64 together as experimental (`src/Collection.js:48-55`, `src/main.js:134-138`), while the system registry gates N64 but not PSX (`src/systems.js:485`, `src/systems.js:662`).
- The server README describes the process as signaling-only/no game state (`server/README.md:1-7`), but it relays replicated STATE, INPUT, WIRE, host election, and diagnostic logs.
- The roadmap says disc changes are not republished (`docs/ROADMAP.md:1050-1055`); code republishes them (`src/main.js:7396-7400`).
- `CLAUDE.md` and `package.json` expose `npm run deploy`, but the real `scripts/deploy.ps1` is ignored and a clean checkout contains only an example (`.gitignore:6-10`, `package.json:45`).

Recommendation: generate system/core capability tables from `systems.js` and manifests, turn claimed invariants into tests, and label roadmap entries as historical/current with verification dates. Make the documented deploy command point to a tracked, safe wrapper whose environment-specific settings remain external.

## Findings: testing and CI

### TST-1 — High — The default suite is useful but there is no CI or release gate

`npm test` runs a chain of custom module runners and three selected Node test files (`package.json:20-23`). In this review it completed successfully: all 35 custom runners and 26 Node test cases passed. This gives real coverage to pure logic such as protocol validation, elections, layouts, content bundles, archives, options, transforms, and worker-control helpers.

However, there is no tracked `.github/workflows` (or equivalent CI definition), and the default command does not run a Vite production build, start either server, open a browser, exercise a real WebSocket/WebRTC pair, validate headers/CSP, inspect deploy contents, or start an emulator core. The many browser/desktop/headset scripts exposed in `package.json:25-42` are opt-in diagnostics rather than release gates. A clean build was intentionally not run here because Vite would rewrite `dist/`, violating this review's “only CODEX_REVIEW.md” constraint; the existing `dist` instead demonstrates the unsafe public-copy boundary in SEC-1.

Recommendation: add a pinned CI matrix with these explicit tiers:

1. Fast: `npm ci`, unit/protocol tests, formatting/lint/type checks, dependency and secret scans.
2. Build: production build into a fresh staging directory, size/license/asset allowlist checks, and generated-file diff checks.
3. Integration: real room/log processes on ephemeral loopback ports, real `ws` clients, hostile-input/resource-limit tests, and graceful-shutdown tests.
4. Browser: two isolated Chromium contexts join a room, elect one host, send input/state/signaling, leave/rejoin, and run representative free test ROMs in main-thread and worker paths.
5. Production smoke: deployed COOP/COEP/CSP/cache headers, headset test page, WebSocket upgrade, log access policy, and protocol build compatibility.

Store structured logs/screenshots/traces as artifacts so failures do not rely on ad-hoc remote logging.

### TST-2 — Medium — Existing smoke tests contain documented false-green paths

The roadmap records concrete weaknesses in emulator smoke automation: N64 can pass using only a loading screen or stale canvas, PSX can pass before meaningful gameplay, C64 keyboard/input is under-verified, and visual checks can mistake UI/background pixels for emulation output (`docs/ROADMAP.md:1012-1047`). These are particularly important because several smoke scripts use “non-black pixels/canvas changed” as a proxy for correctness.

Recommendation: make every core smoke assert a positive gameplay signature and a negative control. Examples: known frame hashes/perceptual regions after a deterministic input sequence; an audio energy signature; an in-core save/memory marker; and a deliberately invalid ROM that must fail. Reset page/runtime state between cases and prove the canvas source belongs to the current boot generation.

### TST-3 — Medium — No automated tests cover the highest-risk lifecycle and adversarial cases

The current suites do not cover the bugs identified in this review: invalid video `bye`; join/leave/rejoin subscriptions; host demotion during boot; same-core device/config changes; worker failure cleanup; cumulative runtime/audio resources; secondary-console save RAM; voice ICE ordering/recovery; overlapping multi-peer input; malicious log viewer fields; room capacity/rate/backpressure; private-asset build rejection; or the production CSP on `headset-test.html`.

Recommendation: turn each of COR-1 through COR-8 and SEC-1 through SEC-6 into a regression test before or alongside its fix. For race cases, inject controllable promises/clocks and assert state transitions rather than depending on real timing.

### TST-4 — Medium — Toolchain and dependency policy are implicit

There is no lint, format, type-check, or coverage command and no root `engines` declaration. Yet the installed Puppeteer version requires Node `>=22.12.0` (`package-lock.json:1320-1336`) and Vite requires Node `^20.19.0 || >=22.12.0` (`package-lock.json:1535-1553`). Root and server dependencies use separate lockfiles, while the deploy template bypasses the server lockfile with `npm install`. Dependency ranges are broad enough that an unlocked install can differ from development.

`npm audit --json` could not complete in this review environment because the registry was unreachable; therefore this report does not claim that Vite is the only vulnerable dependency.

Recommendation: declare and pin a supported Node line (`engines`, `.nvmrc`/Volta, and CI image), use `npm ci` for both packages, add static checking/coverage thresholds, and enable automated dependency PRs plus scheduled audit/advisory scanning. Treat audit network failure as “unknown,” not “clean.”

## Findings: performance and XR budget

### PERF-1 — High — Every TV texture is marked for GPU upload on every XR frame

`TV` starts active (`src/TV.js:33-42`) and exposes `setActive()` (`src/TV.js:146-151`), but no production call site changes that state. `SceneMgr` marks every active TV texture as needing update every tick, regardless of canvas changes, paused runtime, power state, or visibility (`src/SceneMgr.js:433-438`). Rack/spike screens follow a similar unconditional frame path. A `CanvasTexture.needsUpdate` upload can be expensive, and multiple emulator/video surfaces multiply texture bandwidth inside the headset's tight frame budget.

Recommendation: make the producer publish a monotonically increasing frame ID/dirty signal. Upload only on a new frame and only for powered/visible surfaces; suspend hidden/off-screen producers where semantics allow. Add per-surface counters for produced, dropped, drawn, and uploaded frames and profile GPU upload time on Quest with 1, 2, and maximum permitted consoles.

### PERF-2 — High — Resource accumulation makes core swaps an eventual out-of-memory path

The ownership failures in COR-5 are also the dominant memory risk. A 512 MiB PSX Wasm memory plus a 256 MiB N64 memory, ROM/disc buffers, decoded archive copies, canvases/ImageBitmaps, and Web Audio graphs can exceed standalone-headset limits quickly when prior instances are not released. `RackMgr`'s live-console weight cap cannot see orphaned Emscripten instances or audio branches.

Recommendation: measure page-level Wasm memory, workers, canvases, audio nodes, and frame resources before/after every swap; enforce a hard runtime budget; and make the supported swap policy match actual unload capability. Include a 20-swap soak test and failed-boot soak test, with a device-specific memory ceiling.

### PERF-3 — Medium — Audio packet handling allocates and deinterleaves on the main thread

For each pushed audio packet, `SpatialAudio` constructs/uses typed views, creates an `AudioBuffer`, runs nested channel/sample loops to deinterleave, creates a new source node, and schedules it (`src/SpatialAudio.js:136-157`). That work competes with Three.js, XR input, replication, DOM/UI, texture uploads, and main-thread emulator cores. Per-packet allocations and one-shot nodes also increase garbage-collection variability.

Recommendation: use a persistent `AudioWorklet` with a bounded shared/ring buffer where cross-origin isolation permits it; deinterleave/resample off the render thread or emit planar data; and expose underrun, overrun, queue-depth, and scheduling-drift metrics. Keep a bounded fallback for browsers without the required primitives.

### PERF-4 — Medium — The worker frame path still performs multiple copies and fixed-rate wakeups

The worker client defaults to a 16 ms frame interval (`src/runtime/WorkerEmulatorClient.js:60-68`). Each received `ImageBitmap` is drawn into a 2D canvas, then that canvas is uploaded to the Three.js texture on XR tick (`src/runtime/FrameBridge.js:24-54`, `src/SceneMgr.js:433-438`). ACK/backpressure limits uncontrolled bitmap growth, which is good, but the pipeline still entails worker render/readback/transfer, main-thread canvas draw, and GPU texture upload. It also wakes near 60 Hz even when the headset refresh, core frame rate, visibility, or pause state differs.

The per-frame networking path adds allocation pressure: several separate tick callbacks build sets/filter/map collections for remote gizmos (`src/main.js:3553-3618`), and network interpolation builds transient collections per update (`src/net/NetMgr.js:506-524`). Without a room peer cap, these costs scale with untrusted membership.

Recommendation: drive delivery from new emulator frames rather than a fixed timer, preserve one-in-flight backpressure, and compare `bitmaprenderer`, direct bitmap texture, and current canvas paths on target browsers. Consolidate per-room rendering into one session tick with a cached roster. Add XR-frame CPU/GPU histograms and fail performance smoke on sustained missed-frame ratios rather than average FPS alone.

### PERF-5 — Medium — Production JS and static assets have no budgets

The current ignored `dist/assets` contains 1,068,257 bytes of JavaScript: approximately 602.5 KiB for `three`, 280.9 KiB for the main chunk, and 100.7 KiB for `Collection` before transfer compression. Eager production `TestApi` is part of the source graph (ARC-4). More importantly, Vite's unbounded public copy can turn a nominal frontend deploy into several GiB of ROMs/cores (SEC-1). There is no CI budget for either code or static assets.

Recommendation: establish compressed/uncompressed budgets per entry and a strict static-asset manifest. Lazy-load collection/editor/test-only code by interaction/build mode. Serve versioned core/ROM artifacts separately from the app shell with immutable caching and explicit provenance; keep HTML/manifests short-lived. Measure parse/startup and first-XR-frame time on the target headset, not only desktop bundle size.

## Prioritized change plan

### P0 — Release blockers (before the next public deployment)

1. **Make builds incapable of publishing private files.** Move local media outside `public`, build from an allowlisted staging tree, fail on unapproved/oversized/backup artifacts, and inspect the produced manifest. Acceptance: a fixture placed in the local media directory can never appear in `dist` or upload input.
2. **Disable or isolate the public log service.** Require authenticated ingestion/viewing, add strict byte/schema limits and complete output escaping, cap/rotate/close files, and separate it from the room process. Acceptance: hostile/malformed entries cannot crash the service, execute markup, read other sessions, or grow resources without limit.
3. **Patch and contain Vite.** Upgrade to at least 7.3.5, regenerate the lockfile, and default development to loopback with an explicit LAN flag. Acceptance: CI verifies the resolved version and fails if network exposure is enabled by default.
4. **Put hard boundaries around the room relay.** Bind to loopback, authenticate/cap room membership, validate Origin and full message schemas/sizes, set `maxPayload`, rate limits, room/state expiry, and `bufferedAmount` eviction. Make player slots server-authoritative. Acceptance: load/adversarial tests demonstrate fixed memory/FD growth and bounded per-client traffic.
5. **Repair the signaling contract.** Add/validate video teardown and protocol compatibility/version handshake. Acceptance: two-peer video closes immediately, and incompatible app/server versions fail visibly rather than silently.

### P1 — Correctness and operational confidence

6. **Create a transactional boot coordinator.** One immutable launch descriptor, authority epoch, cancellation path, and commit point must serve primary, rack, desktop, and reboot flows. Treat boot-time config as runtime identity. Acceptance: demotion and superseding loads cannot publish/resume stale state; same-core configuration matrix passes.
7. **Implement real lifecycle disposal.** Add idempotent async cleanup for workers, frame bridges, listeners, requests, canvases, audio branches, media, and partial startup; define the reload policy for non-unloadable main-thread cores. Acceptance: successful/failed 20-swap soak leaves resource counts at baseline and stays within the memory budget.
8. **Make room sessions disposable and re-creatable.** Unsubscribe tick/event callbacks and recreate every per-room manager on join. Acceptance: join → leave → join has one callback/listener set, no warnings, and correct avatars/media/input.
9. **Stand up CI as a release gate.** Pin Node, run clean builds plus unit/server/two-browser tests, enforce asset/header/security checks, and retain artifacts. Fix the roadmap's false-green emulator smokes with deterministic positive and negative assertions.
10. **Move saves into each console runtime.** Dirty/periodic persistence plus pre-dispose flush for primary and secondary consoles. Acceptance: forced removal, reload, demotion, and page hide preserve a known save marker in both execution backends.

### P2 — Structural and performance work

11. **Split ownership out of `main.js`.** Introduce app, room, world, and console scopes; share `RoomConnection`, config generation, and boot logic between XR/desktop and worker/main backends. Measure success by removed mutable globals and explicit disposal/invariant tests, not file count alone.
12. **Harden peer media/input semantics.** Recover voice peers, queue ICE, own remote buttons per sender, and bind assigned players to authenticated room members.
13. **Make video/audio frame-driven.** Dirty/visible texture uploads, a persistent AudioWorklet ring, one session tick, and on-device XR frame/memory instrumentation. Gate releases on missed-frame and soak thresholds for target Quest hardware.
14. **Make core builds hermetic.** Commit patches, pin toolchains/sources, reject dirty inputs, track provenance/hashes, and clean-room rebuild representative cores.
15. **Turn documentation into generated contracts.** Generate the system/status inventory, reconcile server/security/deploy docs, track build/protocol versions, ship the lockfile with `npm ci`, and automate dependency updates/audits.

## Bottom line

The repository has substantial working functionality and more targeted pure-logic testing than its lack of CI initially suggests. Its next reliability step is not another feature subsystem: it is explicit lifetime and trust ownership. The same missing boundaries currently produce the most serious security issue (private content crossing the build boundary), the most serious correctness risks (stale room/authority/runtime state), and the largest Quest performance risk (resources and texture/audio work surviving beyond their useful lifetime). Fixing those boundaries first will make subsequent multiplayer and core work materially safer and easier to verify.
