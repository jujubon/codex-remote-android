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
$accountsDir = Join-Path $state 'mail-accounts'
$legacyFiles = @('campus-mail.json', 'campus-mail-csu.json', 'campus-mail-qq.json')
$schoolPattern = '^[a-z0-9._+%-]+@(?:[a-z0-9-]+\.)*csu\.edu\.cn$'
$qqPattern = '^[a-z0-9._+%-]+@qq\.com$'

function Read-MailConfig([string]$file) {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    }
}

function Write-MailConfig([string]$file, $value, [switch]$OnlyIfMissing) {
    New-Item -ItemType Directory -Path $accountsDir -Force | Out-Null
    $temporary = "$file.$PID.tmp"
    $backup = "$file.$PID.bak"
    try {
        $value | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
        if ($OnlyIfMissing) {
            try { [IO.File]::Move($temporary, $file) }
            catch { if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw } }
        } elseif (Test-Path -LiteralPath $file -PathType Leaf) { [IO.File]::Replace($temporary, $file, $backup) }
        else { [IO.File]::Move($temporary, $file) }
        if (Test-Path -LiteralPath $backup -PathType Leaf) { Remove-Item -LiteralPath $backup }
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary }
    }
}

function Get-MailConfigPath([string]$email) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($email.ToLowerInvariant()))
        Join-Path $accountsDir (([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant() + '.json')
    } finally { $sha.Dispose() }
}

$marker = Join-Path $accountsDir '.legacy-imported'
if (!(Test-Path -LiteralPath $marker -PathType Leaf)) {
    New-Item -ItemType Directory -Path $accountsDir -Force | Out-Null
    foreach ($name in $legacyFiles) {
        $legacy = Read-MailConfig (Join-Path $state $name)
        if (!$legacy.secret -or ($legacy.address -notmatch $schoolPattern -and $legacy.address -notmatch $qqPattern)) { continue }
        $target = Get-MailConfigPath $legacy.address
        if (!(Test-Path -LiteralPath $target -PathType Leaf)) { Write-MailConfig $target $legacy -OnlyIfMissing }
    }
    New-Item -ItemType File -Path $marker -Force | Out-Null
}

$eligible = Get-ChildItem -LiteralPath $accountsDir -File -Filter '*.json' | Where-Object { $_.Name -match '^[a-f0-9]{64}\.json$' } |
    ForEach-Object { Read-MailConfig $_.FullName } | Where-Object {
        $_.secret -and (!$Provider -or ($Provider -eq 'qq' -and $_.address -match $qqPattern) -or ($Provider -eq 'csu' -and $_.address -match $schoolPattern))
    }
if (!$Address) {
    $Address = if (@($eligible).Count -eq 1) { $eligible.address } else { Read-Host 'Full email address (CSU or QQ Mail)' }
}
$Address = ([string]$Address).Trim().ToLowerInvariant()
if ($Address -notmatch $schoolPattern -and $Address -notmatch $qqPattern) { throw 'Enter a full CSU or QQ Mail email address.' }
$actualProvider = if ($Address -match $qqPattern) { 'qq' } else { 'csu' }
if ($Provider -and $Provider -ne $actualProvider) { throw 'The email address does not match the selected provider.' }
$Provider = $actualProvider
$providerName = if ($Provider -eq 'qq') { 'QQ Mail' } else { 'CSU mail' }
$path = Get-MailConfigPath $Address
$current = Read-MailConfig $path

if ($Disconnect) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
    foreach ($name in $legacyFiles) {
        $file = Join-Path $state $name
        $legacy = Read-MailConfig $file
        if ($legacy.address -ieq $Address) { Remove-Item -LiteralPath $file }
    }
    Write-Host "$providerName disconnected. Its cache remains in the configured mail data folder."
    return
}

if ($UseSaved) {
    if (!$current.secret) { throw "$providerName does not have a saved account. Run setup without -UseSaved." }
    Write-Host "$providerName is already connected. Select the account in the Mail tab on your phone."
    return
}

if (!$DataDirectory) {
    $lifecycle = Join-Path $state 'DesktopLifecycle\settings.json'
    $settings = if (Test-Path -LiteralPath $lifecycle -PathType Leaf) {
        Get-Content -LiteralPath $lifecycle -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    $DataDirectory = if ($current.dataDir) { $current.dataDir }
        elseif ($settings.updateRoot) { Join-Path $settings.updateRoot 'mail' }
        elseif (@($eligible).Count -ge 1 -and @($eligible)[0].dataDir) { @($eligible)[0].dataDir }
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
Write-MailConfig $path @{ address = $Address; secret = $secret; dataDir = $DataDirectory; model = $Model; prioritySenders = @($PrioritySenders) }
Write-Host "$providerName added. Select the account in the Mail tab on your phone."
Write-Host "Message cache: $DataDirectory"
if (!$Model) { Write-Host 'To use AI summaries, open Mail settings and select a provider.' }
