import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MobileGateway, accountUsage, completedAttachmentTurn, desktopAttachmentPaths, isAbsoluteHostPath, projectDesktopLiveThread } from "../src/gateway.js";

it("cleans only completed turns tied to the opted-in attachment", () => {
  const path = "D:\\PhoneDrop\\attachment.png";
  const text = `查看图片\n\n手机上传到电脑的文件（请查看这些本地文件）：\n- ${JSON.stringify(path)}`;
  const item = { type: "userMessage", content: [{ type: "text", text }] };
  const turn = { id: "turn-a", status: "completed", items: [item] };
  expect(completedAttachmentTurn(turn, { path })).toBe(true);
  expect(completedAttachmentTurn(turn, { path, turnId: "turn-a" })).toBe(true);
  expect(completedAttachmentTurn(turn, { path, turnId: "turn-b" })).toBe(false);
  expect(completedAttachmentTurn({ ...turn, status: "inProgress" }, { path })).toBe(false);
  expect(completedAttachmentTurn({ ...turn, items: [{ ...item, type: "agentMessage" }] }, { path })).toBe(false);
});
import type { ServerConfig } from "../src/config.js";
import { PromptQueueStore } from "../src/prompt-queue.js";
import { DesktopActionError, type desktopAction } from "../src/windows-desktop.js";
import { FileTransferManager } from "../src/file-transfer.js";
import { AppServerRequestError } from "../src/app-server-bridge.js";


it("maps account limits without duplicate buckets or inventing missing windows", () => {
  const bucket = { limitId: "codex", planType: "plus", primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: {} };
  const usage = accountUsage({ rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } });
  expect(usage.plan).toBe("plus");
  expect(usage.windows).toEqual([{ group: "codex", minutes: 300, remainingPercent: 76, resetsAt: 2000000000000 }]);
  expect(accountUsage({}).windows).toEqual([]);
});

describe("Desktop live turn projection", () => {
  it("deduplicates the same active turn when Desktop exposes turnId without id", () => {
    const projected = projectDesktopLiveThread({
      id: "thread-1",
      turns: [
        { turnId: "turn-old", status: "completed", startedAt: 1, items: [{ id: "user-old", type: "userMessage" }] },
        { turnId: "turn-active", status: "inProgress", startedAt: 2, items: [{ id: "assistant-active", type: "agentMessage", text: "working" }] },
      ],
    });
    const turns = projected.turns as Array<Record<string, unknown>>;
    expect(turns.map((turn) => turn.id)).toEqual(["turn-old", "turn-active"]);
    expect(turns.filter((turn) => turn.id === "turn-active")).toHaveLength(1);
  });

  it("keeps the freshest fields and merges items for duplicate canonical turns", () => {
    const projected = projectDesktopLiveThread({
      id: "thread-1",
      turns: [
        { turnId: "turn-active", status: "inProgress", startedAt: 2, items: [{ itemId: "shared", type: "agentMessage", text: "old" }, { id: "first", type: "reasoning" }] },
        { turnId: "turn-active", status: "inProgress", startedAt: 2, updatedAt: 3, items: [{ itemId: "shared", type: "agentMessage", text: "new" }, { id: "second", type: "commandExecution" }] },
      ],
    });
    const turns = projected.turns as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: "turn-active", turnId: "turn-active", updatedAt: 3 });
    expect(turns[0]?.items).toEqual([
      { itemId: "shared", id: "shared", type: "agentMessage", text: "new" },
      { id: "first", type: "reasoning" },
      { id: "second", type: "commandExecution" },
    ]);
  });
});

class FakeBridge extends EventEmitter {
  ready = true;
  olderTurnImagePath?: string;
  calls: Array<{ method: string; params: unknown }> = [];
  responses: Array<{ id: string | number; result: unknown }> = [];
  threadListData: Array<Record<string, unknown>> = [
    { id: "thread-1", name: "Test", preview: "Hello", cwd: "/tmp", modelProvider: "custom", updatedAt: 1, status: { type: "notLoaded" }, parentThreadId: null, agentNickname: null, agentRole: null, source: "appServer" },
    { id: "agent-1", name: "Agent", preview: "Review", cwd: "/tmp", modelProvider: "custom", updatedAt: 2, status: { type: "notLoaded" }, source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", agent_nickname: "Meitner", agent_role: "reviewer" } } } },
  ];
  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return { data: this.threadListData, nextCursor: null };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-1", name: "Test", cwd: "/tmp", turns: [] } };
    }
    if (method === "thread/turns/list") {
      const cursor = (params as { cursor?: string }).cursor;
      return cursor
        ? { data: [{ id: "turn-old", status: "completed", items: [
          ...(this.olderTurnImagePath ? [{ id: "image-old", type: "userMessage", content: [{ type: "localImage", path: this.olderTurnImagePath }] }] : []),
          { id: "progress-old", type: "agentMessage", phase: "commentary", text: "Working" },
          { id: "reply-old", type: "agentMessage", phase: "final_answer", text: "Earlier final reply" },
        ] }], nextCursor: null, backwardsCursor: "newer" }
        : { data: [{ id: "turn-new", status: "completed", items: [{ id: "reply-new", type: "agentMessage", text: "Final reply" }] }], nextCursor: "older", backwardsCursor: null };
    }
    if (method === "model/list") {
      return { data: [{ id: "model-1", model: "model-1", displayName: "Model One", description: "Test model", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }] }] };
    }
    if (method === "skills/list") {
      return { data: [{ cwd: "/tmp", skills: [{ name: "review", description: "Review code", shortDescription: "Review", path: "/skills/review/SKILL.md", scope: "user", enabled: true }], errors: [] }] };
    }
    return {};
  }
  respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
  respondError(): void {}
}

class FakeDesktop extends EventEmitter {
  owner = true;
  ready = true;
  supported = true;
  steerError: Error | null = null;
  conversation: Record<string, unknown> = { id: "thread-1", threadRuntimeStatus: { type: "active", activeFlags: [] }, turns: [{ id: "turn-active", status: "inProgress", items: [] }] };
  calls: Array<{ method: string; threadId: string; params: Record<string, unknown> }> = [];
  hasOwner(): boolean { return this.owner; }
  getConversation(): Record<string, unknown> { return this.conversation; }
  async openConversation(): Promise<Record<string, unknown> | null> {
    return this.owner ? this.conversation : null;
  }
  async steerTurn(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "steer", threadId, params });
    if (this.steerError) throw this.steerError;
    return { id: "steered" };
  }
  async startTurn(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "start", threadId, params });
    return { id: "started" };
  }
  async interruptTurn(threadId: string, mode: "user" | "system"): Promise<unknown> {
    this.calls.push({ method: "interrupt", threadId, params: { mode } });
    return {};
  }
  async resolveApproval(threadId: string, method: string, requestId: string | number, response: unknown): Promise<void> {
    this.calls.push({ method, threadId, params: { requestId, response } });
  }
}

const token = "correct-token-which-is-at-least-32-chars";
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  token,
  tokenDigest: createHash("sha256").update(token).digest(),
  allowedOrigins: new Set(["capacitor://localhost"]),
  codexBin: "codex",
  codexHome: "/tmp/.codex",
  serverId: "test-server",
  desktopIpc: true,
  fileRoots: ["/tmp"],
  uploadDirectory: "/tmp",
  promptQueueFile: "/tmp/cmr-test-prompt-queue.json",
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()?.(); });

async function start(desktop?: FakeDesktop, promptQueue?: PromptQueueStore, overrides?: Partial<ServerConfig>,
                     runDesktopAction?: typeof desktopAction, files?: FileTransferManager) {
  const bridge = new FakeBridge();
  const gateway = new MobileGateway(bridge as never, { ...config, ...overrides }, desktop as never, files, promptQueue, runDesktopAction);
  const server = createServer();
  server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  closers.push(async () => {
    gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { bridge, gateway, port: address.port };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}



describe("Host path validation", () => {
  it("accepts absolute paths for the current Server platform", () => {
    if (process.platform === "win32") {
      expect(isAbsoluteHostPath("C:\\Users\\alice\\project")).toBe(true);
      expect(isAbsoluteHostPath("\\\\server\\share\\project")).toBe(true);
    } else {
      expect(isAbsoluteHostPath("/tmp/project")).toBe(true);
      expect(isAbsoluteHostPath("C:\\Users\\alice\\project")).toBe(false);
    }
  });

  it("rejects relative and drive-relative paths", () => {
    expect(isAbsoluteHostPath("project/file.txt")).toBe(false);
    expect(isAbsoluteHostPath("C:project\\file.txt")).toBe(false);
  });
});

describe("Desktop attachment extraction", () => {
  it("trusts only canonical user attachment fields, not arbitrary tool output paths", () => {
    expect(desktopAttachmentPaths({
      turns: [{ items: [
        { type: "steeringUserMessage", input: [{ type: "text", text: "hello" }, { type: "localImage", path: "/tmp/screen.png" }], attachments: [{ fsPath: "/tmp/screen.png" }], restoreMessage: { context: { imageAttachments: [{ localPath: "/tmp/screen.png" }] } } },
        { type: "commandExecution", output: "/etc/passwd", path: "/etc/passwd" },
      ] }],
    })).toEqual(["/tmp/screen.png"]);
  });

  it.skipIf(process.platform !== "win32")("accepts canonical Windows attachment paths", () => {
    expect(desktopAttachmentPaths({
      turns: [{ items: [{
        type: "steeringUserMessage",
        attachments: [{ fsPath: "C:\\Users\\alice\\screen.png" }],
      }] }],
    })).toEqual(["C:\\Users\\alice\\screen.png"]);
  });
});

describe("MobileGateway", () => {
  it("publishes a Desktop-confirmed title and follows subsequent title events", async () => {
    const actions: Parameters<typeof desktopAction>[0][] = [];
    const { bridge, gateway, port } = await start(undefined, undefined, { desktopOnly: true }, async action => {
      actions.push(action);
      return { thread_id: action.threadId, title: "新标题 📝" };
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${Buffer.from(token).toString("base64url")}`],
      { origin: "capacitor://localhost" });
    const messages: Array<{ type: string; upserts?: Array<{ id: string; name: string }> }> = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "threads.sync" }));
    await waitFor(() => messages.some(message => message.type === "threads.snapshot"));
    expect(await gateway.renameThread("thread-1", "新标题 📝")).toEqual({
      threadId: "thread-1", title: "新标题 📝", scope: "desktop",
    });
    expect(actions).toEqual([{ action: "native-rename", threadId: "thread-1", title: "新标题 📝" }]);
    await waitFor(() => messages.some(message => message.upserts?.some(row => row.id === "thread-1" && row.name === "新标题 📝")));
    bridge.emit("notification", { method: "thread/name/updated", params: { threadId: "thread-1", threadName: "电脑端标题" } });
    await waitFor(() => messages.some(message => message.upserts?.some(row => row.id === "thread-1" && row.name === "电脑端标题")));
    ws.close();
  });

  it("checks the persisted title after the app-server fallback and avoids a second write on an uncertain native result", async () => {
    let uncertain = false;
    const { bridge, gateway } = await start(undefined, undefined, { desktopOnly: true }, async () => {
      if (uncertain) throw new DesktopActionError("未知回执", true);
      throw new DesktopActionError("接口不可用", false, "desktop_rename_unavailable");
    });
    let saved = "Original";
    const fallback = bridge.request.bind(bridge);
    bridge.request = async (method, params) => {
      if (method === "thread/read") return { thread: { id: "thread-1", name: saved } };
      if (method === "thread/name/set") {
        expect(params).toEqual({ threadId: "thread-1", name: "修改后的标题" });
        saved = (params as { name: string }).name;
        return {};
      }
      return fallback(method, params);
    };
    expect(await gateway.renameThread("thread-1", "修改后的标题")).toMatchObject({ title: "修改后的标题", scope: "desktop" });
    uncertain = true;
    await expect(gateway.renameThread("thread-1", "不应该重试写入")).rejects.toThrow("未知回执");
    expect(saved).toBe("修改后的标题");
  });

  it("uses the confirmed Desktop archive for an idle conversation held by another writer", async () => {
    const actions: Parameters<typeof desktopAction>[0][] = [];
    const { bridge, port } = await start(undefined, undefined, { desktopOnly: true }, async action => {
      actions.push(action);
      return { thread_id: action.threadId };
    });
    const rpc = bridge.request.bind(bridge);
    bridge.request = async (method, params) => {
      const { threadId } = params as { threadId?: string };
      if (method === "thread/read") return { thread: { id: threadId,
        status: { type: threadId === "busy" ? "active" : "idle" }, turns: [] } };
      if (method === "thread/archive") {
        bridge.calls.push({ method, params });
        throw new AppServerRequestError("thread already has an active writer", -32600, null);
      }
      return rpc(method, params);
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${Buffer.from(token).toString("base64url")}`],
      { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    for (const threadId of ["busy", "thread-1"]) {
      ws.send(JSON.stringify({ type: "archive.set", threadId, requestId: threadId, archived: true }));
      await waitFor(() => messages.some(message => message.requestId === threadId));
    }
    expect(messages.find(message => message.requestId === "busy")).toMatchObject({ type: "error" });
    expect(messages.find(message => message.requestId === "thread-1")).toMatchObject({
      type: "archive.result", threadId: "thread-1", archived: true,
    });
    expect(actions).toEqual([{ action: "native-archive", threadId: "thread-1" }]);
    expect(bridge.calls.filter(call => call.method === "thread/archive")).toMatchObject([{ params: { threadId: "thread-1" } }]);
    ws.close();
  });

  it("recovers phone ownership from thread details when a fresh list omits the mobile source", async () => {
    const { bridge, port } = await start(undefined, undefined, { desktopOnly: true }, async () => ({}));
    const request = bridge.request.bind(bridge);
    bridge.request = async (method, params) => {
      if (!["thread/read", "thread/resume", "turn/start"].includes(method)) return request(method, params);
      bridge.calls.push({ method, params });
      if (method === "turn/start") return { turn: { id: "resumed-mobile-turn" } };
      return { thread: { id: "thread-1", cwd: "/tmp", threadSource: "codex-remote-mobile" } };
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${Buffer.from(token).toString("base64url")}`],
      { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const send = (message: object) => ws.send(JSON.stringify(message));
    send({ type: "threads.sync", requestId: "list-without-source" });
    await waitFor(() => messages.some(message => message.requestId === "list-without-source"));
    send({ type: "thread.open", requestId: "open-mobile-after-restart", threadId: "thread-1" });
    await waitFor(() => messages.some(message => message.requestId === "open-mobile-after-restart"));
    expect(messages.find(message => message.requestId === "open-mobile-after-restart")).toMatchObject({
      type: "thread", thread: { thread: { mobileManaged: true } },
    });
    send({ type: "turn.start", requestId: "resume-mobile-after-restart", threadId: "thread-1", text: "continue", clientUserMessageId: "resumed" });
    await waitFor(() => messages.some(message => message.requestId === "resume-mobile-after-restart"));
    expect(messages.find(message => message.requestId === "resume-mobile-after-restart")).toMatchObject({
      type: "turn.started", turn: { id: "resumed-mobile-turn" },
    });
    ws.close();
  });

  it("returns the verified Desktop project catalog when the legacy desktop IPC is offline", async () => {
    const desktop = new FakeDesktop();
    desktop.ready = desktop.owner = false;
    const calls: Parameters<typeof desktopAction>[0][] = [];
    const projects = [{ path: join(tmpdir(), "registered-project"), name: "Registered project" }];
    const { bridge, port } = await start(desktop, undefined, { desktopOnly: true }, async request => {
      calls.push(request);
      return { projects };
    });
    bridge.threadListData.unshift({
      id: "recent-mobile", name: "Mobile task", cwd: join(tmpdir(), "mobile"), updatedAt: 10,
      threadSource: "codex-remote-mobile-projectless",
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${Buffer.from(token).toString("base64url")}`],
      { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "projects.list", requestId: "project-picker" }));
    await waitFor(() => messages.some(message => message.requestId === "project-picker"));
    expect(calls).toEqual([{ action: "projects", threadId: "thread-1" }]);
    expect(messages.find(message => message.requestId === "project-picker")).toMatchObject({ type: "projects", projects });
    expect(bridge.calls.some(call => call.method === "turn/start")).toBe(false);
    ws.close();
  });

  it("keeps quota errors distinct from retries and accepts a new turn after recovery", async () => {
    const { bridge, port } = await start();
    const request = bridge.request.bind(bridge);
    let available = false;
    bridge.request = async (method, params) => {
      if (method !== "turn/start") return request(method, params);
      if (!available) throw new AppServerRequestError("Turn rejected", -32000, { codexErrorInfo: "usageLimitExceeded" });
      return { turn: { id: "recovered-turn", status: "inProgress" } };
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${Buffer.from(token).toString("base64url")}`],
      { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const send = (message: object) => ws.send(JSON.stringify(message));
    send({ type: "threads.sync", requestId: "initial-quota" });
    await waitFor(() => messages.some(message => message.requestId === "initial-quota"));

    const failedTurn = { id: "quota-turn", status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } };
    bridge.emit("notification", { method: "turn/started", params: { threadId: "thread-1", turn: { id: "quota-turn" } } });
    bridge.emit("notification", { method: "error", params: { threadId: "thread-1", turnId: "quota-turn", error: failedTurn.error, willRetry: true } });
    await waitFor(() => messages.some(message => message.method === "error"));
    expect(messages.find(message => message.method === "error")).not.toMatchObject({ params: { quotaLimited: true } });
    bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: failedTurn } });
    send({ type: "threads.sync", requestId: "after-quota" });
    await waitFor(() => messages.some(message => message.requestId === "after-quota"));
    expect(messages.find(message => message.requestId === "after-quota")).toMatchObject({
      threads: expect.arrayContaining([expect.objectContaining({ id: "thread-1", status: { type: "quotaLimited" } })]),
    });

    send({ type: "turn.start", requestId: "quota-refusal", threadId: "thread-1", text: "continue", clientUserMessageId: "quota-refusal" });
    await waitFor(() => messages.some(message => message.requestId === "quota-refusal"));
    expect(messages.find(message => message.requestId === "quota-refusal")).toMatchObject({
      type: "error", threadId: "thread-1", code: "usage_limit_reached",
    });
    available = true;
    send({ type: "turn.start", requestId: "quota-recovered", threadId: "thread-1", text: "continue", clientUserMessageId: "quota-recovered" });
    await waitFor(() => messages.some(message => message.requestId === "quota-recovered"));
    expect(messages.find(message => message.requestId === "quota-recovered")).toMatchObject({
      type: "turn.started", turn: { id: "recovered-turn" },
    });
    ws.close();
  });

  it("publishes project membership on the first list and pushes changes without opening the thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-project-membership-"));
    closers.push(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
    const stateFile = join(directory, ".codex-global-state.json");
    await writeFile(stateFile, JSON.stringify({ "projectless-thread-ids": ["thread-1"] }));
    const { bridge, port } = await start(undefined, undefined, { codexHome: directory, desktopOnly: true });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${Buffer.from(token).toString("base64url")}`],
      { origin: "capacitor://localhost" });
    const messages: Array<{ type: string; requestId?: string; upserts?: Array<{ id: string; projectless?: boolean }> }> = [];
    ws.on("message", data => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "threads.sync", requestId: "initial" }));
    await waitFor(() => messages.some(message => message.requestId === "initial"));
    expect(messages.find(message => message.requestId === "initial")).toMatchObject({
      threads: expect.arrayContaining([expect.objectContaining({ id: "thread-1", projectless: true })]),
    });

    bridge.emit("notification", { method: "thread/started", params: { thread: {
      id: "new-thread", cwd: directory, name: "Untitled", updatedAt: 3,
    } } });
    await writeFile(stateFile, JSON.stringify({ "projectless-thread-ids": ["new-thread"] }));
    const changesFor = (id: string) => messages.flatMap(message => message.upserts ?? []).filter(item => item.id === id);
    await waitFor(() => changesFor("new-thread").length > 0 && changesFor("thread-1").length > 0, 2200);
    expect(changesFor("new-thread")[0]?.projectless).toBe(true);
    expect(changesFor("thread-1").at(-1)?.projectless).toBe(false);
    expect(bridge.calls.every(call => call.method !== "thread/read")).toBe(true);
    ws.close();
  });

  it("classifies standalone chats in the first list and stages a model while Desktop owns the chat", async () => {
    const desktop = new FakeDesktop();
    const { bridge, port } = await start(desktop, undefined, { desktopOnly: true }, async () => ({}));
    const cwd = join(tmpdir(), "other-companion-install", "mobile-workspaces", "12345678-1234-4123-8123-123456789abc");
    const row = { id: "standalone", cwd, name: "Standalone", status: { type: "notLoaded" } };
    bridge.threadListData.unshift(row, { ...row, id: "real-project", name: "Real project" });
    const request = bridge.request.bind(bridge);
    bridge.request = async (method, params) => {
      const { threadId } = params as { threadId?: string };
      if (method === "thread/read" && ["standalone", "real-project"].includes(threadId ?? "")) {
        bridge.calls.push({ method, params });
        return { thread: { ...row, id: threadId, threadSource: threadId === "standalone" ? "codex-remote-mobile-projectless" : null } };
      }
      if (threadId === "standalone" && ["thread/resume", "turn/start"].includes(method)) {
        bridge.calls.push({ method, params });
        return method === "thread/resume" ? { thread: row } : { turn: { id: "new-turn" } };
      }
      return request(method, params);
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${Buffer.from(token).toString("base64url")}`],
      { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const send = (message: unknown) => ws.send(JSON.stringify(message));
    send({ type: "threads.list", requestId: "list" });
    await waitFor(() => messages.some(message => message.requestId === "list"));
    const list = messages.find(message => message.requestId === "list")?.threads as Array<Record<string, unknown>>;
    expect(list.find(thread => thread.id === "standalone")).toMatchObject({ projectless: true, mobileManaged: true });
    expect(list.find(thread => thread.id === "real-project")?.projectless).not.toBe(true);

    send({ type: "thread.settings", threadId: "standalone", model: "model-1", effort: "medium", requestId: "pick" });
    await waitFor(() => messages.some(message => message.requestId === "pick"));
    expect(messages.find(message => message.requestId === "pick")).toMatchObject({
      type: "thread.settings.updated", settings: { model: "model-1", effort: "medium" },
    });
    expect(bridge.calls.some(call => ["thread/settings/update", "thread/resume"].includes(call.method))).toBe(false);
    desktop.owner = false;
    send({ type: "turn.start", threadId: "standalone", text: "New prompt", requestId: "next", clientUserMessageId: "next" });
    await waitFor(() => messages.some(message => message.requestId === "next"));
    expect(messages.find(message => message.requestId === "next")?.type).toBe("turn.started");
    expect(bridge.calls.find(call => call.method === "turn/start")?.params).toMatchObject({ model: "model-1", effort: "medium" });
    ws.close();
  });

  it("manages a mobile-created thread inside the desktop host and releases it after the queue finishes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-managed-thread-"));
    closers.push(async () => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const { bridge, port } = await start(undefined, queue, { desktopOnly: true, promptQueueFile: join(directory, "queue.json") });
    const thread = { id: "managed", cwd: directory, model: "model-1", reasoningEffort: "medium", threadSource: "codex-remote-mobile" };
    let started = 0;
    let persisted = false;
    const request = bridge.request.bind(bridge);
    bridge.request = async (method, params) => {
      if (!["thread/start", "turn/start", "thread/read", "thread/turns/list"].includes(method)) return request(method, params);
      bridge.calls.push({ method, params });
      if (method === "turn/start") return { turn: { id: `mobile-turn-${++started}` } };
      if (method === "thread/read" && !persisted) throw new Error("failed to read session metadata: rollout is empty (-32603)");
      if (method === "thread/turns/list") return { data: [{ id: "mobile-turn-1", status: "inProgress", items: [] }], nextCursor: null };
      return { thread };
    };
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const send = (value: Record<string, unknown>) => ws.send(JSON.stringify(value));
    send({ type: "thread.start", requestId: "new", mobileManaged: true, cwd: directory, prompt: "first" });
    await waitFor(() => messages.some(message => message.requestId === "new"));
    expect(messages.find(message => message.requestId === "new")).toMatchObject({ type: "thread",
      thread: { thread: { mobileManaged: true, mobileRuntimeActive: true, mobileActiveTurnId: "mobile-turn-1", turns: [
        { id: "mobile-turn-1", items: [{ type: "userMessage", deliveryAcknowledged: true, content: [{ type: "text", text: "first" }] }] },
      ] } } });
    expect(bridge.calls.some(call => call.method === "thread/read")).toBe(false);
    send({ type: "thread.open", requestId: "reopen-before-write", threadId: "managed" });
    await waitFor(() => messages.some(message => message.requestId === "reopen-before-write"));
    expect(messages.find(message => message.requestId === "reopen-before-write")).toMatchObject({ type: "thread" });
    expect(started).toBe(1);
    persisted = true;

    const questions = [{ id: "happy", question: "Which option?", options: [{ label: "One" }] }];
    bridge.emit("serverRequest", { id: 55, method: "item/tool/requestUserInput", params: { threadId: "managed", turnId: "mobile-turn-1", questions } });
    await waitFor(() => messages.some(message => message.type === "approval"));
    expect(messages.find(message => message.type === "approval")).toMatchObject({
      approval: { requestId: 55, method: "item/tool/requestUserInput", threadId: "managed" },
    });
    send({ type: "approval.resolve", approvalRequestId: 55, decision: { kind: "answerQuestions", answers: { happy: "One" } } });
    await waitFor(() => bridge.responses.some(response => response.id === 55));
    expect(bridge.responses).toContainEqual({ id: 55, result: { answers: { happy: { answers: ["One"] } } } });
    send({ type: "turn.start", threadId: "managed", requestId: "stale", text: "old", deliveryMode: "steer", expectedTurnId: "old", clientUserMessageId: "old" });
    await waitFor(() => messages.some(message => message.requestId === "stale" && message.code === "no_active_turn"));
    send({ type: "turn.start", threadId: "managed", requestId: "steer", text: "now", deliveryMode: "steer", expectedTurnId: "mobile-turn-1", clientUserMessageId: "steer" });
    await waitFor(() => bridge.calls.some(call => call.method === "turn/steer"));
    expect(bridge.calls.filter(call => call.method === "turn/steer")).toMatchObject([{ params: { expectedTurnId: "mobile-turn-1" } }]);
    send({ type: "turn.start", threadId: "managed", requestId: "queue", text: "next", deliveryMode: "queue", clientUserMessageId: "queue" });
    await waitFor(() => messages.some(message => message.type === "prompt.queued"));
    expect(started).toBe(1);
    bridge.emit("notification", { method: "turn/completed", params: { threadId: "managed", turn: { id: "mobile-turn-1", status: "completed" } } });
    await waitFor(() => started === 2 && queue.list("managed").length === 0);
    expect(bridge.calls.some(call => call.method === "thread/unsubscribe")).toBe(false);
    send({ type: "turn.interrupt", threadId: "managed", turnId: "mobile-turn-2" });
    await waitFor(() => bridge.calls.some(call => call.method === "turn/interrupt"));
    expect(bridge.calls.find(call => call.method === "turn/interrupt")).toMatchObject({ params: { threadId: "managed", turnId: "mobile-turn-2" } });
    bridge.emit("notification", { method: "turn/completed", params: { threadId: "managed", turn: { id: "mobile-turn-2", status: "interrupted" } } });
    await waitFor(() => bridge.calls.some(call => call.method === "thread/unsubscribe"));
    ws.close();
  });
  it("authenticates and sends thread data", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await waitFor(() => messages.some((message) => message.type === "welcome"));
    expect(bridge.calls.some((call) => call.method === "thread/list")).toBe(false);
    ws.send(JSON.stringify({ type: "threads.sync", requestId: "initial-sync" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot"));
    const threadsMessage = messages.find((message) => message.type === "threads.snapshot");
    const threads = threadsMessage?.threads as Array<{ id: string; parentThreadId: string | null; agentNickname: string | null }>;
    expect(threads.find((thread) => thread.id === "agent-1")).toMatchObject({ parentThreadId: "thread-1", agentNickname: "Meitner" });
    const listCall = bridge.calls.find((call) => call.method === "thread/list");
    expect(listCall?.params).toMatchObject({ sourceKinds: expect.arrayContaining(["appServer", "subAgent", "subAgentThreadSpawn"]) });
    ws.close();
  });



  it("refreshes an initially empty thread index after app-server reconnects", async () => {
    const { bridge, port } = await start();
    bridge.threadListData = [];
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    ws.send(JSON.stringify({ type: "threads.sync", requestId: "empty-index" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot" && message.requestId === "empty-index"));
    expect((messages.find((message) => message.requestId === "empty-index")?.threads as unknown[])).toHaveLength(0);

    bridge.threadListData = [{
      id: "windows-thread",
      name: "Windows task",
      preview: "Recovered",
      cwd: process.platform === "win32" ? "C:\\Users\\alice\\project" : "/tmp/project",
      modelProvider: "custom",
      updatedAt: 3,
      status: { type: "notLoaded" },
      source: "appServer",
    }];
    bridge.emit("ready");
    ws.send(JSON.stringify({ type: "threads.sync", requestId: "recovered-index" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot" && message.requestId === "recovered-index"));
    expect((messages.find((message) => message.requestId === "recovered-index")?.threads as Array<{ id: string }>)).toMatchObject([{ id: "windows-thread" }]);
    ws.close();
  });

  it("keeps an app-server turn active when Desktop has not loaded the task", async () => {
    const desktop = new FakeDesktop();
    desktop.conversation = {
      id: "thread-1",
      threadRuntimeStatus: { type: "notLoaded" },
      turns: [],
    };
    const { bridge, port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "threads.sync", requestId: "initial-sync" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot"));
    const welcome = messages.find((message) => message.type === "welcome");
    ws.send(JSON.stringify({ type: "sync.resume", requestId: "subscribe", syncVersion: welcome?.syncVersion, cursor: welcome?.latestCursor, threadIds: ["thread-1"] }));
    await waitFor(() => messages.some((message) => message.type === "sync.replay" && message.requestId === "subscribe"));

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-running", status: "inProgress" } },
    });
    desktop.emit("snapshot", desktop.conversation);
    await waitFor(() => messages.some((message) => {
      if (message.type !== "event" || message.method !== "desktop/threadSnapshot") return false;
      const params = message.params as { thread?: { status?: { type?: string } } } | undefined;
      return params?.thread?.status?.type === "active";
    }));

    const desktopSnapshot = messages.findLast((message) => {
      if (message.type !== "event" || message.method !== "desktop/threadSnapshot") return false;
      const params = message.params as { thread?: { status?: { type?: string } } } | undefined;
      return params?.thread?.status?.type === "active";
    });
    const desktopParams = desktopSnapshot?.params as { thread?: { status?: unknown; threadRuntimeStatus?: unknown } } | undefined;
    expect(desktopParams?.thread?.status).toEqual({ type: "active", activeFlags: [] });
    expect(desktopParams?.thread?.threadRuntimeStatus).toEqual({ type: "active", activeFlags: [] });

    ws.send(JSON.stringify({ type: "threads.list", requestId: "active-after-not-loaded" }));
    await waitFor(() => messages.some((message) => message.type === "threads" && message.requestId === "active-after-not-loaded"));
    const activeThreadsMessage = messages.find((message) => message.type === "threads" && message.requestId === "active-after-not-loaded");
    const activeThreads = activeThreadsMessage?.threads as Array<{ id: string; status: unknown }>;
    expect(activeThreads.find((thread) => thread.id === "thread-1")?.status).toEqual({ type: "active", activeFlags: [] });

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-running", status: "completed" } },
    });
    ws.send(JSON.stringify({ type: "threads.list", requestId: "idle-after-completed" }));
    await waitFor(() => messages.some((message) => message.type === "threads" && message.requestId === "idle-after-completed"));
    const idleThreadsMessage = messages.find((message) => message.type === "threads" && message.requestId === "idle-after-completed");
    const idleThreads = idleThreadsMessage?.threads as Array<{ id: string; status: unknown }>;
    expect(idleThreads.find((thread) => thread.id === "thread-1")?.status).toEqual({ type: "idle" });
    ws.close();
  });

  it("streams Desktop snapshots only to sockets subscribed to the active task", async () => {
    const desktop = new FakeDesktop();
    desktop.conversation = {
      id: "thread-1",
      cwd: process.platform === "win32" ? "C:\\Users\\alice\\project" : "/tmp/project",
      threadRuntimeStatus: { type: "active", activeFlags: [] },
      turns: [{ id: "turn-live", status: "inProgress", items: [{ id: "item-1", type: "agentMessage", text: "one" }] }],
    };
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const subscribed = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const observer = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const subscribedMessages: Array<Record<string, unknown>> = [];
    const observerMessages: Array<Record<string, unknown>> = [];
    subscribed.on("message", (data) => subscribedMessages.push(JSON.parse(data.toString())));
    observer.on("message", (data) => observerMessages.push(JSON.parse(data.toString())));
    await Promise.all([
      new Promise<void>((resolve, reject) => { subscribed.once("open", resolve); subscribed.once("error", reject); }),
      new Promise<void>((resolve, reject) => { observer.once("open", resolve); observer.once("error", reject); }),
    ]);
    subscribed.send(JSON.stringify({ type: "thread.open", requestId: "desktop-open", threadId: "thread-1", historyLimit: 20 }));
    await waitFor(() => subscribedMessages.some((message) => message.type === "thread" && message.requestId === "desktop-open"));

    desktop.conversation = {
      ...desktop.conversation,
      turns: [{ id: "turn-live", status: "inProgress", items: [
        { id: "item-1", type: "agentMessage", text: "one" },
        { id: "item-2", type: "commandExecution", status: "inProgress" },
      ] }],
    };
    desktop.emit("snapshot", desktop.conversation);
    await waitFor(() => subscribedMessages.some((message) => message.type === "event" && message.method === "desktop/threadSnapshot"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(observerMessages.some((message) => message.type === "event" && message.method === "desktop/threadSnapshot")).toBe(false);
    const snapshot = subscribedMessages.findLast((message) => message.type === "event" && message.method === "desktop/threadSnapshot");
    const thread = (snapshot?.params as { thread?: { turns?: Array<{ items?: unknown[] }> } } | undefined)?.thread;
    expect(thread?.turns?.at(-1)?.items).toHaveLength(2);
    subscribed.close();
    observer.close();
  });

  it("drops stale Desktop active state when IPC goes offline", async () => {
    const desktop = new FakeDesktop();
    const { bridge, port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    desktop.emit("snapshot", desktop.conversation);
    await waitFor(() => messages.some((message) => message.type === "threads.delta"));
    bridge.threadListData = [{
      id: "thread-1", name: "Test", preview: "Hello", cwd: "/tmp", modelProvider: "custom", updatedAt: 10, status: { type: "notLoaded" }, source: "appServer",
    }];
    desktop.emit("offline");
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot"));
    const refreshed = messages.findLast((message) => message.type === "threads.snapshot");
    const threads = refreshed?.threads as Array<{ id: string; status: unknown }>;
    expect(threads.find((thread) => thread.id === "thread-1")?.status).toEqual({ type: "notLoaded" });
    ws.close();
  });

  it("does not let an inactive status notification override a known running turn", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-new", status: "inProgress" } },
    });
    bridge.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "notLoaded" } },
    });
    await waitFor(() => messages.some((message) => message.type === "event" && message.method === "thread/status/changed"));
    const statusEvent = messages.findLast((message) => message.type === "event" && message.method === "thread/status/changed");
    expect((statusEvent?.params as { status?: unknown } | undefined)?.status).toEqual({ type: "active", activeFlags: [] });

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-old", status: "completed" } },
    });
    ws.send(JSON.stringify({ type: "threads.list", requestId: "stale-completion" }));
    await waitFor(() => messages.some((message) => message.type === "threads" && message.requestId === "stale-completion"));
    const threadsMessage = messages.find((message) => message.type === "threads" && message.requestId === "stale-completion");
    const threads = threadsMessage?.threads as Array<{ id: string; status: unknown }>;
    expect(threads.find((thread) => thread.id === "thread-1")?.status).toEqual({ type: "active", activeFlags: [] });
    ws.close();
  });

  it("opens recent history and pages older turns without a full resume payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmr-desktop-image-"));
    closers.push(() => rm(root, { recursive: true, force: true }));
    const downloadsRoot = await mkdtemp(join(root, "allowed-"));
    const files = await FileTransferManager.create({ allowedRoots: [downloadsRoot], uploadDirectory: downloadsRoot });
    const imagePath = join(root, "clip.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));
    await expect(files.createDownloadTicket(imagePath)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    const { bridge, port } = await start(undefined, undefined, undefined, undefined, files);
    bridge.olderTurnImagePath = imagePath;
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    ws.send(JSON.stringify({ type: "thread.open", requestId: "open-page", threadId: "thread-1", historyLimit: 20, knownTurnIds: ["turn-new"] }));
    await waitFor(() => messages.some((message) => message.type === "thread" && message.requestId === "open-page"));
    expect(bridge.calls).toContainEqual({ method: "thread/resume", params: { threadId: "thread-1", excludeTurns: true } });
    expect(bridge.calls).toContainEqual({ method: "thread/turns/list", params: { threadId: "thread-1", limit: 20, sortDirection: "desc", itemsView: "full" } });
    expect(messages.find((message) => message.requestId === "open-page")?.history).toMatchObject({ nextCursor: "older", hasMore: true });
    expect(messages.find((message) => message.requestId === "open-page")?.thread).toMatchObject({
      thread: { turns: [{ id: "turn-new", items: [{ id: "reply-new", text: "Final reply" }] }] },
    });

    ws.send(JSON.stringify({ type: "thread.history", requestId: "older-page", threadId: "thread-1", cursor: "older", limit: 20, knownTurnIds: ["turn-old"] }));
    await waitFor(() => messages.some((message) => message.type === "thread.history" && message.requestId === "older-page"));
    expect(bridge.calls).toContainEqual({ method: "thread/turns/list", params: { threadId: "thread-1", cursor: "older", limit: 20, sortDirection: "desc", itemsView: "full" } });
    expect(messages.find((message) => message.requestId === "older-page")?.history).toMatchObject({ nextCursor: null, hasMore: false });
    expect(messages.find(message => message.requestId === "older-page")?.turns).toEqual([]);
    expect(messages).toContainEqual({
      type: "event", method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-old", item: { id: "image-old", type: "userMessage", content: [{ type: "localImage", path: imagePath }] } },
    });
    await expect(files.createDownloadTicket(imagePath)).resolves.toMatchObject({ fileName: "clip.png", mimeType: "image/png" });
    expect(messages).toContainEqual({
      type: "event", method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-old", item: { id: "reply-old", type: "agentMessage", phase: "final_answer", text: "Earlier final reply" } },
    });
    expect(messages.some(message => (message.params as { item?: { id: string } } | undefined)?.item?.id === "progress-old")).toBe(false);
    ws.close();
  });

  it("lists models and workspace skills", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "models.list", requestId: "models-1" }));
    ws.send(JSON.stringify({ type: "skills.list", requestId: "skills-1", cwd: "/tmp" }));
    await waitFor(() => messages.some((message) => message.type === "models") && messages.some((message) => message.type === "skills"));
    const models = messages.find((message) => message.type === "models")?.models as Array<{ model: string }>;
    const skills = messages.find((message) => message.type === "skills")?.skills as Array<{ name: string; cwd: string }>;
    expect(models[0]?.model).toBe("model-1");
    expect(skills[0]).toMatchObject({ name: "review", cwd: "/tmp" });
    expect(bridge.calls).toContainEqual({ method: "skills/list", params: { cwds: ["/tmp"] } });
    ws.close();
  });

  it("never widens workspace permissions to filesystem root", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "threads.sync", requestId: "initial-sync" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot"));

    ws.send(JSON.stringify({ type: "thread.settings", requestId: "safe-cwd", threadId: "thread-1", permissionMode: "auto" }));
    await waitFor(() => bridge.calls.some((call) => call.method === "thread/settings/update"));
    expect(bridge.calls.find((call) => call.method === "thread/settings/update")?.params).toMatchObject({
      threadId: "thread-1",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp"] },
    });

    ws.send(JSON.stringify({ type: "thread.settings", requestId: "missing-cwd", threadId: "unknown-thread", permissionMode: "auto" }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "missing-cwd"));
    expect(bridge.calls.filter((call) => call.method === "thread/settings/update")).toHaveLength(1);
    ws.close();
  });

  it("routes compact and model-aware turn requests", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "thread.compact", requestId: "compact-1", threadId: "thread-1" }));
    ws.send(JSON.stringify({ type: "thread.settings", requestId: "settings-1", threadId: "thread-1", model: "model-1", effort: "high", summary: "concise" }));
    ws.send(JSON.stringify({ type: "turn.start", requestId: "turn-1", threadId: "thread-1", text: "Review", model: "model-1", effort: "high", summary: "concise", skill: { name: "review", path: "/skills/review/SKILL.md" } }));
    await waitFor(() => messages.some((message) => message.type === "thread.compaction.accepted") && messages.some((message) => message.type === "thread.settings.updated") && messages.some((message) => message.type === "turn.started"));
    expect(bridge.calls).toContainEqual({ method: "thread/compact/start", params: { threadId: "thread-1" } });
    expect(bridge.calls).toContainEqual({ method: "thread/settings/update", params: { threadId: "thread-1", model: "model-1", effort: "high", summary: "concise" } });
    expect(bridge.calls).toContainEqual({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "skill", name: "review", path: "/skills/review/SKILL.md" }, { type: "text", text: "Review", text_elements: [] }],
        model: "model-1",
        effort: "high",
        summary: "concise",
      },
    });
    ws.close();
  });

  it("sends an authoritative approval snapshot on reconnect", async () => {
    const { port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await waitFor(() => messages.some((message) => message.type === "approvals.snapshot"));
    expect(messages.find((message) => message.type === "approvals.snapshot")).toMatchObject({ approvals: [] });
    ws.close();
  });

  it("suppresses mirrored app-server command approvals for Desktop-owned tasks but keeps MCP elicitations", async () => {
    const desktop = new FakeDesktop();
    const { bridge, gateway } = await start(desktop);
    desktop.emit("snapshot", desktop.conversation);
    bridge.emit("serverRequest", {
      id: 81,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-active", itemId: "command-1", command: "echo mirrored" },
    });
    bridge.emit("serverRequest", {
      id: 82,
      method: "mcpServer/elicitation/request",
      params: { threadId: "thread-1", turnId: "turn-active", message: "Allow Computer Use?" },
    });
    const approvals = (gateway as unknown as { approvals: Map<string | number, unknown> }).approvals;
    await waitFor(() => approvals.has(82));
    expect(approvals.has(81)).toBe(false);
    expect(approvals.has(82)).toBe(true);
  });

  it("clears an app-server approval when the corresponding item completes", async () => {
    const { bridge, gateway } = await start();
    bridge.emit("serverRequest", {
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", command: "echo hi" },
    });
    const approvals = (gateway as unknown as { approvals: Map<string | number, unknown> }).approvals;
    await waitFor(() => approvals.has(91));
    bridge.emit("notification", {
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "command-1", status: "failed" } },
    });
    await waitFor(() => !approvals.has(91));
  });

  it("routes command approvals back to app-server", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    bridge.emit("serverRequest", { id: 42, method: "item/commandExecution/requestApproval", params: { command: "echo hi", cwd: "/tmp" } });
    await waitFor(() => messages.some((message) => message.type === "approval"));
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: 42, decision: "accept" }));
    await waitFor(() => bridge.responses.length === 1);
    bridge.emit("notification", { method: "serverRequest/resolved", params: { requestId: 42 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.responses).toEqual([{ id: 42, result: { decision: "accept" } }]);
    expect(messages.filter((message) =>
      message.type === "approval.resolved" && message.approvalRequestId === 42
    )).toHaveLength(1);
    ws.close();
  });

  it("routes native Computer Use MCP elicitations through the phone approval flow", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const elicitation = {
      id: 47,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "t1",
        turnId: "turn1",
        serverName: "node_repl",
        message: 'Allow Computer Use to use "Finder"?',
        _meta: {
          connector_name: "Computer Use",
          persist: ["session", "always"],
          tool_params: { app: "com.apple.finder" },
        },
      },
    };
    bridge.emit("serverRequest", elicitation);
    bridge.emit("serverRequest", elicitation);
    await waitFor(() => messages.some((message) => message.type === "approval"));
    expect(messages.filter((message) => message.type === "approval")).toHaveLength(1);
    const approval = messages.find((message) => message.type === "approval")?.approval as {
      title: string;
      detail: string;
      availableDecisions: unknown[];
    };
    expect(approval).toMatchObject({
      title: "允许 Computer Use 操作？",
      detail: 'Allow Computer Use to use "Finder"?',
    });
    expect(approval.availableDecisions).toEqual(["decline", "accept", "acceptForSession"]);
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: 47, decision: "acceptForSession" }));
    await waitFor(() => bridge.responses.length === 1);
    expect(bridge.responses).toEqual([{
      id: 47,
      result: {
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      },
    }]);
    ws.close();
  });
  it("routes a chosen option and a custom answer to the waiting Desktop request", async () => {
    const desktop = new FakeDesktop();
    const { bridge, port } = await start(desktop, undefined, { desktopOnly: true });
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const method = "item/tool/requestUserInput";
    const questions = [
      { id: "choice", question: "Which route?", options: [{ label: "Wi-Fi" }, { label: "Hotspot" }] },
      { id: "detail", question: "Enter the address.", options: [] },
    ];
    desktop.emit("snapshot", { ...desktop.conversation,
      requests: [{ id: 42, method, params: { threadId: "thread-1", turnId: "turn-active", questions } }],
    });
    await waitFor(() => messages.some(message => message.type === "approval"));
    expect(messages.find(message => message.type === "approval")?.approval).toMatchObject({ method, raw: { questions } });
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: "desktop:thread-1:42",
      decision: { kind: "answerQuestions", answers: { choice: "Hotspot", detail: "Found the port" } } }));
    await waitFor(() => messages.some(message => message.type === "approval.resolved"));
    expect(desktop.calls).toContainEqual({ method, threadId: "thread-1", params: { requestId: 42,
      response: { answers: { choice: { answers: ["Hotspot"] }, detail: { answers: ["Found the port"] } } },
    } });
    expect(bridge.responses).toEqual([]);
    ws.close();
  });

  it("keeps Desktop approvals pending when only app-server goes offline", async () => {
    const desktop = new FakeDesktop();
    const { bridge, gateway } = await start(desktop);
    desktop.emit("snapshot", {
      ...desktop.conversation,
      requests: [{
        id: "desktop-command",
        method: "item/commandExecution/requestApproval",
        params: { command: "echo desktop" },
      }],
    });
    bridge.emit("serverRequest", {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { command: "echo app-server" },
    });
    const approvals = (gateway as unknown as { approvals: Map<string | number, unknown> }).approvals;
    await waitFor(() => approvals.size === 2);
    bridge.emit("offline", new Error("app-server stopped"));
    expect(approvals.has(42)).toBe(false);
    expect(approvals.has("desktop:thread-1:desktop-command")).toBe(true);
  });

  it("rejects a stale Desktop interrupt turn id", async () => {
    const desktop = new FakeDesktop();
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.interrupt", requestId: "stale-interrupt", threadId: "thread-1", turnId: "turn-old" }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "stale-interrupt"));
    expect(desktop.calls.filter((call) => call.method === "interrupt")).toHaveLength(0);
    ws.send(JSON.stringify({ type: "turn.interrupt", requestId: "current-interrupt", threadId: "thread-1", turnId: "turn-active" }));
    await waitFor(() => desktop.calls.some((call) => call.method === "interrupt"));
    ws.close();
  });

  it("routes permission approvals with granted profile and scope", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const permissions = { network: { enabled: true }, fileSystem: null };
    bridge.emit("serverRequest", { id: 43, method: "item/permissions/requestApproval", params: { threadId: "t1", turnId: "turn1", itemId: "i1", permissions } });
    await waitFor(() => messages.some((message) => message.type === "approval"));
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: 43, decision: "acceptForSession" }));
    await waitFor(() => bridge.responses.length === 1);
    expect(bridge.responses).toEqual([{ id: 43, result: { permissions: { network: { enabled: true } }, scope: "session" } }]);
    ws.close();
  });

  it("steers an active Desktop-owned turn and preserves the client correlation id", async () => {
    const desktop = new FakeDesktop();
    const { bridge, port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "mobile-turn", threadId: "thread-1", text: "steer me", clientUserMessageId: "client-message-1" }));
    await waitFor(() => desktop.calls.length === 1 && messages.some((message) => message.type === "turn.started"));
    expect(desktop.calls[0]).toMatchObject({ method: "steer", threadId: "thread-1", params: { clientUserMessageId: "client-message-1" } });
    expect(bridge.calls.some((call) => call.method === "turn/start")).toBe(false);
    ws.close();
  });

  it("falls back to start only after Desktop explicitly reports an inactive turn", async () => {
    const desktop = new FakeDesktop();
    desktop.steerError = new Error("SteerTurnInactiveError: Cannot steer conversation thread-1 because its active turn already ended");
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "idle-turn", threadId: "thread-1", text: "start me", clientUserMessageId: "client-message-idle" }));
    await waitFor(() => messages.some((message) => message.type === "turn.started"));
    expect(desktop.calls.map((call) => call.method)).toEqual(["steer", "start"]);
    ws.close();
  });

  it("does not start a second turn when Desktop steer has an uncertain outcome", async () => {
    const desktop = new FakeDesktop();
    desktop.steerError = new Error("Desktop IPC request timed out: thread-follower-steer-turn");
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "uncertain-turn", threadId: "thread-1", text: "only once", clientUserMessageId: "client-message-uncertain" }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "uncertain-turn"));
    expect(desktop.calls.map((call) => call.method)).toEqual(["steer"]);
    expect(messages.find((message) => message.requestId === "uncertain-turn")).toMatchObject({ type: "error", code: "submission_state_unknown" });
    ws.close();
  });

  it("sends text through the verified native desktop when follower IPC is absent", async () => {
    const desktop = new FakeDesktop();
    desktop.ready = desktop.owner = false;
    const actions: string[] = [];
    const { bridge, port } = await start(desktop, undefined, { desktopOnly: true }, async request => {
      actions.push(request.action);
      if (request.action === "native-send") {
        if (request.threadId === "uncertain") throw new DesktopActionError("No receipt", true);
        expect(request).toMatchObject({ threadId: "thread-1", prompt: "Review", model: "model-1", thinking: "medium" });
        return { previous_turn_id: "turn-old" };
      }
      if (request.action === "native-model-check") {
        expect(request).toMatchObject({ threadId: "thread-1", model: "model-1", thinking: "medium" });
        return {};
      }
      return { snapshot: { thread: { id: "thread-1", status: { type: "idle" } },
        turns: [{ id: "turn-new", status: "completed", items: [{ id: "reply", type: "agentMessage", text: "OK" }] }] } };
    });
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "thread.open", threadId: "thread-1", requestId: "desktop-open" }));
    await waitFor(() => actions.filter(action => action === "native-read").length === 1);
    ws.send(JSON.stringify({ type: "thread.settings", threadId: "thread-1", model: "model-1", effort: "medium", requestId: "select-model" }));
    await waitFor(() => messages.some(message => message.requestId === "select-model"));
    expect(messages.find(message => message.requestId === "select-model")).toMatchObject({
      type: "thread.settings.updated", settings: { model: "model-1", effort: "medium" },
    });
    ws.send(JSON.stringify({ type: "thread.settings", threadId: "thread-1", model: "model-1", effort: "high", requestId: "unsupported-effort" }));
    await waitFor(() => messages.some(message => message.requestId === "unsupported-effort"));
    expect(messages.find(message => message.requestId === "unsupported-effort")?.type).toBe("error");
    const turn = { type: "turn.start", threadId: "thread-1", text: "Review", clientUserMessageId: "client-id" };
    ws.send(JSON.stringify({ ...turn, requestId: "one" }));
    ws.send(JSON.stringify({ ...turn, requestId: "duplicate" }));
    ws.send(JSON.stringify({ ...turn, requestId: "steer", deliveryMode: "steer" }));
    ws.send(JSON.stringify({ ...turn, threadId: "uncertain", requestId: "unknown" }));
    await waitFor(() => messages.filter(message => message.type === "turn.started").length === 2);
    await waitFor(() => messages.some(message => message.requestId === "unknown" && message.code === "submission_state_unknown"));
    expect(messages.find(message => message.requestId === "steer")).toMatchObject({ code: "desktop_steer_unavailable" });
    expect(actions.filter(action => action === "native-send")).toHaveLength(2);
    await waitFor(() => messages.some(message => message.type === "thread" && JSON.stringify(message.thread).includes('"text":"OK"')), 3500);
    expect(bridge.calls.some(call => call.method === "turn/start")).toBe(false);
    ws.close();
  });

  it("updates an open phone chat when the native Desktop receives a picture", async () => {
    const desktop = new FakeDesktop();
    desktop.ready = desktop.owner = false;
    const image = { type: "userMessage", id: "image-only", content: [{ type: "localImage", path: join(tmpdir(), "clip.png") }] };
    let turns: unknown[] = [];
    const { port } = await start(desktop, undefined, { desktopOnly: true }, async () => ({
      snapshot: { thread: { id: "thread-1", status: { type: "idle" } }, turns },
    }));
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "thread.open", threadId: "thread-1", requestId: "initial-open" }));
    await waitFor(() => messages.some(message => message.requestId === "initial-open" && message.type === "thread"));
    turns = [{ id: "desktop-image-turn", status: "completed", items: [image] }];
    await waitFor(() => messages.some(message => message.type === "thread" && !message.requestId), 6_500);
    expect(messages.find(message => message.type === "thread" && !message.requestId)?.thread).toMatchObject({
      thread: { id: "thread-1", turns },
    });
    ws.close();
  }, 8_000);

  it("sends uploaded image and file references and uses the desktop queue without starting a second turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmr-native-files-"));
    closers.push(() => rm(root, { recursive: true, force: true }));
    let now = Date.now();
    const files = await FileTransferManager.create({ allowedRoots: [root], uploadDirectory: join(root, "uploads"),
      now: () => now, uploadTtlMs: 1_000 });
    const uploads = await Promise.all(["photo.png", "notes.txt"].map(fileName => files.receiveUpload({
      stream: Readable.from([Buffer.from("fixture")]), fileName, contentLength: 7,
      mimeType: fileName.endsWith(".png") ? "image/png" : "text/plain",
    })));
    const desktop = new FakeDesktop();
    desktop.ready = desktop.owner = false;
    const actions: Parameters<typeof desktopAction>[0][] = [];
    const { bridge, port } = await start(desktop, undefined, { desktopOnly: true }, async request => {
      actions.push(request);
      return request.action === "native-queue" ? { queue_id: "queue-1" } : { turn_id: "turn-native" };
    }, files);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${Buffer.from(token).toString("base64url")}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await waitFor(() => messages.some(message => message.type === "welcome"));
    expect(messages.find(message => message.type === "welcome")).toMatchObject({ desktopIpcReady: false });
    const base = { type: "turn.start", threadId: "thread-1", text: "Review the files",
      attachments: uploads.map(upload => ({ uploadId: upload.uploadId, localPath: "/untrusted/mobile/path" })) };
    ws.send(JSON.stringify({ ...base, requestId: "send", clientUserMessageId: "message-1" }));
    await waitFor(() => messages.some(message => message.requestId === "send"));
    const prompt = actions[0]?.prompt;
    expect(prompt).toContain("Review the files");
    expect(prompt).not.toContain("untrusted/mobile/path");
    for (const upload of uploads) expect(prompt).toContain(JSON.stringify(upload.path));
    expect(messages.find(message => message.requestId === "send")).toMatchObject({
      type: "turn.started", turn: { id: "turn-native", submittedText: prompt },
    });

    const queue = { ...base, deliveryMode: "queue", clientUserMessageId: "message-2" };
    ws.send(JSON.stringify({ ...queue, requestId: "queue" }));
    ws.send(JSON.stringify({ ...queue, requestId: "duplicate" }));
    ws.send(JSON.stringify({ ...base, requestId: "steer", deliveryMode: "steer", clientUserMessageId: "message-3" }));
    await waitFor(() => messages.some(message => message.requestId === "duplicate"));
    expect(actions.map(action => action.action)).toEqual(["native-send", "native-queue"]);
    expect(actions[1]?.prompt).toBe(prompt);
    expect(messages.find(message => message.requestId === "queue")).toMatchObject({ type: "prompt.desktopQueued", queueId: "queue-1" });
    expect(messages.find(message => message.requestId === "steer")).toMatchObject({ code: "desktop_steer_unavailable" });
    expect(bridge.calls.some(call => call.method === "turn/start" || call.method === "turn/steer")).toBe(false);
    now += 5_000;
    expect(await files.cleanupExpired()).toMatchObject({ uploads: 0 });
    ws.close();
  });

  it("coalesces duplicate turn submissions with the same client message id", async () => {
    const desktop = new FakeDesktop();
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const base = { type: "turn.start", threadId: "thread-1", text: "same logical submission", clientUserMessageId: "client-message-same" };
    ws.send(JSON.stringify({ ...base, requestId: "duplicate-a" }));
    ws.send(JSON.stringify({ ...base, requestId: "duplicate-b" }));
    await waitFor(() => messages.filter((message) => message.type === "turn.started" && String(message.requestId).startsWith("duplicate-")).length === 2);
    expect(desktop.calls).toHaveLength(1);
    expect(desktop.calls[0]?.method).toBe("steer");
    ws.close();
  });

  it("rejects reuse of a client message id for different content", async () => {
    const desktop = new FakeDesktop();
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "conflict-a", threadId: "thread-1", text: "first", clientUserMessageId: "client-message-conflict" }));
    await waitFor(() => messages.some((message) => message.type === "turn.started" && message.requestId === "conflict-a"));
    ws.send(JSON.stringify({ type: "turn.start", requestId: "conflict-b", threadId: "thread-1", text: "second", clientUserMessageId: "client-message-conflict" }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "conflict-b"));
    expect(desktop.calls).toHaveLength(1);
    expect(messages.find((message) => message.requestId === "conflict-b")).toMatchObject({ type: "error", code: "idempotency_conflict" });
    ws.close();
  });

  it("keeps a Host prompt queued after idle while Desktop owns the conversation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-queue-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const desktop = new FakeDesktop();
    const { port } = await start(desktop, queue);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "queue-a", threadId: "thread-1", text: "next turn", clientUserMessageId: "queued-client-1", deliveryMode: "queue" }));
    await waitFor(() => messages.some((message) => message.type === "prompt.queued"));
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toMatchObject([{ text: "next turn", status: "queued" }]);

    desktop.conversation = { id: "thread-1", threadRuntimeStatus: { type: "idle" }, turns: [{ id: "turn-active", status: "completed", items: [] }] };
    desktop.emit("snapshot", desktop.conversation);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toMatchObject([{ status: "queued", error: expect.stringContaining("不会自动启动") }]);
    ws.close();
  });

  it("auto-drains through app-server when no Desktop owner exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-appserver-queue-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const { bridge, port } = await start(undefined, queue);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "appserver-queued", threadId: "thread-1", text: "next", clientUserMessageId: "appserver-q1", deliveryMode: "queue" }));
    await waitFor(() => bridge.calls.some((call) => call.method === "turn/start") && queue.list("thread-1").length === 0);
    ws.close();
  });

  it("does not treat a Desktop native empty broadcast as permission to auto-start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-desktop-queue-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const desktop = new FakeDesktop();
    desktop.conversation = { id: "thread-1", threadRuntimeStatus: { type: "idle" }, turns: [] };
    const { port } = await start(desktop, queue);
    desktop.emit("queuedFollowUps", { conversationId: "thread-1", messages: [{ id: "desktop-q1", text: "desktop next" }] });

    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "host-queued", threadId: "thread-1", text: "host next", clientUserMessageId: "host-q1", deliveryMode: "queue" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toMatchObject([{ text: "host next", status: "queued" }]);

    desktop.emit("queuedFollowUps", { conversationId: "thread-1", messages: [] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toHaveLength(1);
    ws.close();
  });

  it("pauses queued prompts after an interrupted turn and resumes only on explicit request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-pause-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const desktop = new FakeDesktop();
    const { bridge, port } = await start(desktop, queue);
    await queue.enqueue({ threadId: "thread-1", clientUserMessageId: "paused-client", text: "after interrupt", turnParams: { threadId: "thread-1", clientUserMessageId: "paused-client", input: [{ type: "text", text: "after interrupt" }] } });
    bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-active", status: "interrupted" } } });
    await waitFor(() => queue.list("thread-1")[0]?.status === "paused");
    expect(desktop.calls).toHaveLength(0);

    desktop.conversation = { id: "thread-1", threadRuntimeStatus: { type: "idle" }, turns: [{ id: "turn-active", status: "interrupted", items: [] }] };
    desktop.emit("snapshot", desktop.conversation);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "prompt.queue.resume", requestId: "resume-a", threadId: "thread-1" }));
    await waitFor(() => queue.list("thread-1")[0]?.status === "queued");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(desktop.calls).toHaveLength(0);
    ws.close();
  });

  it("rejects promoting an idle Desktop-owned prompt without a shared queue lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-idle-promote-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const queued = await queue.enqueue({ threadId: "thread-1", clientUserMessageId: "idle-promote-client", text: "start later", turnParams: { threadId: "thread-1", clientUserMessageId: "idle-promote-client", input: [{ type: "text", text: "start later" }] } });
    const desktop = new FakeDesktop();
    desktop.conversation = { id: "thread-1", threadRuntimeStatus: { type: "idle" }, turns: [] };
    const { port } = await start(desktop, queue);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "prompt.queue.promote", requestId: "idle-promote", itemId: queued.id }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "idle-promote"));
    expect(messages.find((message) => message.requestId === "idle-promote")).toMatchObject({ type: "error", code: "desktop_queue_coordination_required" });
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toMatchObject([{ id: queued.id, status: "queued" }]);
    ws.close();
  });

  it("promotes a queued prompt into the active turn on explicit user action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-promote-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const queued = await queue.enqueue({ threadId: "thread-1", clientUserMessageId: "promote-client", text: "guide now", turnParams: { threadId: "thread-1", clientUserMessageId: "promote-client", input: [{ type: "text", text: "guide now" }] } });
    const desktop = new FakeDesktop();
    const { port } = await start(desktop, queue);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "prompt.queue.promote", requestId: "promote-a", itemId: queued.id }));
    await waitFor(() => messages.some((message) => message.type === "turn.started" && message.requestId === "promote-a"));
    expect(desktop.calls.map((call) => call.method)).toEqual(["steer"]);
    expect(queue.list()).toHaveLength(0);
    ws.close();
  });

  it("refreshes a pending file approval when its diff arrives later", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    bridge.emit("serverRequest", {
      id: 45,
      method: "item/fileChange/requestApproval",
      params: { threadId: "t1", turnId: "turn1", itemId: "i1" },
    });
    await waitFor(() => messages.filter((message) => message.type === "approval").length === 1);

    const diff = "diff --git a/demo.txt b/demo.txt\n+review me";
    bridge.emit("notification", { method: "turn/diff/updated", params: { threadId: "t1", turnId: "turn1", diff } });
    await waitFor(() => messages.filter((message) => message.type === "approval").length === 2);

    const approvals = messages.filter((message) => message.type === "approval");
    expect((approvals.at(-1)?.approval as { detail?: string }).detail).toBe(diff);
    ws.close();
  });

  it("clears approvals when app-server reports serverRequest/resolved", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    bridge.emit("serverRequest", { id: 44, method: "item/fileChange/requestApproval", params: { threadId: "t1", turnId: "turn1", itemId: "i1" } });
    await waitFor(() => messages.some((message) => message.type === "approval"));
    bridge.emit("notification", { method: "serverRequest/resolved", params: { threadId: "t1", requestId: 44 } });
    await waitFor(() => messages.some((message) => message.type === "approval.resolved" && message.approvalRequestId === 44));
    ws.close();
  });

  it("routes structured command approval amendments", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const amendment = { command_prefix: ["npm", "test"] };
    bridge.emit("serverRequest", {
      id: 46,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t1",
        availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }, "decline"],
      },
    });
    await waitFor(() => messages.some((message) => message.type === "approval"));
    const approval = messages.find((message) => message.type === "approval")?.approval as { availableDecisions: unknown[] };
    expect(approval.availableDecisions).toContainEqual({ kind: "acceptWithExecpolicyAmendment", execpolicyAmendment: amendment });
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: 46, decision: { kind: "acceptWithExecpolicyAmendment", execpolicyAmendment: amendment } }));
    await waitFor(() => bridge.responses.length === 1);
    expect(bridge.responses).toEqual([{ id: 46, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } } }]);
    ws.close();
  });

});
