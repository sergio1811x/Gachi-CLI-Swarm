# Dev supervisor: restarts `pnpm dev:runtime` when the daemon process dies.
#
# Long-lived daemon sessions occasionally die silently on Windows (native
# node-pty/ConPTY crash, OOM) — no uncaughtException fires, the process is
# just gone, and the workspace sits headless until a human notices. This loop
# brings it back on a 5s/15s/30s/60s backoff ladder and tees every session's
# output to .gachi/daemon-logs/daemon_<stamp>.log so post-mortems survive the
# crash. A session that stayed up for 10+ minutes resets the ladder.
#
# Usage:  pwsh -File scripts\dev-supervised.ps1
# Stop:   Ctrl+C (kills the daemon child too, since it runs in the foreground).

$ErrorActionPreference = 'Continue'

$logDir = Join-Path (Join-Path $PSScriptRoot '..') '.gachi\daemon-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$delays = @(5, 15, 30, 60)
$failures = 0

while ($true) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $log = Join-Path $logDir "daemon_$stamp.log"
    Write-Host "[supervisor] $(Get-Date -Format 'HH:mm:ss') starting daemon (log: $log)"

    $startedAt = Get-Date
    & pnpm dev:runtime 2>&1 | ForEach-Object { "$_" | Tee-Object -FilePath $log -Append }
    $uptimeSeconds = ((Get-Date) - $startedAt).TotalSeconds

    if ($uptimeSeconds -ge 600) {
        $failures = 0
    }
    else {
        $failures++
    }

    $delay = $delays[[Math]::Min($failures, $delays.Count - 1)]
    Write-Host (
        "[supervisor] {0} daemon exited after {1:n0}s, restarting in {2}s" -f
        (Get-Date -Format 'HH:mm:ss'), $uptimeSeconds, $delay
    )
    Start-Sleep -Seconds $delay
}
