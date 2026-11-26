import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type DesktopAction = {
  action: "open" | "create" | "projects" | "native-read" | "native-send" | "native-model-check" | "native-project-create";
  threadId: string;
  cwd?: string;
  prompt?: string;
  model?: string;
  thinking?: string;
  destination?: "projectless" | "newProject";
  projectName?: string;
} | {
  action: "native-queue";
  threadId: string;
  prompt: string;
  codexBin: string;
  codexHome: string;
};

interface DesktopActionResult {
  thread_id?: string;
  projects?: { path: string; name: string }[];
  project?: { id?: string; path: string };
  turn_id?: string;
  previous_turn_id?: string | null;
  queue_id?: string;
  snapshot?: unknown;
}

export class DesktopActionError extends Error {
  constructor(message: string, readonly outcomeUnknown: boolean) { super(message); }
}

export async function desktopAction(request: DesktopAction): Promise<DesktopActionResult> {
  if (request.action === "native-queue") {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(request.threadId))
      throw new DesktopActionError("桌面对话 ID 无法确认，未加入队列。", false);
    try {
      const { stdout } = await promisify(execFile)(request.codexBin,
        ["queue", "--thread", request.threadId, "--message", request.prompt], {
          windowsHide: true, timeout: 20_000, env: { ...process.env, CODEX_HOME: request.codexHome },
        });
      const receipts = [...stdout.matchAll(/^Queued message ([\w-]+) for thread ([\w-]+)\.\s*$/gm)];
      if (receipts.length === 1 && receipts[0]?.[2] === request.threadId) return { queue_id: receipts[0][1] };
    } catch { /* Delivery may have completed before the CLI lost its receipt. */ }
    throw new DesktopActionError("未取得匹配的桌面排队回执，请核对桌面队列。", true);
  }
  const script = fileURLToPath(new URL("../windows/desktop_action.py", import.meta.url));
  const fallback = request.action.startsWith("native-") && request.action !== "native-project-create";
  return new Promise<DesktopActionResult>((resolve, reject) => {
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
