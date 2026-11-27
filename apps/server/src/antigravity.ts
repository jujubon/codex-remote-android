import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApprovalDecision, ApprovalRequest, ThreadSummary } from "@codex-mobile/protocol";
import { acpObject, AntigravityAcp } from "./antigravity-acp.js";
import type { StoredUpload } from "./file-transfer.js";

const IMAGE_TYPE = /^image\/(?:png|jpeg|gif|webp)$/i;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 512 * 1024;
const APPROVAL_PREFIX = "antigravity-approval:";

interface Turn {
  id: string;
  clientUserMessageId?: string;
  text: string;
  response: string;
  startedAt: number;
  completedAt?: number;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  error?: string;
  attachments?: StoredUpload[];
}

interface Conversation {
  id: string;
  cwd: string;
  projectless: boolean;
  title: string;
  sessionId?: string;
  turns: Turn[];
}

type Callbacks = {
  delta: (itemId: string, delta: string) => void;
  completed: (turn: ReturnType<typeof canonicalTurn>) => void;
  approval: (approval: ApprovalRequest) => void;
  approvalResolved: (requestId: string) => void;
};

interface PendingPermission {
  approval: ApprovalRequest;
  options: Map<ApprovalDecision, string>;
  finish: (optionId?: string) => void;
}

const isTurn = (value: Turn) => value?.id && typeof value.text === "string" && typeof value.response === "string";
export const isAntigravityThread = (id: string) => id.startsWith("antigravity:");
export const isAntigravityApproval = (id: number | string): id is string =>
  typeof id === "string" && id.startsWith(APPROVAL_PREFIX);

function canonicalTurn(turn: Turn) {
  return {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.completedAt === undefined ? undefined : turn.completedAt - turn.startedAt,
    items: [
      { type: "userMessage", id: `${turn.id}:user`, clientUserMessageId: turn.clientUserMessageId,
        content: [{ type: "text", text: turn.text }],
        attachments: turn.attachments?.map(file => ({
          type: IMAGE_TYPE.test(file.mimeType) ? "image" : "file", name: file.fileName, path: file.path, mimeType: file.mimeType,
        })),
      },
      ...(turn.response ? [{ type: "agentMessage", id: `${turn.id}:agent`, phase: "final_answer", text: turn.response }] : []),
      ...(turn.error ? [{ type: "agentMessage", id: `${turn.id}:notice`, phase: "final_answer", text: turn.error }] : []),
    ],
  };
}

export async function findAntigravityCli(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const exe = process.platform === "win32" ? "agy.exe" : "agy";
  const candidates = env.CMR_AGY_BIN ? [env.CMR_AGY_BIN] : [
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "agy", "bin", exe)] : []),
    ...(env.PATH ?? "").split(delimiter).map(dir => join(dir, exe)),
  ];
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && (process.platform !== "win32" || /\.exe$/i.test(candidate)) &&
        (await stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
}

export class AntigravitySessions {
  private readonly threads = new Map<string, Conversation>();
  private readonly deleting = new Map<string, Promise<void>>();
  private readonly active = new Map<string, { id: string; abort: AbortController }>();
  private readonly permissions = new Map<string, PendingPermission>();
  private writes = Promise.resolve();

  private constructor(private readonly filename: string, private readonly executable?: string) {}

  static async open(filename: string, executable?: string) {
    const store = new AntigravitySessions(filename, executable);
    const content = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "[]";
    });
    for (const thread of JSON.parse(content) as Conversation[]) {
      if (!thread?.id || !isAntigravityThread(thread.id) || !isAbsolute(thread.cwd) || !Array.isArray(thread.turns)) continue;
      thread.turns = thread.turns.filter(isTurn).map(turn => turn.status === "inProgress"
        ? { ...turn, status: "interrupted", completedAt: Date.now(), error: "电脑服务已重启，这一轮已中断。" } : turn);
      if (thread.turns.length) store.threads.set(thread.id, thread);
    }
    return store;
  }

  get available() { return this.executable !== undefined; }
  currentTurn(id: string) { return this.active.get(id)?.id; }
  get hasActiveTurns() { return this.active.size > 0; }
  approvals() { return [...this.permissions.values()].map(permission => permission.approval); }

  resolveApproval(id: string, decision: ApprovalDecision) {
    const pending = this.permissions.get(id);
    if (!pending) throw new Error("这项 Antigravity 审批已结束。");
    const option = pending.options.get(decision);
    if (!option && decision !== "cancel") throw new Error("这项审批不支持所选操作。");
    pending.finish(option);
  }

  attachmentInUse(path: string) {
    return [...this.active.keys()].some(id => this.getThread(id).turns.at(-1)?.attachments?.some(file => file.path === path));
  }

  finishedTurn(id: string, turnId: string) {
    return this.threads.get(id)?.turns.some(turn => turn.id === turnId && turn.status !== "inProgress") === true;
  }

  private getThread(id: string) {
    const thread = this.threads.get(id);
    if (!thread) throw new Error("找不到这段 Antigravity 对话。");
    return thread;
  }

  summary(id: string): ThreadSummary {
    const thread = this.getThread(id);
    const last = thread.turns.at(-1);
    return {
      id, name: thread.title, cwd: thread.cwd, projectless: thread.projectless, assistant: "antigravity",
      preview: last?.text ?? thread.title, modelProvider: "antigravity", updatedAt: last?.completedAt ?? last?.startedAt ?? Date.now(),
      status: this.active.has(id) ? {
        type: "active", activeFlags: this.approvals().some(approval => approval.threadId === id) ? ["waitingOnApproval"] : [],
      } : { type: "idle" },
      parentThreadId: null, agentNickname: null, agentRole: null, source: null,
    };
  }

  list() { return [...this.threads.keys()].map(id => this.summary(id)); }

  async deleteConversation(id: string): Promise<void> {
    const pending = this.deleting.get(id);
    if (pending) return pending;
    if (this.active.has(id)) throw new Error("请先结束或停止当前 Antigravity 任务，再删除对话。");
    if (!this.threads.has(id)) return;
    const operation = this.save(id).finally(() => { this.deleting.delete(id); });
    this.deleting.set(id, operation);
    return operation;
  }

  page(id: string, limit: number, cursor?: string | null) {
    const thread = this.getThread(id);
    const end = cursor ? thread.turns.findIndex(turn => turn.id === cursor) : thread.turns.length;
    if (end < 0) throw new Error("对话历史已变化，请重新打开。");
    const start = Math.max(0, end - limit);
    const turns = thread.turns.slice(start, end).map(canonicalTurn);
    return { turns, history: { hasMore: start > 0, nextCursor: start > 0 ? turns[0]!.id : null, backwardsCursor: null } };
  }

  async create(cwd: string, projectless: boolean, text: string, callbacks: (id: string, turnId: string) => Callbacks, attachments?: StoredUpload[]) {
    const id = `antigravity:${randomUUID()}`;
    this.threads.set(id, { id, cwd, projectless, title: text.replace(/\s+/g, " ").slice(0, 100), turns: [] });
    try { return { id, turn: await this.start(id, text, callbacks, undefined, attachments) }; }
    catch (error) { this.threads.delete(id); throw error; }
  }

  async start(id: string, text: string, callbacks: (id: string, turnId: string) => Callbacks,
    clientUserMessageId?: string, attachments: StoredUpload[] = []) {
    if (this.deleting.has(id)) throw new Error("正在删除这段 Antigravity 对话。");
    if (!this.executable) throw new Error("电脑未安装 Antigravity CLI（agy）。");
    if (text.length > 20_000) throw new Error("消息过长，请缩短后再发送。");
    if (attachments.length > 10 || attachments.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES)
      throw new Error("Antigravity 每条消息最多可附带 10 个文件，合计不超过 12 MB。");
    const thread = this.getThread(id);
    const received = clientUserMessageId && thread.turns.find(turn => turn.clientUserMessageId === clientUserMessageId);
    if (received) {
      if (received.text !== text || (received.attachments ?? []).map(file => file.uploadId).join(",") !== attachments.map(file => file.uploadId).join(","))
        throw new Error("同一个消息编号已用于其他内容。");
      return canonicalTurn(received);
    }
    if (this.active.has(id)) throw new Error("Antigravity 正在执行，请等本轮结束。");
    if (!thread.sessionId && thread.turns.some(turn => turn.status === "completed"))
      throw new Error("Antigravity 没有返回可续聊的会话编号，请新建对话。");
    const turn: Turn = { id: randomUUID(), text, clientUserMessageId, response: "", startedAt: Date.now(),
      status: "inProgress", ...(attachments.length ? { attachments } : {}) };
    const abort = new AbortController();
    this.active.set(id, { id: turn.id, abort });
    thread.turns.push(turn);
    try { await this.save(); }
    catch (error) { this.active.delete(id); thread.turns.pop(); throw error; }
    setImmediate(() => void this.run(this.executable!, thread, turn, abort.signal, callbacks(id, turn.id)));
    return canonicalTurn(turn);
  }

  stop(id: string, turnId: string) {
    const active = this.active.get(id);
    if (active?.id !== turnId) throw new Error("这轮 Antigravity 任务已结束或已切换。");
    active.abort.abort();
  }

  close() { for (const { abort } of this.active.values()) abort.abort(); }

  private save(removeId?: string) {
    const snapshot = [...this.threads.values()].filter(thread => thread.turns.length)
      .map(thread => ({ id: thread.id, value: JSON.stringify(thread) }));
    const next = this.writes.then(async () => {
      const values = snapshot.filter(thread => thread.id !== removeId && this.threads.has(thread.id)).map(thread => thread.value);
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.filename), { recursive: true });
      try {
        await writeFile(temporary, `[${values.join(",")}]`, { mode: 0o600 });
        await rename(temporary, this.filename);
        if (removeId) this.threads.delete(removeId);
      } finally { await rm(temporary, { force: true }); }
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async run(executable: string, thread: Conversation, turn: Turn, signal: AbortSignal, callbacks: Callbacks) {
    let acp: AntigravityAcp | undefined;
    let capabilities: Record<string, unknown> | undefined;
    let sessionId = thread.sessionId;
    let prompting = false;
    let promptFinished = false;
    let deniedPermission = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const permissionIds = new Set<string>();
    const cancel = () => {
      if (prompting && sessionId) {
        acp?.notify("session/cancel", { sessionId });
        for (const id of permissionIds) this.permissions.get(id)?.finish();
        cancelTimer = setTimeout(() => acp?.close(true), 5000);
      } else if (!promptFinished) {
        acp?.close(true);
      }
    };
    try {
      signal.throwIfAborted();
      acp = new AntigravityAcp(executable, thread.cwd, params => {
        if (!prompting || params.sessionId !== sessionId) return;
        const update = acpObject(params.update);
        const content = acpObject(update?.content);
        if (update?.sessionUpdate !== "agent_message_chunk" || content?.type !== "text" || typeof content.text !== "string") return;
        const text = content.text.slice(0, Math.max(0, 512_000 - turn.response.length));
        if (!text) return;
        turn.response += text;
        callbacks.delta(`${turn.id}:agent`, text);
      }, (params, respond) => {
        if (signal.aborted || !prompting || params.sessionId !== sessionId) { respond(); return; }
        const options = new Map<ApprovalDecision, string>();
        for (const value of Array.isArray(params.options) ? params.options : []) {
          const option = acpObject(value);
          if (typeof option?.optionId !== "string") continue;
          if (option.kind === "allow_once") options.set("accept", option.optionId);
          if (option.kind === "reject_once") options.set("decline", option.optionId);
        }
        if (!options.has("decline")) options.set("cancel", "");
        const tool = acpObject(params.toolCall);
        const rawInput = acpObject(tool?.rawInput);
        const id = APPROVAL_PREFIX + randomUUID();
        const title = typeof tool?.title === "string" ? tool.title.slice(0, 2000) : "Antigravity 请求批准操作";
        const command = typeof rawInput?.command === "string" ? rawInput.command.slice(0, 16_000) : undefined;
        const locations = Array.isArray(tool?.locations) ? tool.locations.slice(0, 10).flatMap(location => {
          const path = acpObject(location)?.path;
          return typeof path === "string" ? [path.slice(0, 1000)] : [];
        }) : [];
        const approval: ApprovalRequest = {
          requestId: id, method: "antigravity/permission", threadId: thread.id, turnId: turn.id,
          title, command, cwd: thread.cwd, detail: locations.length ? locations.join("\n") : undefined,
          availableDecisions: [...options.keys()], raw: null,
        };
        permissionIds.add(id);
        this.permissions.set(id, { approval, options, finish: option => {
          permissionIds.delete(id);
          this.permissions.delete(id);
          if (!signal.aborted && (!option || option === options.get("decline"))) deniedPermission = true;
          respond(option);
          callbacks.approvalResolved(id);
        } });
        callbacks.approval(approval);
      });
      signal.addEventListener("abort", cancel, { once: true });
      const initialized = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: "codex-remote" } });
      if (initialized.protocolVersion !== 1) throw new Error("请更新电脑上的 Antigravity CLI。");
      const agent = acpObject(initialized.agentCapabilities);
      capabilities = acpObject(agent?.sessionCapabilities);
      const options = { cwd: thread.cwd, mcpServers: [] };
      let session;
      if (sessionId) {
        const method = capabilities?.resume ? "session/resume" : "session/load";
        session = await acp.request(method, { ...options, sessionId });
      } else {
        session = await acp.request("session/new", options);
        if (typeof session.sessionId !== "string" || !session.sessionId) throw new Error("Antigravity 未返回会话编号。");
        sessionId = session.sessionId;
        thread.sessionId = sessionId;
        await this.save();
      }
      const modes = acpObject(session.modes);
      if (typeof modes?.currentModeId === "string" && modes.currentModeId !== "default")
        await acp.request("session/set_mode", { sessionId, modeId: "default" });
      const prompt = [{ type: "text", text: turn.text }, ...await Promise.all((turn.attachments ?? []).map(file =>
        attachmentBlock(file, acpObject(agent?.promptCapabilities))))];
      signal.throwIfAborted();
      prompting = true;
      const result = await acp.request("session/prompt", { sessionId, prompt }, 20 * 60_000);
      prompting = false;
      promptFinished = true;
      if (result.stopReason === "cancelled") throw new Error("Antigravity 已取消这一轮。");
      signal.throwIfAborted();
      turn.status = "completed";
      if (result.stopReason === "max_tokens" || result.stopReason === "max_turn_requests")
        turn.error = "Antigravity 已达到本轮输出或请求上限，可以发送新消息继续。";
      else if (!turn.response && deniedPermission)
        turn.error = "已拒绝 Antigravity 请求的操作。";
    } catch (error) {
      turn.status = signal.aborted ? "interrupted" : "failed";
      turn.error = signal.aborted ? "已停止 Antigravity 当前轮。" : error instanceof Error ? error.message : "Antigravity 执行失败。";
    } finally {
      signal.removeEventListener("abort", cancel);
      clearTimeout(cancelTimer);
      for (const id of permissionIds) this.permissions.get(id)?.finish();
      try {
        if (acp && promptFinished && sessionId && capabilities?.close)
          await acp.request("session/close", { sessionId }, 3000);
      } catch { /* Stdin closes below even if session/close failed. */ }
      acp?.close(!promptFinished);
      turn.completedAt = Date.now();
      try { await this.save(); } catch { console.warn("[antigravity] could not persist completed turn"); }
      this.active.delete(thread.id);
      callbacks.completed(canonicalTurn(turn));
    }
  }
}

async function attachmentBlock(file: StoredUpload, capabilities?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mimeType = file.mimeType;
  const uri = pathToFileURL(file.path).href;
  if (capabilities?.image === true && IMAGE_TYPE.test(mimeType)) {
    const bytes = await readFile(file.path);
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("图片超过 Antigravity 的附件上限。");
    return { type: "image", mimeType, uri, data: bytes.toString("base64") };
  }
  if (capabilities?.embeddedContext === true && file.size <= MAX_INLINE_TEXT_BYTES) {
    const bytes = await readFile(file.path);
    const text = bytes.toString("utf8");
    if (bytes.length <= MAX_INLINE_TEXT_BYTES && !text.includes("\0") && !text.includes("�"))
      return { type: "resource", resource: { uri, mimeType, text } };
  }
  return { type: "resource_link", uri, mimeType, name: file.fileName, size: file.size };
}
