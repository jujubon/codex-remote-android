<p align="center"><img src="apps/mobile/public/logo.svg" width="76" height="76" alt="Codex Remote"></p>

<h1 align="center">Codex Remote for Android</h1>
<p align="center"><strong>离开电脑，也能继续手头的 Codex 和 Antigravity 任务。</strong></p>
<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
<p align="center">
  <a href="https://github.com/jujubon/codex-remote-android/releases/latest"><img src="https://img.shields.io/github/v/release/jujubon/codex-remote-android?label=Release&color=4e38a4" alt="最新版"></a>
  <img src="https://img.shields.io/badge/Android-7%2B-387954" alt="Android 7+">
  <img src="https://img.shields.io/badge/Host-Windows-2869a5" alt="Windows 主机">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-595667" alt="MIT 许可证"></a>
</p>

<p align="center"><strong><a href="https://github.com/jujubon/codex-remote-android/releases/latest">下载 APK 和 Windows 配套服务</a></strong> · <a href="#快速开始">快速开始</a> · <a href="#异地连接使用-cloudflare-tunnel">异地连接</a> · <a href="#cockpit-tools-切换-codex-账号">切换账号</a> · <a href="#邮箱">邮箱</a></p>

<p align="center"><img src="docs/images/app-preview.webp" alt="Codex Remote 的 Codex、Antigravity 和电脑三页界面，使用演示数据" width="840"></p>

## 手机上能做什么

在电脑开始的任务，可以从手机看进度、回复提问、补发截图。也可以直接发起新任务。助手在你的 Windows 电脑上执行，沿用已登录的账号。

| 页面 | 你可以在手机上做什么 |
| --- | --- |
| **Codex** | 浏览项目和对话、发起任务、查看额度。支持的会话可以答复提问、处理审批、引导或停止。配合 Cockpit Tools，可以比较各账号额度、切换账号，并自动打开 Codex Desktop。 |
| **Antigravity** | 用电脑上已登录的 CLI 新建和继续对话、查看额度。需要接手桌面对话时，从「启动」进入 Google 官方远程面板。 |
| **电脑** | 自检连接、互传文件和剪贴板、锁屏、熄屏挂机、静音与关机，也可预览收件箱图片、使用手机阅读窗和安装更新。 |
| **邮件** | 并行只读同步学校邮箱和个人 QQ 邮箱，随时切换收件箱与待办。使用 Antigravity 或本地 Ollama 生成摘要、标记重要邮件、提取待办与翻译正文。 |

## 快速开始

准备一部 **Android 7.0 或以上**的手机和一台已安装并登录 **Codex Desktop** 的 Windows 电脑。

1. **安装两端。** 手机上安装 APK，Windows 上把 ZIP 完整解压到固定目录。[下载最新版](https://github.com/jujubon/codex-remote-android/releases/latest)
2. **同一 Wi-Fi 下启动服务。** 双击解压目录里的 `Start.cmd`，窗口会显示 `App address` 和 `Pairing token`。
3. **在手机配对。** 打开「连接设置」，分别填入服务器地址和配对令牌，点「保存并连接」。打开已有对话或点「新聊天」即可。

Windows 启动器优先使用 Codex 附带的 Node.js。提示找不到 `node.exe` 时，可安装 Node.js 22.12 或以上再启动。Antigravity 的 CLI 对话需要在 Windows 上安装并登录 Antigravity CLI，手机发任务时会自动启动 CLI。

## 异地连接使用 Cloudflare Tunnel

本项目日常跨网使用 **Cloudflare Tunnel + 固定 HTTPS 域名**。电脑保持联网、唤醒并登录 Windows，手机切到移动数据后也能连接。

1. **在 Windows 启动隧道模式。** 先退出前台运行的 `Start.cmd`，再双击 `Start-Tunnel.cmd`，配套服务会监听 `http://127.0.0.1:8787`。
2. **配置 Cloudflare。** 先将你的域名添加到 Cloudflare，再在控制台创建 Tunnel，按 Windows 安装指引启动 `cloudflared`。为隧道添加一个公开子域名，服务地址设为 `http://127.0.0.1:8787`。[Cloudflare Tunnel 官方设置指南](https://developers.cloudflare.com/tunnel/get-started/)
3. **在手机使用固定地址。** 在「连接设置」把服务器地址改成你的 HTTPS 域名，例如 `https://remote.example.com`，配对继续使用 Codex Remote 生成的令牌。可切到移动数据，在「电脑 → 连接状态」做一次连接自检。

### 回到 Wi-Fi 时自动直连

把电脑上的可信 Wi-Fi 或手机热点设为 Windows「专用网络」，再以管理员身份运行一次 `Enable-Trusted-LAN.cmd`，然后重启 Windows 配套服务。手机保留固定 HTTPS 域名，找到并验证同一网络上的电脑后会自动直连，切回移动数据时再使用固定域名。

想手动验证局域网，可在手机的「手动局域网地址」填写 `http://<电脑的局域网 IPv4>:18788`。连接成功后，「电脑」页会显示「局域网直连」。热点的发现和可达性取决于 Android 与 Windows 的网络设置。[手机热点和阅读窗说明](docs/phone-reader.md#手机开热点给电脑)

## 常用操作

- **控制电脑。** 「电脑 → 电脑控制」上排是熄屏挂机和静音开关，下排是锁定与关机。关闭熄屏开关会重新点亮显示器，静音开关控制默认音频输出。关机需要再次确认，Windows 关机后手机连接会断开。

- **离开电脑后继续任务。** 手机上可以搜索项目、对话和消息。点「用时」展开执行过程，向上翻历史时暂停自动跟随，点「回到最新」继续看。已有桌面对话的实时操作取决于 Codex Desktop 的本地连接能力和会话状态。[桌面连接说明](docs/desktop-ipc.md)
- **启动或关闭两位助手的桌面。** 在各自的页面点「启动」。绿点表示窗口已打开，橙点表示正在启停。搜索框旁的「⋯」可管理项目和对话。Antigravity 的「进入桌面对话」需要在桌面设置中启用 Remote Control，并在官方面板使用同一 Google 账号。
- **查看额度。** Codex 首页显示 5 小时剩余额度，Antigravity 首页显示 Gemini 分组的 5 小时剩余额度。点开圆环可查看各额度窗口和重置时间。
- **发截图和文件。** 从 Android 分享菜单选「发送到电脑」，或在聊天输入框添加多个附件。图片可在手机收件箱预览。文件接收位置和附件清理可分别配置。[文件传输说明](docs/file-transfer.md)
- **用电脑看手机。** 在「电脑 → 手机投屏」选择本地 Wi-Fi 或跨网方式。本地投屏需配对 scrcpy，跨网共享由 Android 确认。电脑端翻页的权限和步骤见阅读窗说明。[手机阅读窗说明](docs/phone-reader.md)

## Cockpit Tools 切换 Codex 账号

1. 在同一个 Windows 用户下打开 **Cockpit Tools 1.5.3 或更新版本**，启用它的本地 WebSocket 服务，并在 Cockpit 中添加 Codex 账号。[Cockpit Tools 下载](https://github.com/jlcodes99/cockpit-tools/releases/latest)
2. 双端更新到 **Codex Remote 1.1.1 或更新版本**。在手机「Codex → 额度圆环 → Codex 账号」比较各账号的剩余额度与重置时间，也可以单独刷新。结束正在运行的 Codex 任务后，点目标账号的「选用」并确认。
3. Cockpit 确认切换后，Windows 配套服务会重新载入手机的 Codex 连接，并自动打开 Codex Desktop。界面分别显示账号验证和桌面启动结果。若桌面暂未确认打开，可在 Codex 首页点「启动」。相同邮箱的多个工作区需要在电脑上核对。

账号凭据由 Cockpit 在电脑上管理。手机收到脱敏标签、套餐、额度和操作状态。配套服务通过本机回环地址访问 Cockpit 的自动化接口，Cockpit 的 WebSocket 端口应留在本机。

## 邮箱

1. **获取邮箱授权。** 在中南大学网页邮箱的「个人信息 → 邮箱密码」生成客户端专用密码。在 QQ 邮箱设置中启用 IMAP 并生成授权码。 [中南大学邮箱](https://mail.csu.edu.cn/) · [QQ 邮箱](https://mail.qq.com/)
2. **在电脑添加账号。** 在当前使用的 Windows 配套服务目录运行 `Set-CampusMail.cmd -Provider csu` 或 `Set-CampusMail.cmd -Provider qq`，按提示输入完整地址和专用密码或授权码。添加同类的另一个账号时，可通过 `-Address` 指定完整地址。Windows 为当前用户加密凭据，邮件缓存默认位于更新目录下的 `mail` 子目录，也可通过 `-DataDirectory` 指定。
3. **在手机查看。** 打开「邮件」，点顶部邮箱名称切换收件箱和待办。每个账号首次同步最近 20 封，之后在后台独立增量同步。重连可补发最近 24 小时符合条件的提醒。

在「邮件 → 设置」为当前账号选择分析方式，并管理重点联系人。Antigravity 通过电脑上已登录的 CLI 把邮件标题和所需正文发给 Google，生成摘要、分类、待办和中文译文。邮箱凭据和附件留在电脑上。

Windows 配套服务 **1.6.0** 起，优先使用 **Gemini 4 Hydrogen（High）**，遇到额度限制时切换 **Claude Opus 4.6（Thinking）**。Gemini 暂停约 15 分钟后优先重试。两组都受限时继续收信，稍后补分析。 [1.6.0 发布记录](docs/releases.md#160)

如果选择本地处理，可先安装 Ollama 本地模型，再用 `Set-CampusMail.cmd -Address 邮箱地址 -Model 模型名` 配置。在专用密码提示处按回车可沿用现有授权，然后在手机邮箱设置中选择「本地模型」。 [Ollama 本地模式](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features)

普通和推广邮件保留在收件箱。重要邮件可提醒，有明确行动要求的邮件进入「待办」。详情页可切换原文和中文译文，也可手动调整分类、完成待办或延后一小时提醒。用 `Set-CampusMail.cmd -Address 邮箱地址 -Disconnect` 断开指定账号。

## 后台运行与更新

- **Windows 登录后可用。** 第一次连通后，可以双击 `Enable-Autostart.cmd` 启用登录自启，由计划任务在后台启动配套服务。已单独安装的 Cloudflare 连接器由其服务运行，已配置为 Codex Remote 托管的隧道由计划任务一起启动。`Disable-Autostart.cmd` 可停用配套服务的登录自启。
- **手机冷启动时静默检查。** 发现新版时可选「立即更新」或「稍后再说」，也能从「电脑 → 版本与更新」主动检查。App 下载并校验 APK 后，由 Android 确认安装。安装成功后，App 会清理更新缓存中的安装包。
- **Windows 可用同一个入口更新。** 后台守护程序在配置的更新目录下载并解压 Windows ZIP，安装后清除临时 ZIP。如果新版启动失败，会恢复旧版本。1.1.3 起，新设置后台启动时默认使用解压目录下的 `companion-updates`。切换期间手机会短暂重连，继续使用原配对令牌。[发布记录](docs/releases.md)

### 连不上时先查这三项

| 现象 | 检查方式 |
| --- | --- |
| 同一 Wi-Fi 连不上 | 核对电脑窗口里的 `App address`。如果只显示 `127.0.0.1`，请切回同网的 `Start.cmd` 模式，或通过固定域名连入。 |
| 固定域名连不上 | 看 Cloudflare 控制台的隧道是否在线，再检查 Windows 配套服务是否运行。用浏览器访问你的域名加 `/health`，可查看服务是否响应。 |
| 域名可访问，App 仍离线 | 核对手机填的是 Codex Remote 的配对令牌，再运行手机的连接自检，查看同步请求是否能收到回执。 |

<details>
<summary>自定义文件保存位置</summary>

在 Windows 的 `%LOCALAPPDATA%\CodexMobileRemote\device-tools.json` 配置手机分享目录与聊天附件目录。请选择支持硬链接的本地文件系统，例如 NTFS。更改聊天附件目录后需重启配套服务。

```json
{
  "receiveFolder": "D:\\PhoneDrop\\手机分享",
  "chatAttachmentFolder": "D:\\PhoneDrop\\Codex 对话附件",
  "autoOpen": false
}
```

</details>

## 从源码构建

在 Windows PowerShell 中运行。需要 Git、Git LFS、Node.js 22.12+、JDK 21 和 Android SDK Platform 36。Android 构建使用 `JAVA_HOME` 和 `ANDROID_HOME`。

```powershell
git clone https://github.com/jujubon/codex-remote-android.git
cd codex-remote-android
git lfs pull
npm.cmd ci
npm.cmd run build
npm.cmd test
```

构建 Android 调试包可运行 `npm.cmd run android:apk -w @codex-mobile/mobile`。调试 APK 使用本机签名，覆盖安装需要与已安装包的签名一致。打包 Windows ZIP 时，准备包含 `python.exe` 的 Python 3.13 Windows x64 嵌入式分发包，再运行下面的命令。

```powershell
.\windows\Package-Host.ps1 -PythonDirectory 'C:\tools\python-embed'
```

## 来源与许可证

Codex Remote 是社区项目，基于 CodexRemote 开发，Windows 原生对话适配复用了 Codex-QQ 的部分实现。项目使用 MIT 许可证。[CodexRemote](https://github.com/qy1603429908/CodexRemote) · [Codex-QQ](https://github.com/IIMovoMII/Codex-QQ) · [MIT 许可证](LICENSE) · [Windows 适配层许可证](apps/server/windows/native/LICENSE)
