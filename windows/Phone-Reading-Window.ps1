param([switch]$Check)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PhoneReader.Core.ps1')
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$layout = [xml](Get-Content -LiteralPath (Join-Path $PSScriptRoot 'PhoneReader.xaml') -Raw -Encoding UTF8)
$reader = New-Object System.Xml.XmlNodeReader $layout
$window = [Windows.Markup.XamlReader]::Load($reader)
$controls = @{}
foreach ($name in @('Refresh','Devices','PairAddress','PairCode','Pair','ConnectAddress','Connect','Topmost','ScreenOff','Status','Open')) {
    $controls[$name] = $window.FindName($name)
    if (!$controls[$name]) { throw "缺少阅读窗控件 $name" }
}
$tools = Get-ReaderTools
$toolsReady = (Test-Path -LiteralPath $tools.Scrcpy -PathType Leaf) -and (Test-Path -LiteralPath $tools.Adb -PathType Leaf)
if ($Check) {
    if (!$toolsReady) { throw "缺少投屏组件：$($tools.Directory)" }
    Write-Output "Phone Reader UI ready, scrcpy $($tools.Version)"
    return
}

$script:readerOperation = $null
$script:reading = $null
$script:minimizedForReading = $false
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(180)

function Set-ReaderStatus([string]$Message, [bool]$IsError = $false) {
    $controls.Status.Text = $Message
    $color = if ($IsError) { '#9B2B3F' } else { '#625B71' }
    $controls.Status.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString($color)
}

function Update-ReaderButtons {
    $available = $toolsReady -and !$script:readerOperation -and !$script:reading
    foreach ($button in @('Refresh','Pair','Connect')) { $controls[$button].IsEnabled = $available }
    $controls.Open.IsEnabled = $available -and $null -ne $controls.Devices.SelectedItem
}

function Start-AdbAction([string[]]$Arguments, [string]$Message, [scriptblock]$OnComplete, [string]$InputText = '', [string]$Notice = '') {
    if ($script:readerOperation) { return }
    $child = Start-ReaderChild -File $tools.Adb -Arguments $Arguments -InputText $InputText
    $script:readerOperation = [pscustomobject]@{
        Child = $child; OnComplete = $OnComplete; Notice = $Notice; Deadline = [DateTime]::UtcNow.AddSeconds(20)
    }
    Set-ReaderStatus $Message
    Update-ReaderButtons
}

function Refresh-ReaderDevices([string]$Notice = '') {
    Start-AdbAction -Arguments @('devices','-l') -Message '正在查找手机…' -Notice $Notice -OnComplete {
        param($Result, $AfterConnect)
        if ($Result.ExitCode -ne 0) {
            Set-ReaderStatus 'ADB 无法读取设备列表。可以拔插数据线后重试。' $true
            return
        }
        $previous = $controls.Devices.SelectedItem.Serial
        $found = @(Get-ReaderDevices $Result.Stdout)
        $ready = @($found | Where-Object State -eq 'device')
        $controls.Devices.ItemsSource = $ready
        if ($ready.Count -eq 1) { $controls.Devices.SelectedIndex = 0 }
        elseif ($previous) { $controls.Devices.SelectedItem = $ready | Where-Object Serial -eq $previous | Select-Object -First 1 }

        if ($ready.Count -gt 0) {
            Set-ReaderStatus '手机已连接，可以打开阅读窗。'
        } elseif ($AfterConnect) {
            Set-ReaderStatus $AfterConnect
        } elseif ($found | Where-Object State -eq 'unauthorized') {
            Set-ReaderStatus '已发现手机。请解锁手机，点「允许 USB 调试」，再刷新设备。'
        } elseif ($found | Where-Object State -eq 'offline') {
            Set-ReaderStatus '手机连接已掉线。请重新插线或重新连接无线调试。' $true
        } else {
            Set-ReaderStatus '还没有检测到手机。连接数据线或完成 Wi-Fi 配对后刷新。'
        }
    }
}

function Open-PhoneReadingWindow {
    $selected = $controls.Devices.SelectedItem
    if (!$selected -or $script:reading) { return }
    try {
        $argsForReader = @(Get-ReaderArguments $selected.Serial ($controls.Topmost.IsChecked -eq $true) ($controls.ScreenOff.IsChecked -eq $true))
        $script:reading = Start-ReaderChild -File $tools.Scrcpy -Arguments $argsForReader -Adb $tools.Adb
        $script:minimizedForReading = $false
        Set-ReaderStatus '正在打开阅读窗…'
        Update-ReaderButtons
    } catch { Set-ReaderStatus $_.Exception.Message $true }
}

$controls.Refresh.Add_Click({ Refresh-ReaderDevices })
$controls.Devices.Add_SelectionChanged({ Update-ReaderButtons })
$controls.Open.Add_Click({ Open-PhoneReadingWindow })
$controls.Pair.Add_Click({
    try {
        $endpoint = Get-ReaderLanEndpoint $controls.PairAddress.Text
        $code = $controls.PairCode.Password
        if ($code -notmatch '^[0-9]{6}$') { throw '请输入手机显示的六位配对码。' }
        $controls.PairCode.Clear()
        Start-AdbAction -Arguments @('pair',$endpoint) -InputText $code -Message '正在与手机配对…' -OnComplete {
            param($Result)
            if ($Result.ExitCode -eq 0 -and $Result.Stdout -match '(?i)successfully paired') {
                Refresh-ReaderDevices '配对成功。若列表还没有手机，填写无线调试首页的 IP:端口，再点「连接」。'
            } else { Set-ReaderStatus '配对未成功。请核对配对弹窗里的地址、端口和配对码。' $true }
        }
    } catch { Set-ReaderStatus $_.Exception.Message $true }
})
$controls.Connect.Add_Click({
    try {
        $endpoint = Get-ReaderLanEndpoint $controls.ConnectAddress.Text
        Start-AdbAction -Arguments @('connect',$endpoint) -Message '正在连接手机…' -OnComplete {
            param($Result)
            if ($Result.ExitCode -eq 0 -and $Result.Stdout -match '(?im)^\s*(?:already )?connected to ') {
                Refresh-ReaderDevices 'Wi-Fi 连接成功。等手机出现在列表后，就可以打开阅读窗。'
            } else { Set-ReaderStatus '无线连接未成功。请核对手机首页的端口，并确认两台设备在同一 Wi-Fi。' $true }
        }
    } catch { Set-ReaderStatus $_.Exception.Message $true }
})

$timer.Add_Tick({
    try {
        $operation = $script:readerOperation
        if ($operation -and $operation.Child.Process.HasExited -and
            $operation.Child.Stdout.IsCompleted -and $operation.Child.Stderr.IsCompleted) {
            $script:readerOperation = $null
            $result = Receive-ReaderChild $operation.Child
            & $operation.OnComplete $result $operation.Notice
            Update-ReaderButtons
        } elseif ($operation -and [DateTime]::UtcNow -ge $operation.Deadline) {
            $script:readerOperation = $null
            $operation.Child.Process.Dispose()
            Set-ReaderStatus '这次连接未及时返回，请检查手机上的调试授权后重试。' $true
            Update-ReaderButtons
        }
        if ($script:reading) {
            if ($script:reading.Process.HasExited) {
                if (!$script:reading.Stdout.IsCompleted -or !$script:reading.Stderr.IsCompleted) { return }
                $closed = Receive-ReaderChild $script:reading
                $script:reading = $null
                if ($script:minimizedForReading) { $window.WindowState = 'Normal' }
                if ($closed.ExitCode -eq 0) { Set-ReaderStatus '阅读窗已关闭。' }
                else {
                    $details = ($closed.Stderr + [Environment]::NewLine + $closed.Stdout) -split '\r?\n' |
                        Where-Object { $_ -match 'ERROR|WARN' } | Select-Object -Last 1
                    Set-ReaderStatus "阅读窗启动或连接失败。请确认手机已授权，并刷新设备。 $details" $true
                }
                Update-ReaderButtons
            } else {
                $script:reading.Process.Refresh()
                if (!$script:minimizedForReading -and $script:reading.Process.MainWindowHandle -ne [IntPtr]::Zero) {
                    $window.WindowState = 'Minimized'
                    $script:minimizedForReading = $true
                    Set-ReaderStatus '阅读窗正在运行。关闭小窗后可在这里重新选择设备。'
                }
            }
        }
    } catch {
        Set-ReaderStatus $_.Exception.Message $true
        Update-ReaderButtons
    }
})

$window.Add_Loaded({
    if ($toolsReady) {
        Refresh-ReaderDevices
        $timer.Start()
    } else {
        Set-ReaderStatus "请下载官方 $($tools.Asset).zip，并把文件夹完整解压到 $($tools.Directory)。" $true
        Update-ReaderButtons
    }
})
$window.Add_Closed({ $timer.Stop() })
[void]$window.ShowDialog()
