function Get-ReaderTools {
    $version = 'v5.0.1'
    $arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
        'X64' { 'win64' }
        'X86' { 'win32' }
        'Arm64' { 'winarm64' }
        default { throw '当前 Windows 架构没有对应的投屏组件。' }
    }
    $asset = "scrcpy-$arch-$version"
    $directory = Join-Path $env:LOCALAPPDATA "CodexMobileRemote\PhoneReader\$asset"
    [pscustomobject]@{
        Scrcpy = Join-Path $directory 'scrcpy.exe'
        Adb = Join-Path $directory 'adb.exe'
        Directory = $directory
        Asset = $asset
        Version = $version
    }
}

function Get-ReaderDevices([string]$Output) {
    foreach ($line in ($Output -split '\r?\n')) {
        if ($line -notmatch '^([A-Za-z0-9._:\[\]%-]+)\s+(device|unauthorized|offline)(?:\s+(.*))?$') { continue }
        $serial = $Matches[1]
        $state = $Matches[2]
        $details = $Matches[3]
        $model = if ($details -match '(?:^|\s)model:([^\s]+)') { $Matches[1].Replace('_', ' ') } else { '' }
        $mode = if ($serial -match '^emulator-') { '模拟器' }
        elseif ($serial -match ':|\._adb-tls-connect\._tcp') { 'Wi-Fi' }
        else { 'USB' }
        $label = if ($model) { "$model · $mode" } else { "$serial · $mode" }
        [pscustomobject]@{ Serial = $serial; State = $state; Mode = $mode; Label = $label }
    }
}

function Get-ReaderLanEndpoint([string]$Value) {
    if ($Value.Trim() -notmatch '^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$') {
        throw '请输入手机显示的局域网 IPv4 地址和端口，例如 192.168.1.20:37123。'
    }
    $ip = $Matches[1]
    $port = [int]$Matches[2]
    $bytes = @($ip.Split('.') | ForEach-Object { [int]$_ })
    $private = $bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or ($bytes[0] -eq 169 -and $bytes[1] -eq 254)
    if (!$private -or @($bytes | Where-Object { $_ -gt 255 }).Count -gt 0 -or $port -lt 1 -or $port -gt 65535) {
        throw '请填写手机无线调试页面上显示的局域网地址和有效端口。'
    }
    return ($bytes -join '.') + ':' + $port
}

function Get-ReaderArguments([string]$Serial, [bool]$Topmost, [bool]$ScreenOff) {
    if ($Serial -notmatch '^[A-Za-z0-9._:\[\]%-]+$') { throw '请选择一个有效的手机。' }
    @(
        "--serial=$Serial"
        '--window-title=Codex Remote - Phone Reader'
        '--window-width=360'
        '--max-size=1600'
        '--max-fps=24'
        '--video-bit-rate=4M'
        '--no-audio'
        '--no-clipboard-autosync'
        '--keep-active'
        '--shortcut-mod=lalt'
        if ($Topmost) { '--always-on-top' }
        if ($ScreenOff) { '--turn-screen-off' }
    )
}

function Start-ReaderChild([string]$File, [string[]]$Arguments, [string]$InputText = '', [string]$Adb = '') {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $File
    $start.WorkingDirectory = Split-Path -Parent $File
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.Arguments = ($Arguments | ForEach-Object {
        if ($_ -match '\s|"|^$') { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
        else { $_ }
    }) -join ' '
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardInput = $InputText.Length -gt 0
    if ($Adb) { $start.EnvironmentVariables['ADB'] = $Adb }
    $process = [System.Diagnostics.Process]::Start($start)
    if (!$process) { throw '无法启动阅读窗组件。' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if ($start.RedirectStandardInput) {
        try { $process.StandardInput.WriteLine($InputText) } finally { $process.StandardInput.Close() }
    }
    [pscustomobject]@{ Process = $process; Stdout = $stdout; Stderr = $stderr }
}

function Receive-ReaderChild($Child) {
    try {
        [pscustomobject]@{
            ExitCode = $Child.Process.ExitCode
            Stdout = $Child.Stdout.GetAwaiter().GetResult()
            Stderr = $Child.Stderr.GetAwaiter().GetResult()
        }
    } finally { $Child.Process.Dispose() }
}
