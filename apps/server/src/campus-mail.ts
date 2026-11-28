import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeMail, isVoluntaryPetition, MailResultError, openMailGenerator, translateMailPart, translationChunks, type Importance, type MailSummary } from "./mail-analysis.js";

const mailHelper = fileURLToPath(new URL("../windows/campus_mail.py", import.meta.url));
const retained = 150;
const oneDay = 86_400_000;
type MailConfig = { address: string; secret: string; dataDir: string; model?: string; prioritySenders?: string[] };
type MailContent = { uid: number; subject: string; sender: string; address: string; receivedAt: number; body: string; truncated: boolean };
type Provider = "antigravity" | "ollama" | "off";
type Preferences = { provider?: Provider; prioritySenders?: string[] };
type Task = { state: "pending" | "review" | "done" | "ignored"; remindAt?: number; manual?: boolean };
type Message = MailContent & {
  id: string; noticedAt?: number; priority: boolean; summary?: MailSummary; summaryFailed?: boolean; retryAt?: number;
  translationParts?: string[]; translation?: string; override?: Importance; task?: Task; voluntaryPetition?: boolean;
};
type Cache = { epoch: number; cursor: number; rows: Message[]; lastSyncAt: number; preferences?: Preferences };
type Batch = { epoch: number; cursor: number; initial: boolean; more: boolean; rows: MailContent[]; error?: string };
export type MailAlert = { id: string; mailId?: string; at: number; priority: boolean; subject: string; preview?: string };
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const importanceOf = (row: Message) => row.override ?? (row.voluntaryPetition ? "promotion" : row.summary?.importance);
const normalizedAddress = /^[^\s@]+@[^\s@]+$/;
const schoolAddress = /^[a-z0-9._+%-]+@(?:[a-z0-9-]+\.)*csu\.edu\.cn$/i;
const qqAddress = /^[a-z0-9._+%-]+@qq\.com$/i;

export function classifyMailRow(row: Message): Message {
  if (row.voluntaryPetition !== undefined) return row;
  if (!isVoluntaryPetition(row)) return { ...row, voluntaryPetition: false };
  // Legacy review items were model suggestions. Keep finished or manually accepted tasks.
  const automated = row.task?.state === "review" || (row.task?.state === "pending" && !row.task.manual &&
    !row.task.remindAt && row.summary?.task === "explicit");
  return { ...row, voluntaryPetition: true, task: automated ? undefined : row.task,
    summary: row.summary ? { ...row.summary, importance: "promotion", task: "none", action: "", deadline: "", quote: "" } : undefined };
}

export function mailAlerts(rows: Message[], now: number, provider: Provider, failed: boolean): MailAlert[] {
  const alerts: MailAlert[] = [];
  for (const row of rows) {
    const preview = [row.summary?.action || row.summary?.overview, row.summary?.deadline].filter(Boolean).join(" · ").slice(0, 180);
    const importance = importanceOf(row);
    const important = importance === "important";
    const fallback = !importance && row.priority && (provider === "off" || failed || now - (row.noticedAt ?? now) >= 90_000);
    if (row.noticedAt && row.noticedAt >= now - oneDay && (important || fallback)) {
      alerts.push({ id: row.id, at: row.noticedAt, priority: true, subject: row.subject, preview: preview || undefined });
    }
    const remindAt = row.task?.state === "pending" ? row.task.remindAt : undefined;
    if (remindAt && remindAt <= now && remindAt >= now - oneDay) {
      alerts.push({ id: digest(`${row.id}:snooze:${remindAt}`), mailId: row.id, at: remindAt,
        priority: true, subject: row.subject, preview: preview || "待办提醒" });
    }
  }
  return alerts.sort((a, b) => b.at - a.at).slice(0, 30).reverse();
}

export function taskFromSummary(summary: MailSummary): Task | undefined {
  if (summary.importance === "promotion") return undefined;
  if (summary.task === "explicit") return { state: "pending" };
  if (summary.task === "review") return { state: "review" };
}

export class CampusMail {
  private cache?: Cache;
  private settings?: MailConfig;
  private accountKey?: string;
  private cachePath?: string;
  private polling?: Promise<void>;
  private summarizing?: Promise<void>;
  private interval?: NodeJS.Timeout;
  private status = "";
  private analysisStatus = "";
  private analyzingId?: string;
  private analysisAbort?: AbortController;
  private nextAnalysisAt = 0;
  private modelReady: boolean | null = null;
  private nextAttemptAt = 0;
  private backoff = 30_000;
  private stopped = false;
  private writeTail = Promise.resolve();

  constructor(private readonly configFile: string, private readonly publish: (alerts: MailAlert[]) => void) {}

  start() {
    void this.sync();
    this.interval = setInterval(() => {
      if (this.polling || this.nextAttemptAt > Date.now()) {
        this.publish(this.alerts());
        this.launchAnalysis();
      } else void this.sync();
    }, 30_000).unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.interval);
    this.analysisAbort?.abort();
  }

  private get provider(): Provider {
    return this.cache?.preferences?.provider ?? (this.settings?.model ? "ollama" : "off");
  }

  private get prioritySenders(): string[] {
    return this.cache?.preferences?.prioritySenders ?? (Array.isArray(this.settings?.prioritySenders)
      ? this.settings.prioritySenders.filter(value => typeof value === "string").map(value => value.toLowerCase()) : []);
  }

  alerts(): MailAlert[] {
    return mailAlerts(this.cache?.rows ?? [], Date.now(), this.provider, !!this.analysisStatus);
  }

  list() {
    return {
      configured: Boolean(this.settings), mailbox: this.settings ? (qqAddress.test(this.settings.address) ? "qq" : "csu") : undefined,
      mailboxId: this.accountKey,
      syncing: Boolean(this.polling), status: this.status,
      model: this.settings?.model ?? null, modelReady: this.modelReady, lastSyncAt: this.cache?.lastSyncAt ?? null,
      smartMail: true, provider: this.provider, prioritySenders: this.prioritySenders,
      analysisStatus: this.analysisStatus, analyzingId: this.analyzingId,
      pendingAnalysis: this.provider === "off" ? 0 : this.cache?.rows.filter(row =>
        !row.summary?.importance || row.summary.needsTranslation && !row.translation).length ?? 0,
      rows: this.cache?.rows.map(row => ({
        id: row.id, subject: row.subject, sender: row.sender, receivedAt: row.receivedAt,
        summary: row.summary?.overview, priority: row.priority, importance: importanceOf(row),
        task: row.task?.state !== "ignored" ? row.task : undefined,
        action: row.task?.state !== "ignored" ? row.summary?.action : undefined, deadline: row.summary?.deadline,
      })) ?? [],
    };
  }

  read(id: string) {
    const row = this.cache?.rows.find(row => row.id === id);
    if (!row) return undefined;
    const { subject, sender, address, receivedAt, body, truncated, summary, summaryFailed, priority, translation } = row;
    return { id, subject, sender, address, receivedAt, body, truncated, summary, summaryFailed, priority, translation,
      importance: importanceOf(row), importanceOverride: row.override, task: row.task?.state !== "ignored" ? row.task : undefined };
  }

  async configure(input: { provider?: unknown; cloudConsent?: unknown; prioritySenders?: unknown }) {
    const provider = input.provider;
    if (provider !== undefined && provider !== "off" && provider !== "ollama" && provider !== "antigravity")
      throw new Error("请选择有效的摘要方式。");
    if (provider === "ollama" && !this.settings?.model) throw new Error("请先在电脑配置 Ollama 模型。");
    if (provider === "antigravity" && input.cloudConsent !== true)
      throw new Error("请先确认 Antigravity 云端摘要授权。");
    const senders = input.prioritySenders;
    if (senders !== undefined && (!Array.isArray(senders) || senders.length > 60 ||
        senders.some(value => typeof value !== "string" || value.length > 254 || !normalizedAddress.test(value.trim())))) {
      throw new Error("请输入有效的邮箱地址，最多 60 个。");
    }
    const previous = this.provider;
    await this.changeCache(cache => {
      const addresses = Array.isArray(senders) ? [...new Set(senders.map((value: string) => value.trim().toLowerCase()))] : this.prioritySenders;
      const changed = provider !== undefined && provider !== this.provider;
      return { ...cache, preferences: { ...cache.preferences, ...(provider !== undefined ? { provider } : {}),
        ...(Array.isArray(senders) ? { prioritySenders: addresses } : {}) },
        rows: cache.rows.map(row => ({ ...row, priority: addresses.includes(row.address),
          ...(changed ? { retryAt: undefined, summaryFailed: undefined } : {}) })) };
    });
    if (previous !== this.provider) this.resetAnalysis();
    this.publish(this.alerts());
    this.launchAnalysis();
    return this.list();
  }

  async change(id: string, operation: unknown) {
    if (!["add", "complete", "reopen", "dismiss", "snooze", "important", "normal", "promotion", "automatic"].includes(String(operation)))
      throw new Error("无效的邮件操作。");
    await this.changeCache(cache => {
      if (!cache.rows.some(row => row.id === id)) throw new Error("这封邮件已离开近期收件箱。");
      return { ...cache, rows: cache.rows.map(row => {
        if (row.id !== id) return row;
        switch (operation) {
          case "add": case "reopen": return { ...row, task: { state: "pending", manual: true } };
          case "complete": return row.task ? { ...row, task: { state: "done", manual: row.task.manual } } : row;
          case "dismiss": return { ...row, task: { state: "ignored" } };
          case "snooze": return row.task?.state === "pending" ? { ...row, task: { ...row.task, remindAt: Date.now() + 3_600_000 } } : row;
          case "important": case "normal": case "promotion": return { ...row, override: operation };
          default: return { ...row, override: undefined };
        }
      }) };
    });
    this.publish(this.alerts());
    return this.read(id);
  }

  sync(force = false): Promise<void> {
    if (this.stopped || this.polling || (!force && this.nextAttemptAt > Date.now())) return this.polling ?? Promise.resolve();
    // Bound repeated manual retries in addition to the scheduled retry backoff.
    if (force && this.nextAttemptAt > Date.now() && this.backoff > 30_000) return Promise.resolve();
    if (force && this.cache && Date.now() - this.cache.lastSyncAt < 3_000) return Promise.resolve();
    this.polling = this.poll().catch(() => {
      this.status ||= "暂时无法同步邮箱，稍后会重试。";
      this.nextAttemptAt = Date.now() + this.backoff;
      this.backoff = Math.min(this.backoff * 2, 300_000);
    }).finally(() => {
      this.polling = undefined;
      if (!this.stopped) { this.publish(this.alerts()); this.launchAnalysis(); }
    });
    return this.polling;
  }

  private async poll() {
    const raw = await readFile(this.configFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!raw) {
      this.settings = this.cache = this.accountKey = this.cachePath = undefined;
      this.status = "";
      this.resetAnalysis();
      return;
    }
    let config: MailConfig | undefined;
    try { config = JSON.parse(raw.replace(/^\uFEFF/, "")) as MailConfig; } catch {}
    if (!config || typeof config.address !== "string" || (!schoolAddress.test(config.address) && !qqAddress.test(config.address)) ||
        typeof config.secret !== "string" || !config.secret || typeof config.dataDir !== "string" || !isAbsolute(config.dataDir)) {
      this.settings = this.cache = this.accountKey = this.cachePath = undefined;
      this.resetAnalysis();
      this.status = "邮箱配置无效，请在电脑上重新设置。";
      throw new Error("mail configuration");
    }
    if (typeof config.model !== "string" || !config.model) config.model = undefined;
    const key = digest(config.address.toLowerCase());
    const path = join(config.dataDir, `inbox-${key}.json`);
    const changed = this.accountKey !== key || this.settings?.dataDir !== config.dataDir;
    if (changed) {
      this.cache = undefined;
      this.accountKey = key;
      this.resetAnalysis();
    }
    if (this.settings?.model !== config.model && this.provider === "ollama") this.resetAnalysis();
    this.cachePath = path;
    this.settings = config;
    const cache = this.cache ?? await readFile(path, "utf8").then(data => JSON.parse(data) as Cache).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!this.cache && cache) this.cache = { ...cache, rows: cache.rows.map(classifyMailRow) };
    const batch = await readImap(config, cache);
    if (batch.error) {
      this.status = batch.error === "login" ? "邮箱未接受登录，请在电脑上核对客户端授权码。" : "邮箱暂时无法连接。";
      throw new Error("imap");
    }
    const now = Date.now();
    await this.mutate(async () => {
      const prioritySenders = new Set(this.prioritySenders);
      const rows = batch.rows.map(item => classifyMailRow({ ...item, id: digest(`${key}:${batch.epoch}:${item.uid}`),
        priority: prioritySenders.has(item.address), ...(batch.initial ? {} : { noticedAt: now }) }));
      const prior = this.cache?.rows ?? [];
      const next: Cache = { epoch: batch.epoch, cursor: batch.cursor, lastSyncAt: now,
        preferences: this.cache?.preferences,
        rows: [...rows.reverse(), ...(batch.initial ? prior.filter(row => row.task?.state === "pending" || row.task?.state === "review") : prior)]
          .filter((row, index) => index < retained || row.task?.state === "pending" || row.task?.state === "review" ||
            (this.provider !== "off" && (!row.summary?.importance || row.summary.needsTranslation && !row.translation))) };
      await saveCache(path, next);
      this.cache = next;
    });
    this.status = "";
    this.backoff = 30_000;
    this.nextAttemptAt = 0;
    if (batch.more) setTimeout(() => void this.sync(), 250).unref();
  }

  private mutate(task: () => Promise<void>) {
    const result = this.writeTail.then(task);
    this.writeTail = result.catch(() => undefined);
    return result;
  }

  private changeCache(change: (cache: Cache) => Cache, signal?: AbortSignal) {
    const path = this.cachePath;
    return this.mutate(async () => {
      if (signal?.aborted) return;
      if (this.stopped || !path || this.cachePath !== path || !this.cache) throw new Error("请先完成邮箱同步。");
      const next = change(this.cache);
      await saveCache(path, next);
      if (this.cachePath === path) this.cache = next;
    });
  }

  private resetAnalysis() {
    this.analysisAbort?.abort();
    this.nextAnalysisAt = 0;
    this.analysisStatus = "";
    this.modelReady = null;
  }

  private launchAnalysis() {
    const config = this.settings;
    const provider = this.provider;
    if (this.stopped || !this.cache || !config || provider === "off" || this.summarizing || this.nextAnalysisAt > Date.now()) return;
    const controller = new AbortController();
    this.analysisAbort = controller;
    this.summarizing = this.processAnalysis(config, provider, controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        this.analysisStatus = "暂时无法保存邮件分析，稍后会重试。";
        this.nextAnalysisAt = Date.now() + 120_000;
      }
    }).finally(() => {
      this.summarizing = undefined;
      this.analyzingId = undefined;
      if (!this.stopped) this.publish(this.alerts());
      if (controller.signal.aborted && !this.stopped) this.launchAnalysis();
    });
  }

  private async processAnalysis(config: MailConfig, provider: Exclude<Provider, "off">, signal: AbortSignal) {
    const generate = await openMailGenerator(provider, config.model, config.dataDir, signal).catch(() => undefined);
    if (signal.aborted) return;
    this.modelReady = !!generate;
    if (!generate) {
      this.analysisStatus = provider === "antigravity" ? "未找到电脑上的 Antigravity CLI。" : "本地 Ollama 模型暂不可用。";
      this.nextAnalysisAt = Date.now() + 120_000;
      return;
    }
    for (let index = 0; index < 24 && !signal.aborted; index++) {
      const available = (this.cache?.rows ?? []).filter(row => !row.retryAt || row.retryAt <= Date.now());
      const needsSummary = available.filter(row => !row.summary?.importance);
      const row = needsSummary.find(row => row.priority) ?? needsSummary[0] ??
        available.find(row => row.summary?.needsTranslation && !row.translation);
      if (!row) return;
      this.analyzingId = row.id;
      this.publish(this.alerts());
      try {
        let update: Partial<Message>;
        if (!row.summary?.importance) {
          const summary = await analyzeMail(generate, row);
          update = { summary, task: row.task ?? taskFromSummary(summary) };
        } else {
          const chunks = translationChunks(row.body);
          const parts = row.translationParts ?? [];
          const next = chunks[parts.length];
          const translated = next ? [...parts, await translateMailPart(generate, next)] : parts;
          update = translated.length < chunks.length ? { translationParts: translated }
            : { translation: translated.join("\n"), translationParts: undefined };
        }
        if (signal.aborted) return;
        await this.changeCache(cache => ({ ...cache, rows: cache.rows.map(entry => entry.id === row.id ? {
          ...entry, ...update, task: entry.task ?? update.task, retryAt: undefined, summaryFailed: undefined,
        } : entry) }), signal);
        this.analysisStatus = "";
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof MailResultError) {
          await this.changeCache(cache => ({ ...cache, rows: cache.rows.map(entry => entry.id === row.id
            ? { ...entry, summaryFailed: true, retryAt: Date.now() + 600_000 } : entry) }), signal);
          continue;
        }
        const reason = error instanceof Error ? error.message : "";
        this.analysisStatus = reason === "quota" ? "Antigravity 额度暂不可用，邮件会保留并稍后补分析。"
          : reason === "login" ? "请在电脑上登录 Antigravity CLI，邮件已保留。" : "邮件模型暂时无法处理，稍后会重试。";
        const retryAt = Date.now() + (reason === "quota" ? 15 * 60_000 : 120_000);
        this.nextAnalysisAt = retryAt;
        await this.changeCache(cache => ({ ...cache, rows: cache.rows.map(entry => entry.id === row.id
          ? { ...entry, summaryFailed: true, retryAt } : entry) }), signal);
        return;
      }
    }
  }
}

async function saveCache(path: string, cache: Cache) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(cache), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function readImap(config: MailConfig, cache?: Cache): Promise<Batch> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CMR_PYTHON || "python", ["-B", "-X", "utf8", mailHelper], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("IMAP timed out")); }, 95_000);
    const pieces: Buffer[] = [];
    let size = 0;
    child.on("error", reject);
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) child.kill();
      else pieces.push(chunk);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0 || size > 3 * 1024 * 1024) return reject(new Error("IMAP process failed"));
      try { resolve(JSON.parse(Buffer.concat(pieces).toString("utf8")) as Batch); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ address: config.address, secret: config.secret, epoch: cache?.epoch, cursor: cache?.cursor }));
  });
}
