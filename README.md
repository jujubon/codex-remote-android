# Codex Remote for Android

通过一部 Android 手机使用 Windows 上的 Codex 和 Antigravity。任务在电脑上执行，分别沿用电脑上已登录的账号。Codex Remote 是社区项目，包含 Android App 和 Windows 配套服务。[下载 1.0.0](https://github.com/jujubon/codex-remote-android/releases/tag/v1.0.0)

| 页面 | 用途 |
| --- | --- |
| Codex | 查看桌面项目和历史，在手机新建对话，处理支持的提问与审批，查看额度和管理对话。 |
| Antigravity | 在手机通过已登录的 CLI 新建对话、查看额度，或进入 Google 官方远程面板使用桌面对话。 |
| 电脑 | 查看连接、传文件和剪贴板、使用手机阅读窗，以及检查和安装更新。 |

## 第一次连接

准备一台能正常使用 **Codex Desktop** 的 Windows 电脑和一部 **Android 7.0 或更高版本**的手机。先在电脑端登录 Codex、打开一个对话，并确认可以正常发送消息。

1. 从 [Releases](https://github.com/jujubon/codex-remote-android/releases) 下载同一版本的 Android APK 和 Windows ZIP。也可按下文从源码构建。发布流程见 [版本发布](docs/releases.md)。
2. 在手机上安装 APK。把 Windows ZIP **完整解压到固定文件夹**。直接在压缩包预览里双击 `.cmd` 会让它找不到同目录的 PowerShell 脚本。
3. 第一次建议让手机和电脑连到同一可信 Wi-Fi。在解压目录双击 **`Start.cmd`**。电脑窗口会显示 `App address` 和 `Pairing token`。启动器优先使用 Codex 附带的 Node.js；如果提示找不到 `node.exe`，安装 Node.js 22.12 或更高版本后重试。
4. 在手机的「连接设置」分别填入这两项，点「保存并连接」。看到项目列表后可打开已有对话或新建聊天。使用期间请让电脑保持联网和唤醒，确保配套服务在线。

Antigravity 的 CLI 聊天需要电脑安装并登录 Antigravity CLI。手机发起对话时，配套服务会启动 CLI。使用「进入桌面对话」时，在 Antigravity 桌面设置中启用 Remote Control，官方面板使用同一个 Google 账号。

## 出门后怎么连

手机用移动数据时，需要一个它能访问的电脑地址。先关闭之前前台运行的连接服务，再按下面的方式选一个启动入口。

| 使用场景 | 电脑端 | 手机填什么 |
| --- | --- | --- |
| 同一可信 Wi-Fi | 双击 `Start.cmd` | 窗口中的局域网地址，如 `http://192.168.1.20:8787` |
| 蒲公英等虚拟局域网 | 手机和电脑加入同一个虚拟网络。双击 `Start-VPN.cmd`，输入分配给**电脑**的虚拟 IPv4 | 窗口中的虚拟网络地址，并保持手机端组网连接 |
| 手机只装 Codex Remote | 双击 `Start-Tunnel.cmd`，让服务监听电脑本机，再通过支持 WebSocket 的 HTTPS 隧道或反向代理转发 | 隧道提供的 `https://` 地址，以及电脑窗口里的配对令牌 |

**以 ngrok 为例**，在 Windows 完成 ngrok 自己的账号配置后，保持 `Start-Tunnel.cmd` 运行，在另一个终端执行：

```powershell
ngrok http http://127.0.0.1:8787
```

等 ngrok 显示 `online`，把 `Forwarding` 左侧的 HTTPS 地址填入手机。`127.0.0.1` 是电脑端的转发目标。手机的「配对令牌」使用 Codex Remote 生成的值，ngrok 的 Authtoken 只用于电脑上的 ngrok。电脑换网络后，需要能够重新连上隧道服务。公网隧道的 TLS 在服务商处终止时，服务商有能力接触传输内容。也可以使用自己的 HTTPS 入口。参阅 [ngrok Windows 安装说明](https://ngrok.com/download/windows)和[自建反向代理说明](docs/public-reverse-proxy.md)。

### 固定域名与局域网自动切换

使用固定 HTTPS 域名连接时，可在 Windows 的可信专用网络上以管理员身份运行一次 `Enable-Trusted-LAN.cmd`，再重新启动 `Start-Tunnel.cmd`。手机保留原来的域名和配对令牌。连接同一局域网时，「电脑」页显示「局域网直连」。切到 5G 或 Wi-Fi 无法访问电脑时，App 使用固定域名。

### 桌面对话的附件与排队

桌面 IPC 可用时，手机能随消息发送内嵌附件，也能引导当前轮。桌面 IPC 不可用时，手机可以上传文件并随文字发送电脑上的文件路径，或在任务运行中排队到下一轮。

## 手机阅读窗

在 Windows 解压目录双击 `Phone-Reading-Window.cmd`。手机对应入口在「电脑 → 手机阅读窗」。

- **同一 Wi-Fi**。安装 scrcpy 并完成一次无线调试配对后，桌面入口发现唯一已连接的手机会直接打开投屏。可以用鼠标点击、拖动、滚动，也可熄灭手机屏幕。
- **异地或本地连不上**。Windows 确认配套服务和 HTTPS 隧道在线，再在阅读窗点「改用跨网」。手机点「开始跨网投屏」并在 Android 弹窗中确认共享。首次使用电脑翻页时，勾选「允许电脑翻页」、开启「Codex Remote 阅读窗翻页」无障碍权限并选择阅读 App。共享时保持手机解锁，阅读 App 在前台。

跨网窗口按低帧率传输，Windows 只在内存中保留最新一帧。配对、翻页和结束共享的详细步骤见[手机阅读窗说明](docs/phone-reader.md)。

## 设备工具

从底部点「电脑」打开设备工具。在运行中的聊天点右上角「⋯」，可以打开「熄屏挂机到本轮结束」。

- **剪贴板**。点击「发送手机剪贴板」或「拉取电脑剪贴板」来传输纯文本。需在手机打开 App 后操作，Windows 端使用登录用户的剪贴板。
- **锁屏与熄屏挂机**。「锁定电脑」请求 Windows 锁屏。「熄屏挂机」可选择 30 分钟、1 小时或 2 小时，也可从运行中的聊天保持到当前任务结束（最多 2 小时）。期间保持主机唤醒，鼠标键盘能再次点亮屏幕。到期、任务结束、停止挂机或退出 Windows 服务后，Windows 恢复原先的休眠策略。
- **分享**。从 Android 分享菜单选择「发送到电脑」来发送图片、PDF 或网页链接。接收后保存在 Windows 当前用户桌面下的 `PhoneDrop` 目录，单个文件上限 64 MB。可在「设备工具」开启选中分享入口后直接发送。设备工具与聊天附件使用各自的存储。

如需修改收件位置，在电脑的 `%LOCALAPPDATA%\CodexMobileRemote\device-tools.json` 写入以下设置。手机分享使用 `receiveFolder`，聊天上传使用 `chatAttachmentFolder`。目录应使用支持硬链接的本地文件系统（例如 NTFS）。`autoOpen` 默认关闭，开启后会尝试打开收到的常见图片、PDF 或网页链接。链接也会作为文本保存在收件目录。更改聊天附件目录后重新启动 Windows 配套服务，分享设置会在下一次请求时读取。手动配置的 `CMR_UPLOAD_DIRECTORY` 优先于 `chatAttachmentFolder`。

```json
{
  "receiveFolder": "D:\\PhoneDrop\\手机分享",
  "chatAttachmentFolder": "D:\\PhoneDrop\\Codex 对话附件",
  "autoOpen": false
}
```

## 在手机上工作

- **继续已有对话**。在「全部项目」按目录展开，或用「最近」和搜索找到对话。可以查看 Markdown 长回复、工具调用和任务状态，向正在运行的任务追加要求，或处理它发来的问题和审批。
- **查看执行过程**。对话默认收起同一轮的进度说明和工具调用，最终回复直接显示。点「用时」旁的箭头可以展开。旧记录缺少计时时显示「执行过程」。
- **筛选历史**。手机默认隐藏闲置的 Guardian 自动审阅记录。项目列表上方的「管理 → 对话显示」可进一步隐藏未载入的历史，或恢复显示全部。筛选只改变手机列表。
- **归档与恢复**。在聊天右上角「⋯ → 归档这段对话」确认。在首页「管理 → 已归档对话」点「恢复」可放回。操作同步到电脑，保留对话历史。
- **新聊天**。首页点「＋ 新聊天」，默认是「直接新聊天（无项目）」。也可以选「在已有项目中聊天」，或「新建项目并聊天」。新项目按名称保存在电脑的 `%USERPROFILE%\CodexProjects` 下，桌面确认项目后才发送首条消息。项目旁边的「＋」会预选该项目。已同步的无项目聊天集中在列表末尾的「无项目对话」。
- **隐藏和恢复项目**。在项目行的「⋯」选择「仅在本机隐藏此项目」，会在这部手机上收起该项目及其对话。电脑的项目、磁盘文件、历史和正在执行的任务都会保留。在项目列表上方打开「管理」，从「已隐藏项目」点「恢复显示」即可找回。
- **模型和额度**。点聊天标题下方的模型名称，按对话支持的能力选择模型、思考强度和权限。助手首页的额度圆环可打开剩余额度和重置时间。可用模型和额度窗口取决于当前账号。
- **阅读长回复**。代码块可以横向滑动和复制。向上翻历史时暂停跟随，点「↓ 回到最新」恢复跟随。

## 后台运行与更新

双击启动器可手动运行服务。要在登录 Windows 后自动运行配套服务，先连通一次，再双击同一文件夹里的 `Enable-Autostart.cmd`。后台服务和已配置的 Cloudflare 隧道会在 Windows 登录后运行。`Disable-Autostart.cmd` 可关闭自动启动。单独安装的 VPN 或隧道由各自的设置管理。

Codex 和 Antigravity 页都有「启动桌面」。绿点表示桌面窗口已打开，橙点表示正在启动或关闭。可在面板内确认关闭，Windows 会向对应的桌面窗口请求正常关闭。使用此功能需要 Windows 配套服务 1.0.0。

每次冷启动已配对的 App 会静默检查 GitHub Releases，发现可更新版本时可以选择「立即更新」或「稍后再说」。也可在「电脑 → 版本与更新」手动检查。

- **手机**。App 下载 Android APK 并校验 SHA-256，然后交给 Android 安装器。Android 要求用户确认，并校验覆盖安装签名。首次在 App 内安装更新时，可能需要授予「允许安装应用」权限。
- **电脑**。手机经配对连接发送目标版本号，电脑从 GitHub Releases 下载并校验 Windows ZIP。后台守护程序在新的目录中准备服务，切换后检查服务是否可用，启动失败会恢复旧版本。更新期间连接会短暂中断，可继续使用原来的配对令牌。电脑运行配套服务任务时，需等待当前任务结束再更新。

在 App 内更新 Windows 需要 0.9.47 或更新版的后台守护程序。使用旧版或手动启动的服务时，可完整解压新版 ZIP，退出旧服务后按原模式启动，或在解压目录双击 `Enable-Autostart.cmd`。配对信息保存在当前 Windows 用户的 `%LOCALAPPDATA%\CodexMobileRemote`。


## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 手机显示离线 | 在手机浏览器访问「服务器地址」加 `/health`。出现 `"ok": true` 表明 HTTP 路径已通。App 仍离线时，核对令牌，并确认代理支持 `/ws` 的 WebSocket 升级。 |
| 同一个 Wi-Fi 也连不上 | 核对电脑窗口显示的地址。访客 Wi-Fi 或校园网可能隔离设备。若窗口只显示 `127.0.0.1`，手机需要改用可访问的局域网、组网或隧道地址。 |
| ngrok 有地址，App 却掉线 | 检查 `Session Status`。显示 `reconnecting` 时，等待电脑恢复到 `online`。如使用代理节点，还要检查节点连接。 |
| 点击「启动桌面」后状态未变 | 检查电脑是否已登录 Windows、应用是否安装，以及是否在电脑上等待确认。关闭窗口需要 1.0.0 或更新版的配套服务。 |
| Codex 升级后部分桌面操作失败 | 已有对话的实时控制取决于 Codex Desktop 暴露的本地通道和会话状态。反馈时请注明桌面版本、连接方式及出错的操作，截图中遮住令牌。 |

## 从源码构建

下面的命令在 Windows PowerShell 中执行。准备 Git 和 Git LFS（用于下载通知音等资源）、Node.js 22.12 或更高版本、JDK 21，以及安装了 Android SDK Platform 36 的 Android SDK。为命令行构建配置好 `JAVA_HOME` 和 `ANDROID_HOME`。

```powershell
git lfs install
git clone https://github.com/jujubon/codex-remote-android.git
cd codex-remote-android
git lfs pull
npm.cmd ci
npm.cmd run build
npm.cmd test
```

**构建 Android 调试 APK**。下面同步已构建的网页资源并调用仓库内的 Gradle Wrapper。产物是 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。自行构建的调试包使用本机调试签名；覆盖安装要求新旧 APK 签名一致。

```powershell
cd apps/mobile
npx.cmd cap copy android
cd android
.\gradlew.bat assembleDebug
cd ../../..
```

**打包 Windows 配套程序**。从 Python 官网下载并解压 Windows x64 的 Python 3.13 embeddable package。回到仓库根目录，把下面的示例路径换成实际包含 `python.exe` 的目录。脚本会收集构建好的服务、依赖和 Python 运行时，生成 `dist/Codex-Remote-Windows-1.0.0.zip`。

```powershell
.\windows\Package-Host.ps1 -PythonDirectory 'C:\tools\python-embed'
```

## 来源和许可证

本仓库基于 [qy1603429908/CodexRemote](https://github.com/qy1603429908/CodexRemote) 开发。Windows 原生对话适配复用了 [IIMovoMII/Codex-QQ](https://github.com/IIMovoMII/Codex-QQ) 的部分实现。项目采用 [MIT 许可证](LICENSE)，复用代码的版权声明保存在 [Windows 适配层许可证](apps/server/windows/native/LICENSE)。

更多实现细节见[桌面 IPC](docs/desktop-ipc.md)、[增量同步与缓存](docs/incremental-sync-v0.3.md)、[Android 后台通知](docs/android-background.md)和[文件传输](docs/file-transfer.md)。
