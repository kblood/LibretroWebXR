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
Restart=always
```

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
