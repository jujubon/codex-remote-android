# 手机阅读窗

Windows 解压目录中的 **Phone-Reading-Window.cmd** 同时提供本地 Wi-Fi 和跨网投屏。Android 端从「电脑 → 手机阅读窗」打开电脑上的 Wi-Fi 阅读窗，或开始和停止跨网共享。

## 本地 Wi-Fi 首次准备

从 [Genymobile 官方发布页](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1) 下载与 Windows 架构对应的 scrcpy 5.0.1。普通 64 位 Windows 用 `scrcpy-win64-v5.0.1.zip`，ARM64 用 `scrcpy-winarm64-v5.0.1.zip`，32 位 Windows 用 `scrcpy-win32-v5.0.1.zip`。在 [官方 Windows 安装说明](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/windows.md) 核对 SHA-256 后，完整解压到 `%LOCALAPPDATA%\CodexMobileRemote\PhoneReader`。保留 ZIP 内自带的文件夹，使 `scrcpy.exe` 与 `adb.exe` 位于同一版本目录。

1. 手机和电脑连到同一 Wi-Fi。开启手机开发者选项和无线调试，选择「使用配对码配对设备」。
2. 双击 `Phone-Reading-Window.cmd`，展开「配对或手动连接」。填写手机配对弹窗里的 IP、端口和六位配对码，在 Windows 点「配对」。
3. 如果列表仍为空，抄下无线调试**首页**的 IP 和端口，在 Windows 点「连接」。首页的端口与配对弹窗的端口各有用途，端口变化后使用手机当前显示的值。
4. 选中手机后点「打开本地投屏」。已有一台无线设备在线时，下次打开入口或点「重试本地」会自动打开投屏。有多台时可手动选择。

首次配对完成后，保持手机和电脑在同一 Wi-Fi，并打开手机的无线调试。Android 端点「在电脑打开 Wi-Fi 阅读窗」，Windows 会为唯一已连接的无线设备打开小窗。电脑与手机之间的画面和翻页仍走本地连接，手机可以沿用已有的配套服务地址。手机启动的阅读窗默认保持手机屏幕点亮。

## 本地阅读

- 默认置顶、静音、24 帧上限，初始窗口宽度 360 像素。启动前可取消置顶或取消关闭手机屏幕。
- 点击小窗后可用鼠标、滚轮及键盘操作。方向键是否翻页取决于阅读 App。横向翻页可按住鼠标左键拖动，模拟触屏左右滑动。
- 在小窗中按 `左 Alt + O` 关闭手机屏幕，按 `左 Alt + Shift + O` 点亮。关闭阅读小窗即可结束投屏。

## 跨网阅读

1. 启动 Windows 0.9.11 配套服务和 HTTPS 隧道，确保 Windows 已登录。手机沿用该隧道地址和配对令牌。
2. 在手机「电脑 → 手机投屏」选择「跨网投屏」并开始。Windows 会打开接收窗口，已有 Wi-Fi 小窗时会先请求关闭。然后在 Android 弹窗中选择要共享的内容。
3. 想在电脑翻页时，开始前勾选「允许电脑翻页」，首次授予「Codex Remote 阅读窗翻页」无障碍权限，并选择阅读 App。投屏后保持手机解锁和阅读 App 在前台。
4. 电脑用左右方向键或「上一页／下一页」横向翻页，用滚轮或上下方向键滚动。手机通知、App 和 Windows 跨网窗口都可以结束共享。

参考 [scrcpy 窗口选项](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/window.md)、[屏幕与省电选项](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/device.md)和 [Android 无线调试](https://developer.android.com/tools/adb#wireless-android11-command-line)。
