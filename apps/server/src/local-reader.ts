import { spawn } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import { createInterface } from "node:readline";

const results = new Map([
  ["reader:missing", "电脑缺少投屏组件。请先在 Windows 打开「手机投屏」并完成安装。"],
  ["reader:no-device", "电脑未发现已连接的手机。请让两台设备连接同一 Wi-Fi，开启手机的无线调试。如尚未配对，请先在 Windows 完成配对。"],
  ["reader:multiple", "电脑发现多台已配对的手机。请在 Windows 的「手机投屏」中选择设备。"],
  ["reader:busy", "电脑上已有本地投屏小窗。"],
  ["reader:failed", "阅读窗未能打开。请检查手机的无线调试，然后重试。"],
]);

export class LocalReaderError extends Error {}

export function localReaderLauncher(script: string | undefined, viewerPort: number, remote = false): (() => Promise<void>) | undefined {
  if (process.platform !== "win32" || !script || !isAbsolute(script)) return undefined;
  const shell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return () => new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CMR_READER_VIEWER_PORT: String(viewerPort) };
    delete env.CMR_TOKEN;
    const child = spawn(shell, ["-NoProfile", "-STA", "-ExecutionPolicy", "RemoteSigned", "-File", script, remote ? "-RemoteFromPhone" : "-FromPhone"], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env,
    });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(remote ? "电脑没有确认跨网窗口已打开。" : "电脑没有确认阅读窗已打开。请检查无线调试后重试。"), remote ? 6500 : 11_000);
    const finish = (error?: string) => {
      clearTimeout(timer);
      lines.close();
      if (error) reject(new LocalReaderError(error));
      else resolve();
    };
    child.once("error", () => finish("无法启动 Windows 阅读窗。"));
    child.once("close", () => finish("Windows 阅读窗已退出。"));
    lines.on("line", line => {
      if (line === "reader:open") finish();
      else if (results.has(line)) finish(results.get(line));
    });
  });
}
