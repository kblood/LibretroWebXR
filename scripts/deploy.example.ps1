<#
.SYNOPSIS
  EXAMPLE deploy script — build LibretroWebXR and publish dist/ to a static host.

.DESCRIPTION
  Template only. Copy to `scripts/deploy.ps1` (gitignored) and fill in your own
  connection details, OR set the DEPLOY_* env vars below and run this as-is.
  Contains NO real hosts, users, or key paths — never commit those.

  Flow: npm run fetch-cores → npm run build → check-dist (publishing gate) →
  per-item scp of dist/ into a staging dir on the remote → atomic `mv` staging→live
  (keeps a `.old` until success). The gate is mandatory: `node scripts/check-dist.mjs`
  exits nonzero on anything unpublishable or oversized in dist/ (*.bak, credentials,
  node_modules, scratch output, non-allowlisted paths/types) and this script throws
  before the first scp. It REPORTS rather than refuses public/roms/local/, the
  private sideload, which ships on purpose — see that file's header; `--strict`
  turns it into a refusal for a genuinely public release.
  roms/freeware/ is not blanket-allowed either: a ROM there must be an allowlisted
  title (FREEWARE_ALLOW in check-dist.mjs, or referenced from a tracked
  public/roms/*.json) and under the per-ROM size ceiling. The same check also runs
  inside the vite build (on the RESOLVED build.outDir, so `--outDir` is covered)
  and as npm `postbuild`; the three are independent on purpose.
  public/.htaccess is uploaded explicitly because `scp dist/*` skips the dotfile,
  and its COOP/COEP headers are what make crossOriginIsolated (→ SharedArrayBuffer
  → the threaded libretro cores) work.

  NOTE ON REMOVAL: only the FULL path (staging dir + atomic swap) can take
  already-published content OFF the server. -AppOnly is additive and cannot.
  See .PARAMETER AppOnly.

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
  everything vite copied out of public/, which for this project means cores/ (~122 MB)
  and the free ROM set: minutes of scp for a 1 MB code change. -AppOnly is
  seconds. It is a SPEED optimisation, never a safety control — check-dist.mjs runs
  on every path, including this one, but a green check only ever describes the NEW
  upload. It refuses to run if the live folder doesn't exist yet (it would produce a
  deployment with no cores), and it's safe despite not being atomic because vite
  content-hashes assets/ — new bundles land under new names and the .html files that
  reference them go last.

  ####################################################################
  #  -AppOnly CANNOT UN-PUBLISH ANYTHING. IT IS ADDITIVE, ONLY.      #
  #                                                                  #
  #  It skips roms/ and cores/ and never deletes a remote file. If   #
  #  something private is ALREADY on the server, -AppOnly will not   #
  #  remove it however thoroughly you fixed the build first: a green #
  #  check-dist here only proves the NEW upload is clean.            #
  #                                                                  #
  #  TO TAKE PUBLISHED CONTENT DOWN, either run a FULL deploy (this  #
  #  script without -AppOnly: it uploads to a staging dir and `mv`s  #
  #  it over the live folder, so anything absent from dist/ is gone) #
  #  or delete the path by hand over ssh. Then confirm with a real   #
  #  request — a 404 is the proof, not a successful deploy.          #
  ####################################################################

.EXAMPLE
  $env:DEPLOY_HOST='example.com'; $env:DEPLOY_USER='me'
  $env:DEPLOY_KEY="$HOME\.ssh\id_ed25519"; $env:DEPLOY_REMOTE_BASE='/var/www/html/webxr'
  pwsh scripts/deploy.example.ps1 -Name libretrowebxr
#>

# NOTE: #requires must come AFTER the comment-based help block. With it above,
# PowerShell parses NO comment-based help at all and `Get-Help` on this script
# prints only the syntax line — verified against the pre-change file.
#requires -Version 5
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
  # server/package-lock.json SHIPS TOO, and the remote install is `npm ci`, not
  # `npm install`. This is a real gap that was closed, not a tidy-up: the lockfile
  # stayed on the dev box, so `npm install` resolved `"ws": "^8.21.1"` against the
  # registry AT DEPLOY TIME. CI proves ws 8.21.3; the first deploy after 8.22.x
  # publishes would have put 8.22.x on the server with no gate anywhere — the
  # deployed relay was the one component whose dependency set was never the tested
  # one, and `npm run test:servers` (which gates the admission limits and the
  # SIGNAL 'bye' round trip) never saw that build.
  $files = @(
    @{ src = 'server\Hub.js';            dst = "$RoomBase/server/" },
    @{ src = 'server\room-server.mjs';   dst = "$RoomBase/server/" },
    @{ src = 'server\log-server.mjs';    dst = "$RoomBase/server/" },
    @{ src = 'server\package.json';      dst = "$RoomBase/server/" },
    @{ src = 'server\package-lock.json'; dst = "$RoomBase/server/" },
    @{ src = 'src\net\NetProtocol.js';   dst = "$RoomBase/src/net/" }
  )
  foreach ($f in $files) { if (-not (Test-Path (Join-Path $RepoRoot $f.src))) { throw "missing $($f.src)" } }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Invoke-Ssh "sudo cp -a '$RoomBase' '$RoomBase.bak-$stamp' && echo 'backup: $RoomBase.bak-$stamp'"
  foreach ($f in $files) { Write-Host "    + $($f.src)"; Invoke-Scp (Join-Path $RepoRoot $f.src) $f.dst }
  # `npm ci` deletes and recreates node_modules and HARD-FAILS if package.json and
  # package-lock.json disagree. That is the intended new failure: a room deploy
  # now aborts rather than silently installing a dependency set nothing tested.
  # Run the first deploy after this change with -DryRun, then verify on the box:
  #   node -e "console.log(require('ws/package.json').version)"
  # must print exactly the version in server/package-lock.json.
  Invoke-Ssh "cd '$RoomBase/server' && npm ci --omit=dev --no-audit --no-fund >/dev/null && echo 'deps ok (npm ci, locked)'"
  Invoke-Ssh "sudo systemctl restart $Unit"
  Start-Sleep 3
  Invoke-Ssh "systemctl is-active $Unit"
  Invoke-Ssh "journalctl -u $Unit -n 8 --no-pager | tail -8"
  Write-Host ''
  Write-Host "Done (room server). Roll back: sudo cp -a $RoomBase.bak-$stamp/. $RoomBase/ && sudo systemctl restart $Unit" -ForegroundColor Green
  if ($DryRun) { Write-Host '    (dry run — nothing changed)' -ForegroundColor Yellow }
  return
}

# --- publishing gate (runs before ANY dist/ upload) --------------------------
# vite copies the WHOLE of public/ into dist/ and .gitignore has no say in a
# build, so whatever sits under public/ ends up staged for public upload by the
# loops below. This is the independent check on what that actually is: backups,
# credentials, VCS/dependency dirs, scratch output, unlisted ROMs under
# roms/freeware/ and anything over the size budgets are refused. public/roms/local/
# is REPORTED, not refused — it ships deliberately (see check-dist.mjs's header).
# Runs for -AppOnly too (that path uploads dist/ items as well) and in -DryRun
# (local + read-only). Placed after the -Room early return: the room server is
# not a dist/ asset.
$Guard = Join-Path $PSScriptRoot 'check-dist.mjs'
if (-not (Test-Path $Guard)) { throw "missing scripts/check-dist.mjs - refusing to upload an unchecked dist/" }
Write-Host '=== check-dist (publishing gate) ===' -ForegroundColor Cyan
node $Guard $Dist
if ($LASTEXITCODE -ne 0) {
  throw "check-dist FAILED (exit $LASTEXITCODE) - ABORTED before uploading anything. See the violations above; rebuild with 'npm run build'. Do NOT delete anything under public/."
}

if ($AppOnly) {
  Write-Host "=== app-only refresh $Name -> ${Target}:$Live ===" -ForegroundColor Cyan
  Write-Host '    -AppOnly is ADDITIVE: it uploads assets/ + .html + .htaccess and deletes NOTHING.' -ForegroundColor Yellow
  Write-Host '    It cannot un-publish roms/ or cores/ content an earlier deploy put on the server.' -ForegroundColor Yellow
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
  Write-Host '    NOTHING WAS REMOVED FROM THE SERVER. -AppOnly is additive and cannot un-publish' -ForegroundColor Yellow
  Write-Host '    what an earlier deploy put there — use a FULL deploy (staging + atomic swap), or' -ForegroundColor Yellow
  Write-Host "      ssh <host> `"rm -rf $Live/<path>`"   # then curl the URL and confirm a 404" -ForegroundColor Yellow
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
