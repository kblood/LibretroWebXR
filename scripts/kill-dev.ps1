param(
    # Dev servers this project starts: vite (5173/5174), room-server (8787),
    # log-server (8788), plus the smoke/test ports the suites bind.
    [int[]]$Ports = @(5173, 5174, 8787, 8788, 8799, 8801, 8803)
)

# Stop ONLY this project's dev servers, by listening port - never by image name.
#
# DO NOT use `taskkill /F /IM node.exe` (or `Stop-Process -Name node`) to free these
# ports. This box runs many node processes - the AI Control Center server, its agent
# CLIs, MCP servers, loggers. A blanket node kill takes the whole fleet down with it
# (it already did once). Killing by port touches only the process you actually started.

$killed = @()
foreach ($port in $Ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $procId = $c.OwningProcess
        if ($procId -and $procId -ne 0 -and ($killed -notcontains $procId)) {
            try {
                $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
                Stop-Process -Id $procId -Force -ErrorAction Stop
                $killed += $procId
                Write-Host "killed PID $procId ($name) on :$port"
            } catch {
                Write-Host "could not kill PID $procId on :$port - $($_.Exception.Message)"
            }
        }
    }
}
if (-not $killed) { Write-Host "no dev servers listening on $($Ports -join ', ')" }
