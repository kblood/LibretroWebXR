# Test automation — `window.__testApi` + `scripts/lib/mp-harness.mjs`

The supported way to drive this app from outside the browser: one documented
client-side namespace, one Node harness that wraps it, and one worked example.

| Piece | Where | What it is |
|---|---|---|
| Client API | `src/TestApi.js` → `window.__testApi` | A thin facade over NetMgr / RackMgr / GrabMgr / GameInputMgr / VideoMgr and the real load functions. Installed by both `src/main.js` (VR) and `src/desktop/main.js` (desktop) with the **same shape**. |
| Node harness | `scripts/lib/mp-harness.mjs` | Puppeteer wrapper: N browser processes, one `Peer` object each, methods mirroring the client namespace 1:1, plus cross-peer pixel comparison. |
| Worked example | `scripts/demo-automation-api.mjs` | A three-peer bidirectional session test that uses ONLY this API. `npm run demo-automation` |
| Contract tests | `scripts/test-testapi.mjs` | Node unit tests for the dispatcher, error codes, capability gating, sanitiser. Part of `npm test`. |

## Why it exists

Before this there were 40+ ad-hoc `window.__*` hooks, added one at a time, with
inconsistent shapes — some sync, some async, some returning strings like
`'no-client'` as errors, three different ways to load a ROM. Every headless test
hand-rolled its own calls into whatever hook existed, and several of those tests
turned out to be **vacuously green**:

* `window.__client.paused` was `false` on a client whose core had never booted.
* Two peers' room layouts "matched" because both had independently built the same
  *default* layout — proving no sync at all.
* WebRTC `receivingCount()` / `connectedCount()` reported a healthy stream over a
  **frozen picture** (the track stays `'live'` after the source canvas is retired).

The real bugs only surfaced once we found the right evidence channels: TV pixel
correlation between peers, decoded-frame progression, "did this browser fetch a
core binary at all", negative-controlled reverts. This API's job is to make those
the *easy* things to reach for. Where an obvious-looking check is a trap, the
method that would encourage it either doesn't exist or is documented as
insufficient — see [Evidence, not vibes](#evidence-not-vibes).

---

## Calling convention

Everything is reachable two ways.

**From a driver (what the harness uses).** One dispatcher that never rejects:

```js
const res = await page.evaluate(() => window.__testApi.call('session.state'));
// { ok: true,  value: {...} }
// { ok: false, error: { code, message, detail } }
```

Return values pass through a sanitiser, so a THREE object or a DOM node becomes an
identity stub (`{ object3D: 'TV' }`) instead of an opaque
"could not serialize" failure, and cycles are safe.

**From devtools / a page snippet.** The same functions, namespaced, which *throw*
`TestApiError`:

```js
await __testApi.ready();
await __testApi.session.join({ room: 'lobby', nick: 'me' });
await __testApi.input.tap('Start');
```

### Error codes (stable — tests may assert on them)

| code | meaning |
|---|---|
| `no-such-method` | the dotted path does not exist |
| `unsupported` | valid method, subsystem absent on this client (e.g. `props.*` on desktop) |
| `not-connected` | needs an active room session |
| `not-host` / `host-not-eligible` | needs to be host / cannot legitimately be promoted |
| `not-found` | no such prop / console / TV / shelf entry (`detail` lists the known ids) |
| `timeout` | a `wait*` method ran out of time |
| `blank` | a pixel sample was empty, uniform, or tainted → **no evidence**, not a pass |
| `failed` | the underlying app call refused; `message` carries its reason |

### Discovery

```js
__testApi.version          // 1 — bumped on an incompatible change
__testApi.clientKind       // 'vr' | 'desktop'
__testApi.methods()        // every dotted path, sorted
__testApi.capabilities()   // { session:true, props:false, rack:true, … }
__testApi.supports(path)   // method exists AND its subsystem was injected
__testApi.raw()            // the legacy window.__* hooks this supersedes
```

Prefer `supports()` / `capabilities()` over sniffing `clientKind`.

---

## The API surface

`await __testApi.ready()` first — it resolves when the world is fully built
(`buildCartridgeWorld` including `resumePendingLoad`). The object itself appears
at module eval, so a driver can `waitForFunction(() => window.__testApi)` and
then `ready()`; methods called before the world exists answer `unsupported`.

### `session` — room / role control

| method | notes |
|---|---|
| `state()` | one snapshot: `connected, room, selfId, peerCount, peers, hostId, isHost, serverElects, mayRunLocalCore, tvOwner` |
| `join({room, nick, color})` | the real `connectToRoom`; resolves when the socket is up |
| `leave()` | the real Leave-button path |
| `isHost()` | true when solo |
| `waitForHostElection()` | waits until `hostId` is *known*. Use this instead of a sleep: before HELLO lands every peer reads `hostId === null`, and a test that boots then is testing an undecided room |
| `becomeHost()` | already host → no-op. Fallback election (old relay) → writes a winning claim. **Server-elected room → `host-not-eligible`**, because the server picks by seniority and there is no promotion message |
| `objectState(k)` / `setObjectState(k,v)` / `objectEntries()` | shared STATE channel (`tv`, `room`, `prop:<id>`, …) |
| `sendWire(ch,d)` / `wireRx(ch)` | transient relay + its receive log |
| `recvInputs()` | host side: forwarded controller inputs received from peers |

**Deterministic hosts.** `becomeHost()` deliberately cannot promote a junior peer
in a server-elected room. Open the intended host **first** —
`harness.openHost()` does exactly that and asserts it worked.

### `props` — room objects

`list()`, `get(id)`, `add(type, {pos, texture})`, `remove(id)`,
`grab(id)`, `moveTo(id, [x,y,z], {rot})`, `release(id)`, `move(id, pos)`,
`waitForProp(id)`, `waitForPosition(id, pos, {tol})`.

* `grab()` takes the **network** side of a grab (the exclusive hold key, so peers
  really do see a gamepad/gun/mouse locked) and marks the prop so `moveTo()`
  streams live `drag` frames like a held prop. It does *not* run GrabMgr's
  raycast — there is no headless XR squeeze.
* `release()` calls GrabMgr's own `onEditRelease` callback: editor snapping, the
  authoritative `prop:<id>` broadcast, rack persistence. Exactly what a real VR
  release runs.
* **Therefore the released pose is not always the requested one.** The room
  editor's surface-snap pulls a poster onto the nearest wall. `move()` returns the
  *settled* prop view — assert against **that**, not your input coordinates, or
  you are asserting that snapping is broken.
* Prop state is peer-scoped (only `tv`/`room`/`shelf:*` are host-owned), so any
  peer may move any prop. Test both directions.

### `input` — controllers

`press(btn, opts)`, `release(btn, opts)`, `tap(btn, {ms})`, `sequence([…])`,
`releaseAll()`, `state()`, `setSystem(sys)`, `rawKey(code, key, down, {consoleId})`.

`btn` is a RetroPad name: `A B X Y L R Start Select Up Down Left Right`.
`opts` is `{ player = 1, consoleId, route }` where `player` is the console **port
slot** 1..4.

**Routing is automatic and mirrors production:**

| this peer | what `press()` does |
|---|---|
| host / solo | `GameInputMgr.setRemoteButton()` — the exact path a networked player's input takes into the host's core; awaits the next tick so it really dispatched |
| non-host client | `NetMgr.forwardGameInput()` — the exact path a real client's controller takes to the host |

Force it with `{ route: 'local' \| 'net' }`. `route:'local'` on a client sends the
button to that client's own idle core — which is how the demo builds a negative
control for "did the input actually cross the network".

`rawKey()` is for keyboard systems (DOS, C64, Amiga) where "RetroPad button" is
the wrong abstraction.

### `gun` / `mouse` — peripherals

`gun.arm() / disarm() / state() / port(cableId)` and
`gun.fire({u, v, trigger, tvId})` — `u,v` are 0..1 over the TV's framebuffer and
are converted to a world muzzle pose + aim point for you (`{pos, look}` is still
accepted for aim-geometry tests). One real `LightGunMgr` tick per call.

`mouse.arm() / disarm() / state() / port() / move(dx, dy, buttons)`.

### `content` — ROMs and carts

| method | which real path |
|---|---|
| `shelf()` | every insertable cart |
| `insert(ref, {consoleId})` | `handleCartridgeInserted` — what a physical cartridge snapping into a slot calls. Client-boot suppression, same-core hot-swap, cross-core reload all behave as in the app. **Fire-and-forget**; follow with `waitForGame()` |
| `load(ref)` | `loadCartridge` (the ROM-resolver path), awaited |
| `loadFile({url})` / `loadFile({name, bytes})` | the file-picker stand-in; host-only, live-swaps instead of reloading. `bytes` may be base64 so it survives `page.evaluate` |
| `current({consoleId})`, `localRoms()`, `addToShelf(meta)`, `waitForGame(ref)` | |

`ref` is a shelf `file`, a `title`, a substring, or an explicit meta object.

### `rack` — consoles

`list()`, `spawn(system)`, `focus(id)`, `power(id, on)`, `reset(id)`,
`mayRunLocalCore()`, `budget()`, and:

```js
await __testApi.rack.running({ ms: 1200 })
// [{ id, core, loaded, live, allowed, framesDelta, pixelsChanged, blank, running }]
```

`live` is only "not paused" — **an unbooted client reads `live: true`**. `running`
is the honest verdict: loaded **and** unpaused **and** allowed **and** its picture
actually moved over `ms` (decoded worker frames where the runtime reports them,
otherwise the canvas pixel hash changing). On a watching client every entry must
read `running: false`; that is the one-running-core invariant, and it is what an
MP test should assert instead of trusting `paused`.

### `tv` — what is really on the screen

`list()`, `get(tvId)` → `{ id, kind, sourceId, active, console, width, height }`.
`kind` is `'canvas' | 'video' | 'none'` — the question that used to require
three.js spelunking: is this screen painting a local canvas or a remote host's
`<video>`?

```js
await __testApi.tv.sample(tvId, { gx, gy, cell, rect })
// { id, kind, w, h, hash, sig, blank, spread }
```

**Two measurements, two different questions. Mixing them up is how you write a
vacuous test:**

* **`hash`** — FNV-1a over a downsampled RGB grab. Asks *"did **this** peer's
  picture change between t0 and t1"*. Exact, therefore **not comparable across
  peers**: a watcher sees a WebRTC-re-encoded version, so the bytes always differ.
* **`sig`** — coarse luma grid. Asks *"are these two peers looking at the same
  picture"*, via `correlate(sigA, sigB)`. Same game ⇒ ≈1; different games ⇒ ≈0.
  This is the check that caught "the watcher is stuck on the retired canvas",
  which every connection-count check passed.
* **`blank: true`** means the sample carries **no evidence** (uniform, unpainted,
  or a tainted canvas). Never read it as a pass.

Also: `progress(tvId, {ms})` (hash-based, peer-local), `waitForMotion(tvId)`, and

```js
await __testApi.tv.profile(tvId, { rect: {u0,v0,u1,v1}, axis: 'y', bins: 30 })
// { …, axis, bins, values: [luma per band] }
```

`profile()` is a 1-D luma profile of a crop — how you locate a **moving sprite**
without the app knowing what a sprite is. Crop to where it lives, profile along
the axis it moves, compare before/after an input. Prefer the **normalised**
`{u0,v0,u1,v1}` crop over pixels: the host samples its own canvas while a watcher
samples a re-scaled `<video>`, and only a normalised rect lands on the same part
of the game on both.

### `video` — host → client WebRTC

`state()` gives connection *and* liveness in one snapshot
(`amHost, sourcing, sendingCount, receivingCount, connectedCount, hasAudio,
receivingAudio, peers, hostVideo`).

**Read `hostVideo` before trusting the counts** — they stayed "healthy" over a
frozen stream in a real bug. That is what `progress({ms})` is for: it samples
twice and reports `{ advanced, dFrames, dTime, paused, w, h }`. `advanced` is the
only honest "the picture is alive" signal on a watcher. `waitForStream()` waits
for a live track *and* for frames to advance.

### `room`

`descriptor()` (what this peer built its world from), `published()` (the HOST's
`room` key), `tv()` (the HOST's published game).

---

## The Node harness

```js
import { MpHarness, makeChecks, parseArgs, correlate, brightCentroid } from './lib/mp-harness.mjs';

const mp = new MpHarness({ app: 'http://localhost:5199/', ws: 'ws://localhost:8797/' });
const { ok, section, summary } = makeChecks();

const host    = await mp.openHost('Host');   // opened FIRST → deterministically host
const client  = await mp.open('Client');
await client.waitUntilWatching();

await host.loadFile({ url: 'roms/freeware/lwx-nes-pong.nes' });
await host.waitForGame('lwx-nes-pong');
await client.waitForStream();

ok(await mp.samePicture(host, client) > 0.85, 'both peers show one game');
await mp.closeAll();
process.exit(summary() ? 0 : 1);
```

One browser **process** per peer — not tabs. WebRTC between two contexts of one
browser does not exercise the ICE path two real machines do.

`Peer` methods mirror the client namespace: `joinRoom`, `leaveRoom`,
`sessionState`, `becomeHost`, `waitUntilHost`, `waitUntilWatching`,
`waitForPeers`, `listProps`, `moveObject`, `grabProp`, `moveObjectTo`,
`releaseProp`, `press`, `releaseButton`, `tap`, `hold`, `insertCart`, `loadRom`,
`loadFile`, `waitForGame`, `consoles`, `runningCores`, `spawnConsole`,
`powerConsole`, `tvs`, `tvState`, `sampleTv`, `pixelHash`, `pixelSignature`,
`tvProfile`, `tvProgress`, `waitForMotion`, `videoState`, `videoProgress`,
`waitForStream`, `armGun`, `fireGun`, `moveMouse`, `recvInputs`, `screenshot`.
Plus `call(path,args)` (throws) and `tryCall(path,args)` → `{ok,value,error}`
for expected-failure checks.

Harness-level, cross-peer:

| helper | what it answers |
|---|---|
| `mp.openHost(nick)` | open a peer and assert it *is* the host (fails loudly if the room already had one) |
| `mp.samePicture(a, b)` | best correlation of two peers' screens over a few samples. ≈1 same, ≈0 unrelated, `null` = one side blank ⇒ **no evidence** |
| `mp.sameProfile(a, b, opts)` | same, for 1-D profiles |
| `mp.spritePosition(peer, {rect, axis})` | median `brightCentroid` over several grabs — where a moving sprite is, 0..1 along the axis. Robust to a ball crossing the crop |
| `correlate`, `brightCentroid` | the pure maths, exported |

`LAUNCH_ARGS` is exported and pre-set for the three flags that otherwise cause
fake failures: `--autoplay-policy=no-user-gesture-required` (an auto-paused
`<video>` freezes the *texture* too), `--disable-features=WebRtcHideLocalIpsWithMdns`
(without it two local browser processes never complete ICE), and
`--enable-features=SharedArrayBuffer` (threaded cores).

---

## Writing a new headless multiplayer test

1. **Prereqs.** Two terminals:
   ```
   $env:PORT=8797; node server/room-server.mjs
   npm run dev -- --port 5199
   ```
   Every script takes `--app`/`--ws`, so the same test runs against production
   (`--app=https://dionysus.dk/webxr/libretrowebxr2/ --ws=wss://dionysus.dk/ws/`).
   The room server is **not** in `dist/` — deploy it separately (`npm run deploy-room`).

2. **Copy the skeleton** from `scripts/demo-automation-api.mjs`. Open the intended
   host first with `openHost()`, then the watchers, then `waitUntilWatching()`.

3. **Drive the app, not the transport.** `content.insert` / `content.loadFile` /
   `input.press` / `props.move` all go through the same functions the UI calls. A
   test that pokes `setObjectState('tv', …)` directly passes happily while the app
   does something else entirely — that mistake hid real bugs here twice.

4. **Assert on evidence, not on plumbing.** See below.

5. **Add a negative control** in the same run, and make it a real assertion.

6. Register it in `package.json` if it should be runnable by name.

### Evidence, not vibes

| Question | ❌ don't | ✅ do |
|---|---|---|
| Is a core running? | `paused === false` | `rack.running()` → `running: true` (requires motion) |
| Does the client run zero cores? | `!booted` | `rack.running()` all `running: false`, plus `rack.mayRunLocalCore() === false` |
| Is the client seeing the host? | `receivingCount() > 0` | `video.progress().advanced` **and** `mp.samePicture(host, client) > 0.85` |
| Which screen source? | reach into `scene._tvs[0].material` | `tv.get().kind === 'video'` |
| Did input reach the game? | "the wire message was sent" | the **picture changed**: `mp.spritePosition()` before/after |
| Did a prop sync? | both peers have the prop | both converge on the **mover's settled pose**, from a *different* previous pose |
| Do two rooms match? | compare layouts | make the host's layout *differ from default* first |

### Negative controls

A green check is not evidence until it has been seen to go red. The demo has
three, each asserting the **red** outcome so it cannot silently pass:

* **NC1 — pixel correlation.** Compare the host against a peer deliberately
  running a *different* game with the same `samePicture()` call; require ≈0.
* **NC2 — prop convergence.** Ask `waitForPosition` for a transform nobody ever
  broadcast; require `code: 'timeout'`.
* **NC3 — client → host input.** Press with `route:'local'` so the button goes to
  the client's own idle core instead of the host; require the identical paddle
  measurement *not* to move.

Cheap alternatives when those don't fit: assert an ordering (the mover's new pose
must differ measurably from the old one), or assert a floor on the number of
checks that ran (`state.passed`), so a run that fell over early cannot report
success.

---

## What the demo proves

`npm run demo-automation -- --app=… --ws=…` — three peers, **49 checks, 0 failures**,
all through `__testApi` with no legacy hooks. Measured, not asserted by faith:

* **Room objects, both directions.** Host→clients, ClientA→host+ClientB,
  ClientB→host+ClientA, plus a three-step grab/live-drag/release where the
  in-flight transform arrives on the transient channel and the authoritative one
  survives the release.
* **Game control, both directions, in pixels.** LWX Pong's right paddle is
  CPU-driven until player 2 touches up/down (`games/nes-pong/main.c`). The
  *client* holds P2 Up→Down→Up and the paddle travels 0.121 → 0.897 → 0.121 of its
  column, measured identically **on the host's canvas and on the client's received
  video**; the uninvolved third peer sees it too. Then the *host* holds P1 Up→Down
  and its own left paddle does the same, so the host is not merely relaying. Every
  direction is asserted as a **transition** (Δ > 0.35 from the previous extreme),
  never as an absolute position — on one run the CPU had already parked the paddle
  at the bottom, which would have made an absolute "Down → bottom" check vacuous.
* **Video from both roles.** Host: own screen is a live local canvas, picture
  non-blank and advancing, exactly one core genuinely running, `tv` state
  published. Clients: TV `kind === 'video'`, decoded frames advance, zero cores
  running, correlation with the host's canvas ≈ 0.99.

---

## Relationship to the existing scripts

This is **additive**. The 20-odd `scripts/smoke-*.mjs` / `probe-*.mjs` files and
the legacy `window.__*` hooks all still work and were not touched — `__testApi`
wraps them rather than replacing them, and `__testApi.raw()` lists what it
supersedes. Migrate opportunistically: when you next need to change a smoke,
consider porting it; don't churn them for its own sake.

Related reading: `docs/MULTIPLAYER.md` (the host-authoritative design and the
existing smoke inventory), `docs/HANDOFF.md` (project orientation).
