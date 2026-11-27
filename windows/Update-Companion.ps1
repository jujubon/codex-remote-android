$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'CodexMobileRemote'
$root = Join-Path $stateDir 'DesktopLifecycle'
$configPath = Join-Path $root 'settings.json'
$updatePath = Join-Path $root 'update.json'
$versions = Join-Path $root 'versions'
$repository = 'jujubon/codex-remote-android'
$stageDir = $null
$archive = Join-Path $root "update-$PID.zip"
$marker = $null

function Read-Json([string]$Path) {
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Save-Json([string]$Path, $Value) {
    $temp = "$Path.$PID.tmp"
    $backup = "$Path.$PID.bak"
    try {
        $Value | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $temp -Encoding UTF8
        [IO.File]::Replace($temp, $Path, $backup)
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup }
    }
}

function Restore-Companion($Update) {
    if (!$Update.nextCompanion -or !$Update.previousCompanion) { return }
    $config = Read-Json $configPath
    if ($config.companion -eq $Update.nextCompanion) {
        $config.companion = $Update.previousCompanion
        Save-Json $configPath $config
    }
}

function Read-Health([string]$Address) {
    $request = [Net.HttpWebRequest]::Create("http://${Address}:8787/health")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 1800
    $request.ReadWriteTimeout = 1800
    $response = $null
    try {
        try { $response = $request.GetResponse() } catch [Net.WebException] {
            $response = $_.Exception.Response
            if (!$response -or [int]$response.StatusCode -ne 503) { return }
        }
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } finally {
        if ($response) { $response.Dispose() }
    }
}

$mutex = [Threading.Mutex]::new($false, 'Local\CodexRemoteCompanionUpdate')
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (!$owned) { return }
    $marker = Read-Json $updatePath
    if ($marker.stage -notin @('pending', 'downloading', 'switching')) { return }
    if ($marker.version -cnotmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') { throw 'Invalid version.' }
    if ($marker.stage -ne 'switching') {
        $marker.stage = 'downloading'
        Save-Json $updatePath $marker
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $api = "https://api.github.com/repos/$repository/releases/latest"
        $release = Invoke-RestMethod -Uri $api -MaximumRedirection 0 -TimeoutSec 20 -UserAgent 'Codex-Remote-Updater'
        $tag = "v$($marker.version)"
        if ($release.tag_name -cne $tag -or $release.draft -or $release.prerelease) { throw 'Requested version is not the latest release.' }
        $name = "Codex-Remote-Windows-$($marker.version).zip"
        $assets = @($release.assets | Where-Object { $_.name -ceq $name -and $_.state -eq 'uploaded' })
        if ($assets.Count -ne 1 -or $assets[0].digest -notmatch '^sha256:[0-9a-f]{64}$' -or
            $assets[0].size -le 0 -or $assets[0].size -gt 150MB) { throw 'Update asset metadata is invalid.' }
        $asset = $assets[0]
        $url = "https://github.com/$repository/releases/download/$tag/$name"
        Invoke-WebRequest -Uri $url -UseBasicParsing -MaximumRedirection 3 -TimeoutSec 180 -OutFile $archive
        if ((Get-Item -LiteralPath $archive).Length -ne $asset.size -or
            (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $asset.digest.Substring(7)) {
            throw 'The release checksum did not match.'
        }
        $stageDir = Join-Path $versions ("Windows-$($marker.version)-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
        Expand-Archive -LiteralPath $archive -DestinationPath $stageDir
        foreach ($file in @('Start-CodexMobile.ps1', 'Update-Companion.ps1', 'apps\server\dist\index.js', 'apps\server\dist\config.js', 'python\python.exe')) {
            if (!(Test-Path -LiteralPath (Join-Path $stageDir $file) -PathType Leaf)) { throw "Missing $file." }
        }
        $versionFile = Join-Path $stageDir 'apps\server\dist\config.js'
        if (!(Select-String -LiteralPath $versionFile -SimpleMatch "HOST_VERSION = `"$($marker.version)`"" -Quiet)) {
            throw 'The package version does not match.'
        }
        $config = Read-Json $configPath
        if (!$config.enabled -or $config.companion -ne (Join-Path $PSScriptRoot 'Start-CodexMobile.ps1')) {
            throw 'The Windows lifecycle settings changed during download.'
        }
        $marker | Add-Member -NotePropertyName previousCompanion -NotePropertyValue $config.companion -Force
        $marker | Add-Member -NotePropertyName nextCompanion -NotePropertyValue (Join-Path $stageDir 'Start-CodexMobile.ps1') -Force
        $marker.stage = 'switching'
        Save-Json $updatePath $marker
    }

    $config = Read-Json $configPath
    if (!$config.enabled -or $config.companion -notin @($marker.previousCompanion, $marker.nextCompanion)) {
        throw 'The Windows lifecycle settings changed before activation.'
    }
    if ($config.companion -ne $marker.nextCompanion) {
        if (!(Test-Path -LiteralPath $marker.nextCompanion -PathType Leaf)) { throw 'The staged companion is missing.' }
        $config.companion = $marker.nextCompanion
        Save-Json $configPath $config
    }
    $deadline = [datetime]::UtcNow.AddSeconds(50)
    do {
        Start-Sleep -Seconds 2
        $addresses = @('127.0.0.1')
        $activeAddress = Join-Path $stateDir 'active-address.txt'
        if (Test-Path -LiteralPath $activeAddress) {
            $ip = ([string](Get-Content -LiteralPath $activeAddress -TotalCount 1)).Trim()
            if ($ip -match '^(?:\d{1,3}\.){3}\d{1,3}$') { $addresses += $ip }
        }
        foreach ($address in ($addresses | Select-Object -Unique)) {
            $health = Read-Health $address
            if ($health.service -eq 'codex-mobile-remote' -and $health.version -ceq $marker.version) {
                Save-Json $updatePath @{ version = $marker.version; stage = 'completed' }
                return
            }
        }
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'The updated companion did not respond.'
} catch {
    if ($marker -and $marker.stage -in @('pending', 'downloading', 'switching')) {
        $failure = $_.Exception.Message
        Restore-Companion $marker
        Save-Json $updatePath @{ version = $marker.version; stage = 'failed' }
        Add-Content -LiteralPath (Join-Path $root 'watch.log') -Value "$(Get-Date -Format o) Companion update failed. $failure"
    } else { throw }
} finally {
    try {
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
    } finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
