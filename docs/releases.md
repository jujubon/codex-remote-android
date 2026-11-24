# 版本发布

每次更新用户可安装的版本，都同步在维护者的 GitHub 仓库发布 GitHub Release。

1. 同步 Android `versionName`、Windows 包名和 Host 健康接口的版本。Android `versionCode` 必须高于上一版。
2. 运行类型检查和测试，构建 Android APK 与 Windows ZIP。确认 APK 签名兼容覆盖安装，检查两个包的内容和 SHA-256。
3. 提交对应源码并推送到维护者仓库。基于该提交创建 `v<版本号>` 标签。
4. 用该标签发布 GitHub Release，附上 APK、ZIP 和 SHA-256，说明变更、升级方式和已知限制。发布后检查 Release 页面和两个附件。

## 0.9.11

- 手机可直接发起跨网投屏。Windows 打开接收窗口，Android 仍要求用户确认共享。
- 配置可信局域网地址后，App 可在局域网直连与 HTTPS 域名之间切换。
- 「电脑」页统一了投屏选择、按钮与翻页开关，并提供直接分享文件入口。
- 修复历史回放中提问与回答的顺序，加入删除未确认本地消息的入口，默认折叠工具详情。
- 修复桌面原生模式的模型选择和文本发送，改善额度读取及断线后的历史同步。

更新时在 Android 上覆盖安装，在 Windows 上退出旧配套服务并运行新版 `Start-Tunnel.cmd`。

桌面私有 IPC 不可用时，原生发送目前支持普通文字。实机上的 Wi-Fi 与 5G 切换、跨网投屏和 Windows 锁屏场景仍需验收。
