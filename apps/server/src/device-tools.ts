import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { link, mkdir, open, readFile, realpath, stat, unlink, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage } from "node:http";
import { FileTransferError, sanitizeFileName, type FileTransferManager, type StoredUpload } from "./file-transfer.js";

type Settings = { folder: string; autoOpen: boolean };
type Receipt = { fileName: string; opened: boolean };
type NativeReply = { ok: boolean; text?: string; opened?: boolean; muted?: boolean; displayOff?: boolean };
type CodexDesktopState = "unavailable" | "closed" | "starting" | "open";
type PowerHold = { child: ChildProcessWithoutNullStreams; until: number; tick: NodeJS.Timeout };
type SettingsDocument = { receiveFolder?: unknown; autoOpen?: unknown; chatAttachmentFolder?: unknown };
const CLIPBOARD_BYTES = 64 * 1024;
const RECEIPT_TTL = 30 * 60_000;
const windowsDeviceScript = fileURLToPath(new URL("../windows/device_tools.py", import.meta.url));

function invalid(message: string): never {
  throw new FileTransferError("INVALID_ARGUMENT", message, 400);
}

async function readSettingsDocument(settingsFile: string): Promise<SettingsDocument> {
  let settings: unknown;
  try { settings = JSON.parse((await readFile(settingsFile, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("电脑上的 device-tools.json 无法读取，请检查配置。", { cause: error });
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return invalid("电脑上的收件设置应为 JSON 对象。");
  return settings as SettingsDocument;
}

export async function findAntigravityDesktop(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const candidates = env.CMR_ANTIGRAVITY_DESKTOP_BIN ? [env.CMR_ANTIGRAVITY_DESKTOP_BIN] : [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Antigravity", "Antigravity.exe"),
    env.ProgramFiles && join(env.ProgramFiles, "Antigravity", "Antigravity.exe"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Antigravity", "Antigravity.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && isAbsolute(candidate) && parse(candidate).base.toLowerCase() === "antigravity.exe" &&
        (await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
}

export async function readChatAttachmentFolder(settingsFile: string): Promise<string | undefined> {
  const { chatAttachmentFolder } = await readSettingsDocument(settingsFile);
  if (chatAttachmentFolder === undefined) return undefined;
  if (typeof chatAttachmentFolder !== "string" || !isAbsolute(chatAttachmentFolder)) {
    return invalid("Codex 对话附件目录需要使用绝对路径。");
  }
  return resolve(chatAttachmentFolder);
}

function sharedName(value: string): string {
  const name = sanitizeFileName(value).replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/g, "");
  return /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])(?:[. ]|$)/i.test(name) ? "_" + name : name;
}

function shareLink(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value))
    return invalid("分享内容必须是有效的 HTTP 或 HTTPS 链接。");
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch { return invalid("分享内容必须是有效的 HTTP 或 HTTPS 链接。"); }
}

async function isPreviewable(path: string): Promise<boolean> {
  const ext = extname(path).toLowerCase();
  const handle = await open(path);
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes);
    const head = bytes.subarray(0, bytesRead);
    const ascii = head.toString("ascii");
    switch (ext) {
      case ".pdf": return ascii.startsWith("%PDF-");
      case ".jpg":
      case ".jpeg": return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      case ".png": return head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
      case ".gif": return ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a");
      case ".webp": return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
      default: return false;
    }
  } finally { await handle.close(); }
}

export async function storeDrop(directory: string, name: string, source: string | Buffer): Promise<string> {
  await mkdir(directory, { recursive: true });
  const folder = await realpath(directory);
  const { name: stem, ext } = parse(sharedName(name));
  const stage = join(folder, "." + randomUUID() + ".part");
  try {
    if (typeof source === "string") {
      await copyFile(source, stage);
    } else {
      const handle = await open(stage, "wx");
      try { await handle.writeFile(source); } finally { await handle.close(); }
    }
    // A hard link publishes the completed bytes without replacing an existing file.
    for (let suffix = 0; suffix < 1000; suffix++) {
      const destination = join(folder, suffix ? stem + " (" + suffix + ")" + ext : stem + ext);
      try {
        await link(stage, destination);
        return destination;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("收件目录中的同名文件过多。");
  } finally { await unlink(stage).catch(() => undefined); }
}

export class DeviceTools {
  readonly supported = process.platform === "win32";
  private clipboardOperation: Promise<unknown> = Promise.resolve();
  private antigravityLaunch?: Promise<void>;
  private codexLaunch?: Promise<CodexDesktopState>;
  private codexCheck?: Promise<CodexDesktopState>;
  private codexStartingUntil = 0;
  private readonly desktopCloseRequests = new Map<"codex" | "antigravity", Promise<boolean>>();
  private hold: PowerHold | null = null;
  private changingHold = false;
  private audioOperation: Promise<unknown> = Promise.resolve();
  private displayOperation: Promise<unknown> = Promise.resolve();
  private shutdownPendingUntil = 0;
  private shutdownError?: string;
  private readonly receipts = new Map<string, { operation: Promise<Receipt>; expiresAt: number }>();

  constructor(
    private readonly settingsFile: string,
    private readonly defaultFolder: string = join(homedir(), "Desktop", "PhoneDrop"),
    private readonly currentTurn: (threadId: string) => string | undefined = () => undefined,
    private readonly turnFinished: (threadId: string, turnId: string) => boolean = () => false,
    private readonly recordShare?: (path: string) => Promise<void>,
  ) {}

  async settings(): Promise<Settings> {
    const settings = await readSettingsDocument(this.settingsFile);
    const folder = settings.receiveFolder ?? this.defaultFolder;
    if (typeof folder !== "string" || !isAbsolute(folder)) return invalid("电脑上的收件目录需要使用绝对路径。");
    return { folder: resolve(folder), autoOpen: settings.autoOpen === true };
  }

  async status() {
    const [antigravity, codexDesktop] = await Promise.all([
      this.supported ? findAntigravityDesktop() : undefined,
      this.codexDesktopStatus().catch(() => undefined),
    ]);
    const info = {
      supported: this.supported,
      computerControls: this.supported,
      displayControl: this.supported,
      shutdownPending: Date.now() < this.shutdownPendingUntil,
      shutdownError: this.shutdownError,
      desktopCloseSupported: this.supported,
      awakeUntil: this.hold?.until ?? null,
      antigravityDesktopInstalled: Boolean(antigravity),
      antigravityDesktopOpen: antigravity
        ? await this.native({ action: "antigravity-status", target: antigravity }).then(result => result.opened).catch(() => undefined)
        : undefined,
      codexDesktop,
    };
    try {
      const settings = await this.settings();
      return { ...info, receiveFolder: settings.folder, autoOpen: settings.autoOpen };
    } catch (error) {
      return { ...info, receiveFolder: null, autoOpen: false, shareError: error instanceof Error ? error.message : "收件设置不可用。" };
    }
  }

  clipboardRead() {
    return this.queueClipboard(async () => {
      const result = await this.native({ action: "clipboard-read" });
      return { text: this.validateClipboard(result.text ?? "") };
    });
  }

  clipboardWrite(value: unknown) {
    const text = this.validateClipboard(value);
    return this.queueClipboard(() => this.native({ action: "clipboard-write", text }));
  }

  private validateClipboard(value: unknown): string {
    if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > CLIPBOARD_BYTES)
      return invalid("剪贴板目前支持最多 64 KB 的纯文本。");
    return value;
  }

  private queueClipboard<T>(run: () => Promise<T>): Promise<T> {
    const next = this.clipboardOperation.then(run);
    this.clipboardOperation = next.catch(() => undefined);
    return next;
  }

  async lock(): Promise<void> {
    await this.native({ action: "lock" });
  }

  audioMuteStatus() {
    return this.audioMute();
  }

  setAudioMute(muted: unknown) {
    if (typeof muted !== "boolean") return invalid("请提供有效的电脑静音状态。");
    return this.audioMute(muted);
  }

  private audioMute(muted?: boolean): Promise<{ muted: boolean }> {
    const next = this.audioOperation.then(async () => {
      const reply = await this.native(muted === undefined ? { action: "audio-mute-read" }
        : { action: "audio-mute-write", muted }).catch(() => {
        throw new Error("无法访问电脑的默认音频输出，请检查 Windows 声音设置。");
      });
      if (typeof reply.muted !== "boolean") throw new Error("电脑未返回静音状态。");
      return { muted: reply.muted };
    });
    this.audioOperation = next.catch(() => undefined);
    return next;
  }

  displayPowerStatus() {
    return this.displayPower();
  }

  setDisplayOff(off: unknown) {
    if (typeof off !== "boolean") return invalid("请提供有效的电脑屏幕状态。");
    return this.displayPower(off);
  }

  private displayPower(off?: boolean): Promise<{ displayOff: boolean }> {
    const next = this.displayOperation.then(async () => {
      const reply = await this.native(off === undefined ? { action: "display-power-read" }
        : { action: "display-power-write", off }).catch(() => {
        throw new Error(off === undefined ? "Windows 暂未报告屏幕状态。" : "Windows 暂未确认屏幕切换，请检查电脑后再试。");
      });
      if (typeof reply.displayOff !== "boolean") throw new Error("电脑未返回屏幕状态。");
      return { displayOff: reply.displayOff };
    });
    this.displayOperation = next.catch(() => undefined);
    return next;
  }

  requestShutdown() {
    if (Date.now() >= this.shutdownPendingUntil) {
      this.shutdownError = undefined;
      this.shutdownPendingUntil = Date.now() + 15_000;
      // Give the paired client time to receive its receipt before Windows signs out.
      setTimeout(() => {
        void this.native({ action: "shutdown" }).catch(() => {
          this.shutdownPendingUntil = 0;
          this.shutdownError = "Windows 未确认关机，请查看电脑上的权限或保存提示。";
        });
      }, 1500).unref();
    }
    return { requested: true };
  }

  private get codexDesktopAvailable(): boolean {
    return this.supported && process.env.CMR_CODEX_DESKTOP_APP_ID === "OpenAI.Codex_2p2nqsd0c76g0!App";
  }

  private async codexDesktopStatus(): Promise<CodexDesktopState> {
    if (!this.codexDesktopAvailable) return "unavailable";
    if (this.codexLaunch) return this.codexLaunch;
    this.codexCheck ??= this.native({ action: "codex-status" }).then(reply => {
      if (reply.opened === true) {
        this.codexStartingUntil = 0;
        return "open" as const;
      }
      return Date.now() < this.codexStartingUntil ? "starting" as const : "closed" as const;
    }).finally(() => { this.codexCheck = undefined; });
    return this.codexCheck;
  }

  async openCodexDesktop(): Promise<CodexDesktopState> {
    if (this.desktopCloseRequests.has("codex")) throw new FileTransferError("INVALID_ARGUMENT", "正在关闭 Codex 桌面，请稍后再试。", 409);
    if (!this.codexDesktopAvailable) throw new FileTransferError("INVALID_ARGUMENT", "电脑上未找到可启动的 Codex Desktop。", 409);
    if (this.codexLaunch) return this.codexLaunch;
    if (Date.now() < this.codexStartingUntil) return this.codexDesktopStatus();
    this.codexLaunch = this.native({ action: "codex-open" }).then(reply => {
      if (reply.opened === true) return "open" as const;
      this.codexStartingUntil = Date.now() + 20_000;
      return "starting" as const;
    }).finally(() => { this.codexLaunch = undefined; });
    return this.codexLaunch;
  }

  async ensureCodexDesktopOpen(): Promise<boolean> {
    let state = await this.openCodexDesktop();
    const deadline = this.codexStartingUntil;
    while (state === "starting" && Date.now() <= deadline) {
      await delay(500);
      state = await this.codexDesktopStatus();
    }
    return state === "open";
  }

  openAntigravityDesktop(): Promise<void> {
    if (this.desktopCloseRequests.has("antigravity")) throw new FileTransferError("INVALID_ARGUMENT", "正在关闭 Antigravity 桌面，请稍后再试。", 409);
    this.antigravityLaunch ??= (async () => {
      const target = this.supported ? await findAntigravityDesktop() : undefined;
      if (!target) throw new FileTransferError("INVALID_ARGUMENT", "电脑上未找到 Antigravity 桌面版。", 409);
      await this.native({ action: "antigravity-open", target });
    })().finally(() => { this.antigravityLaunch = undefined; });
    return this.antigravityLaunch;
  }

  closeDesktop(assistant: "codex" | "antigravity"): Promise<boolean> {
    const existing = this.desktopCloseRequests.get(assistant);
    if (existing) return existing;
    const operation = (async () => {
      if (assistant === "codex") {
        if (!this.codexDesktopAvailable) throw new FileTransferError("INVALID_ARGUMENT", "电脑上未找到 Codex Desktop。", 409);
        if (this.codexLaunch || Date.now() < this.codexStartingUntil)
          throw new FileTransferError("INVALID_ARGUMENT", "Codex 桌面正在启动，请稍后再关闭。", 409);
        return (await this.native({ action: "codex-close" })).opened === true;
      }
      if (this.antigravityLaunch) throw new FileTransferError("INVALID_ARGUMENT", "Antigravity 桌面正在启动，请稍后再关闭。", 409);
      const target = this.supported ? await findAntigravityDesktop() : undefined;
      if (!target) throw new FileTransferError("INVALID_ARGUMENT", "电脑上未找到 Antigravity 桌面版。", 409);
      return (await this.native({ action: "antigravity-close", target })).opened === true;
    })().finally(() => { this.desktopCloseRequests.delete(assistant); });
    this.desktopCloseRequests.set(assistant, operation);
    return operation;
  }

  async startHold(minutes: unknown, threadId: unknown): Promise<void> {
    if (this.changingHold) return invalid("正在切换熄屏挂机，请稍后重试。");
    const untilTask = minutes === "task";
    if (!untilTask && minutes !== 30 && minutes !== 60 && minutes !== 120) return invalid("请选择有效的挂机时长。");
    const taskThread = untilTask && typeof threadId === "string" ? threadId : undefined;
    const turn = taskThread ? this.currentTurn(taskThread) : undefined;
    if (untilTask && !turn) return invalid("电脑没有确认该任务正在执行，请刷新后重试或选择固定时长。");
    this.changingHold = true;
    const until = Date.now() + (untilTask ? 120 : minutes as number) * 60_000;
    try {
      const child = this.startNative();
      let exited = false;
      child.once("exit", () => {
        exited = true;
        if (this.hold?.child === child) this.stopHold();
      });
      await this.send(child, { action: "hold" }, true);
      if (exited) throw new Error("Windows 保持唤醒请求已结束。");
      this.stopHold();
      const tick = setInterval(() => {
        if (Date.now() >= until || (taskThread && turn && this.turnFinished(taskThread, turn))) this.stopHold();
      }, 1000);
      tick.unref();
      this.hold = { child, until, tick };
    } finally { this.changingHold = false; }
  }

  cancelHold(): void {
    if (this.changingHold) return invalid("正在启动熄屏挂机，请稍后再取消。");
    this.stopHold();
  }

  stopHold(): void {
    const lease = this.hold;
    this.hold = null;
    if (lease) {
      clearInterval(lease.tick);
      lease.child.stdin.end();
    }
  }

  private rememberDrop(requestId: string | undefined, run: () => Promise<Receipt>): Promise<Receipt> {
    if (!requestId || !/^[A-Za-z0-9_-]{20,100}$/.test(requestId)) return invalid("无效的传输请求编号。");
    const now = Date.now();
    for (const [id, result] of this.receipts) if (result.expiresAt <= now) this.receipts.delete(id);
    const previous = this.receipts.get(requestId);
    if (previous) return previous.operation;
    if (this.receipts.size >= 256) return invalid("收件请求过多，请稍后再试。");
    const operation = run().catch(error => {
      this.receipts.delete(requestId);
      throw error;
    });
    this.receipts.set(requestId, { operation, expiresAt: now + RECEIPT_TTL });
    return operation;
  }

  file(request: IncomingMessage, files: FileTransferManager): Promise<Receipt> {
    const requestId = request.headers["x-cmr-request-id"];
    const id = typeof requestId === "string" ? requestId : undefined;
    const cached = id && this.receipts.get(id);
    if (cached && cached.expiresAt > Date.now()) request.resume();
    return this.rememberDrop(id, async () => {
      const options = await this.settings();
      let upload: StoredUpload | undefined;
      try {
        let fileName = "file";
        try { fileName = decodeURIComponent(String(request.headers["x-cmr-filename"] ?? "file")); } catch { return invalid("无效的文件名。"); }
        const length = request.headers["content-length"];
        upload = await files.receiveUpload({
          stream: request, fileName: sharedName(fileName), mimeType: request.headers["content-type"],
          contentLength: length == null ? null : Number(length),
        });
        const saved = await storeDrop(options.folder, upload.fileName, upload.path);
        await this.indexShare(saved);
        return {
          fileName: parse(saved).base,
          opened: options.autoOpen && await this.openPreview(saved, "file"),
        };
      } finally {
        if (upload) await files.removeUpload(upload.uploadId).catch(() => undefined);
      }
    });
  }

  link(requestId: unknown, value: unknown): Promise<Receipt> {
    const url = shareLink(value);
    return this.rememberDrop(typeof requestId === "string" ? requestId : undefined, async () => {
      const options = await this.settings();
      const saved = await storeDrop(options.folder, "来自手机的链接.txt", Buffer.from(url + "\r\n"));
      await this.indexShare(saved);
      return { fileName: parse(saved).base, opened: options.autoOpen && await this.openPreview(url, "link") };
    });
  }

  private async indexShare(path: string) {
    try { await this.recordShare?.(path); }
    catch { console.warn("[file-inbox] could not index a saved share"); }
  }

  private async openPreview(target: string, kind: "file" | "link"): Promise<boolean> {
    try {
      if (kind === "file" && !(await isPreviewable(target))) return false;
      await this.native({ action: "open", target });
      return true;
    } catch { return false; } // The saved file is already durable; opening is optional.
  }

  private startNative(): ChildProcessWithoutNullStreams {
    const env = { ...process.env };
    delete env.CMR_TOKEN;
    return spawn(process.env.CMR_PYTHON || "python", ["-B", "-X", "utf8", windowsDeviceScript], { env, windowsHide: true });
  }

  private native(payload: object): Promise<NativeReply> {
    return this.send(this.startNative(), payload);
  }

  private send(child: ChildProcessWithoutNullStreams, payload: object, keepOpen = false): Promise<NativeReply> {
    return new Promise((resolve, reject) => {
      const reader = createInterface({ input: child.stdout });
      child.stderr.resume();
      let settled = false;
      const failure = () => new Error("电脑未确认操作，请检查 Windows 配套服务的登录会话。");
      const finish = (reply?: NativeReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reader.close();
        if (reply?.ok === true) {
          resolve(reply);
        } else {
          child.stdin.end();
          reject(failure());
        }
      };
      const fail = () => finish();
      const timer = setTimeout(() => { fail(); child.kill(); }, 6000);
      child.once("error", fail);
      child.stdin.on("error", fail);
      reader.once("close", fail);
      reader.once("line", line => {
        try { finish(JSON.parse(line) as NativeReply); }
        catch { fail(); }
      });
      const input = JSON.stringify(payload) + "\n";
      if (keepOpen) child.stdin.write(input);
      else child.stdin.end(input);
    });
  }
}
