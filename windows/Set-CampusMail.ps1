param(
    [ValidateSet('csu','qq')][string]$Provider,
    [string]$Address,
    [string]$DataDirectory,
    [string]$Model,
    [string[]]$PrioritySenders,
    [switch]$Disconnect,
    [switch]$UseSaved
)
$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'CodexMobileRemote'
$path = Join-Path $state 'campus-mail.json'

function Read-MailConfig([string]$file) {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    }
}

function Write-MailConfig([string]$file, $value) {
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    $temporary = "$file.$PID.tmp"
    $backup = "$file.$PID.bak"
    try {
        $value | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
        if (Test-Path -LiteralPath $file -PathType Leaf) { [IO.File]::Replace($temporary, $file, $backup) }
        else { [IO.File]::Move($temporary, $file) }
        if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup }
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary }
    }
}

$active = Read-MailConfig $path
$activeProvider = if ($active.address -match '@qq\.com$') { 'qq' } else { 'csu' }
if (!$Provider) {
    $Provider = if ($Address -match '@qq\.com$') { 'qq' } elseif ($Address) { 'csu' } else { $activeProvider }
}
$savedPath = Join-Path $state "campus-mail-$Provider.json"
$current = if ($active -and $activeProvider -eq $Provider) { $active } else { Read-MailConfig $savedPath }
$pattern = if ($Provider -eq 'qq') { '^[a-z0-9._+%-]+@qq\.com$' } else { '^[a-z0-9._+%-]+@(?:[a-z0-9-]+\.)*csu\.edu\.cn$' }
$providerName = if ($Provider -eq 'qq') { 'QQ Mail' } else { 'CSU mail' }

function Select-MailConfig($value) {
    if ($active -and $activeProvider -ne $Provider) {
        Write-MailConfig (Join-Path $state "campus-mail-$activeProvider.json") $active
    }
    Write-MailConfig $path $value
    if (Test-Path -LiteralPath $savedPath -PathType Leaf) { Remove-Item -LiteralPath $savedPath }
    Write-Host "$providerName is selected. Refresh the Mail tab in Codex Remote."
}

if ($Disconnect) {
    if ($activeProvider -eq $Provider -and (Test-Path -LiteralPath $path -PathType Leaf)) { Remove-Item -LiteralPath $path }
    if (Test-Path -LiteralPath $savedPath -PathType Leaf) { Remove-Item -LiteralPath $savedPath }
    Write-Host "$providerName disconnected. Its cache remains in the configured mail data folder."
    return
}

if ($UseSaved) {
    if (!$current.secret -or $current.address -notmatch $pattern) { throw "$providerName does not have a saved account. Run setup without -UseSaved." }
    Select-MailConfig $current
    return
}

if (!$Address) { $Address = if ($current) { $current.address } else { Read-Host "Full $providerName address" } }
$Address = ([string]$Address).Trim().ToLowerInvariant()
if ($Address -notmatch $pattern) { throw "Enter a full $providerName address." }
if (!$DataDirectory) {
    $lifecycle = Join-Path $state 'DesktopLifecycle\settings.json'
    $settings = if (Test-Path -LiteralPath $lifecycle -PathType Leaf) {
        Get-Content -LiteralPath $lifecycle -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    $DataDirectory = if ($current.dataDir) { $current.dataDir }
        elseif ($settings.updateRoot) { Join-Path $settings.updateRoot 'mail' }
        elseif ($active.dataDir) { $active.dataDir }
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
$credentialLabel = if ($Provider -eq 'qq') { 'QQ Mail IMAP authorization code' } else { 'Mail client password from CSU webmail' }
$password = Read-Host "$credentialLabel (Enter to keep the saved credential for this address)" -AsSecureString
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

New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
Select-MailConfig @{ address = $Address; secret = $secret; dataDir = $DataDirectory; model = $Model; prioritySenders = @($PrioritySenders) }
Write-Host "Message cache: $DataDirectory"
if (!$Model) { Write-Host 'To use AI summaries, open Mail settings and select a provider.' }
