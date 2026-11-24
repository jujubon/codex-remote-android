import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

type DesktopAction = {
  action: "open" | "create" | "projects" | "native-read" | "native-send" | "native-model-check";
  threadId: string;
  cwd?: string;
  prompt?: string;
  model?: string;
  thinking?: string;
  destination?: "projectless" | "newProject";
  projectName?: string;
};

export class DesktopActionError extends Error {
  constructor(message: string, readonly outcomeUnknown: boolean) { super(message); }
}

export async function desktopAction(request: DesktopAction) {
  const script = fileURLToPath(new URL("../windows/desktop_action.py", import.meta.url));
  const fallback = request.action.startsWith("native-");
  return new Promise<{
    thread_id?: string;
    projects?: { path: string; name: string }[];
    turn_id?: string;
    previous_turn_id?: string | null;
    snapshot?: unknown;
  }>((resolve, reject) => {
    const child = execFile(process.env.CMR_PYTHON || "python", ["-B", "-X", "utf8", script], {
      timeout: fallback ? 20_000 : 60_000, windowsHide: true, maxBuffer: fallback ? 4 * 1024 * 1024 : 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(new DesktopActionError("桌面操作回执不可用，请刷新对话核对结果。", true));
      try {
        const result = JSON.parse(stdout);
        if (result.state !== "confirmed") throw new DesktopActionError(result.reply || "桌面未确认操作。", result.state !== "rejected");
        resolve(result);
      } catch (reason) {
        reject(reason instanceof DesktopActionError ? reason : new DesktopActionError("无法核对桌面操作结果。", true));
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}
