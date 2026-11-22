param([switch]$Background, [switch]$EnableAutostart, [switch]$DisableAutostart, [switch]$Vpn, [switch]$Tunnel)
$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'CodexMobileRemote'
New-Item -ItemType Directory -Force $stateDir | Out-Null
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Mobile Host.lnk'
if ($EnableAutostart) {
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
    $link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $link.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Background'
    $link.WorkingDirectory = $PSScriptRoot
    $link.Save()
    Write-Host 'Enabled. Keep this folder in its current location.'
    return
}
if ($DisableAutostart) {
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
    return
}
$runtime = Get-AppxPackage 'OpenAI.CodexPrimaryRuntime*' | Sort-Object Version -Descending | Select-Object -First 1
$nodePath = if ($runtime) { Join-Path $runtime.InstallLocation 'dependencies\node\bin\node.exe' }
if (!$nodePath -or !(Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe).Source }
$env:CODEX_BIN = (Get-Command codex.exe -ErrorAction SilentlyContinue).Source
if (!$env:CODEX_BIN) { $env:CODEX_BIN = "$env:LOCALAPPDATA\Programs\OpenAI\Codex\bin\codex.exe" }
if (!(Test-Path -LiteralPath $env:CODEX_BIN)) { throw 'Install or open Codex Desktop first.' }
$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
$env:CMR_PYTHON = Join-Path $PSScriptRoot 'python\python.exe'
if (!(Test-Path -LiteralPath $env:CMR_PYTHON)) { $env:CMR_PYTHON = (Get-Command python.exe).Source }
$env:CMR_STATE_DIRECTORY = $stateDir
if (!$env:CMR_PHONE_DROP_DIR) {
    $desktopDirectory = [Environment]::GetFolderPath('DesktopDirectory')
    if ($desktopDirectory) { $env:CMR_PHONE_DROP_DIR = Join-Path $desktopDirectory 'PhoneDrop' }
}
$env:CMR_DESKTOP_ONLY = '1'
$env:CMR_PORT = '8787'
$env:CMR_SERVER_ID = $env:COMPUTERNAME + '-codex-desktop'
$tokenPath = Join-Path $stateDir 'pairing.dpapi'
$entry = Join-Path $PSScriptRoot 'apps\server\dist\index.js'
if (!(Test-Path -LiteralPath $entry)) { throw 'Extract the entire Windows ZIP before starting.' }
$lock = New-Object Threading.Mutex($false, 'Local\CodexMobileRemoteHost')
$ownsLock = $false
try {
    try { $ownsLock = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsLock = $true }
    if (!(Test-Path -LiteralPath $tokenPath)) {
        if (!$ownsLock) { throw 'The host is starting. Open this file again in a moment.' }
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $secret = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
        ConvertFrom-SecureString $secret | Set-Content -LiteralPath $tokenPath
    }
    $secure = Get-Content -LiteralPath $tokenPath | ConvertTo-SecureString
    $env:CMR_TOKEN = [Net.NetworkCredential]::new('', $secure).Password
    $savedIP = Join-Path $stateDir 'vpn-address.txt'
    $activeIP = Join-Path $stateDir 'active-address.txt'
    if (!$ownsLock) {
        if (Test-Path $activeIP) { Write-Host "Running address http://$(Get-Content -LiteralPath $activeIP -TotalCount 1):8787" }
        if (!$Background) { Write-Host "Pairing token  $($env:CMR_TOKEN)" }
        Write-Host 'Close the running host before changing network modes.'
        return
    }
    $vpnAddress = ''
    if ($Tunnel) {
        $vpnAddress = '127.0.0.1'
        Set-Content -LiteralPath $savedIP -Value $vpnAddress
    } elseif ($Vpn) {
        $ips = @(Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred | Where-Object {
            $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)'
        })
        $ips | Select-Object InterfaceAlias,IPAddress | Format-Table | Out-Host
        $vpnAddress = (Read-Host 'Enter the virtual IP shown for this PC in your VPN client').Trim()
        if ($vpnAddress -notin $ips.IPAddress) { throw 'Connect the VPN first and enter its assigned private IPv4 address.' }
        Set-Content -LiteralPath $savedIP -Value $vpnAddress
    } elseif ($Background -and (Test-Path $savedIP)) {
        $vpnAddress = Get-Content -LiteralPath $savedIP -TotalCount 1
    } elseif (Test-Path $savedIP) { Remove-Item -LiteralPath $savedIP }
    $shown = ''
    do {
        $lanIP = Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.NetAdapter.HardwareInterface -and $_.IPv4DefaultGateway } |
            ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } | Select-Object -First 1
        $env:CMR_HOST = if ($lanIP) { $lanIP } else { '127.0.0.1' }
        if ($vpnAddress) {
            if (!(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $vpnAddress -AddressState Preferred -ErrorAction SilentlyContinue)) {
                if (!$Background) { throw 'VPN address is offline.' }
                Start-Sleep -Seconds 5
                continue
            }
            $env:CMR_HOST = $vpnAddress
        }
        Set-Content -LiteralPath $activeIP -Value $env:CMR_HOST
        if (!$Background -and $shown -ne $env:CMR_HOST) {
            if ($Tunnel) { Write-Host 'Tunnel origin  http://127.0.0.1:8787 (on this PC). Use the public HTTPS address in the phone app.' }
            else { Write-Host "App address    http://$($env:CMR_HOST):8787" }
            Write-Host "Pairing token  $($env:CMR_TOKEN)"
            if (!$lanIP -and !$vpnAddress) { Write-Host 'Connect the computer to a private LAN to pair over Wi-Fi.' }
            $shown = $env:CMR_HOST
        }
        if ($Background -and !$lanIP -and !$vpnAddress) { Start-Sleep -Seconds 5; continue }
        & $nodePath $entry
        if (!$Background) { break }
        Start-Sleep -Seconds 5
    } while ($Background)
} finally {
    if ($ownsLock) { $lock.ReleaseMutex() }
    $lock.Dispose()
    Remove-Item Env:\CMR_TOKEN -ErrorAction SilentlyContinue
}
