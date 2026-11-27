import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import WebSocket from "ws";
import type { AppServerBridge } from "./app-server-bridge.js";
import { FileTransferError } from "./file-transfer.js";

type Operation = { operation: "list"; platform: "codex" } |
  { operation: "switch"; platform: "codex"; accountId: string };
type Target = { id: string; key: string; email?: string; label: string; plan?: string };
type SwitchStatus = { id: string; stage: "switching" | "verified" | "unverified" | "failed"; message?: string };

function row(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function conflict(message: string) {
  return new FileTransferError("INVALID_ARGUMENT", message, 409);
}

async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error();
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw new Error();
    return JSON.parse(buffer.toString("utf8", 0, bytesRead).replace(/^\uFEFF/, ""));
  } finally { await handle.close(); }
}

async function localStatus(home: string) {
  const override = process.env.COCKPIT_TOOLS_DATA_DIR?.trim();
  const preference = override ?? await readJson(join(home, ".cockpit_tools-data-root.json")).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (preference != null && (typeof preference !== "string" || !isAbsolute(preference))) throw new Error();
  const localPath = join(typeof preference === "string" ? preference : join(home, ".cockpit_tools"), "server.json");
  const data = row(await readJson(localPath).catch(error => {
    if (preference == null && error.code === "ENOENT") return readJson(join(home, ".antigravity_cockpit", "server.json"));
    throw error;
  }));
  return { port: data?.ws_port, token: data?.auth_token, version: data?.automation_version };
}

async function automation(home: string, command: Operation): Promise<unknown> {
  const status = await localStatus(home).catch(() => {
    throw conflict("请在电脑上打开 Cockpit Tools，并启用本地 WebSocket 服务。");
  });
  if (status.version !== 1) throw conflict("当前 Cockpit Tools 缺少兼容的账号自动化接口。请在电脑上更新至 1.5.3 或更新版本。");
  const { port, token } = status;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 ||
    typeof token !== "string" || token.length < 16 || token.length > 512) {
    throw conflict("Cockpit Tools 的本地连接信息无效。请重开 Cockpit Tools 后重试。");
  }
  const requestId = randomUUID();
  return new Promise((accept, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 3500, maxPayload: 512 * 1024 });
    const unavailable = () => conflict(command.operation === "list"
      ? "无法连接 Cockpit Tools。请确认桌面应用在线并启用了本地服务。"
      : "暂未收到 Cockpit Tools 切换回执，请先在电脑上核对当前账号。");
    const timer = setTimeout(() => finish(unavailable()), command.operation === "list" ? 7000 : 120_000);
    let settled = false;
    function finish(error?: Error, data?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error); else accept(data);
    }
    socket.once("open", () => socket.send(JSON.stringify({ type: "request.automation",
      payload: { version: 1, requestId, authToken: token, command } }), error => { if (error) finish(unavailable()); }));
    socket.on("error", () => finish(unavailable()));
    socket.once("close", () => finish(unavailable()));
    socket.on("message", (message, binary) => {
      if (binary) return;
      let event;
      try { event = row(JSON.parse(message.toString())); } catch { return; }
      const payload = row(event?.payload);
      if (event?.type !== "response.automation" || payload?.requestId !== requestId) return;
      if (payload.version === 1 && payload.status === "ok") finish(undefined, payload.data);
      else finish(conflict(payload.code === "unauthorized" ? "Cockpit Tools 本地认证失效，请重开 Cockpit Tools。"
        : "Cockpit Tools 未确认操作。请在电脑上检查账号登录和默认实例设置。"));
    });
  });
}

export class CockpitAccounts {
  private operation?: SwitchStatus;
  private accepting = false;
  private readonly home: string;

  constructor(private readonly bridge: Pick<AppServerBridge, "request" | "restart">,
    private readonly acquireIdle: () => boolean, private readonly releaseIdle: () => void,
    codexHome: string, home = homedir()) {
    this.home = home;
    this.supported = process.platform === "win32" && resolve(codexHome).toLowerCase() === resolve(home, ".codex").toLowerCase();
  }

  readonly supported: boolean;

  private async targets(): Promise<Target[]> {
    if (!this.supported) throw conflict("切换账号需要 Windows 上的 Codex 默认实例。");
    const list = await automation(this.home, { operation: "list", platform: "codex" });
    if (!Array.isArray(list)) throw conflict("Cockpit Tools 未返回有效的 Codex 账号列表。");
    return list.slice(0, 200).flatMap((value): Target[] => {
      const data = row(value);
      if (!data || typeof data.id !== "string" || !data.id || data.id.length > 512) return [];
      const key = createHash("sha256").update(data.id).digest("hex");
      const email = typeof data.email === "string" && /^[^\s@]+@[^\s@]+$/.test(data.email) && data.email.length <= 254
        ? data.email.toLowerCase() : undefined;
      const [local, domain] = email?.split("@") ?? [];
      const label = local ? `${local.slice(0, Math.max(0, Math.min(3, local.length - 1)))}•••@${domain}` : "Codex 账号";
      const plan = typeof data.plan === "string" && /^[a-z0-9 _-]{1,24}$/i.test(data.plan) ? data.plan : undefined;
      return [{ id: data.id, key, email, label, plan }];
    });
  }

  private async currentEmail(): Promise<string | undefined> {
    const reply = await this.bridge.request("account/read", { refreshToken: false }, 2500).catch(() => undefined);
    const email = row(row(reply)?.account)?.email;
    return typeof email === "string" ? email.toLowerCase() : undefined;
  }

  async list() {
    const accounts = await this.targets();
    const email = this.operation?.stage === "switching" ? undefined : await this.currentEmail();
    const matches = email ? accounts.filter(account => account.email === email) : [];
    return { accounts: accounts.map(({ key, label, plan }) => ({
      key, label: `${label} · ${key.slice(0, 4)}`, plan, current: matches.length === 1 && matches[0]?.key === key,
    })), operation: this.operation };
  }

  async start(key: unknown) {
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw new FileTransferError("INVALID_ARGUMENT", "账号编号无效。", 400);
    if (this.accepting || this.operation?.stage === "switching") throw conflict("已有账号切换正在处理，请稍候。");
    this.accepting = true;
    try {
      const accounts = await this.targets();
      const target = accounts.find(account => account.key === key);
      if (!target) throw conflict("账号列表已变化，请刷新后再选择。");
      if (!this.acquireIdle()) throw conflict("电脑仍在处理任务或更新，请等当前操作结束再切号。");
      const operation: SwitchStatus = { id: randomUUID(), stage: "switching" };
      this.operation = operation;
      void this.complete(operation, target, Boolean(target.email && accounts.filter(account => account.email === target.email).length === 1));
      return operation;
    } finally { this.accepting = false; }
  }

  status() { return { operation: this.operation }; }

  private async complete(operation: SwitchStatus, target: Target, identifiable: boolean) {
    try {
      const receipt = row(await automation(this.home, { operation: "switch", platform: "codex", accountId: target.id }));
      if (receipt?.accountId !== target.id || receipt.platform !== "codex") throw conflict("切换回执不完整，请在电脑上核对账号。");
      const reloaded = await this.bridge.restart().then(() => true, () => false);
      const verified = reloaded && identifiable && await this.currentEmail() === target.email;
      this.operation = { id: operation.id, stage: verified ? "verified" : "unverified" };
    } catch (error) {
      this.operation = { id: operation.id, stage: "failed", message: error instanceof FileTransferError
        ? error.message : "暂未确认切换，请在电脑上核对当前账号。" };
    } finally { this.releaseIdle(); }
  }
}
