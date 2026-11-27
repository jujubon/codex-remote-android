import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HOST_VERSION } from "./config.js";
import { FileTransferError } from "./file-transfer.js";

type UpdateState = { version: string; stage: "pending" | "downloading" | "switching" | "completed" | "failed" };
const versionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const isUpdating = (state?: UpdateState): state is UpdateState =>
  Boolean(state && ["pending", "downloading", "switching"].includes(state.stage));

export class CompanionUpdates {
  private readonly path = process.platform === "win32" && process.env.CMR_LIFECYCLE_UPDATES === "1" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "CodexMobileRemote", "DesktopLifecycle", "update.json") : undefined;
  private accepting = false;

  constructor(private readonly pause: () => boolean, private readonly resume: () => void) {}

  get supported(): boolean { return this.path !== undefined; }

  async restoreGuard(): Promise<void> {
    if (isUpdating(await this.status()) && this.pause()) this.monitor();
  }

  async status(): Promise<UpdateState | undefined> {
    if (!this.path) return;
    const content = await readFile(this.path, "utf8").catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!content) return;
    const { version, stage } = JSON.parse(content.replace(/^\uFEFF/, "")) as UpdateState;
    return { version, stage };
  }

  async start(version: unknown): Promise<UpdateState> {
    const path = this.path;
    if (!path) throw new FileTransferError("INVALID_ARGUMENT", "此电脑需要先安装支持手机更新的 Windows 配套服务。", 409);
    if (typeof version !== "string" || !versionPattern.test(version))
      throw new FileTransferError("INVALID_ARGUMENT", "无效的发布版本。", 400);
    const current = HOST_VERSION.split(".").map(Number);
    const target = version.split(".").map(Number);
    if ((target[0]! - current[0]! || target[1]! - current[1]! || target[2]! - current[2]!) <= 0)
      throw new FileTransferError("INVALID_ARGUMENT", "电脑配套服务已达到该版本。", 409);
    if (this.accepting) throw new FileTransferError("INVALID_ARGUMENT", "电脑正在接受更新请求，请稍候。", 409);
    this.accepting = true;
    try {
      const previous = await this.status();
      if (isUpdating(previous)) {
        if (previous.version === version) return previous;
        throw new FileTransferError("INVALID_ARGUMENT", "电脑正在安装另一版本。", 409);
      }
      if (!this.pause()) throw new FileTransferError("INVALID_ARGUMENT", "电脑还有任务正在运行，请等本轮结束再更新。", 409);
      const state: UpdateState = { version, stage: "pending" };
      const temporary = path + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(state), { flag: "wx" });
        await rename(temporary, path);
      } catch (error) {
        this.resume();
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      this.monitor();
      return state;
    } finally {
      this.accepting = false;
    }
  }

  private monitor(): void {
    const timer = setInterval(() => void this.status().then(next => {
      if (isUpdating(next)) return;
      clearInterval(timer);
      this.resume();
    }).catch(() => undefined), 3000);
    timer.unref();
  }
}
