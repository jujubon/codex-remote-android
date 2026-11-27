param([switch]$Disable)
$ErrorActionPreference = 'Stop'

$state = Join-Path $env:LOCALAPPDATA 'CodexMobileRemote\DesktopLifecycle'
$configPath = Join-Path $state 'settings.json'
$watchPath = Join-Path $state 'Watch-CodexDesktop.ps1'
$taskName = 'Codex Remote Desktop Watch'
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Mobile Host.lnk'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

function Save-Settings($Config) {
    $temporary = Join-Path $state ("settings.$PID.tmp")
    $backup = Join-Path $state ("settings.$PID.bak")
    try {
        $Config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporary -Encoding UTF8
        if (Test-Path -LiteralPath $configPath) {
            [IO.File]::Replace($temporary, $configPath, $backup)
        } else {
            [IO.File]::Move($temporary, $configPath)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup }
    }
}

function Move-LegacyShortcut {
    if (Test-Path -LiteralPath $shortcut) {
        $backup = Join-Path $state ('legacy-startup-' + [guid]::NewGuid().ToString('N') + '.lnk')
        Move-Item -LiteralPath $shortcut -Destination $backup
    }
}

New-Item -ItemType Directory -Path $state -Force | Out-Null
$config = if (Test-Path -LiteralPath $configPath) {
    Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    [pscustomobject]@{}
}
if ($Disable) {
    $config | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
    Save-Settings $config
    if ($task) { Disable-ScheduledTask -TaskName $taskName | Out-Null }
    Move-LegacyShortcut
    Write-Host 'Automatic start with Codex Desktop is disabled.'
    return
}

$entry = Join-Path $PSScriptRoot 'apps\server\dist\index.js'
if (!(Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Extract the entire Windows ZIP before enabling automatic start.' }
if (!(Get-AppxPackage 'OpenAI.Codex')) { throw 'Install Codex Desktop before enabling automatic start.' }
$sourceLauncher = Join-Path $PSScriptRoot 'CodexRemoteWatch.exe'
if (!(Test-Path -LiteralPath $sourceLauncher -PathType Leaf)) { throw 'The Windows package is missing CodexRemoteWatch.exe.' }
$launcherHash = (Get-FileHash -LiteralPath $sourceLauncher -Algorithm SHA256).Hash
$launcher = Join-Path $state "CodexRemoteWatch-$($launcherHash.Substring(0, 16)).exe"
if (!(Test-Path -LiteralPath $launcher)) { Copy-Item -LiteralPath $sourceLauncher -Destination $launcher }
if ((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -ne $launcherHash) { throw 'The installed watcher launcher differs from the Windows package.' }

$sourceWatch = Join-Path $PSScriptRoot 'Watch-CodexDesktop.ps1'
$scriptChanged = !(Test-Path -LiteralPath $watchPath) -or
    (Get-FileHash -LiteralPath $sourceWatch).Hash -ne (Get-FileHash -LiteralPath $watchPath).Hash
$action = New-ScheduledTaskAction -Execute $launcher
$description = 'Starts Codex Remote in the background at Windows sign-in.'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (!$task) {
    if ($scriptChanged) { Copy-Item -LiteralPath $sourceWatch -Destination $watchPath -Force }
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userSid
    $principal = New-ScheduledTaskPrincipal -UserId $userSid -LogonType Interactive -RunLevel Limited
    $options = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $options -Description $description | Out-Null
} elseif ($scriptChanged -or $task.Description -ne $description -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ne $launcher -or $task.Actions[0].Arguments) {
    $wasRunning = $task.State -eq 'Running'
    try {
        if ($wasRunning) {
            $paused = $config.PSObject.Copy()
            $paused | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
            Save-Settings $paused
            $deadline = [datetime]::UtcNow.AddSeconds(25)
            while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
                if ([datetime]::UtcNow -ge $deadline) { throw 'The existing watcher did not stop gracefully.' }
                Start-Sleep -Milliseconds 300
            }
        }
        $task.Actions = @($action)
        $task.Description = $description
        Set-ScheduledTask -InputObject $task | Out-Null
        if ($scriptChanged) { Copy-Item -LiteralPath $sourceWatch -Destination $watchPath -Force }
    } catch {
        if ($wasRunning) {
            Save-Settings $config
            if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Ready') { Start-ScheduledTask -TaskName $taskName }
        }
        throw
    }
}
$config | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
$config | Add-Member -NotePropertyName companion -NotePropertyValue (Join-Path $PSScriptRoot 'Start-CodexMobile.ps1') -Force
Save-Settings $config
if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Disabled') { Enable-ScheduledTask -TaskName $taskName | Out-Null }
Move-LegacyShortcut
if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') {
    Start-ScheduledTask -TaskName $taskName
}
Write-Host 'Codex Remote will start in the background when you sign in to Windows. Keep this package in its current location.'
