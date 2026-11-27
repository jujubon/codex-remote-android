$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$configPath = Join-Path $root 'settings.json'
$updatePath = Join-Path $root 'update.json'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-WatchLog([string]$Message) {
    $file = Join-Path $root 'watch.log'
    if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 128KB) {
        Move-Item -LiteralPath $file -Destination (Join-Path $root 'watch.previous.log') -Force
    }
    Add-Content -LiteralPath $file -Encoding UTF8 -Value "$(Get-Date -Format o) $Message"
}

function Start-BackgroundProcess([string]$FilePath, [string]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($FilePath, $Arguments)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    return [Diagnostics.Process]::Start($start)
}

function Stop-Child($Child) {
    if ($null -eq $Child) { return }
    try {
        if (!$Child.HasExited) {
            $stop = Start-BackgroundProcess "$env:SystemRoot\System32\taskkill.exe" "/PID $($Child.Id) /T /F"
            try { $stop.WaitForExit() } finally { $stop.Dispose() }
            if (!$Child.WaitForExit(3000)) { throw 'A managed process failed to exit.' }
        }
    } finally {
        if ($Child.HasExited) { $Child.Dispose() }
    }
}

$mutex = [Threading.Mutex]::new($false, 'Local\CodexRemoteDesktopWatch')
$owned = $false
$hostChild = $null
$tunnelChild = $null
$updateChild = $null
$hostKey = $tunnelKey = ''
$hostRetry = $tunnelRetry = [datetime]::MinValue
try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (!$owned) { return }
    Write-WatchLog 'Starting Codex Remote for the Windows session.'
    while ($true) {
        try {
            $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($config.enabled -eq $false) { break }
            $updater = Join-Path (Split-Path -Parent $config.companion) 'Update-Companion.ps1'
            $env:CMR_LIFECYCLE_UPDATES = if (Test-Path -LiteralPath $updater -PathType Leaf) { '1' } else { '0' }
            if ($updateChild -and $updateChild.HasExited) {
                $updateChild.Dispose()
                $updateChild = $null
            }
            if (!$updateChild -and $env:CMR_LIFECYCLE_UPDATES -eq '1' -and (Test-Path -LiteralPath $updatePath)) {
                $update = Get-Content -LiteralPath $updatePath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($update.stage -in @('pending', 'downloading', 'switching')) {
                    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $updater + '"'
                    $updateChild = Start-BackgroundProcess $psExe $arguments
                }
            }
            $launchTunnel = $config.tunnelExe -and $config.tokenFile -and $config.protocol -in @('http2', 'quic', 'auto')
            $nextTunnelKey = if ($launchTunnel) { "$($config.tunnelExe)|$($config.tokenFile)|$($config.protocol)" } else { '' }
            $nextHostKey = "$($config.companion)|$launchTunnel"
            if ($nextTunnelKey -ne $tunnelKey) {
                Stop-Child $tunnelChild
                $tunnelChild = $null
                $tunnelKey = $nextTunnelKey
                $tunnelRetry = [datetime]::MinValue
            }
            if ($nextHostKey -ne $hostKey) {
                Stop-Child $hostChild
                $hostChild = $null
                $hostKey = $nextHostKey
                $hostRetry = [datetime]::MinValue
            }

            $now = [datetime]::UtcNow
            if ($hostKey -and (!$hostChild -or $hostChild.HasExited) -and $now -ge $hostRetry) {
                $hostRetry = $now.AddSeconds(10)
                if ($hostChild) { $hostChild.Dispose(); $hostChild = $null }
                $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $config.companion + '" -Background'
                if ($launchTunnel) { $arguments += ' -Tunnel' }
                $hostChild = Start-BackgroundProcess $psExe $arguments
                Write-WatchLog "Companion launched ($($hostChild.Id))."
            }
            if ($tunnelKey -and $hostChild -and (!$tunnelChild -or $tunnelChild.HasExited) -and $now -ge $tunnelRetry) {
                $tunnelRetry = $now.AddSeconds(10)
                if ($tunnelChild) { $tunnelChild.Dispose(); $tunnelChild = $null }
                $arguments = 'tunnel --no-autoupdate --protocol ' + $config.protocol + ' --logfile "' +
                    (Join-Path $root 'tunnel.log') + '" run --token-file "' + $config.tokenFile + '"'
                $tunnelChild = Start-BackgroundProcess $config.tunnelExe $arguments
                Write-WatchLog "Cloudflare tunnel launched ($($tunnelChild.Id))."
            }
        } catch {
            Write-WatchLog "Lifecycle check or launch failed ($($_.Exception.GetType().Name)); retrying."
        }
        Start-Sleep -Seconds 3
    }
} finally {
    try {
        if ($owned) {
            if ($updateChild) { $updateChild.Dispose() }
            try { Stop-Child $tunnelChild } finally { Stop-Child $hostChild }
            Write-WatchLog 'Companion and tunnel stopped.'
        }
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
