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

- `npm run dev` — vite (:5173)
- `cd server && npm start` — room-server (:8787); `PORT=` to change
- `npm run deploy` — `pwsh scripts/deploy.ps1`
