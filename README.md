# Codex Remote for Android

用 Android 手机继续 Windows 上的 Codex Desktop 对话。出门前在电脑上开始的任务，可以在手机上打开同一段历史、阅读长回复、追加要求或处理审批。任务在电脑上执行，沿用电脑上已登录的 Codex 账号。这个社区项目包含一个 Android App 和一个 Windows 配套服务。

## 第一次连接

准备一台能正常使用 **Codex Desktop** 的 Windows 电脑和一部 **Android 7.0 或更高版本**的手机。先在电脑端登录 Codex、打开一个对话，并确认可以正常发送消息。

1. 准备 Android 0.9.2 和 Windows 0.9.1，分别为 `Codex-Remote-0.9.2.apk` 和 `Codex-Remote-Windows-0.9.1.zip`。可以在[仓库的 Releases 页面](https://github.com/jujubon/codex-remote-android/releases)查看已发布附件；如果没有对应版本，请按下文从源码构建。
2. 在手机上安装 APK。把 Windows ZIP **完整解压到固定文件夹**。直接在压缩包预览里双击 `.cmd` 会让它找不到同目录的 PowerShell 脚本。
3. 第一次建议让手机和电脑连到同一可信 Wi-Fi。在解压目录双击 **`Start.cmd`**。电脑窗口会显示 `App address` 和 `Pairing token`。启动器优先使用 Codex 附带的 Node.js；如果提示找不到 `node.exe`，安装 Node.js 22.12 或更高版本后重试。
4. 在手机的「连接设置」分别填入这两项，点「保存并连接」。看到项目列表后，打开电脑上已有的对话并发送一条消息，在桌面核对回复。使用期间请让电脑保持唤醒，并让 Codex Desktop 和配套服务保持运行。

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

## 设备工具

Android 0.9.2 搭配 Windows 配套服务 0.9.1 使用。从首页底部点「电脑」打开设备工具。在运行中的聊天点右上角「⋯」，可以打开「熄屏挂机到本轮结束」。

- **剪贴板**。点击「发送手机剪贴板」或「拉取电脑剪贴板」来传输纯文本。需在手机打开 App 后操作，Windows 端使用登录用户的剪贴板。
- **锁屏与熄屏挂机**。「锁定电脑」请求 Windows 锁屏。「熄屏挂机」可选择 30 分钟、1 小时或 2 小时，也可从运行中的聊天保持到当前任务结束（最多 2 小时）。期间保持主机唤醒，鼠标键盘能再次点亮屏幕。到期、任务结束、停止挂机或退出 Windows 服务后，Windows 恢复原先的休眠策略。
- **分享**。从 Android 分享菜单选择「发送到电脑」来发送图片、PDF 或网页链接。接收后保存在 Windows 当前用户桌面下的 `PhoneDrop` 目录，单个文件上限 64 MB。可在「设备工具」开启选中分享入口后直接发送。设备工具与聊天附件使用各自的存储。

如需修改收件位置，在电脑的 `%LOCALAPPDATA%\CodexMobileRemote\device-tools.json` 写入以下设置。目录应使用支持硬链接的本地文件系统（例如 NTFS）。`autoOpen` 默认关闭，开启后会尝试打开收到的常见图片、PDF 或网页链接。链接也会作为文本保存在收件目录。配置在下一次请求时读取。

```json
{
  "receiveFolder": "D:\\PhoneDrop",
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
- **模型和额度**。点聊天标题下方的模型名称，打开「对话设置」选择模型、思考强度和权限。展开「账号与额度」可查看剩余额度和重置时间，首页底部也能查看额度。可用模型和额度窗口取决于当前账号。
- **阅读长回复**。代码块可以横向滑动和复制。向上翻历史时暂停跟随，点「↓ 回到最新」恢复跟随。Git 有变更时可在输入框上方展开查看。

## 后台运行与更新

双击启动器时，服务在当前窗口运行，可以最小化。希望它在登录 Windows 后自动运行，先用所选模式连通一次，再双击同一文件夹里的 `Enable-Autostart.cmd`。从下次登录起，服务使用已保存的地址在后台启动。`Disable-Autostart.cmd` 用于取消登录自启。VPN、ngrok 等外部软件需要单独配置自启。

更新时，用相同签名的新版 APK 覆盖安装。电脑端先停止旧服务，将同版本 ZIP 完整解压，再启动新版。如果更换了解压目录，在新目录重新运行一次 `Enable-Autostart.cmd`。配对信息保存在当前 Windows 用户的 `%LOCALAPPDATA%\CodexMobileRemote`，通常可以继续使用原令牌。

如果已经用 0.6.0 配好了 ngrok 和登录自启，可把新版 Windows ZIP 解压到新的固定文件夹，双击其中的 `Enable-Autostart.cmd`。保存电脑上的工作，下次重新登录 Windows 时新服务会接手原有隧道配置。手机直接覆盖安装新版 APK，沿用原地址和配对令牌。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 手机显示离线 | 在手机浏览器访问「服务器地址」加 `/health`。出现 `"ok": true` 表明 HTTP 路径已通。App 仍离线时，核对令牌，并确认代理支持 `/ws` 的 WebSocket 升级。 |
| 同一个 Wi-Fi 也连不上 | 核对电脑窗口显示的地址。访客 Wi-Fi 或校园网可能隔离设备。若窗口只显示 `127.0.0.1`，手机需要改用可访问的局域网、组网或隧道地址。 |
| ngrok 有地址，App 却掉线 | 检查 `Session Status`。显示 `reconnecting` 时，等待电脑恢复到 `online`。如使用代理节点，还要检查节点连接。 |
| 新任务仍然只能填目录 | 核对 APK 和正在运行的 Windows 服务是否都已升级至 0.7.0，尤其留意登录自启是否仍指向旧目录。 |
| Codex 升级后部分桌面操作失败 | 项目依赖 Codex Desktop 的本地 IPC。本版曾在 Windows Codex Desktop `26.1111.2228.0` 上验证真实对话读取；其他版本需要分别验证。反馈问题时请注明桌面版本、连接方式及出错的操作，截图中遮住令牌。 |

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

**打包 Windows 配套程序**。从 Python 官网下载并解压 Windows x64 的 Python 3.13 embeddable package。回到仓库根目录，把下面的示例路径换成实际包含 `python.exe` 的目录。脚本会收集构建好的服务、依赖和 Python 运行时，生成 `dist/Codex-Remote-Windows-0.9.1.zip`。

```powershell
.\windows\Package-Host.ps1 -PythonDirectory 'C:\tools\python-embed'
```

## 来源和许可证

本仓库基于 [qy1603429908/CodexRemote](https://github.com/qy1603429908/CodexRemote) 开发。Windows 原生对话适配复用了 [IIMovoMII/Codex-QQ](https://github.com/IIMovoMII/Codex-QQ) 的部分实现。项目采用 [MIT 许可证](LICENSE)，复用代码的版权声明保存在 [Windows 适配层许可证](apps/server/windows/native/LICENSE)。

更多实现细节见[桌面 IPC](docs/desktop-ipc.md)、[增量同步与缓存](docs/incremental-sync-v0.3.md)、[Android 后台通知](docs/android-background.md)和[文件传输](docs/file-transfer.md)。
