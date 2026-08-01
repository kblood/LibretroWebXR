#requires -Version 5
<#
.SYNOPSIS
  Rebuild the DOS-TOOLS release images from C:\LLM\DOS and publish them to dionysus.dk.

.DESCRIPTION
  C:\LLM\DOS\BuildReleasesVHD.ps1 bundles CC, GWIZ, Q87, ASMQuake, Quake486, DOSXP
  and GoldBox native builds into a mountable DOS tools disk, emitting two forms of
  the same filesystem:

    DOS-TOOLS.img   raw image — DOSBox mounts it with no geometry argument, and it
                    is the form browser/libretro DOS cores want
    DOS-TOOLS.vhd   the same bytes plus a 512-byte fixed-disk footer, for Hyper-V,
                    Windows Mount-DiskImage, and MiSTer ao486

  Neither is a bootable DOS install — they are data/tools disks meant to be
  `imgmount`ed as a second drive (or attached as an extra hard disk on ao486).

  This script rebuilds both and uploads them to the same dionysus.dk box the WebXR
  app deploys to (scripts/deploy.ps1), reusing the same SSH key and connection
  pattern. They are published under $RemoteBase/dos-tools/ — a folder that is a
  *sibling* of the per-app deploy folders (e.g. .../webxr/libretrowebxr2/), not
  nested inside one. That's deliberate: deploy.ps1 does a full atomic folder swap
  on every app deploy (the old live dir is discarded wholesale after the swap), so
  anything placed inside an app folder but outside its dist/ output would get
  silently wiped by the next ordinary `npm run deploy`. A sibling folder under
  webxr/ is untouched by that.

  No elevation is required. BuildReleasesVHD.ps1 writes the image directly via its
  Fat16Vhd.psm1 module (MBR + FAT16 + VHD footer) instead of going through
  New-VHD/Mount-DiskImage/Format-Volume, so a normal shell can produce a release.

  Every upload is verified by comparing a local SHA256 against `sha256sum` on the
  server before the file is moved into place. A 256MB image that arrives subtly
  corrupt is otherwise invisible — it has the right size and downloads fine, and
  only fails later at mount time.

.PARAMETER DosRoot    Path to the C:\LLM\DOS checkout. Default C:\LLM\DOS.
.PARAMETER SkipBuild  Skip the rebuild; publish whatever images already exist.
.PARAMETER DryRun     Print remote actions without touching the server.

.EXAMPLE
  pwsh scripts/publish-dos-tools.ps1              # rebuild + publish
  pwsh scripts/publish-dos-tools.ps1 -SkipBuild   # publish the existing images only
#>
[CmdletBinding()]
param(
  [string]$DosRoot = 'C:\LLM\DOS',
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# --- connection (shared dionysus.dk GCloud box; see scripts/deploy.ps1) ------
$SshKey     = 'C:\Devstuff\GCloud\caldor_nopass'
$RemoteUser = 'kaspersolesen'
$RemoteHost = '35.228.204.127'              # == dionysus.dk
$RemoteBase = '/var/www/html/webxr'
$RemoteDir  = "$RemoteBase/dos-tools"
$Target     = "${RemoteUser}@${RemoteHost}"

if (-not (Test-Path -LiteralPath $DosRoot)) { throw "DOS root not found: $DosRoot" }
$BuildScript = Join-Path $DosRoot 'BuildReleasesVHD.ps1'
if (-not (Test-Path -LiteralPath $BuildScript)) { throw "BuildReleasesVHD.ps1 not found under $DosRoot" }
if (-not (Test-Path -LiteralPath $SshKey)) { throw "SSH key missing: $SshKey" }

$Artifacts = @('DOS-TOOLS.img', 'DOS-TOOLS.vhd')

$SshOpts = @(
  '-i', $SshKey,
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=8',
  '-o', 'ConnectTimeout=20'
)

function Invoke-Ssh([string]$cmd) {
  Write-Host "    ssh> $cmd" -ForegroundColor DarkGray
  if ($DryRun) { return }
  $out = & ssh @SshOpts $Target $cmd
  if ($LASTEXITCODE -ne 0) { throw "ssh failed: $cmd" }
  return $out
}

# Upload to a temp name, verify the bytes landed intact, and only then move it
# into place — a reader never sees a partial or corrupt file at the real URL.
function Publish-Artifact([string]$localPath, [string]$name) {
  $remoteTmp   = "$RemoteDir/.$name.uploading"
  $remoteFinal = "$RemoteDir/$name"

  if ($DryRun) {
    Write-Host "    scp> $localPath -> $remoteTmp" -ForegroundColor DarkGray
    Write-Host "    ssh> (verify sha256) && mv -f '$remoteTmp' '$remoteFinal'" -ForegroundColor DarkGray
    return
  }

  $localHash = (Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash.ToLower()
  $sizeMb    = [math]::Round((Get-Item -LiteralPath $localPath).Length / 1MB, 1)
  Write-Host "    + $name ($sizeMb MB, sha256 $($localHash.Substring(0,12))...)"

  for ($try = 1; $try -le 3; $try++) {
    & scp @SshOpts $localPath "${Target}:${remoteTmp}"
    if ($LASTEXITCODE -ne 0) {
      if ($try -lt 3) { Write-Warning "scp $try/3 failed ($name) - retry in 3s"; Start-Sleep 3; continue }
      throw "scp failed after 3 attempts: $name"
    }

    $remoteHash = (& ssh @SshOpts $Target "sha256sum '$remoteTmp' | cut -d' ' -f1").Trim()
    if ($LASTEXITCODE -ne 0) { throw "could not hash uploaded file: $remoteTmp" }
    if ($remoteHash -eq $localHash) {
      Invoke-Ssh "mv -f '$remoteTmp' '$remoteFinal'" | Out-Null
      Write-Host "      verified" -ForegroundColor Green
      return
    }

    Write-Warning "upload corrupt ($name): remote $($remoteHash.Substring(0,12))... != local $($localHash.Substring(0,12))..."
    if ($try -lt 3) { Write-Warning "re-uploading ($try/3)"; Start-Sleep 3 }
  }

  & ssh @SshOpts $Target "rm -f '$remoteTmp'" | Out-Null
  throw "$name failed SHA256 verification after 3 uploads — live file left untouched."
}

# --- 1) rebuild ---------------------------------------------------------------
# The sub-project builds disagree about how they find NASM: cc\package.ps1 and
# DOSXP\build.bat hardcode %LOCALAPPDATA%\bin\NASM\nasm.exe, ASMQuake\build.bat
# honours a NASM env var then falls back to PATH, and Q87\src\build.bat does a
# flat `set NASM=nasm` (so an env var can't reach it — only PATH can). NASM is
# not on this machine's persistent PATH, so an otherwise-fine run dies partway
# through at Q87 with "[FAIL] NASM not found in PATH". Prepending the directory
# satisfies all three conventions at once, for this process only.
if (-not $SkipBuild) {
  $NasmExe = Join-Path $env:LOCALAPPDATA 'bin\NASM\nasm.exe'
  if (Test-Path -LiteralPath $NasmExe) {
    $NasmDir = Split-Path -Parent $NasmExe
    if (($env:PATH -split ';') -notcontains $NasmDir) { $env:PATH = "$NasmDir;$env:PATH" }
    if (-not $env:NASM) { $env:NASM = $NasmExe }
    Write-Host "    nasm: $NasmExe" -ForegroundColor DarkGray
  } elseif (-not (Get-Command nasm -ErrorAction SilentlyContinue)) {
    throw "nasm.exe not found at $NasmExe nor on PATH — the Q87/ASMQuake/DOSXP builds need it."
  }

  Write-Host '=== BuildReleasesVHD.ps1 -Build ===' -ForegroundColor Cyan
  if (-not $DryRun) {
    Push-Location $DosRoot
    try {
      & pwsh -NoProfile -ExecutionPolicy Bypass -File $BuildScript -Build -Format Both
      if ($LASTEXITCODE) { throw 'BuildReleasesVHD.ps1 failed' }
    } finally { Pop-Location }
  }
} else {
  Write-Host '=== -SkipBuild: publishing existing images as-is ===' -ForegroundColor Cyan
}

$local = @{}
foreach ($name in $Artifacts) {
  $path = Join-Path $DosRoot $name
  if (-not $DryRun) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$name not found: $path (run without -SkipBuild first)" }
    if ((Get-Item -LiteralPath $path).Length -eq 0) { throw "$name is empty: $path" }
  }
  $local[$name] = $path
}

# --- 2) publish ---------------------------------------------------------------
Write-Host "=== publish -> ${Target}:$RemoteDir ===" -ForegroundColor Cyan
Invoke-Ssh "mkdir -p '$RemoteDir'" | Out-Null
foreach ($name in $Artifacts) { Publish-Artifact $local[$name] $name }

Write-Host ''
Write-Host 'Done. Live:' -ForegroundColor Green
foreach ($name in $Artifacts) { Write-Host "  https://dionysus.dk/webxr/dos-tools/$name" -ForegroundColor Green }
if ($DryRun) { Write-Host '    (dry run - nothing changed)' -ForegroundColor Yellow }
