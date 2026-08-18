# Room server — M0 presence relay

A tiny WebSocket relay that powers **shared-room presence** (avatars, nicknames,
and later voice signaling) for LibretroWebXR. It is the Layer-1 transport from
[`docs/MULTIPLAYER.md`](../docs/MULTIPLAYER.md): low-rate, non-deterministic
sync of head/hand poses and join/leave — **no game state**, so it works for every
core.

This is a **long-running Node process**, not a static asset. The web app stays a
static site; this runs alongside it and the web server reverse-proxies a path to
it.

The same server also backs `desktop.html`, the flat-screen (non-VR) build's
netplay (`src/desktop/DesktopNet.js`) — it's a second client of this same
room/wire protocol, not a separate server.

## Run

```bash
cd server
npm install
npm start                 # listens on :8787 (set PORT to change)
```

The browser connects to `wss://<host>/ws/?room=<id>`. Rooms are created on demand
by the `?room=` query param (default `lobby`); peers in the same room see each
other. Per connection the server assigns an id and is authoritative over it — it
stamps that id onto every relayed `pose`/`join`, so a client can't impersonate
another peer.

## Admission control — every env knob, and what production actually ships

This process is **public**. `dionysus.dk` reverse-proxies `/ws/` to it and real
headsets connect over the internet, so the limits below — not the bind address —
are the defence. Every one is an environment variable with a default that is
comfortably above what a real 4-player room sends; nothing here needs to be set
for normal operation, though **the deployed unit does set four of them** (see
[what production ships](#what-production-actually-ships)).

All **44** are in the tables below: the 26 read by `room-server.mjs`, the 14 in
`Hub.js`'s `HUB_LIMITS`, and the 4 read by `log-server.mjs`, which runs **in this
same process** (`room-server.mjs` imports it). "Every env knob" is meant
literally, and getting it literally right has taken three passes — one version
omitted `ROOM_MAX_NICK_LEN`/`ROOM_MAX_COLOR_LEN`, the next stated a count of 29
against 30 rows, and neither documented the log server's own variables at all.
If you add a knob, add its row **and** fix the count in this sentence.

### ⚠ `ROOM_ALLOWED_ORIGINS` ships EMPTY — "no Origin check" is still true

The default is the empty string, which means **any origin is accepted**. Setting
it is an operator decision that has not been made, so *production has no Origin
check today*. That is a deliberate default, not an oversight: the app is served
from `dionysus.dk` but is also opened from `localhost` dev servers, `file://`
builds and the headset's own origin, and a wrong guess here silently breaks every
headset with a 403 on upgrade.

To lock the deployed relay down, set it in the systemd unit:

```ini
Environment=ROOM_ALLOWED_ORIGINS=https://dionysus.dk
```

Comma-separate to allow more than one (`https://dionysus.dk,http://localhost:5173`).
A **missing** `Origin` header is always allowed regardless: browsers always send
one on a WebSocket upgrade, so only non-browser clients (this repo's own `ws`
smoke tests, `curl`) lack it — and those are not what an Origin check defends
against.

### How a cap refuses: **two tiers**, and why it took three attempts

A refusal is delivered one of two ways, and which one is a per-address decision:

| Tier | What the relay does | What it costs the relay | Who gets it |
| --- | --- | --- | --- |
| **Soft** | Accepts the upgrade, then closes at once with **`1013`** ("try again later") + the reason | A full handshake, an entry in `wss.clients` for `ROOM_REFUSAL_GRACE_MS`, a log line and a terminate timer | Every capacity refusal, while the address is inside `ROOM_MAX_SOFT_REFUSALS_PER_IP` and the process is inside its in-flight cap |
| **Hard** | Kills the HTTP upgrade with **`429`** — no `Sec-WebSocket-Accept`, no WebSocket object, nothing in `wss.clients` | A status line and `socket.destroy()` | An address that has spent its soft budget, i.e. one knocking far faster than any client should |

**Why soft exists.** The clients already deployed to headsets only retry a socket
that has been **open at least once** (`wasConnected || this._reconnectTries` in
`src/net/NetMgr.js` and `src/desktop/DesktopNet.js`, both falsy on a fresh
client's first connect), and only close code `4010` produces any status text — so
a killed upgrade put the multiplayer widget on "Offline" for the rest of the
page's life, with no reason and nothing retrying behind it. That is the exact
dead end COR-9 was written to remove, and a *transient* cap must not recreate it.

**Why hard exists.** Making *every* refusal soft made refusing **strictly more
expensive than admitting**, and the global gate was `wss.clients.size >=
ROOM_MAX_SOCKETS` — which counts refused sockets. One address at ~256
upgrades/second therefore held the relay at capacity with **zero peers in any
room**, and neither per-IP cap could shed it, because a rate refusal was itself a
full accept. A cheap door is not an optional refinement; without one the caps
invert.

**What keeps a full room out of the hard tier.** The two per-address budgets are
deliberately separate and only one of them can refuse anything:

* `ROOM_MAX_UPGRADES_PER_IP` (churn) is charged **only by admissions**, because
  only an admitted upgrade buys the room-state replay it exists to bound.
* `ROOM_MAX_SOFT_REFUSALS_PER_IP` is charged **only by refusals**, and it cannot
  refuse — it only decides whether a "no" costs a handshake or an HTTP error.

The single bucket these replace charged both and refused over the total, so a
client stuck in a refusal loop drove its own address over the budget and locked
out **everything else at that address** — including the sixteen headsets already
in the room, reconnecting after a Wi-Fi blip. Now a refused attempt never makes
the next attempt likelier to be refused; it only makes the next *refusal*
cheaper.

**The trade, stated.** A softly refused pre-COR-9 client resets its backoff on
the `open` the refusal itself produces, so it knocks at 2 Hz forever and cannot
be shipped a fix. Server survival wins over one stuck client, so that address's
expensive answers run out and it starts getting `429`s.

What that costs a real user, in the worst *legitimate* case: nothing, as long as
they have been told once. A hard refusal is only ever a cheaper way to say a "no"
that was already decided — it never turns an admission into a refusal — so the
moment a seat frees, the same address is admitted, budget or no budget. Every
client that has already been softly refused once (or has ever been connected)
keeps retrying through the `429`s and gets in.

The residue is one case: a device whose **very first** connection attempt lands
while its address has burned 64 refusals inside a minute. It gets a bare `429`,
which reaches a browser as a `1006` with no reason. A current client retries it
anyway (the first-connect gate is gone) and simply shows "Offline" until it gets
in; a pre-COR-9 client does not retry at all and stays there until the page is
reloaded. That window is exactly the window in which everything at that address
is being turned away 64+ times a minute, and it ends when the flood does.

Two things stay hard refusals for a different reason: a **disallowed `Origin`**
(an operator's exclusion — retrying can only produce the same answer, and such a
browser should not hold a socket at all) and `ws`'s own `maxPayload`, which
closes an already-established socket with `1009`.

**The client half.** `NetMgr`/`DesktopNet` reset their reconnect backoff when a
**session** exists (the `HELLO`), not when a socket opens — an `open` now also
happens on a soft refusal, and resetting there is what produced the 2 Hz knock —
and a `1013` selects a slower backoff table (5/10/20/30 s) than a dropped
connection does (0.5–8 s). They record the close code + reason on `lastClose` and
offer an `onRetry` callback so the widget can say *why*.

That last half is now wired: `src/main.js` passes `onRetry` and derives one
status line — `mpOfflineStatus()` — for **both** the header widget and the in-VR
multiplayer panel, so a refused user reads `room "x" full (16/16) — retrying in
10s` instead of a bare "Offline" (widget) or "Connecting…" (panel). It reads
`net.lastClose` live on each repaint rather than latching the callback's copy,
because `NetMgr` clears `lastClose` on the HELLO — which is what makes the line
disappear on its own the moment a seat frees. A *permanent* refusal (`onFatal`,
4010) still outranks it: that one is latched, because nothing is coming back.
This matters more than the wording suggests — with a household's ghost sockets
holding the seats, the gap between a seat freeing and the client being let in is
~10-30 s (see `RETRY_LATER_DELAYS_MS` in `src/net/NetMgr.js`), and a silent UI
for half a minute is indistinguishable from a broken one.

### Handshake / connection caps

| Env var | Default | Why |
| --- | --- | --- |
| `PORT` | `8787` | WebSocket listen port. |
| `ROOM_HOST` | *(empty = every interface)* | Bind address. Empty keeps `ws`'s own dual-stack (IPv4 **and** IPv6) listener, which LAN dev needs — a Quest connects straight to the dev box. The deployed unit sets `127.0.0.1`, because Apache proxies `/ws/` from loopback: without it the relay was *also* reachable directly on `:8787` from the internet, bypassing TLS termination and everything the vhost enforces. (Defaulting to a literal `0.0.0.0` would have silently dropped the IPv6 listener, so the default is "don't pass `host` at all".) |
| `ROOM_MAX_SOCKETS_PER_IP` | `ROOM_MAX_PEERS` (`16`) | Concurrent sockets **per address**. `ROOM_MAX_SOCKETS` is global, so without this one client could hold all 256 and every later headset would be turned away. The default is **derived from `ROOM_MAX_PEERS`, not guessed**: the first pass guessed 8 as "well above a real household" and it was below the app's own normal case — a 16-peer room behind one NAT (a household of headsets, a LAN party, a rack demo driven from several tabs on one desktop) is something the app actively invites, and the 9th of them was refused by a cap meant for an attacker. Starting at `ROOM_MAX_PEERS` means this can never bite before the per-room cap does, while still bounding one address to 16 of the 256 global sockets. A socket that has missed a ping by more than a quarter of `ROOM_HEARTBEAT_MS` stops counting here, so a **sleeping headset's ghost cannot lock its own household out** while the sweep catches up. Soft-refused with **1013**. |
| `ROOM_MAX_UPGRADES_PER_IP` | `ROOM_MAX_SOCKETS_PER_IP` x 16 (`256`) | **Admitted** upgrades **per address** per window, as a leaky bucket. This is the one that matters: the per-socket rate bucket is created fresh in the connection handler, so *reconnecting reset it* and churn had no sustained limit at all — while each join makes the server replay the room's whole STATE map (one `encode()` per key, up to 4096 keys / 2 MiB), so one TCP handshake could buy ~2 MiB of serialization on a single-threaded relay. Charged **on admission only**, and checked **last**: a refused attempt costs no replay, and charging it here is what let one client stuck in a refusal loop lock out every other device at its address (see [How a cap refuses](#how-a-cap-refuses-two-tiers-and-why-it-took-three-attempts)). Hammering while already at a cap is bounded by the soft-refusal budget below instead, which is the cheap bound. The x8 default this replaces was **below** the case its own derivation claimed to cover: the backoff chain is 500/1000/2000/4000/8000 ms, so a device that keeps failing makes ~10.5 upgrades in the first minute, not 7.5, and 16 of them behind one NAT make ~168 — against a budget of 128. x16 puts that household at ~66% of the budget. Soft-refused with **1013**. |
| `ROOM_MAX_SOFT_REFUSALS_PER_IP` | `ROOM_MAX_SOCKETS_PER_IP` x 4 (`64`) | How many refusals per `ROOM_UPGRADE_WINDOW_MS` this address is worth answering the **expensive** way (accept the upgrade, close `1013` + reason). Past it a refusal it was getting anyway is delivered as a bare `429`. **It can never turn an admission into a refusal** — that separation is what lets a full 16-peer room behind one NAT keep working while two stuck tabs at the same address burn this budget. Sized so a whole household can be turned away four times a minute and still be told why, while a flood gets ~1 expensive answer a second and HTTP errors for the rest. There is no separate window knob: it drains over `ROOM_UPGRADE_WINDOW_MS`, like the row above. A connection with **no billable address** (`ROOM_TRUST_PROXY` on, no `X-Forwarded-For`) has no budget here and is bounded by the process-wide in-flight cap instead — `ROOM_MAX_SOCKETS`/8, derived rather than a knob because it has no meaning apart from the two numbers it sits between. |
| `ROOM_UPGRADE_WINDOW_MS` | `60000` | The window **both** per-address buckets above drain over — the churn budget and the soft-refusal budget; neither has a window knob of its own. The drain is leaky and continuous (a score decays by elapsed/window every time it is read), not a boundary reset, so there is no edge to line a burst up against. Nothing is clamped, because nothing needs to be: **only admissions are charged** to churn (see the two rows above), and a score that is never charged past its own cap cannot overshoot it. The single bucket these replace *did* charge refusals, which is why it needed a two-windows' clamp to stop a flood locking a NATted household out for hours after it stopped — that whole failure mode went out with the merged bucket. To throttle a client that is *knocking*, tune `ROOM_MAX_SOFT_REFUSALS_PER_IP`; lowering this one throttles real joins and does nothing to a knocker. |
| `ROOM_TRUST_PROXY` | *(unset = off)* | Whose address to bill. **Off**: the socket address, and `X-Forwarded-For` is ignored — mandatory for a direct/LAN bind, where a client-supplied XFF would otherwise buy a fresh budget per socket. **On** (`1`/`true`/`yes`/`on`, and what the deployed unit sets): the **last** hop of `X-Forwarded-For`, which is the one Apache appended and therefore the one the client cannot forge — reading the *first* hop, the usual "original client" convention, is what makes an XFF-keyed limiter free to evade. Behind a proxy this is not optional: keyed on the socket address, every headset in the world is billed to `127.0.0.1` and the **17th** connection to the site is refused (`ROOM_MAX_SOCKETS_PER_IP` defaults to `ROOM_MAX_PEERS` = 16 — the figure agrees with the deployment table below, and the number an operator will actually observe). A request with **no** XFF while this is on is **exempt**, not billed to a shared key — so a proxy that turns out not to forward the header degrades to "no per-IP cap" rather than to a site-wide outage. |
| `ROOM_MAX_PAYLOAD_BYTES` | `1048576` (1 MiB) | `ws`'s own `maxPayload`. The largest real frame is a host `room`/`shelf:collections` STATE — committed room descriptors are 1.2–1.6 kB and the biggest collection JSON in the tree is 10,842 B — so this is ~100x real traffic and 100x **smaller** than `ws`'s 100 MB default. Over-size closes the socket with 1009. |
| `ROOM_MAX_PEERS` | `16` | Peers per room. Shipped multiplayer is 4-player (NES Four Score is the widest input path); 16 leaves room for spectators and a rack demo. Also the default for `ROOM_MAX_SOCKETS_PER_IP`. Soft-refused with **1013**. |
| `ROOM_MAX_SOCKETS` | `256` | Sockets process-wide — counting only sockets that **are or can become a session**. Softly refused sockets are excluded: they are real entries in `wss.clients` for `ROOM_REFUSAL_GRACE_MS`, and comparing this against `wss.clients.size` meant a flood of refusals held the relay at capacity with no peers in any room. Total residency is therefore this **plus** at most `ROOM_MAX_SOCKETS`/8 refusals in flight — a known number rather than one the attacker picks. Soft-refused with **1013**. |
| `ROOM_MAX_ROOMS` | `128` | Distinct rooms. A *new* room past this is soft-refused with **1013**; joining an existing one is not. |
| `ROOM_MAX_ROOM_ID_LEN` | `40` | Room ids are Map keys straight off the query string; they are sanitised to `[A-Za-z0-9_-]` and truncated to this. |
| `ROOM_MAX_SID_LEN` | `64` | The host-reclaim session id is only ever compared for equality, so a 10 MB "sid" would be pure retained memory. |
| `ROOM_ALLOWED_ORIGINS` | *(empty = any)* | See the warning above. |
| `ROOM_SWEEP_MS` | `60000` | Empty-room reaper interval (safety net for a missed teardown). |
| `ROOM_HEARTBEAT_MS` | `10000` | Ping sweep. Two missed periods terminate a socket, so this is also how fast an unclean host death is noticed and the host role migrates. Also drives the aggregate outbound sweep below, and — at a **quarter** of this — how long a silent socket keeps holding its address's `ROOM_MAX_SOCKETS_PER_IP` slot. (A quarter, not the full period, because a headset on Wi-Fi answers a ping in tens of milliseconds; waiting for the sweep meant a slept Quest's ghost could refuse its own household's rejoin for up to two whole periods.) |
| `ROOM_SHUTDOWN_GRACE_MS` | `5000` | SIGTERM/SIGINT drain window (see [Graceful shutdown](#graceful-shutdown-sigtermsigint)). How long live sockets get to acknowledge their `1001` close before the process forces its own exit, so a peer that never answers cannot hold the systemd unit open (`ws` would wait 30 s for it). `0` restores the pre-fix behaviour — exit immediately, every peer sees `1006` — and is the negative control in `scripts/test-room-protocol.mjs`. |

### The in-process log server (`log-server.mjs`)

`room-server.mjs` **imports** it, so these run in the same process as the relay
and a failure in one is a failure in both (there is an `uncaughtException` guard
in `room-server.mjs` for exactly that reason).

| Env var | Default | Why |
| --- | --- | --- |
| `LOG_PORT` | `8788` | HTTP listen port (binds `127.0.0.1`; Apache reverse-proxies `/logs` to it). |
| `LOG_DIR` | `server/logs` | Where per-session `.log` files are written. Session ids are sanitised to a safe alphabet and Windows device names are prefixed before they reach a path. |
| `LOG_TOKEN` | *(empty = open)* | Read gate for `GET /logs` and `/logs.json`, accepted as `?token=`, `X-Log-Token` or `Authorization: Bearer`. **`POST /log` is never gated** — the Quest carries no secret, and gating ingest would break remote logging outright. Empty by default because that is right for a developer running this locally; **the deployed unit sets one** via `EnvironmentFile` (see below), because without it `curl https://dionysus.dk/logs.json?tail=0` returns every session's entries *and* the session list — room names, nicks and ROM filenames from the private library, shipped automatically by every visitor to the production host. The headset workflow survives it verbatim: `dionysus.dk/logs?session=<room>&token=<yours>`. |
| `LOG_CORS_ORIGINS` | *(see log-server.mjs)* | Origin allow-list for the read endpoints. The viewer and the app are same-origin in production, so a restrictive value costs nothing there; a dev at `localhost:5173` shipping to a remote log server is the case that needs an entry. |

### Inbound rate

| Env var | Default | Why |
| --- | --- | --- |
| `ROOM_MSG_RATE` | `600` msg/s | Token-bucket refill per socket. A peer aiming a light gun *and* moving a mouse at frame rate while dragging a prop peaks at ~275 msg/s (120 + 120 + 20 drag + 12 pose), so this is >2x the real worst case. Over-budget messages are **dropped, not fatal**. |
| `ROOM_MSG_BURST` | `1200` | Bucket size — one burst of 1200 is absorbed without a single drop. |
| `ROOM_MAX_RATE_VIOLATIONS` | `600` | Drops **within one window** (below) before the socket is closed with **4008**. |
| `ROOM_RATE_VIOLATION_WINDOW_MS` | `10000` | The violation score decays linearly to zero over this window. **This is a sliding budget, not a lifetime total.** It used to be a lifetime counter set to 0 at connect and only ever incremented, so "600 violations" meant "the 600th over-budget message this socket ever sent" — an evening-long Quest session would accumulate its way to a mid-game 4008 that nothing client-side retries. |

### Outbound backpressure

| Env var | Default | Why |
| --- | --- | --- |
| `ROOM_MAX_BUFFERED_BYTES` | `4194304` (4 MiB) | Per socket. A client that has stopped reading (suspended tab, half-open TCP) makes every broadcast queue in this process's memory. Deliberately **larger than `ROOM_MAX_STATE_BYTES_PER_ROOM`**: a late joiner is sent the room's whole state map at once, so a room allowed to hold more than a socket may buffer would evict its own legitimate late joiners. |
| `ROOM_MAX_BUFFERED_TOTAL_BYTES` | `33554432` (32 MiB) | **Aggregate.** The per-socket cap alone multiplies out to 256 x 4 MiB = 1 GiB. The send path **and** the heartbeat sum `bufferedAmount` across all clients and evict the most-backed-up ones until the process total is under this. |
| `ROOM_BUFFER_SWEEP_MS` | `250` | How often the aggregate walk may run **from the send path**. Enforcing the total only on the heartbeat made 32 MiB a *ten-second average*, not a ceiling: 256 sockets that stop reading while their peers fan out ~1 MiB WIRE frames reach ~1.25 GiB resident in well under a second, and the sweep at `ROOM_HEARTBEAT_MS` = 10 s does not look until long after that. The walk is gated on the socket being sent to already holding more than a quarter of `ROOM_MAX_BUFFERED_BYTES` (or an eighth of the total budget, whichever is smaller), so a healthy room never walks at all; this throttle bounds the cost when *every* socket is over that trigger, which is the attack. `0` = walk on every over-trigger send (what the test uses); a value longer than a test run restores heartbeat-only enforcement and is the negative control. |
| `ROOM_REFUSAL_GRACE_MS` | `1000` | How long a **softly refused** socket gets to flush its `1013` close frame before `terminate()`. Not optional: `ws.close()` waits for the peer's close *reply* (`ws` allows 30 s), and a socket waiting that long is still in `wss.clients` — so a client that never answers could park unlimited refused sockets in the process, which is the thing these caps exist to prevent. One small frame needs nowhere near a second. `0` destroys it immediately, which is the negative control: the client then sees a bare `1006` with no reason, exactly what a killed upgrade produced. |
| `ROOM_BACKPRESSURE_GRACE_MS` | `2000` | How long an evicted socket gets to flush before `terminate()`. Without it the **4009** close code was unreachable — `close(4009)` was followed immediately by `terminate()`, which destroyed the socket before a close frame queued behind >4 MiB could flush, so every evicted peer saw a bare 1006 and the `slow client` reason string was decorative. `0` restores that old behaviour (used as the negative control in the test suite). |

### Identity (JOIN)

| Env var | Default | Why |
| --- | --- | --- |
| `ROOM_MAX_NICK_LEN` | `64` | Characters kept from a JOIN nick. `Hub.identify()` **truncates rather than rejects**: an over-long nick is cosmetic abuse, not an attack on the room, and dropping the JOIN would leave that peer nameless for everyone else. `NetProtocol.validate()` has no length bound of its own, so this is the only one. |
| `ROOM_MAX_COLOR_LEN` | `32` | Same, for the avatar colour string. Also truncated, never rejected. |

### Ephemeral relay — `WIRE` and `SIGNAL` bodies

The budgets in the next section bound what the relay **retains**. `WIRE`,
`SIGNAL` and `POSE` are relayed and forgotten, so not one of them applies, and
until RELAY-2 the only bound on any of the three was `ws`'s
`ROOM_MAX_PAYLOAD_BYTES` — **1 MiB, four times the largest STATE value the same
server will accept**. A 1 MiB `WIRE` was legal and is *broadcast*, so one socket
could fan 15 MiB into the room per frame: the ingress half of the outbound
blow-up `ROOM_MAX_BUFFERED_TOTAL_BYTES` bounds at the other end.

| Env var | Default | Why |
| --- | --- | --- |
| `ROOM_MAX_WIRE_BYTES` | `8192` (8 KiB) | JSON characters in one relayed `WIRE`, measured after the relay projects it to `{ch, data}`. Real channels are tiny — `gun`/`mouse` ~80 B, `gp` ~60 B, `drag` one serialized prop, `insert` a game descriptor — so this is ~20x the largest one in the tree (asserted from the real shapes in `scripts/test-net.mjs`). |
| `ROOM_MAX_SIGNAL_BYTES` | `65536` (64 KiB) | Same, for a relayed `SIGNAL`. An offer's SDP is the biggest real one (a few kB even with every codec); ICE candidates are ~200 B. Kept an order of magnitude looser than `WIRE` because an SDP's size is the browser's choice, not ours — and a dropped offer costs a whole call, where a dropped `WIRE` costs one frame the next frame replaces. |

An over-cap body is **dropped, and not answered with a correction** — unlike a
refused STATE write, there is no authoritative value to re-converge onto.

`POSE` and `INPUT` need no knob and have none: `Hub.pose()`/`Hub.input()` rebuild
the message from the fields the format defines instead of spreading the sender's,
so their bodies are a fixed size whatever was attached to them. (The spread was
not a theoretical hole: no consumer ever *read* an unknown POSE field, the relay
simply rebroadcast it to everyone at 12 Hz.)

### Shared STATE — per-axis caps, a structural cap, **and** an aggregate budget

The room-object `Map` is the only thing the relay *retains*: every accepted key
lives for the life of the room and is replayed to every future joiner.

| Env var | Default | Why |
| --- | --- | --- |
| `ROOM_MAX_STATE_KEY_LEN` | `128` | Real keys are `prop:<uuid>`-shaped (~45 chars). Over-length is dropped outright and **not** echoed back — a correction would put the abusive key straight back on the wire. |
| `ROOM_MAX_STATE_VALUE_BYTES` | `262144` (256 KiB) | JSON characters in one value. ~21x the largest real value (12,502 B / 290 nodes with *every* collection in this tree inlined into one `shelf:collections`), i.e. room for a ~490-game collection at the ~533 B/game this tree's collections serialize to. |
| `ROOM_MAX_STATE_VALUE_NODES` | `8192` | **Structural.** JSON nodes in one value — one per container, one per array element / object property. The biggest real value is 290. See below for why a byte cap alone is not enough. Refused as `value-too-complex`. |
| `ROOM_MAX_STATE_VALUE_DEPTH` | `16` | **Structural.** Nesting levels in one value. The deepest real value is a serialized `room` at 7. Refused as `value-too-deep`. |
| `ROOM_STATE_NODE_COST_BYTES` | `128` | Accounted bytes charged per JSON node, on top of the serialized length, against the three aggregate budgets below. Measured per-node resident cost is 121 B for an empty object, 68 B for an empty array, 110 B per `"k123":1` property, 15 B per number. `0` restores the character-only accounting (the negative control in the test suite). |
| `ROOM_MAX_STATE_KEYS_PER_PEER` | `512` | A live room's key set is order *tens* even for a full patchable rack. |
| `ROOM_MAX_STATE_KEYS_PER_ROOM` | `4096` | Same, across all peers. |
| `ROOM_MAX_STATE_BYTES_PER_PEER` | `1048576` (1 MiB) | **Aggregate**, in *accounted* bytes. A real host's entire state set — `tv`, `room`, `shelf:collections`, `shelf:local` and 30 `prop:` keys — is 19,289 raw characters / 869 nodes = **130,521 accounted**, i.e. 12.4% of this. |
| `ROOM_MAX_STATE_BYTES_PER_ROOM` | `2097152` (2 MiB) | **Aggregate**, across all peers. A real 4-player room is under 200 kB accounted. |
| `ROOM_MAX_STATE_BYTES_TOTAL` | `67108864` (64 MiB) | **Aggregate**, process-wide. 128 rooms of real traffic — every room this server will create — is ~16 MiB accounted. |

Refused writes are reported to the client the same way an over-cap value already
was: the writer gets the **authoritative current value back as a directed STATE
correction**, so its optimistic local copy re-converges instead of silently
diverging. Nothing is disconnected for a refused write, and clearing a key
(`value: null`) is *always* allowed — it frees budget, and a peer that cannot
climb back out of its own budget would be a self-inflicted DoS.

#### Why the aggregate budgets exist — multiply the per-axis ones out

Each per-axis cap above is individually defensible and they were **jointly
meaningless**: 512 keys x 256 KiB is 128 MiB *per socket*, x 256 sockets ≈ 32 GiB;
per room 4096 x 256 KiB = 1 GiB, x 128 rooms = 128 GiB. Measured against the
shipped defaults before the byte budgets existed — one WebSocket, 512 x 250 KiB
STATE writes into one room:

```
RSS 56.9 MiB → 212.7 MiB      writes refused: 0      server limit lines: 0
```

Nothing refused anything, because every individual write was inside every
individual cap. With the budgets, the identical probe:

```
RSS 57.0 MiB → 74.6 MiB       writes refused: 508    corrections to writer: 508
```

(The ~18 MiB it *does* grow by is the churn of receiving 125 MiB of inbound
frames, not retained state — only 4 of the 512 values are kept — and it moves
between runs with GC timing: 17.6 / 30.9 / 16.4 MiB over three.) That probe is
section 0 of `scripts/test-room-limits.mjs`, kept as the acceptance test, with a
negative control that raises only the three byte budgets to 1 GiB and shows the
same server go 56.9 → 207.1 MiB with 0 refusals.

#### Why a byte count is not the unit — the structural cap

The version of those budgets that shipped first counted
`JSON.stringify(value).length` and nothing else. It worked, and it was still
**~20x optimistic**, because *the defender picked the unit and the attacker picks
the shape*. Retained heap is paid per **allocation**, not per character, and
JSON's cheapest heap allocation is three characters wide: `[{},{},{},…]`.

Measured: filling the **entire** 64 MiB byte budget — 64 sockets, 64 rooms,
4 x 256 KiB each, every per-axis and every aggregate cap honoured, **zero
refusals** — with an array of empty objects:

```
RSS 57.4 MiB → 1515.3 MiB    64 MiB accounted → 1457.9 MiB resident (22.78x)
                             (arrays of empty arrays: 15.26x;
                              the same harness with one string blob: 1.24x)
```

So the honest ceiling of the byte-only budget was not "336 MiB, fits a 1 GB VPS
with headroom" — it was **~1.5 GB, which does not**. That claim was measured with
*one* value shape and reported as if it were the worst case.

The fix has two halves, both in `Hub.js`:

1. **A structural cap per value** — `ROOM_MAX_STATE_VALUE_NODES` (8192) and
   `ROOM_MAX_STATE_VALUE_DEPTH` (16), walked iteratively by `measureValue()`,
   which bails as soon as the node cap is provably passed (so a hostile value
   costs neither the memory nor the CPU).
2. **A structural charge in the accounting** — every accepted value costs
   `serialized characters + nodes x ROOM_STATE_NODE_COST_BYTES` against the three
   aggregate budgets. 128 B/node is the measured worst-case per-node resident
   cost.

**Two known gaps in that unit** — an accounted byte is close to, but not a hard
bound on, a resident byte, and an earlier version of this section wrongly claimed
it was:

- **UTF-16.** `JSON.stringify(value).length` counts code *units*, but V8 stores a
  string containing any code point above U+00FF as a **two-byte** string. Filling
  the pool to 63.8 MiB accounted with 256 KiB values retains 64.2 MiB of live heap
  in ASCII (1.01x) and **128.2 MiB with U+4E2D (2.01x)** — same code path, one
  character swapped. Latin-1 (`é`) is not the attack; CJK and emoji are. Charging
  2 bytes/char would close it and would also halve every legitimate budget, so the
  cost is documented rather than paid.
- **Inbound parse churn.** `decode()` parses a frame *before* `setState()` can
  refuse it, so **refused** values are never accounted yet are briefly resident.
  32 sockets sending 900 kB `[{},{},…]` frames — all refused, nothing retained —
  peak the relay at **~354 MiB** before it settles back to ~58 MiB. That is
  bounded by `ROOM_MAX_PAYLOAD_BYTES` x concurrent frames, not by the structural cap.

**The worst case, multiplied out:**

| Bound | Arithmetic | Total |
| --- | --- | --- |
| per peer | 1 MiB x 256 sockets | 256 MiB |
| per room | 2 MiB x 128 rooms | 256 MiB |
| **process-wide** | — | **64 MiB accounted ← binds** |

Measured multipliers after the fix, worst first — real relay, shipped defaults,
RSS read externally rather than self-reported:

| Attack shape | Multiplier |
| --- | --- |
| two-byte strings (U+4E2D), whole pool | **2.30x** ← worst found |
| one-byte strings (ASCII), whole pool | 2.15x |
| values sized just under the node cap | 1.36–1.47x |
| arrays of empty objects / empty arrays | 2.4–2.5x |
| *the same attacks with the node charge disabled* | *23–36x* ← what this replaced |

**Read 2.30x as a floor, not a proof.** It is the worst over the shapes anyone
has tried — which is precisely the caveat the previous version of this section
omitted, and it was then caught out by a shape nobody had tried. Taking 2.30x on
a completely full pool (64 MiB x 2.30 ≈ 147 MiB), plus the ~57 MiB Node/`ws`
baseline and the 32 MiB aggregate outbound budget:

```
~57 MiB baseline + ~147 MiB state + 32 MiB outbound  ≈  236 MiB steady
+ inbound parse churn of refused frames              ≈  ~354 MiB transient peak
```

which still fits a **1 GB VPS** — that operational conclusion is unchanged, and
it is the part that matters. The numbers are 236/354, not the 183 this paragraph
used to carry. Sections 0b and 4c of `scripts/test-room-limits.mjs` are the
acceptance measurement, with the inverting control described above.

What the node charge costs a legitimate host: a maxed ~490-game inlined
collection is ~880 kB accounted, so **one** of those fits the 1 MiB per-peer
budget where the character-only accounting fitted two. The biggest collection in
this tree is 18 games / 9,603 B.

#### The trade the process-wide budget makes

Once the pool is exhausted, writes in *other* rooms are refused too — it is a
single process-wide pool, not a per-room reservation. That still needs ~32 rooms
simultaneously at their full 2 MiB (already an attack, not a busy evening), and
the failure mode is a correction message rather than a dead process.

**The node charge did tighten this, and the tightening is not hidden here.** The
pool is 64 MiB of *accounted* bytes, so a room reaches its 2 MiB with less raw
JSON than it used to — how much less depends on shape (a container-heavy value is
charged ~40x its characters, a string ~1x). Measured against what the app really
sends, that leaves 128 rooms — every room this server will create — at ~16 MiB of
the 64 MiB pool, so a full server of real traffic sits at ~25% of the budget. It
was ~4% under the character-only accounting; the ~16 MiB is the honest number for
what is now charged.

It is **not** partitioned per room on purpose: a 2 MiB per-room reservation x 128
rooms would guarantee 256 MiB of retained state and hand an attacker the right to
allocate it by opening 128 sockets, which is the DoS the pool exists to close.

Raising `ROOM_MAX_STATE_BYTES_TOTAL` is now a *predictable* decision, which is
the one real operational gain here: with the byte-only accounting an extra MiB of
budget could cost ~23 MiB of RSS depending on what shape arrived; with the node
charge it costs ~1.5 MiB, measured. Raise it if you genuinely run that many
big-shelf rooms and have the RAM.

## Protocol compatibility — the client/server version handshake

The app and this server ship by **two different commands** (`npm run deploy`
publishes `dist/`; `npm run deploy-room` ships `server/*` plus
`src/net/NetProtocol.js`). A version-skewed pair is therefore the **normal state
during a rollout**, not an edge case — and skew used to be invisible, because
`decode()` silently drops what it does not understand and both ends simply fall
quiet. That is exactly how a missing `bye` signalling kind went unnoticed for
months, and how the live relay ran a two-month-old `Hub.js` for five days.

So both ends now **state their version**, from one shared constant
(`PROTOCOL_VERSION` in `src/net/NetProtocol.js`, imported by the client *and* by
`Hub.js`/`room-server.mjs`, so the two can never drift):

- the client announces it in its **`JOIN`** (`join.v`);
- the server announces it in its **`HELLO`** (`hello.v`), so a *new client
  talking to an old server* — the direction the server cannot possibly check,
  since it has never heard of the field — is detectable client-side.

Format is `MAJOR.MINOR`. **The rule is: same MAJOR = compatible.** Bump MINOR for
an additive change (a new message type, a new optional field, a new signalling
kind) — an older peer ignores what it does not know and the pair still works.
Bump MAJOR only when an existing message's meaning or required shape changes,
i.e. when the old peer would *misinterpret* rather than ignore.

| The client says | The server does |
| --- | --- |
| nothing (`join.v` absent) | **Accepts.** It is an app built before this handshake — and one is deployed right now. Logged once per socket so the skew is visible in the journal. A relay update must never brick a deployed app. |
| the same MAJOR | Accepts, whatever the minor. |
| a different MAJOR, or an unparseable version | Closes with **`4010`** and a human-readable reason naming both versions. |

`4010` is **permanent**: retrying it with the same build can only produce another
`4010`, so `NetMgr` and `DesktopNet` both break their reconnect backoff on it,
record the reason and surface it (`onFatal`) instead of looping forever. Every
other close — `1001`, `1006`, `4008`, `4009` — is still retried. Which codes are
permanent lives in `NetProtocol.isPermanentClose()` rather than in each of the
two connection lifecycles, because a rule written twice is a rule that drifts.

## Graceful shutdown (SIGTERM/SIGINT)

`npm run deploy-room` restarts the systemd unit on every server update. Until
2026-08-15 there was **no signal handler at all**, so that restart destroyed
every socket mid-frame: each headset saw a bare `1006`, indistinguishable from a
crash or a Wi-Fi drop, and the room kept its ghost until the next heartbeat sweep.

`SIGTERM`/`SIGINT` now drain, in order: stop the timers, `wss.close()` (stop
*accepting* — `ws` does not close clients for you), close every live socket with
**`1001` "going away" + `server restarting`**, close the in-process log server,
and arm an **unref'd** forced-exit timer of `ROOM_SHUTDOWN_GRACE_MS`. Unref'd
matters: a clean drain exits early and naturally (measured: ~10 ms), while a peer
that never answers its close frame — which `ws` would wait 30 s for, long enough
for systemd to give up and `SIGKILL` — is overruled at the grace deadline. The
handler is idempotent, so a second signal neither re-runs the drain nor arms a
second timer.

`scripts/test-room-protocol.mjs` asserts all of it over real sockets against a
spawned relay, with `ROOM_SHUTDOWN_GRACE_MS=0` as the negative control that shows
the same client seeing the old `1006`.

## Architecture

- **`Hub.js`** — pure room/peer bookkeeping + broadcast decisions. No sockets, so
  it's unit-tested in the project's `npm test` (`scripts/test-net.mjs`). Imports
  the same `src/net/NetProtocol.js` builders the browser client uses, so the two
  ends can't drift on the wire format.
- **`room-server.mjs`** — thin `ws` adapter: maps `peerId ↔ socket`, sends
  `Hub`'s broadcast instructions, heartbeats dead sockets.

## Tests

```bash
# pure relay logic (part of the project suite):
npm test                      # from repo root — includes Hub assertions

# end-to-end transport (real ws, two clients):
cd server && node smoke.mjs

# protocol handshake + graceful shutdown (spawns real relays on :8894/:8895):
node scripts/test-room-protocol.mjs
#   Asserts the COR-9 version handshake (legacy accepted, wrong major closed with
#   4010) and the SEC-6 SIGTERM/SIGINT drain (1001 + reason, fast clean exit,
#   forced exit past a stuck socket, idempotent), each paired with a control.

# admission control end-to-end (spawns real relays on :8892/:8893, ~2.5 min):
npm run test:room-limits
#   Every cap is asserted as a PAIR — the same abusive action refused on a
#   tightened relay and ACCEPTED on a loosened one — so a green run cannot mean
#   "nothing works". Section 0 measures the server's RSS from outside the process
#   while one socket tries to park 128 MiB of STATE in one room; section 0b does
#   the same for the SHAPE attack (arrays of empty objects / empty arrays filling
#   the whole budget), with the node charge turned off as the control.

# end-to-end client (real Chrome connects + renders a peer avatar):
#   terminal 1:  $env:PORT=8798; node server/room-server.mjs
#   terminal 2:  npm run dev
#   terminal 3:  node scripts/smoke-presence.mjs
```

## Deploy (Apache reverse proxy)

Run this process under a supervisor (systemd) and proxy `/ws/` to it. The app
defaults to `wss://<same-origin>/ws/`, which keeps it on the same origin as the
COOP/COEP-isolated page.

```apache
# in the site's vhost
ProxyPass        /ws/  ws://127.0.0.1:8787/
ProxyPassReverse /ws/  ws://127.0.0.1:8787/
```

```ini
# /etc/systemd/system/libretrowebxr-room.service
[Service]
WorkingDirectory=/opt/libretrowebxr-room/server
ExecStart=/usr/bin/node room-server.mjs
Environment=PORT=8787
Environment=ROOM_HOST=127.0.0.1
Environment=ROOM_TRUST_PROXY=1
EnvironmentFile=-/etc/default/libretrowebxr-room
Restart=always
```

### What production actually ships

The committed unit (`deploy/libretrowebxr-room.service`) is no longer "defaults
plus `PORT`". Four settings differ, and each is a pair — one of them is only
*safe* because of another:

| Setting | Where | Why it is not the default |
| --- | --- | --- |
| `ROOM_HOST=127.0.0.1` | unit | Apache proxies `/ws/` from loopback, so nothing needs the public interface. Without it the relay was reachable directly on `:8787`, TLS and vhost bypassed. |
| `ROOM_TRUST_PROXY=1` | unit | **Required by the line above.** Behind the proxy every socket's peer address is `127.0.0.1`; keyed on that, `ROOM_MAX_SOCKETS_PER_IP` would refuse the 17th visitor to the whole site. Safe here *because* the direct path is closed — an unproxied client cannot reach the port to forge a header. |
| `LOG_TOKEN=…` | `/etc/default/libretrowebxr-room` (**not committed**) | Turns on the `GET /logs` read gate. See below. |
| *(left at its default:* `ROOM_ALLOWED_ORIGINS`*)* | — | Deliberate — see the warning at the top of this section. |

**`npm run deploy-room` does not install any of this.** It ships `server/*` and
restarts the unit; it never touches `/etc/systemd/system/`. So after changing
`deploy/libretrowebxr-room.service` someone has to `sudo cp` it into place and
`sudo systemctl daemon-reload` by hand, exactly as when it was first installed.
Until that happens the box simply keeps the old unit and the old (permissive)
behaviour — every setting here is opt-in, so a stale unit degrades, it does not
break.

One thing to be aware of with `ROOM_TRUST_PROXY`: it depends on Apache actually
sending `X-Forwarded-For` (`ProxyAddHeaders`, on by default, and
`mod_proxy_wstunnel` builds the same header brigade as `mod_proxy_http`). If a
future Apache config turns that off, the per-address caps quietly stop applying
rather than locking anyone out — the deliberate fail-open direction, but it does
mean "no 429s in the journal" is not by itself proof they work. `journalctl -u
libretrowebxr-room` shows both the keying (`per-address: … keyed on …` at
startup) and every refusal.

`EnvironmentFile=-/etc/default/libretrowebxr-room` carries the secret; the
leading `-` means the unit still starts if the file is absent, so a fresh box
comes up (open, as it is today) rather than crash-looping. Create it with a value
that is generated, never invented:

```bash
sudo sh -c 'umask 077; echo "LOG_TOKEN=$(openssl rand -hex 24)" > /etc/default/libretrowebxr-room'
sudo systemctl restart libretrowebxr-room
sudo cat /etc/default/libretrowebxr-room     # the value to append to your /logs bookmark
```

Then the headset workflow is `https://dionysus.dk/logs?session=<room>&token=<yours>`
— unchanged apart from the suffix, because the viewer's auto-refresh re-requests
the current URL query string and all, and its filter form re-submits the token as
a hidden field. `POST /log` is **never** gated, so the Quest needs no change and
no secret: only *reading* is.

**Do not commit the token.** The repo's existing pattern for this is
`deploy/coturn.conf.example` — a placeholder in the tree, the real value only on
the box.

Enable `mod_proxy` + `mod_proxy_wstunnel`, then `a2enmod proxy proxy_wstunnel`
and reload. Verify: open the app with `?session=test` in two tabs — each should
see the other's avatar.

### ⚠ Updating it is a SEPARATE step from `npm run deploy`

```powershell
npm run deploy-room     # = pwsh scripts/deploy.ps1 -Room
```

`npm run deploy` publishes `dist/` — a static folder. **This server is not in
`dist/`,** so an app deploy never updates it. Run `npm run deploy-room` whenever
you touch anything under `server/` **or `src/net/NetProtocol.js`** (`Hub.js`
imports it, so they must move together or the service crash-loops on a missing
export). The script backs the old tree up, restarts the unit, and re-greps the new
code on the box so a silent no-op can't look like success.

**Why this warning is here.** On 2026-08-03 the live process had been up for five
days running `Hub.js` **from 2026-06-09** — no `_senior`/host election, no
`HOST_RECLAIM_MS`, no `isHostOwnedKey`, and **no `wire()` method at all**, so the
whole client→host channel (cart `insert`, `insert-nack`, peripheral binds) was
being dropped on the floor in production. Every multiplayer milestone from M1.0 to
M1.4 had been verified only against a *local* `node server/room-server.mjs`, which
is always current, and the docs recorded them as "shipped + deployed". A real
two-computer playtest reported rooms not synced, screens not synced, and each
machine running its own game — which the stale server alone is enough to cause,
whatever the client does. Measured after updating it, with the same scripts and the
same deployed app: `smoke-shared-game.mjs` against production went 41/45 → **45/45**,
and a watcher that had been permanently frozen (0 decoded frames for 90 s) after a
host migration started decoding ~30 fps off the new host.

> **Deployed on dionysus.dk (2026-06-09; Hub/protocol refreshed 2026-08-03).** The
> room server runs as the systemd
> unit `libretrowebxr-room` from `/opt/libretrowebxr-room` (port 8787); Apache
> proxies `/ws/` to it via the `libretrowebxr-room` conf. The committed templates
> are `deploy/libretrowebxr-room.service` and `deploy/libretrowebxr-room.conf`.
> Verified live: `node scripts/smoke-presence.mjs --app=https://dionysus.dk/webxr/libretrowebxr2/ --ws=wss://dionysus.dk/ws/`
> connects through the proxy and renders a peer avatar.
