import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function desktopAction(request: { action: "open" | "create" | "projects"; threadId: string; cwd?: string; prompt?: string; destination?: "projectless" | "newProject"; projectName?: string }) {
  const script = fileURLToPath(new URL("../windows/desktop_action.py", import.meta.url));
  return new Promise<{ thread_id?: string; projects?: { path: string; name: string }[] }>((resolve, reject) => {
    const child = execFile(process.env.CMR_PYTHON || "python", ["-B", "-X", "utf8", script], { timeout: 60_000, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error("桌面操作回执不可用，请刷新对话核对结果。"));
      try {
        const result = JSON.parse(stdout);
        if (result.state !== "confirmed") throw new Error(result.reply || "桌面未确认操作。");
        resolve(result);
      } catch (reason) { reject(reason); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}
