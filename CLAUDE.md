# LibretroWebXR — agent guide

WebXR multiplayer libretro frontend. Vite app (`src/`, dev on **:5173**) + a Node
room-server (`server/room-server.mjs`, **:8787**) with an HTTP log-server (**:8788**).

## ⛔ NEVER blanket-kill node

This machine runs many node processes that are **not** this project: the AI Control
Center server (port 5200), its agent terminal CLIs, MCP servers, the heartbeat logger.

**Do NOT** run any of these to free a dev port — they kill every node on the box and
take the whole agent fleet (and the Control Center) down with them:

- `taskkill /F /IM node.exe`  ← this exact command already killed the fleet once
- `taskkill //F //IM node.exe`
- `Stop-Process -Name node`  /  `Get-Process node | Stop-Process`
- `pkill node`  /  `killall node`

**Instead, kill only this project's dev servers by port:**

```powershell
pwsh scripts/kill-dev.ps1
```

It stops only the PIDs listening on this project's ports (5173/5174 vite, 8787
room-server, 8788 log-server, 8799/8801/8803 smoke) and never touches anything else.

To target a specific port: `pwsh scripts/kill-dev.ps1 -Ports 8787`.

If you must do it inline, kill by port, never by name — e.g. free :8787:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## Dev servers

- `npm run dev` — vite (:5173), **loopback only**
- `cd server && npm start` — room-server (:8787); `PORT=` to change
- `npm run deploy` — `pwsh scripts/deploy.ps1`

**Testing on a real Quest?** The dev/preview server binds `127.0.0.1` by default
(the vite dev-server advisories need a `0.0.0.0` bind on Windows). Opt in:

```powershell
$env:LAN=1; npm run dev        # then: Remove-Item Env:LAN
```

## Tests

- `npm test` — pure-logic tier: no browser, no server, no ports. This is the CI gate.
- `npm run test:servers` — spawns the room/log servers on 8891-8897 and drives
  them over real sockets. Kept out of `npm test` on purpose.

Both tiers run through `scripts/run-tests.mjs`, which **discovers** every
`scripts/test-*.mjs`: writing one is all it takes to be in CI — there is no list
to append to (four suites were once written, green and never run). The server
tier is the one explicit list in that file, and a logic-tier suite that imports
`ws`/`puppeteer`/`node:http`/`node:net`/`node:child_process` fails the run as
MISCLASSIFIED rather than quietly binding a port on a CI runner. Pass substrings
to run a subset: `node scripts/run-tests.mjs voice gun`.

- `scripts/probe-*` / `scripts/smoke-*` — need real Chrome and/or a running
  room-server and fetched cores. Opt-in, never in CI.

## ⛔ `public/roms/local/` ships on purpose

It is the user's private, gitignored ROM sideload, and the build/deploy
**publishes it** to dionysus.dk — that is the only practical way to test light
guns on a headset. A guard that strips it has been added and reverted **twice**
(`0df8aeb` → `b192911`, and again 2026-08-14). Both whole-repo reviews rank
"deploy can publish the private ROM library" as their #1 critical finding; for
this project that recommendation is wrong. `scripts/check-dist.mjs` reports the
private tree on every build and only refuses it under `--strict`, which is for a
genuinely public release. Read that file's header before changing anything here.
