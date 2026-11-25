$ErrorActionPreference = 'Stop'
$session = (Get-Process -Id $PID).SessionId
$root = $PSScriptRoot
$configPath = Join-Path $root 'settings.json'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$desktopPath = '^' + [regex]::Escape((Join-Path $env:ProgramFiles 'WindowsApps\OpenAI.Codex_')) +
    '[0-9.]+_(?:x64|arm64|x86)__2p2nqsd0c76g0\\app\\(?:ChatGPT|Codex)\.exe$'

function Write-WatchLog([string]$Message) {
    $file = Join-Path $root 'watch.log'
    if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 128KB) {
        Move-Item -LiteralPath $file -Destination (Join-Path $root 'watch.previous.log') -Force
    }
    Add-Content -LiteralPath $file -Encoding UTF8 -Value "$(Get-Date -Format o) $Message"
}

function Stop-Child($Child) {
    if ($null -eq $Child) { return }
    try {
        if (!$Child.HasExited) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $Child.Id /T /F 2>$null | Out-Null
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
$hostKey = $tunnelKey = ''
$desktopOpen = $false
$hostRetry = $tunnelRetry = [datetime]::MinValue
try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (!$owned) { return }
    Write-WatchLog 'Waiting for Codex Desktop.'
    while ($true) {
        try {
            $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($config.enabled -eq $false) { break }
            $desktops = @(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object {
                $_.SessionId -eq $session -and $_.Path -match $desktopPath
            })
            if (!$desktopOpen -and @($desktops | Where-Object MainWindowHandle -NE 0).Count -gt 0) {
                $desktopOpen = $true
                Write-WatchLog 'Codex Desktop opened.'
            }
            if ($desktopOpen -and $desktops.Count -eq 0) {
                $desktopOpen = $false
                Write-WatchLog 'Codex Desktop exited.'
            }

            $launchTunnel = $desktopOpen -and $config.tunnelExe -and $config.tokenFile -and $config.protocol -in @('http2', 'quic', 'auto')
            $nextTunnelKey = if ($launchTunnel) { "$($config.tunnelExe)|$($config.tokenFile)|$($config.protocol)" } else { '' }
            $nextHostKey = if ($desktopOpen) { "$($config.companion)|$launchTunnel" } else { '' }
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
                $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $config.companion + '" -Background'
                if ($launchTunnel) { $arguments += ' -Tunnel' }
                $hostChild = Start-Process -FilePath $psExe -ArgumentList $arguments -WindowStyle Hidden -PassThru
                Write-WatchLog "Companion launched ($($hostChild.Id))."
            }
            if ($tunnelKey -and $hostChild -and (!$tunnelChild -or $tunnelChild.HasExited) -and $now -ge $tunnelRetry) {
                $tunnelRetry = $now.AddSeconds(10)
                if ($tunnelChild) { $tunnelChild.Dispose(); $tunnelChild = $null }
                $arguments = 'tunnel --no-autoupdate --protocol ' + $config.protocol + ' --logfile "' +
                    (Join-Path $root 'tunnel.log') + '" run --token-file "' + $config.tokenFile + '"'
                $tunnelChild = Start-Process -FilePath $config.tunnelExe -ArgumentList $arguments -WindowStyle Hidden -PassThru
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
            try { Stop-Child $tunnelChild } finally { Stop-Child $hostChild }
            Write-WatchLog 'Companion and tunnel stopped.'
        }
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
