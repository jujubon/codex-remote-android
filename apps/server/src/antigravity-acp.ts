import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

type ObjectMap = Record<string, unknown>;
export const acpObject = (value: unknown): ObjectMap | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as ObjectMap : undefined;

type Permission = (params: ObjectMap, respond: (optionId?: string) => void) => void;

export class AntigravityAcp {
  private readonly pending = new Map<number, { finish: (error: Error | null, result?: unknown) => void }>();
  private sequence = 0;
  private closed = false;
  private readonly child;

  constructor(executable: string, cwd: string, onUpdate: (params: ObjectMap) => void, onPermission: Permission) {
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(?:CMR_|CODEX_|OPENAI_|CF_TUNNEL_)/i.test(key)));
    this.child = spawn(executable, ["acp"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail());
    this.child.once("error", () => this.fail());
    this.child.once("close", () => { lines.close(); this.fail(); });
    lines.on("line", line => {
      let message: ObjectMap | undefined;
      try { message = acpObject(JSON.parse(line)); } catch { return; }
      if (message?.jsonrpc !== "2.0") return;
      const params = acpObject(message.params) ?? {};
      const id = message.id;
      if (message.method === "session/update") { onUpdate(params); return; }
      if (typeof message.method === "string") {
        if (typeof id !== "string" && typeof id !== "number") return;
        if (message.method === "session/request_permission") {
          onPermission(params, optionId => this.send({
            id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } },
          }));
        } else {
          this.send({ id, error: { code: -32601, message: "Unsupported client method" } });
        }
        return;
      }
      if (typeof id !== "number") return;
      const error = acpObject(message.error);
      this.pending.get(id)?.finish(error ? acpError(error) : null, message.result);
    });
  }

  request(method: string, params: ObjectMap, timeoutMs = 20_000): Promise<ObjectMap> {
    if (this.closed) return Promise.reject(new Error("Antigravity 连接已关闭。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Antigravity 响应超时，请重试。")), timeoutMs);
      const finish = (error: Error | null, result?: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(acpObject(result) ?? {});
      };
      this.pending.set(id, { finish });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: ObjectMap) { this.send({ method, params }); }

  close(force = false) {
    this.fail();
    this.child.stdin.end();
    if (!force || !this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (process.platform !== "win32") { this.child.kill(); return; }
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const fallback = () => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    };
    killer.on("error", fallback);
    killer.on("exit", code => { if (code !== 0) fallback(); });
  }

  private send(message: ObjectMap) {
    if (!this.closed && this.child.stdin.writable)
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  private fail() {
    if (this.closed) return;
    this.closed = true;
    for (const { finish } of this.pending.values()) finish(new Error("Antigravity CLI 连接已结束。"));
  }
}

function acpError(error: ObjectMap): Error {
  const detail = typeof error.message === "string" ? error.message : "";
  if (error.code === -32000 || /authenticat|sign.in|credential|unauthorized/i.test(detail))
    return new Error("请先在电脑终端打开 agy 并完成登录，然后重试。");
  if (/workspace.{0,40}trust|trust.{0,40}workspace/i.test(detail))
    return new Error("请先在电脑端的 agy 中确认信任这个项目目录。");
  if (/quota|rate.limit|resource.exhausted/i.test(detail))
    return new Error("Antigravity 额度或请求频率达到上限，请稍后重试。");
  return new Error("Antigravity 未能完成请求，请在电脑端检查 CLI 状态后重试。");
}
