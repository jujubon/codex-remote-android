import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { ThreadSummary } from "@codex-mobile/protocol";

interface Turn {
  id: string;
  clientUserMessageId?: string;
  text: string;
  response: string;
  startedAt: number;
  completedAt?: number;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  error?: string;
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
};

const isTurn = (value: Turn) => value?.id && typeof value.text === "string" && typeof value.response === "string";
export const isAntigravityThread = (id: string) => id.startsWith("antigravity:");

function canonicalTurn(turn: Turn) {
  return {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.completedAt === undefined ? undefined : turn.completedAt - turn.startedAt,
    items: [
      { type: "userMessage", id: `${turn.id}:user`, clientUserMessageId: turn.clientUserMessageId, content: [{ type: "text", text: turn.text }] },
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
  private readonly active = new Map<string, { id: string; abort: AbortController }>();
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
      status: this.active.has(id) ? { type: "active", activeFlags: [] } : { type: "idle" },
      parentThreadId: null, agentNickname: null, agentRole: null, source: null,
    };
  }

  list() { return [...this.threads.keys()].map(id => this.summary(id)); }

  page(id: string, limit: number, cursor?: string | null) {
    const thread = this.getThread(id);
    const end = cursor ? thread.turns.findIndex(turn => turn.id === cursor) : thread.turns.length;
    if (end < 0) throw new Error("对话历史已变化，请重新打开。");
    const start = Math.max(0, end - limit);
    const turns = thread.turns.slice(start, end).map(canonicalTurn);
    return { turns, history: { hasMore: start > 0, nextCursor: start > 0 ? turns[0]!.id : null, backwardsCursor: null } };
  }

  async create(cwd: string, projectless: boolean, text: string, callbacks: (id: string, turnId: string) => Callbacks) {
    const id = `antigravity:${randomUUID()}`;
    this.threads.set(id, { id, cwd, projectless, title: text.replace(/\s+/g, " ").slice(0, 100), turns: [] });
    try { return { id, turn: await this.start(id, text, callbacks) }; }
    catch (error) { this.threads.delete(id); throw error; }
  }

  async start(id: string, text: string, callbacks: (id: string, turnId: string) => Callbacks, clientUserMessageId?: string) {
    if (!this.executable) throw new Error("电脑未安装 Antigravity CLI（agy）。");
    if (text.length > 20_000) throw new Error("消息过长，请缩短后再发送。");
    const thread = this.getThread(id);
    const received = clientUserMessageId && thread.turns.find(turn => turn.clientUserMessageId === clientUserMessageId);
    if (received) {
      if (received.text !== text) throw new Error("同一个消息编号已用于其他内容。");
      return canonicalTurn(received);
    }
    if (this.active.has(id)) throw new Error("Antigravity 正在执行，请等本轮结束。");
    if (!thread.sessionId && thread.turns.some(turn => turn.status === "completed"))
      throw new Error("Antigravity 没有返回可续聊的会话编号，请新建对话。");
    const turn: Turn = { id: randomUUID(), text, clientUserMessageId, response: "", startedAt: Date.now(), status: "inProgress" };
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

  private save() {
    const snapshot = JSON.stringify([...this.threads.values()].filter(thread => thread.turns.length));
    const next = this.writes.then(async () => {
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.filename), { recursive: true });
      try {
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, this.filename);
      } finally { await rm(temporary, { force: true }); }
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async run(executable: string, thread: Conversation, turn: Turn, signal: AbortSignal, callbacks: Callbacks) {
    try {
      const result = await runCli(executable, thread.cwd, thread.sessionId, turn.text, signal, (delta, sessionId) => {
        if (sessionId && thread.sessionId !== sessionId) {
          thread.sessionId = sessionId;
          void this.save().catch(() => console.warn("[antigravity] could not checkpoint session id"));
        }
        const text = delta.slice(0, Math.max(0, 512_000 - turn.response.length));
        if (!text) return;
        turn.response += text;
        callbacks.delta(`${turn.id}:agent`, text);
      });
      if (result.response) turn.response = result.response.slice(0, 512_000);
      turn.status = "completed";
      turn.error = result.notice;
    } catch (error) {
      turn.status = signal.aborted ? "interrupted" : "failed";
      turn.error = signal.aborted ? "已停止 Antigravity 当前轮。" : error instanceof Error ? error.message : "Antigravity 执行失败。";
    } finally {
      turn.completedAt = Date.now();
      try { await this.save(); } catch { console.warn("[antigravity] could not persist completed turn"); }
      this.active.delete(thread.id);
      callbacks.completed(canonicalTurn(turn));
    }
  }
}

async function runCli(executable: string, cwd: string, sessionId: string | undefined, text: string, signal: AbortSignal,
  onUpdate: (delta: string, sessionId?: string) => void): Promise<{ response?: string; notice?: string }> {
  signal.throwIfAborted();
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--mode", "default", "--print-timeout", "20m"];
  if (sessionId) args.push("--conversation", sessionId);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CMR_|CODEX_|OPENAI_|CF_TUNNEL_)/i.test(key)));
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const stop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32") { child.kill(); return; }
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    killer.on("exit", code => { if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill(); });
  };
  signal.addEventListener("abort", stop, { once: true });
  let diagnostics = "";
  let result: { status?: string; response?: string; error?: unknown } | undefined;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    try {
      const event = JSON.parse(line);
      if (event?.event === "result") result = event.result;
      if (event?.event !== "step_update") return;
      const step = event.step_update;
      const id = step?.conversation_id;
      onUpdate(step?.step_type === "agent_response" && typeof step.text_delta === "string" ? step.text_delta : "",
        typeof id === "string" && /^[a-z0-9-]{10,128}$/i.test(id) ? id : undefined);
    } catch { /* Ignore non-protocol output. */ }
  });
  child.stderr.on("data", chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-16_000); });
  child.stdin.on("error", () => undefined);
  try {
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    child.stdin.end(`${JSON.stringify({ event: "user", message: { content: text } })}\n`);
    const code = await finished;
    signal.throwIfAborted();
    const details = `${diagnostics}\n${JSON.stringify(result?.error ?? "")}`;
    if (code === 0 && result?.status === "SUCCESS") return {
      response: typeof result.response === "string" ? result.response : undefined,
      ...(/(?:soft.denied|permission.{0,36}denied|requires? (?:user )?approval)/i.test(details) ?
        { notice: "部分操作需要在 Antigravity 中审批，无界面会话已跳过这些操作。" } : {}),
    };
    if (/authenticat|sign.in|credential|unauthorized/i.test(details)) throw new Error("请先在电脑终端打开 agy 并完成登录，然后重试。");
    if (/workspace.{0,40}trust|trust.{0,40}workspace/i.test(details)) throw new Error("请先在电脑端的 agy 中确认信任这个项目目录。");
    if (/quota|rate.limit|resource.exhausted/i.test(details)) throw new Error("Antigravity 额度或请求频率达到上限，请稍后重试。");
    throw new Error("Antigravity 没有完成这一轮，请在电脑端检查 CLI 状态后重试。");
  } finally {
    lines.close();
    signal.removeEventListener("abort", stop);
  }
}
