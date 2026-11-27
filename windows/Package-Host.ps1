param([Parameter(Mandatory=$true)][string]$PythonDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $root 'dist\Windows-1.0.1'
$target = Join-Path $stage 'apps\server'
$modules = Join-Path $stage 'node_modules'
$protocol = Join-Path $modules '@codex-mobile\protocol'
foreach ($dir in @($stage, $target, $modules, $protocol)) { New-Item -Force -ItemType Directory $dir | Out-Null }
foreach ($name in @('Start.cmd','Start-VPN.cmd','Start-Tunnel.cmd','Start-CodexMobile.ps1','Enable-Autostart.cmd','Disable-Autostart.cmd',
    'Set-DesktopLifecycle.ps1','Watch-CodexDesktop.ps1','Update-Companion.ps1',
    'Phone-Reading-Window.cmd','Phone-Reading-Window.ps1','PhoneReader.Core.ps1','PhoneReader.xaml','Enable-Trusted-LAN.cmd')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $stage -Force
}
$launcherBuild = Join-Path $stage ("watch-build-$PID.exe")
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'DesktopWatchLauncher.cs') -OutputAssembly $launcherBuild -OutputType WindowsApplication
    Move-Item -LiteralPath $launcherBuild -Destination (Join-Path $stage 'CodexRemoteWatch.exe') -Force
} finally {
    if (Test-Path -LiteralPath $launcherBuild) { Remove-Item -LiteralPath $launcherBuild }
}
Copy-Item "$root\apps\server\dist" -Destination $target -Recurse -Force
Copy-Item "$root\apps\server\windows" -Destination $target -Recurse -Force -Exclude '*.pyc','__pycache__'
Copy-Item "$root\apps\server\package.json" -Destination $target -Force
Copy-Item "$root\node_modules\ws" -Destination $modules -Force -Recurse
Copy-Item "$root\packages\protocol\dist","$root\packages\protocol\package.json" -Destination $protocol -Recurse -Force
Copy-Item "$root\LICENSE" -Destination $stage -Force
New-Item -ItemType Directory -Force "$stage\python" | Out-Null
Copy-Item "$PythonDirectory\*" -Destination "$stage\python" -Recurse -Force
Compress-Archive -Path "$stage\*" -DestinationPath "$root\dist\Codex-Remote-Windows-1.0.1.zip" -Force
