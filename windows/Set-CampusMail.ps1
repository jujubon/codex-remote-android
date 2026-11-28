param(
    [string]$Address,
    [string]$DataDirectory,
    [string]$Model,
    [string[]]$PrioritySenders,
    [switch]$Disconnect
)
$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'CodexMobileRemote'
$path = Join-Path $state 'campus-mail.json'
if ($Disconnect) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
    Write-Host 'School mailbox disconnected. Its cached messages remain in the configured mail data folder.'
    return
}

$current = if (Test-Path -LiteralPath $path -PathType Leaf) { Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json }
if (!$Address) { $Address = if ($current) { $current.address } else { Read-Host 'Full CSU email address' } }
$Address = ([string]$Address).Trim().ToLowerInvariant()
if ($Address -notmatch '^[a-z0-9._+%-]+@(?:[a-z0-9-]+\.)*csu\.edu\.cn$') { throw 'Enter a full CSU email address.' }
if (!$DataDirectory) {
    $lifecycle = Join-Path $state 'DesktopLifecycle\settings.json'
    $settings = if (Test-Path -LiteralPath $lifecycle -PathType Leaf) {
        Get-Content -LiteralPath $lifecycle -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    $DataDirectory = if ($current.dataDir) { $current.dataDir }
        elseif ($settings.updateRoot) { Join-Path $settings.updateRoot 'mail' }
        else { Join-Path $PSScriptRoot 'campus-mail-data' }
}
if ($DataDirectory -notmatch '^[A-Za-z]:\\') { throw 'The mail data directory must be an absolute local path.' }
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
if (!$PSBoundParameters.ContainsKey('Model')) {
    $Model = $current.model
    if (!$current) {
        $installed = try {
            (Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3).models |
                Where-Object { $_.name -match '^[A-Za-z0-9_./:-]{1,100}$' -and $_.name -notmatch 'cloud' -and $_.size -gt 0 -and !$_.remote_host -and !$_.remote_model } |
                ForEach-Object { $_.name }
        } catch {}
        if ($installed) {
            Write-Host "Local summary models: $($installed -join ', ')"
            $Model = Read-Host 'Enter a model name, or press Enter to skip AI summaries'
        }
    }
}
if ($Model -and ($Model -notmatch '^[A-Za-z0-9_./:-]{1,100}$' -or $Model -match 'cloud')) { throw 'Select an installed local Ollama model.' }
if (!$PSBoundParameters.ContainsKey('PrioritySenders')) { $PrioritySenders = @($current.prioritySenders | Where-Object { $_ }) }
if ($PrioritySenders | Where-Object { $_ -notmatch '^[^\s@]+@[^\s@]+$' }) { throw 'Priority senders must be full email addresses.' }

Add-Type -AssemblyName System.Security
$password = Read-Host 'Mail client password from CSU webmail (Enter to keep saved password for this address)' -AsSecureString
$secret = $current.secret
if ($password.Length) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($password)
    $clear = New-Object byte[] ($password.Length * 2)
    try {
        [Runtime.InteropServices.Marshal]::Copy($pointer, $clear, 0, $clear.Length)
        $secret = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($clear, $null, 'CurrentUser'))
    } finally {
        [Array]::Clear($clear, 0, $clear.Length)
        [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer)
        $password.Dispose()
    }
} elseif (!$secret -or $Address -ine $current.address) { throw 'A client password is required for this email address.' }

New-Item -ItemType Directory -Path $state,$DataDirectory -Force | Out-Null
$temporary = "$path.$PID.tmp"
$backup = "$path.$PID.bak"
try {
    @{ address = $Address; secret = $secret; dataDir = $DataDirectory; model = $Model; prioritySenders = @($PrioritySenders) } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
    if (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Replace($temporary, $path, $backup) }
    else { [IO.File]::Move($temporary, $path) }
} finally {
    foreach ($file in @($temporary, $backup)) {
        if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file }
    }
}
Write-Host "Mailbox configured. Check the Mail tab in Codex Remote. Message cache: $DataDirectory"
if (!$Model) { Write-Host 'AI summaries are off. Run this setup again with -Model after installing a local Ollama model.' }
