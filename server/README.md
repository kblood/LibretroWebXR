# Room server — M0 presence relay

A tiny WebSocket relay that powers **shared-room presence** (avatars, nicknames,
and later voice signaling) for LibretroWebXR. It is the Layer-1 transport from
[`docs/MULTIPLAYER.md`](../docs/MULTIPLAYER.md): low-rate, non-deterministic
sync of head/hand poses and join/leave — **no game state**, so it works for every
core.

This is a **long-running Node process**, not a static asset. The web app stays a
static site; this runs alongside it and the web server reverse-proxies a path to
it.

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

> **Not yet deployed.** M0 is verified locally (unit + two smokes). Standing up
> the proxied server on dionysus.dk is the remaining step to make presence live.
