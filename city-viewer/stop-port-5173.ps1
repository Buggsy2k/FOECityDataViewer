param(
    [int]$Port = 5173,
    [switch]$Force
)

$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

if (-not $connections) {
    Write-Host "No listening process found on port $Port."
    exit 0
}

$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique

foreach ($pid in $pids) {
    try {
        $process = Get-Process -Id $pid -ErrorAction Stop
        if ($Force) {
            Stop-Process -Id $pid -Force -ErrorAction Stop
            Write-Host "Stopped process $($process.ProcessName) (PID $pid) on port $Port with -Force."
        }
        else {
            Stop-Process -Id $pid -ErrorAction Stop
            Write-Host "Stopped process $($process.ProcessName) (PID $pid) on port $Port."
        }
    }
    catch {
        Write-Error "Failed to stop PID $pid on port $Port. $($_.Exception.Message)"
        exit 1
    }
}

exit 0
