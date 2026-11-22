# 手机阅读窗

在 Windows 上打开 Android 的竖屏阅读小窗。阅读窗使用官方 scrcpy，通过 USB 或同一 Wi-Fi 连接手机。它从 Windows 本地启动，使用手机的调试授权。

## 首次准备

从 [Genymobile 官方发布页](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1) 下载与 Windows 架构对应的 scrcpy 5.0.1。普通 64 位 Windows 用 `scrcpy-win64-v5.0.1.zip`，ARM64 用 `scrcpy-winarm64-v5.0.1.zip`，32 位 Windows 用 `scrcpy-win32-v5.0.1.zip`。在 [官方 Windows 安装说明](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/windows.md) 核对 SHA-256 后，完整解压到 `%LOCALAPPDATA%\CodexMobileRemote\PhoneReader`。保留 ZIP 内自带的文件夹，使 `scrcpy.exe` 与 `adb.exe` 位于同一版本目录。

从项目的 `windows` 目录双击 **Phone-Reading-Window.cmd**。使用单独的阅读窗 ZIP 时，先完整解压。Windows 可能会给下载的 ZIP 加来源标记，可在确认来源后通过资源管理器的 ZIP「属性」解除阻止，再重新解压。

## USB

1. 在手机设置开启开发者选项及 USB 调试。
2. 用数据线连接手机，解锁并允许这台电脑的调试授权。
3. 在 Windows 阅读窗点「刷新设备」，选中手机并点「打开阅读窗」。

## 同一 Wi-Fi

1. 在手机的无线调试页选择「使用配对码配对设备」。
2. 用配对弹窗里的 IP、端口和六位配对码，在 Windows 阅读窗里点「配对」。
3. 手机可能自动出现。如果列表仍为空，抄下无线调试**首页**的 IP 和端口，在 Windows 阅读窗点「连接」。首页的端口与配对弹窗的端口各有用途，端口变化后使用手机当前显示的值。

## 阅读

- 默认置顶、静音、24 帧上限，初始窗口宽度 360 像素。启动前可取消置顶或取消关闭手机屏幕。
- 点击小窗后可用鼠标、滚轮及键盘操作。方向键是否翻页取决于阅读 App。横向翻页可按住鼠标左键拖动，模拟触屏左右滑动。
- 在小窗中按 `左 Alt + O` 关闭手机屏幕，按 `左 Alt + Shift + O` 点亮。关闭阅读小窗即可结束投屏。

参考 [scrcpy 窗口选项](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/window.md)、[屏幕与省电选项](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/device.md)和 [Android 无线调试](https://developer.android.com/tools/adb#wireless-android11-command-line)。
