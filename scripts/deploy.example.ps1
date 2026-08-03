#requires -Version 5
<#
.SYNOPSIS
  EXAMPLE deploy script — build LibretroWebXR and publish dist/ to a static host.

.DESCRIPTION
  Template only. Copy to `scripts/deploy.ps1` (gitignored) and fill in your own
  connection details, OR set the DEPLOY_* env vars below and run this as-is.
  Contains NO real hosts, users, or key paths — never commit those.

  Flow: npm run fetch-cores → npm run build → per-item scp of dist/ into a staging
  dir on the remote → atomic `mv` staging→live (keeps a `.old` until success).
  public/.htaccess is uploaded explicitly because `scp dist/*` skips the dotfile,
  and its COOP/COEP headers are what make crossOriginIsolated (→ SharedArrayBuffer
  → the threaded libretro cores) work.

  Requires the OpenSSH client on PATH and an SSH key authorized on the host.

.PARAMETER Name   Target subfolder under the remote base (default 'libretrowebxr').
.PARAMETER Room
  Deploy the multiplayer ROOM SERVER (a long-running node process) instead of the
  web app — server/*.mjs + server/Hub.js + src/net/NetProtocol.js into its install
  dir, then restart its service unit. NOT part of a normal deploy, because the room
  server isn't a dist/ asset. Fill in $RoomBase/$Unit for your host. Run it whenever
  server/ or src/net/NetProtocol.js changes: nothing else does, which is how a live
  room server can end up months behind the app that talks to it while every doc says
  the feature is deployed.

.PARAMETER SkipCores / SkipBuild / DryRun   As named.

.PARAMETER AppOnly
  Refresh only the app (assets/ + the .html entry points + .htaccess) directly into
  the existing live folder — no staging dir, no atomic swap. A full deploy re-uploads
  everything vite copied out of public/, which for this project means cores/ and any
  local ROM/disc sideload: gigabytes of scp for a 1 MB code change. -AppOnly is
  seconds. It refuses to run if the live folder doesn't exist yet (it would produce a
  deployment with no cores), and it's safe despite not being atomic because vite
  content-hashes assets/ — new bundles land under new names and the .html files that
  reference them go last.

.EXAMPLE
  $env:DEPLOY_HOST='example.com'; $env:DEPLOY_USER='me'
  $env:DEPLOY_KEY="$HOME\.ssh\id_ed25519"; $env:DEPLOY_REMOTE_BASE='/var/www/html/webxr'
  pwsh scripts/deploy.example.ps1 -Name libretrowebxr
#>
[CmdletBinding()]
param(
  [string]$Name = 'libretrowebxr',
  [switch]$SkipCores,
  [switch]$SkipBuild,
  [switch]$AppOnly,
  [switch]$Room,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# --- connection: from env vars, with placeholders to edit if you prefer -------
# Set these as environment variables (recommended) or replace the '<...>' values.
# NEVER commit real values — copy this file to scripts/deploy.ps1 (gitignored).
$SshKey     = if ($env:DEPLOY_KEY)         { $env:DEPLOY_KEY }         else { '<path-to-your-ssh-private-key>' }
$RemoteUser = if ($env:DEPLOY_USER)        { $env:DEPLOY_USER }        else { '<ssh-user>' }
$RemoteHost = if ($env:DEPLOY_HOST)        { $env:DEPLOY_HOST }        else { '<host-or-ip>' }
$RemoteBase = if ($env:DEPLOY_REMOTE_BASE) { $env:DEPLOY_REMOTE_BASE } else { '/var/www/html/webxr' }
$Target     = "${RemoteUser}@${RemoteHost}"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

if ($SshKey -like '<*>' -or $RemoteUser -like '<*>' -or $RemoteHost -like '<*>') {
  throw "fill in connection details (env vars DEPLOY_KEY/USER/HOST or edit the placeholders)"
}
if (-not (Test-Path $SshKey)) { throw "SSH key missing: $SshKey" }
if ($Name -notmatch '^[A-Za-z0-9._-]+$') { throw "invalid -Name '$Name'" }

$SshOpts = @(
  '-i', $SshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8', '-o', 'ConnectTimeout=20'
)
function Invoke-Ssh([string]$cmd) {
  Write-Host "    ssh> $cmd" -ForegroundColor DarkGray
  if ($DryRun) { return }
  & ssh @SshOpts $Target $cmd
  if ($LASTEXITCODE -ne 0) { throw "ssh failed: $cmd" }
}
function Invoke-Scp([string]$src, [string]$dst) {
  if ($DryRun) { Write-Host "    scp> $src -> $dst" -ForegroundColor DarkGray; return }
  for ($try = 1; $try -le 3; $try++) {
    & scp @SshOpts -r $src "${Target}:${dst}"
    if ($LASTEXITCODE -eq 0) { return }
    if ($try -lt 3) { Write-Warning "scp $try/3 failed - retry in 3s"; Start-Sleep 3 }
  }
  throw "scp failed after 3 attempts: $src -> $dst"
}

# NOTE: call `npm` directly, not `& npm` — the pwsh call-operator + npm.cmd shim
# bug drops the first char ("Unknown command pm").
if (-not $SkipCores) { Write-Host '=== fetch-cores ===' -ForegroundColor Cyan; if (-not $DryRun) { npm run fetch-cores; if ($LASTEXITCODE) { throw 'fetch-cores failed' } } }
if (-not $SkipBuild) { Write-Host '=== build ==='      -ForegroundColor Cyan; if (-not $DryRun) { npm run build;       if ($LASTEXITCODE) { throw 'build failed' } } }

$Dist = Join-Path $RepoRoot 'dist'
if (-not (Test-Path $Dist)) { throw "no dist/ — build first (drop -SkipBuild)" }
$Htaccess = Join-Path $RepoRoot 'public\.htaccess'
if (-not (Test-Path $Htaccess)) { throw "missing public/.htaccess (COOP/COEP headers)" }

$id      = ([guid]::NewGuid().ToString().Substring(0, 8))
$Staging = "$RemoteBase/.staging-$Name-$id"
$Live    = "$RemoteBase/$Name"
$Old     = "$Live.old-$id"

# The room server is a long-running process, not a dist/ asset, so a normal deploy
# never touches it. Keep this step next to the app deploy or it WILL rot: on
# 2026-08-03 the live one was still the 2026-06-09 Hub.js (no host election, no
# host-owned state keys, no wire() at all) while the app shipped M1.4 and the docs
# said multiplayer was deployed. Everything had only ever been verified against a
# local `node server/room-server.mjs`.
if ($Room) {
  $RoomBase = '/opt/libretrowebxr-room'   # <-- your install dir
  $Unit     = 'libretrowebxr-room'        # <-- your systemd unit
  Write-Host "=== room server -> ${Target}:$RoomBase ($Unit) ===" -ForegroundColor Cyan
  # Hub.js imports ../src/net/NetProtocol.js — ship them together or the service
  # crash-loops on a missing export.
  $files = @(
    @{ src = 'server\Hub.js';          dst = "$RoomBase/server/" },
    @{ src = 'server\room-server.mjs'; dst = "$RoomBase/server/" },
    @{ src = 'server\log-server.mjs';  dst = "$RoomBase/server/" },
    @{ src = 'server\package.json';    dst = "$RoomBase/server/" },
    @{ src = 'src\net\NetProtocol.js'; dst = "$RoomBase/src/net/" }
  )
  foreach ($f in $files) { if (-not (Test-Path (Join-Path $RepoRoot $f.src))) { throw "missing $($f.src)" } }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Invoke-Ssh "sudo cp -a '$RoomBase' '$RoomBase.bak-$stamp' && echo 'backup: $RoomBase.bak-$stamp'"
  foreach ($f in $files) { Write-Host "    + $($f.src)"; Invoke-Scp (Join-Path $RepoRoot $f.src) $f.dst }
  Invoke-Ssh "cd '$RoomBase/server' && npm install --omit=dev --no-audit --no-fund >/dev/null && echo 'deps ok'"
  Invoke-Ssh "sudo systemctl restart $Unit"
  Start-Sleep 3
  Invoke-Ssh "systemctl is-active $Unit"
  Invoke-Ssh "journalctl -u $Unit -n 8 --no-pager | tail -8"
  Write-Host ''
  Write-Host "Done (room server). Roll back: sudo cp -a $RoomBase.bak-$stamp/. $RoomBase/ && sudo systemctl restart $Unit" -ForegroundColor Green
  if ($DryRun) { Write-Host '    (dry run — nothing changed)' -ForegroundColor Yellow }
  return
}

if ($AppOnly) {
  Write-Host "=== app-only refresh $Name -> ${Target}:$Live ===" -ForegroundColor Cyan
  Invoke-Ssh "test -d '$Live' || { echo 'no live folder yet - run a FULL deploy first' >&2; exit 1; }"
  $appLast = @('index.html', 'desktop.html', 'headset-test.html')
  Get-ChildItem -Path $Dist -Force |
    Where-Object { $_.Name -notin @('roms', 'cores', '.htaccess') -and $_.Name -notin $appLast } |
    ForEach-Object { Write-Host "    + $($_.Name)"; Invoke-Scp $_.FullName "$Live/" }
  Write-Host '    + .htaccess (COOP/COEP)'; Invoke-Scp $Htaccess "$Live/.htaccess"
  foreach ($n in $appLast) {
    $p = Join-Path $Dist $n
    if (Test-Path $p) { Write-Host "    + $n"; Invoke-Scp $p "$Live/" }
  }
  Write-Host ''
  Write-Host "Done (app only). Live folder: $Live" -ForegroundColor Green
  Write-Host '    roms/ and cores/ untouched — run a full deploy to change them.' -ForegroundColor DarkGray
  if ($DryRun) { Write-Host '    (dry run — nothing changed)' -ForegroundColor Yellow }
  return
}

Write-Host "=== deploy $Name -> ${Target}:$Live ===" -ForegroundColor Cyan
Invoke-Ssh "mkdir -p '$Staging'"
Get-ChildItem -Path $Dist -Force | ForEach-Object { Write-Host "    + $($_.Name)"; Invoke-Scp $_.FullName "$Staging/" }
Write-Host '    + .htaccess (COOP/COEP)'; Invoke-Scp $Htaccess "$Staging/.htaccess"
Invoke-Ssh ("if [ -e '$Live' ]; then mv '$Live' '$Old'; fi && mv '$Staging' '$Live' && rm -rf '$Old'")

Write-Host ''
Write-Host "Done. Live folder: $Live" -ForegroundColor Green
Write-Host "    NOTE: a NEW remote folder needs Apache 'AllowOverride FileInfo' (see deploy/*.conf)" -ForegroundColor DarkGray
Write-Host "    before its .htaccess COOP/COEP headers apply. Verify: curl -sI <url> | grep -i cross-origin" -ForegroundColor DarkGray
if ($DryRun) { Write-Host '    (dry run — nothing changed)' -ForegroundColor Yellow }
