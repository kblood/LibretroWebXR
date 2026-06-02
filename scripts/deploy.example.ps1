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
.PARAMETER SkipCores / SkipBuild / DryRun   As named.

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
