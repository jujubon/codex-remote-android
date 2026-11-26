import type { IncomingMessage } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { desktopAction, DesktopActionError } from "./windows-desktop.js";
import { mkdir, readFile, stat } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join, isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  WIRE_PROTOCOL,
  type AccountUsage,
  type ApprovalDecision,
  type ApprovalRequest,
  type ClientMessage,
  type ModelOption,
  type ServerMessage,
  type SkillOption,
  type ThreadSummary,
} from "@codex-mobile/protocol";
import { authenticateUpgrade, selectedProtocol } from "./auth.js";
import { HOST_VERSION, type ServerConfig } from "./config.js";
import { AppServerBridge } from "./app-server-bridge.js";
import {
  DesktopIpcBridge,
  activeConversationTurnId,
  canonicalTurns,
  conversationIsActive,
  isExplicitInactiveSteerError,
  isUncertainDesktopSubmissionError,
} from "./desktop-ipc-bridge.js";
import type { FileTransferManager } from "./file-transfer.js";
import { GitDiffError, readGitDiff, type GitDiffSnapshot } from "./git-diff.js";
import { PromptQueueStore, type StoredPromptQueueItem } from "./prompt-queue.js";
import { SyncJournal, ThreadIndexStore } from "./sync-state.js";
import { isUsageLimitError, USAGE_LIMIT_MESSAGE } from "./usage-limit.js";

const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024;

interface RpcEnvelope {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface ThreadListResult {
  data?: Array<Record<string, unknown>>;
  nextCursor?: string | null;
}

interface MobileThreadStart {
  thread: Record<string, unknown>;
  turn: Record<string, unknown>;
  expiresAt: number;
}

interface ThreadTurnsListResult {
  data?: Array<Record<string, unknown>>;
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

interface ModelListResult {
  data?: Array<Record<string, unknown>>;
}

interface SkillsListResult {
  data?: Array<{ cwd?: unknown; skills?: Array<Record<string, unknown>> }>;
}

interface TurnSubmissionEntry {
  fingerprint: string;
  createdAt: number;
  promise: Promise<unknown>;
}

class GatewayRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

const TURN_SUBMISSION_TTL_MS = 10 * 60_000;
const MAX_TURN_SUBMISSIONS = 1_000;
const EMPTY_THREAD_INDEX_TTL_MS = 5_000;
const THREAD_INDEX_TTL_MS = 60_000;
const RECENT_TURNS_TO_REPLAY = 3;
const NATIVE_OBSERVATION_INTERVAL_MS = 5_000;
const MOBILE_THREAD_SOURCE = "codex-remote-mobile";
const MOBILE_PROJECTLESS_SOURCE = "codex-remote-mobile-projectless";
const MOBILE_THREAD_CONFIG = { thread_unload_delay_secs: 1 };
const THREAD_SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
];

export class MobileGateway {
  private pendingUsage?: Promise<AccountUsage>;

  readAccountUsage(): Promise<AccountUsage> {
    return this.pendingUsage ??= this.bridge.request("account/rateLimits/read", {})
      .then(accountUsage)
      .finally(() => { this.pendingUsage = undefined; });
  }
  private readonly wss: WebSocketServer;
  private readonly approvals = new Map<number | string, RpcEnvelope>();
  private readonly desktopApprovalKeys = new Set<number | string>();
  private readonly archivedIds = new Set<string>();
  private readonly changingArchive = new Set<string>();
  private readonly turnDiffs = new Map<string, string>();
  private readonly desktopThreads = new Map<string, Record<string, unknown>>();
  private readonly threadCwds = new Map<string, string>();
  private readonly failedAuth = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly turnSubmissions = new Map<string, TurnSubmissionEntry>();
  private readonly appServerThreadStatuses = new Map<string, unknown>();
  private readonly appServerCurrentTurnIds = new Map<string, string>();
  private readonly appServerCompletedTurnIds = new Map<string, string>();
  private readonly quotaFailedTurns = new Map<string, string>();
  private readonly recentMobileStarts = new Map<string, MobileThreadStart>();
  private readonly queueDrains = new Map<string, Promise<void>>();
  private readonly desktopQueuedFollowUps = new Map<string, number>();
  private readonly gitDiffs = new Map<string, GitDiffSnapshot>();
  private readonly syncJournal = new SyncJournal();
  private readonly threadIndex = new ThreadIndexStore();
  private readonly socketThreads = new WeakMap<WebSocket, Set<string>>();
  private readonly nativeDesktopTurns = new Map<string, NodeJS.Timeout | null>();
  private readonly nativeObservationDigests = new Map<string, string>();
  private nativeObservationTimer?: NodeJS.Timeout;
  private readonly projectMembershipPath: string;
  private readonly onProjectMembershipChange = () => { void this.refreshProjectMembership(); };
  private readonly mobileProjectlessIds = new Set<string>();
  private membershipLoad?: Promise<void>;
  private membershipStamp?: string;
  private observingNativeDesktop = false;
  private readonly nativeDesktopModelOverrides = new Map<string, { model: string; effort: string | null }>();
  private readonly mobileThreads = new Set<string>();
  private readonly subscribedMobileThreads = new Set<string>();
  private readonly desktopThreadIds = new Set<string>();
  private readonly mobileOperations = new Map<string, Promise<unknown>>();
  private readonly mobileModelOverrides = new Map<string, { model: string; effort: string | null }>();
  private threadIndexLoad: Promise<void> | null = null;
  private threadIndexLoadedAt = 0;

  constructor(
    private readonly bridge: AppServerBridge,
    private readonly config: ServerConfig,
    private readonly desktopIpc?: DesktopIpcBridge,
    private readonly files?: FileTransferManager,
    private readonly promptQueue?: PromptQueueStore,
    private readonly runDesktopAction = desktopAction,
  ) {
    this.projectMembershipPath = join(config.codexHome, ".codex-global-state.json");
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: selectedProtocol,
      perMessageDeflate: {
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        threshold: 1024,
        zlibDeflateOptions: { level: 3 },
      },
    });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    if (config.desktopOnly) {
      watchFile(this.projectMembershipPath, { persistent: false, interval: 500 }, this.onProjectMembershipChange);
    }
    bridge.on("ready", () => {
      this.threadIndexLoadedAt = 0;
      this.broadcast({ type: "status", codexReady: true });
    });
    bridge.on("offline", (error: Error) => {
      for (const [requestId, approval] of this.approvals) {
        if (approval.params?._desktopOrigin === true) continue;
        this.approvals.delete(requestId);
        this.broadcast({
          type: "approval.resolved",
          approvalRequestId: requestId,
        });
      }
      this.turnDiffs.clear();
      this.appServerThreadStatuses.clear();
      this.appServerCurrentTurnIds.clear();
      this.appServerCompletedTurnIds.clear();
      this.subscribedMobileThreads.clear();
      this.broadcast({
        type: "status",
        codexReady: false,
        detail: error.message,
      });
    });
    bridge.on(
      "notification",
      (message: { method: string; params?: unknown }) => {
        const params = asRecord(message.params);
        if (message.method === "thread/closed" && typeof params?.threadId === "string") {
          this.subscribedMobileThreads.delete(params.threadId);
        }
        if (
          message.method === "thread/status/changed" &&
          typeof params?.threadId === "string"
        ) {
          this.rememberAppServerThreadStatus(params.threadId, params.status);
        }
        if (message.method === "turn/started" && typeof params?.threadId === "string") {
          this.rememberAppServerStartedTurn(params.threadId, params.turn);
        }
        if (
          message.method === "turn/diff/updated" &&
          typeof params?.threadId === "string" &&
          typeof params.turnId === "string" &&
          typeof params.diff === "string"
        ) {
          this.turnDiffs.set(
            turnKey(params.threadId, params.turnId),
            params.diff,
          );
          for (const pending of this.approvals.values()) {
            const approvalParams = pending.params ?? {};
            const matchesTurn =
              approvalParams.threadId === params.threadId &&
              approvalParams.turnId === params.turnId;
            const isFileApproval =
              pending.method === "item/fileChange/requestApproval" ||
              pending.method === "applyPatchApproval";
            if (matchesTurn && isFileApproval) {
              this.broadcast({
                type: "approval",
                approval: normalizeApproval(pending, params.diff),
              });
            }
          }
        }
        if (
          message.method === "turn/completed" &&
          typeof params?.threadId === "string"
        ) {
          const turn = asRecord(params.turn);
          if (turn && typeof turn.id === "string" && isUsageLimitError(turn.error) && this.rememberQuotaFailure(params.threadId, turn.id)) {
            turn.quotaLimited = true;
          }
          if (turn?.id && this.quotaFailedTurns.get(params.threadId) === turn.id) turn.quotaLimited = true;
          this.clearAppServerApprovals(params.threadId);
          if (typeof turn?.id === "string") this.turnDiffs.delete(turnKey(params.threadId, turn.id));
          this.rememberAppServerCompletedTurn(params.threadId, turn);
          const completedStatus = String(turn?.status ?? params.status ?? "").toLowerCase();
          if (this.quotaFailedTurns.has(params.threadId)) {
            void this.pausePromptQueue(params.threadId, USAGE_LIMIT_MESSAGE);
          } else if (completedStatus.includes("interrupt")) {
            void this.pausePromptQueue(params.threadId, "队列已暂停，可手动恢复。");
          } else {
            this.scheduleQueueDrain(params.threadId);
          }
          this.scheduleMobileThreadRelease(params.threadId);
          void this.refreshThreadDiff(params.threadId, true);
        }
        if (message.method === "error" && params?.willRetry === false && typeof params.threadId === "string" &&
            typeof params.turnId === "string" && isUsageLimitError(params.error) && this.rememberQuotaFailure(params.threadId, params.turnId)) {
          params.quotaLimited = true;
          this.rememberAppServerCompletedTurn(params.threadId, { id: params.turnId });
          this.upsertThreadStatus(params.threadId, { type: "quotaLimited" });
          this.clearAppServerApprovals(params.threadId, { turnId: params.turnId });
          void this.pausePromptQueue(params.threadId, USAGE_LIMIT_MESSAGE);
          this.scheduleMobileThreadRelease(params.threadId);
        }
        if (
          (message.method === "item/completed" ||
            message.method === "item/commandExecution/completed" ||
            message.method === "item/fileChange/completed") &&
          typeof params?.threadId === "string"
        ) {
          const item = asRecord(params.item);
          const itemId =
            typeof params.itemId === "string"
              ? params.itemId
              : typeof item?.id === "string"
                ? item.id
                : undefined;
          const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
          this.clearAppServerApprovals(params.threadId, { turnId, itemId });
        }
        if (
          message.method === "serverRequest/resolved" &&
          (typeof params?.requestId === "string" ||
            typeof params?.requestId === "number")
        ) {
          if (this.approvals.delete(params.requestId))
            this.broadcast({
              type: "approval.resolved",
              approvalRequestId: params.requestId,
            });
        }
        if (message.method === "thread/started" && params?.thread && this.config.desktopOnly) {
          void this.publishStartedThread(params);
          return;
        }
        this.updateThreadIndexFromNotification(message.method, params);
        const eventParams = message.method === "thread/status/changed" && typeof params?.threadId === "string"
          ? { ...params, status: this.mergedThreadStatus(params.threadId, params.status) }
          : message.method === "turn/started" && typeof params?.threadId === "string" && this.mobileThreads.has(params.threadId)
            ? { ...params, mobileRuntimeActive: true }
            : message.params ?? null;
        const eventMessage: ServerMessage = {
          type: "event",
          method: message.method,
          params: eventParams,
        };
        const contentThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
        if (contentThreadId && isThreadContentEvent(message.method)) this.broadcastThread(contentThreadId, eventMessage);
        else this.broadcast(eventMessage);
      },
    );
    bridge.on("serverRequest", (message: RpcEnvelope) =>
      this.onServerRequest(message),
    );
    desktopIpc?.on("snapshot", (thread: Record<string, unknown>) => {
      const id = typeof thread.id === "string" ? thread.id : null;
      if (!id || this.archivedIds.has(id)) return;
      const wasDesktopActive = conversationIsActive(this.desktopThreads.get(id));
      this.desktopThreads.set(id, thread);
      if (!conversationIsActive(thread)) {
        const latestTurn = asRecord(canonicalTurns(thread).at(-1));
        const latestStatus = String(latestTurn?.status ?? "").toLowerCase();
        if (wasDesktopActive && latestStatus.includes("interrupt")) {
          void this.pausePromptQueue(id, "队列因当前 turn 被中断而暂停；确认后可恢复。");
        } else if (!this.isThreadActive(id)) {
          this.scheduleQueueDrain(id);
        }
        if (wasDesktopActive && !this.isThreadActive(id)) void this.refreshThreadDiff(id, true);
      }
      if (typeof thread.cwd === "string" && isAbsoluteHostPath(thread.cwd)) this.threadCwds.set(id, thread.cwd);
      this.upsertThreadSummary({ ...toThreadSummary(thread), status: this.mergedThreadStatus(id, thread.threadRuntimeStatus ?? thread.status) });
      this.syncDesktopApprovals(id, thread);
      const liveThread = projectDesktopLiveThread(this.projectThreadRuntimeStatus(thread));
      void this.trustDesktopAttachments(liveThread).then(() => {
        if (this.desktopThreads.get(id) !== thread) return;
        this.broadcastThread(id, {
          type: "event",
          method: "desktop/threadSnapshot",
          params: { thread: liveThread },
        });
      });
    });
    desktopIpc?.on("queuedFollowUps", (event: { conversationId?: unknown; messages?: unknown }) => {
      if (typeof event.conversationId !== "string" || !Array.isArray(event.messages)) return;
      this.desktopQueuedFollowUps.set(event.conversationId, event.messages.length);
      if (event.messages.length === 0) this.scheduleQueueDrain(event.conversationId);
    });
    desktopIpc?.on("ready", () => {
      if (this.config.desktopOnly) this.broadcast({ type: "status", codexReady: this.bridge.ready, desktopIpcReady: true });
      for (const socket of this.wss.clients)
        for (const threadId of this.socketThreads.get(socket) ?? [])
          void this.restoreDesktopSubscription(socket, threadId);
    });
    desktopIpc?.on("offline", () => {
      this.clearDesktopState();
      if (this.config.desktopOnly) this.broadcast({ type: "status", codexReady: this.bridge.ready, desktopIpcReady: false });
    });
    desktopIpc?.on("reset", () => this.clearDesktopState());
    desktopIpc?.on("ownerLost", (threadId: string) => {
      this.desktopThreads.delete(threadId);
      this.desktopQueuedFollowUps.delete(threadId);
      this.clearDesktopApprovalsForThread(threadId);
      const change = this.threadIndex.remove(threadId);
      if (change)
        this.broadcast({
          type: "threads.delta",
          baseVersion: change.version - 1,
          version: change.version,
          upserts: [],
          removedIds: [threadId],
        });
      void this.refreshThreadIndexBroadcast().catch((error) =>
        console.warn("[desktop-ipc] failed to refresh after owner loss", error),
      );
    });
    desktopIpc?.on("threadArchived", (params: Record<string, unknown>) => {
      const threadId = typeof params.conversationId === "string"
        ? params.conversationId
        : typeof params.threadId === "string"
          ? params.threadId
          : null;
      if (!threadId) return;
      this.markArchived(threadId);
    });
    desktopIpc?.on("threadUnarchived", (params: Record<string, unknown>) => {
      const id = params.conversationId ?? params.threadId;
      if (typeof id === "string") this.archivedIds.delete(id);
      void this.refreshThreadIndexBroadcast().catch((error) =>
        console.warn("[desktop-ipc] failed to refresh unarchived thread", error),
      );
    });
    desktopIpc?.on("diagnostic", (error: unknown) =>
      console.warn("[desktop-ipc]", error),
    );
    if (config.desktopOnly) {
      this.nativeObservationTimer = setInterval(() => void this.observeNativeDesktop(), NATIVE_OBSERVATION_INTERVAL_MS);
      this.nativeObservationTimer.unref();
    }
  }

  private async restoreDesktopSubscription(
    socket: WebSocket,
    threadId: string,
  ): Promise<void> {
    if (!this.desktopIpc?.ready) return;
    try {
      const thread = await this.desktopIpc.openConversation(
        threadId,
        "local",
        2_500,
        false,
      );
      if (!thread || this.archivedIds.has(threadId) || !this.desktopIpc.hasOwner(threadId)) return;
      this.desktopThreads.set(threadId, thread);
      const liveThread = projectDesktopLiveThread(
        this.projectThreadRuntimeStatus(thread),
      );
      await this.trustDesktopAttachments(liveThread);
      if (this.socketThreads.get(socket)?.has(threadId))
        this.send(socket, {
          type: "event",
          method: "desktop/threadSnapshot",
          params: { thread: liveThread },
        });
    } catch (error) {
      console.warn(`[desktop-ipc] failed to restore ${threadId}`, error);
    }
  }

  private clearDesktopApprovalsForThread(threadId: string): void {
    const prefix = `desktop:${threadId}:`;
    for (const wireId of [...this.desktopApprovalKeys]) {
      if (!String(wireId).startsWith(prefix)) continue;
      this.desktopApprovalKeys.delete(wireId);
      if (this.approvals.delete(wireId))
        this.broadcast({
          type: "approval.resolved",
          approvalRequestId: wireId,
        });
    }
  }

  private clearDesktopState(): void {
    for (const threadId of this.desktopThreads.keys())
      this.threadIndex.remove(threadId);
    this.desktopThreads.clear();
    this.desktopQueuedFollowUps.clear();
    for (const wireId of [...this.desktopApprovalKeys]) {
      this.desktopApprovalKeys.delete(wireId);
      if (this.approvals.delete(wireId))
        this.broadcast({
          type: "approval.resolved",
          approvalRequestId: wireId,
        });
    }
    void this.refreshThreadIndexBroadcast().catch((error) =>
      console.warn("[desktop-ipc] failed to refresh after reset", error),
    );
  }

  private async refreshThreadIndexBroadcast(): Promise<void> {
    this.threadIndexLoadedAt = 0;
    await this.ensureThreadIndex();
    this.broadcast({
      type: "threads.snapshot",
      version: this.threadIndex.currentVersion,
      threads: this.withMembership(this.threadIndex.snapshot()),
    });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    if (this.isRateLimited(remoteAddress)) {
      this.rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    if (request.url !== "/ws") {
      this.rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const auth = authenticateUpgrade(request, this.config);
    if (!auth.ok) {
      this.recordAuthFailure(remoteAddress);
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    this.failedAuth.delete(remoteAddress);
    this.wss.handleUpgrade(request, socket, head, (ws) =>
      this.wss.emit("connection", ws, request),
    );
  }

  close(): void {
    if (this.config.desktopOnly) unwatchFile(this.projectMembershipPath, this.onProjectMembershipChange);
    for (const timer of this.nativeDesktopTurns.values()) if (timer) clearTimeout(timer);
    this.nativeDesktopTurns.clear();
    clearInterval(this.nativeObservationTimer);
    this.nativeObservationTimer = undefined;
    this.nativeObservationDigests.clear();
    for (const socket of this.wss.clients)
      socket.close(1001, "server shutdown");
    this.wss.close();
  }

  private onConnection(socket: WebSocket): void {
    this.socketThreads.set(socket, new Set());
    socket.on("error", () => undefined);
    socket.on("message", (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data.toString()) > 1_000_000) {
        this.send(socket, {
          type: "error",
          code: "invalid_message",
          message: "Only JSON messages up to 1 MB are accepted.",
        });
        return;
      }
      void this.handleClientMessage(socket, data.toString("utf8"));
    });
    socket.on(
      "pong",
      () => ((socket as WebSocket & { isAlive?: boolean }).isAlive = true),
    );
    (socket as WebSocket & { isAlive?: boolean }).isAlive = true;

    this.send(socket, {
      type: "welcome",
      desktopOnly: this.config.desktopOnly,
      desktopIpcReady: this.config.desktopOnly ? this.desktopIpc?.ready === true : undefined,
      projectCreation: this.config.desktopOnly,
      mobileManagedThreads: this.config.desktopOnly,
      archiveManagement: true,
      version: HOST_VERSION,
      serverId: this.config.serverId,
      codexReady: this.bridge.ready,
      syncVersion: this.syncJournal.version,
      latestCursor: this.syncJournal.latestCursor,
      threadIndexVersion: this.threadIndex.currentVersion,
    });
    const pendingApprovals: ApprovalRequest[] = [];
    for (const approval of this.approvals.values()) {
      const params = approval.params ?? {};
      const diff =
        typeof params.threadId === "string" && typeof params.turnId === "string"
          ? this.turnDiffs.get(turnKey(params.threadId, params.turnId))
          : undefined;
      const normalized = normalizeApproval(approval, diff);
      pendingApprovals.push(normalized);
      this.send(socket, {
        type: "approval",
        approval: normalized,
      });
    }
    // This is the authoritative reconciliation boundary for reconnects. Individual
    // approval messages stay for backwards compatibility; the snapshot lets new
    // clients remove approvals whose resolved event was missed while offline.
    this.send(socket, { type: "approvals.snapshot", approvals: pendingApprovals });
    // Large task indexes and histories are client-requested after welcome so a
    // reconnect can resume from its persisted cursor without a duplicate dump.
  }

  startHeartbeat(): NodeJS.Timeout {
    const timer = setInterval(() => {
      for (const socket of this.wss.clients) {
        const tracked = socket as WebSocket & { isAlive?: boolean };
        if (tracked.isAlive === false) {
          socket.terminate();
          continue;
        }
        tracked.isAlive = false;
        socket.ping();
      }
    }, 30_000);
    timer.unref();
    return timer;
  }

  private async handleClientMessage(
    socket: WebSocket,
    raw: string,
  ): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(socket, {
        type: "error",
        code: "invalid_json",
        message: "Message must be valid JSON.",
      });
      return;
    }

    try {
      switch (message.type) {
        case "ping":
          this.send(socket, { type: "pong", id: message.id });
          break;
        case "sync.resume": {
          const afterCursor = typeof message.cursor === "number" ? message.cursor : undefined;
          const threadIds = Array.isArray(message.threadIds)
            ? message.threadIds.filter((value): value is string => typeof value === "string").slice(0, 20)
            : [];
          const subscriptions = this.socketThreads.get(socket);
          for (const threadId of threadIds) subscriptions?.add(threadId);
          const replay = this.syncJournal.replay(message.syncVersion, afterCursor, threadIds);
          if (replay.reset) {
            this.send(socket, {
              type: "sync.reset",
              requestId: message.requestId,
              syncVersion: this.syncJournal.version,
              latestCursor: replay.latestCursor,
              reason: "服务器同步版本已变化或断线期间事件超出保留窗口。",
            });
          } else {
            this.send(socket, {
              type: "sync.replay",
              requestId: message.requestId,
              syncVersion: this.syncJournal.version,
              fromCursor: afterCursor ?? 0,
              toCursor: replay.latestCursor,
              events: replay.events,
            });
          }
          for (const threadId of threadIds)
            void this.restoreDesktopSubscription(socket, threadId);
          break;
        }
        case "threads.sync":
          await this.syncThreads(socket, message.requestId, message.knownVersion);
          break;
        case "threads.list":
          await this.listThreads(socket, message.requestId, message.limit);
          break;
        case "usage.read": {
          const usage = await this.readAccountUsage();
          this.send(socket, { type: "usage.result", requestId: message.requestId, usage });
          break;
        }
        case "models.list": {
          this.send(socket, {
            type: "models",
            requestId: message.requestId,
            models: await this.listModels(),
          });
          break;
        }
        case "skills.list": {
          const cwd =
            typeof message.cwd === "string" && message.cwd.trim()
              ? requiredAbsolutePath(message.cwd, "cwd")
              : undefined;
          const result = (await this.bridge.request(
            "skills/list",
            cwd ? { cwds: [cwd] } : {},
          )) as SkillsListResult;
          this.send(socket, {
            type: "skills",
            requestId: message.requestId,
            skills: flattenSkills(result),
          });
          break;
        }
        case "archive.list": {
          const page = await this.bridge.request("thread/list", { archived: true, limit: 50,
            cursor: message.cursor ?? null, sourceKinds: THREAD_SOURCE_KINDS, sortKey: "updated_at", sortDirection: "desc" }) as ThreadListResult;
          this.send(socket, { type: "archive.result", requestId: message.requestId, threads: (page.data ?? []).map(toThreadSummary), nextCursor: page.nextCursor ?? null });
          break;
        }
        case "archive.set": {
          const id = requiredString(message.threadId, "threadId");
          if (typeof message.archived !== "boolean") throw new Error("无效的归档操作。");
          if (this.changingArchive.has(id)) throw new Error("电脑正在处理这段对话的归档操作。");
          this.changingArchive.add(id);
          try {
            const current = message.archived
              ? asRecord(asRecord(await this.bridge.request("thread/read", { threadId: id, includeTurns: false }))?.thread)
              : null;
            if (message.archived && current?.id !== id) throw new Error("电脑未确认目标对话，请刷新后再试。");
            if (message.archived && (conversationIsActive(current) || this.isThreadActive(id) || (this.desktopQueuedFollowUps.get(id) ?? 0) > 0
                || this.promptQueue?.list(id).some(item => ["queued", "sending", "paused", "uncertain"].includes(item.status))
                || [...this.approvals.values()].some(request => request.params?.threadId === id))) {
              throw new Error("请在任务和待处理操作结束后归档。");
            }
            const result = await this.bridge.request(message.archived ? "thread/archive" : "thread/unarchive", { threadId: id });
            if (message.archived) this.markArchived(id);
            else {
              this.archivedIds.delete(id);
              const thread = asRecord(asRecord(result)?.thread);
              if (thread) this.upsertThreadSummary(toThreadSummary(thread));
            }
            this.threadIndexLoadedAt = 0;
            this.desktopIpc?.announceArchiveState(id, message.archived);
            this.send(socket, { type: "archive.result", requestId: message.requestId, threadId: id, archived: message.archived });
          } finally {
            this.changingArchive.delete(id);
          }
          break;
        }
        case "thread.open": {
          const threadId = requiredString(message.threadId, "threadId");
          this.socketThreads.get(socket)?.add(threadId);
          try {
            await this.openThreadPage(socket, threadId, message.requestId, message.historyLimit, message.knownTurnIds);
          } catch (error) {
            if (!isMobileHistoryPending(error) || !this.sendMobileThreadStart(socket, threadId, message.requestId)) throw error;
          }
          break;
        }
        case "thread.close": {
          const threadId = requiredString(message.threadId, "threadId");
          this.socketThreads.get(socket)?.delete(threadId);
          break;
        }
        case "thread.history": {
          const threadId = requiredString(message.threadId, "threadId");
          this.socketThreads.get(socket)?.add(threadId);
          await this.sendThreadHistoryPage(
            socket,
            threadId,
            message.requestId,
            message.cursor,
            message.limit,
            message.knownTurnIds,
          );
          break;
        }
        case "projects.list": {
          if (!this.config.desktopOnly) throw new Error("当前连接不支持桌面项目目录。");
          const source = await this.desktopProjectSource();
          const result = await this.runDesktopAction({ action: "projects", threadId: source.id });
          this.send(socket, { type: "projects", requestId: message.requestId, projects: result.projects ?? [] });
          break;
        }
        case "thread.start": {
          if (this.config.desktopOnly && message.mobileManaged === true) {
            await this.startMobileThread(socket, message);
            break;
          }
          if (this.config.desktopOnly) {
            const prompt = requiredString(message.prompt, "首条任务");
            if (message.destination !== undefined && !["projectless", "newProject"].includes(message.destination)) throw new Error("未知的对话位置。");
            const cwd = message.destination ? undefined : requiredAbsolutePath(message.cwd, "cwd");
            const source = await this.desktopProjectSource(cwd);
            const created = await this.runDesktopAction({ action: "create", threadId: source.id, cwd, prompt, destination: message.destination, projectName: message.projectName });
            if (!created.thread_id) throw new Error("桌面未返回新对话编号，请刷新列表核对。");
            this.threadIndexLoadedAt = 0;
            if (message.destination === "projectless") {
              await this.refreshProjectMembership();
              this.projectlessIds.add(created.thread_id);
            }
            await this.openThreadPage(socket, created.thread_id, message.requestId);
            break;
          }
          const cwd = requiredAbsolutePath(message.cwd, "cwd");
          const result = await this.bridge.request("thread/start", {
            cwd,
            ...(message.model ? { model: message.model } : {}),
            ...(message.modelProvider
              ? { modelProvider: message.modelProvider }
              : {}),
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            threadSource: "codex-mobile-remote",
          });
          const startedThread = asRecord(asRecord(result)?.thread);
          const startedId =
            typeof startedThread?.id === "string" ? startedThread.id : null;
          if (startedId) this.threadCwds.set(startedId, cwd);
          this.send(socket, {
            type: "thread",
            requestId: message.requestId,
            thread: result,
          });
          break;
        }
        case "thread.compact": {
          const threadId = requiredString(message.threadId, "threadId");
          if (await this.isMobileThread(threadId)) {
            await this.withMobileThread(threadId, async () => {
              await this.loadMobileThread(threadId);
              await this.bridge.request("thread/compact/start", { threadId });
            });
            this.send(socket, { type: "thread.compaction.accepted", requestId: message.requestId, threadId });
            break;
          }
          await this.ensureDesktopOwner(threadId);
          if (this.desktopIpc?.hasOwner(threadId))
            await this.desktopIpc.compactThread(threadId);
          else await this.bridge.request("thread/compact/start", { threadId });
          this.send(socket, {
            type: "thread.compaction.accepted",
            requestId: message.requestId,
            threadId,
          });
          break;
        }
        case "thread.settings": {
          const threadId = requiredString(message.threadId, "threadId");
          const mobile = await this.isMobileThread(threadId);
          if (this.config.desktopOnly && !mobile && !this.desktopIpc?.ready && (message.model || message.effort)
              && !message.permissionMode && !message.collaborationMode && !message.summary) {
            const settings = await this.setNativeModelOverride(threadId, message.model, message.effort);
            this.send(socket, { type: "thread.settings.updated", requestId: message.requestId, threadId, settings: { ...settings, mobileSendOnly: true } });
            break;
          }
          const threadSettings = {
            ...(message.model ? { model: message.model } : {}),
            ...(message.effort ? { effort: message.effort } : {}),
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.permissionMode
              ? permissionSettings(
                  message.permissionMode,
                  this.permissionCwd(threadId, message.permissionMode),
                )
              : {}),
            ...(message.collaborationMode
              ? { collaborationMode: message.collaborationMode }
              : {}),
          };
          if (mobile) {
            const settings = await this.withMobileThread(threadId, async () => {
              await this.loadMobileThread(threadId);
              await this.bridge.request("thread/settings/update", { threadId, ...threadSettings });
              if (!message.model && !message.effort) return undefined;
              const latest = threadMetadataFromPayload(await this.bridge.request("thread/read", { threadId, includeTurns: false }), threadId);
              const current = asRecord(latest.latestThreadSettings);
              if (typeof current?.model !== "string" || (message.model && current.model !== message.model)
                  || (message.effort && current.effort !== message.effort)) {
                throw new GatewayRequestError("settings_unconfirmed", "电脑未确认模型设置，请刷新后再试。");
              }
              const confirmed = { model: current.model, effort: typeof current.effort === "string" ? current.effort : null };
              this.mobileModelOverrides.set(threadId, confirmed);
              return confirmed;
            }).finally(() => this.scheduleMobileThreadRelease(threadId));
            this.send(socket, { type: "thread.settings.updated", requestId: message.requestId, threadId, settings });
            break;
          }
          await this.ensureDesktopOwner(threadId);
          if (this.config.desktopOnly && !message.permissionMode && !message.collaborationMode && (message.model || message.effort)) {
            if (!this.desktopIpc?.hasOwner(threadId)) throw new Error("桌面对话已断开。");
            const settings = await this.desktopIpc.updateModelSettings(threadId, message.model, message.effort);
            this.send(socket, { type: "thread.settings.updated", requestId: message.requestId, threadId, settings });
            break;
          }
          if (this.desktopIpc?.hasOwner(threadId))
            await this.desktopIpc.updateThreadSettings(
              threadId,
              threadSettings,
            );
          else
            await this.bridge.request("thread/settings/update", {
              threadId,
              ...threadSettings,
            });
          this.send(socket, {
            type: "thread.settings.updated",
            requestId: message.requestId,
            threadId,
          });
          break;
        }
        case "thread.diff.get": {
          const threadId = requiredString(message.threadId, "threadId");
          const snapshot = await this.refreshThreadDiff(threadId, false);
          this.send(socket, { type: "thread.diff", requestId: message.requestId, snapshot });
          break;
        }
        case "prompt.queue.list": {
          if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
          const threadId = typeof message.threadId === "string" ? requiredString(message.threadId, "threadId") : undefined;
          this.send(socket, { type: "prompt.queue", requestId: message.requestId, items: this.promptQueue.list(threadId) });
          break;
        }
        case "prompt.queue.resume": {
          if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
          const threadId = requiredString(message.threadId, "threadId");
          await this.promptQueue.resumeThread(threadId);
          this.broadcastQueue(threadId);
          this.scheduleQueueDrain(threadId);
          break;
        }
        case "prompt.queue.cancel": {
          if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
          const itemId = requiredString(message.itemId, "itemId");
          const stored = this.promptQueue.get(itemId);
          if (!stored) throw new GatewayRequestError("queue_item_not_found", "排队提示词不存在或已经投递。");
          if (stored.status === "sending") throw new GatewayRequestError("queue_item_sending", "提示词正在投递，不能取消。");
          await this.promptQueue.cancel(itemId);
          this.releaseQueueUploads(stored);
          this.send(socket, { type: "prompt.queue.cancelled", requestId: message.requestId, threadId: stored.threadId, itemId });
          this.broadcastQueue(stored.threadId);
          break;
        }
        case "prompt.queue.promote": {
          if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
          const itemId = requiredString(message.itemId, "itemId");
          const stored = this.promptQueue.get(itemId);
          if (!stored) throw new GatewayRequestError("queue_item_not_found", "排队提示词不存在或已经投递。");
          if (stored.status === "sending") throw new GatewayRequestError("queue_item_sending", "提示词正在投递。");
          if (stored.status === "paused") throw new GatewayRequestError("queue_paused", "队列已暂停，请先恢复队列。");
          if (this.desktopIpc?.hasOwner(stored.threadId) && !this.isThreadActive(stored.threadId)) {
            throw new GatewayRequestError("desktop_queue_coordination_required", "电脑端 GUI 正在管理该空闲会话；当前协议没有共享队列锁，不能安全地从手机强制启动下一轮。请在任务执行中使用立即引导，或关闭电脑端会话后再发送。");
          }
          const item = await this.promptQueue.claim(itemId);
          if (!item) throw new GatewayRequestError("queue_item_not_found", "排队提示词不存在或已经投递。");
          this.broadcastQueue(item.threadId);
          this.turnSubmissions.delete(`${item.threadId}:${item.clientUserMessageId}`);
          const result = await this.deliverClaimedQueueItem(item, "promote");
          const turnResult = asRecord(result);
          this.send(socket, { type: "turn.started", requestId: message.requestId, threadId: item.threadId, turn: turnResult?.turn ?? result });
          break;
        }
        case "turn.start": {
          if (this.changingArchive.has(message.threadId) || this.archivedIds.has(message.threadId))
            throw new Error("对话已归档或正在更改归档状态，请刷新后再发送。");
          const threadId = requiredString(message.threadId, "threadId");
          const text = requiredString(message.text, "text");
          if (message.deliveryMode != null && !["auto", "steer", "queue"].includes(message.deliveryMode))
            throw new Error("无效的消息发送方式。");
          const mobile = await this.isMobileThread(threadId);
          const desktopFallback = this.config.desktopOnly && !this.desktopIpc?.ready;
          if (this.config.desktopOnly && !mobile && (desktopFallback || message.deliveryMode === "queue")) {
            if (message.deliveryMode === "steer") {
              throw new GatewayRequestError("desktop_steer_unavailable", "当前桌面连接无法确认并引导指定轮次。可选择排队下一轮。");
            }
            if (message.skill || message.model || message.effort || message.summary || message.permissionMode || message.collaborationMode) {
              throw new GatewayRequestError("desktop_route_limited", "当前发送方式无法随消息应用技能或设置。请先在对话设置里修改模型。");
            }
            const queued = message.deliveryMode === "queue";
            const receipt = await this.submitNativeDesktopPrompt(threadId, text,
              requiredString(message.clientUserMessageId, "clientUserMessageId"),
              [...new Set(message.attachments?.map(attachment => requiredString(attachment.uploadId, "attachment.uploadId")) ?? [])], queued);
            if (queued && receipt.queueId) {
              this.send(socket, { type: "prompt.desktopQueued", requestId: message.requestId, threadId, queueId: receipt.queueId });
            } else {
              this.send(socket, { type: "turn.started", requestId: message.requestId, threadId, turn: receipt.turn });
            }
            break;
          }
          if (!mobile) await this.ensureDesktopOwner(threadId);
          const input: Array<Record<string, unknown>> = [];
          const queuedUploadIds: string[] = [];
          const queuedFileNames: string[] = [];
          const queuedFilePaths: string[] = [];
          if (message.skill) {
            input.push({
              type: "skill",
              name: requiredString(message.skill.name, "skill.name"),
              path: requiredAbsolutePath(message.skill.path, "skill.path"),
            });
          }
          for (const attachment of message.attachments ?? []) {
            if (!this.files) throw new Error("File transfer is unavailable.");
            const uploadId = requiredString(attachment.uploadId, "attachment.uploadId");
            const upload = await this.files.getUpload(uploadId);
            queuedUploadIds.push(uploadId);
            queuedFileNames.push(upload.fileName);
            queuedFilePaths.push(upload.path);
            if (
              attachment.type === "image" ||
              upload.mimeType.startsWith("image/")
            ) {
              input.push({ type: "localImage", path: upload.path });
            } else {
              input.push({
                type: "mention",
                name: upload.fileName,
                path: upload.path,
              });
            }
          }
          input.push({ type: "text", text, text_elements: [] });
          const turnParams = {
            threadId,
            input,
            ...(message.deliveryMode === "steer" && message.expectedTurnId !== undefined
              ? { expectedTurnId: requiredString(message.expectedTurnId, "expectedTurnId") } : {}),
            ...(message.clientUserMessageId
              ? {
                  clientUserMessageId: requiredString(
                    message.clientUserMessageId,
                    "clientUserMessageId",
                  ),
                }
              : {}),
            ...(message.model ? { model: message.model } : {}),
            ...(message.effort ? { effort: message.effort } : {}),
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.permissionMode
              ? permissionSettings(
                  message.permissionMode,
                  this.permissionCwd(threadId, message.permissionMode),
                )
              : {}),
            ...(message.collaborationMode
              ? { collaborationMode: message.collaborationMode }
              : {}),
          };
          const clientUserMessageId = typeof turnParams.clientUserMessageId === "string"
            ? turnParams.clientUserMessageId
            : undefined;
          const deliveryMode = message.deliveryMode ?? "auto";
          if (deliveryMode === "queue") {
            if (!this.promptQueue || !clientUserMessageId) throw new GatewayRequestError("queue_unavailable", "提示词队列不可用或缺少 clientUserMessageId。");
            for (const uploadId of queuedUploadIds) this.files?.pinUpload(uploadId);
            let item: StoredPromptQueueItem;
            try {
              item = await this.promptQueue.enqueue({
                threadId,
                clientUserMessageId,
                text,
                turnParams,
                fileNames: queuedFileNames,
                filePaths: queuedFilePaths,
                uploadIds: queuedUploadIds,
              });
            } catch (error) {
              for (const uploadId of queuedUploadIds) this.files?.releaseUpload(uploadId);
              if (String(error).includes("idempotency_conflict")) {
                throw new GatewayRequestError("idempotency_conflict", "同一个 clientUserMessageId 被用于不同的排队内容。");
              }
              throw error;
            }
            if (!mobile && this.desktopIpc?.hasOwner(threadId)) {
              await this.promptQueue.requeue(item.id, "电脑端 GUI 正在作为会话 owner。当前 Desktop IPC 没有可供外部 follower 参与的原生队列锁；为避免双 start，手机队列不会自动启动。执行中可点“立即引导”。");
            }
            this.send(socket, { type: "prompt.queued", requestId: message.requestId, threadId, item: this.promptQueue.list(threadId).find((candidate) => candidate.id === item.id)! });
            this.broadcastQueue(threadId);
            this.scheduleQueueDrain(threadId);
            break;
          }
          const result = await this.submitPreparedTurn(threadId, turnParams, deliveryMode);
          await Promise.all(queuedUploadIds.map((uploadId) => this.files?.commitUpload(uploadId)));
          const turnResult = asRecord(result);
          this.send(socket, {
            type: "turn.started",
            requestId: message.requestId,
            threadId,
            turn: turnResult?.turn ?? result,
          });
          break;
        }
        case "turn.interrupt": {
          const threadId = requiredString(message.threadId, "threadId");
          const turnId = requiredString(message.turnId, "turnId");
          if (await this.isMobileThread(threadId)) {
            if (this.appServerCurrentTurnIds.get(threadId) !== turnId)
              throw new GatewayRequestError("no_active_turn", "手机服务当前没有运行这一轮。");
            await this.bridge.request("turn/interrupt", { threadId, turnId });
            break;
          }
          await this.ensureDesktopOwner(threadId);
          if (this.desktopIpc?.hasOwner(threadId)) {
            const activeTurnId = activeConversationTurnId(
              this.desktopIpc.getConversation(threadId),
            );
            if (!activeTurnId)
              throw new Error("Desktop task has no active turn to interrupt.");
            if (activeTurnId !== turnId)
              throw new Error("The requested turn is no longer the active Desktop turn.");
            await this.desktopIpc.interruptTurn(threadId, this.config.desktopOnly ? "user-stop" : "user", turnId);
          } else {
            await this.bridge.request("turn/interrupt", { threadId, turnId });
          }
          break;
        }
        case "approval.resolve":
          await this.resolveApproval(
            socket,
            message.approvalRequestId,
            message.decision,
            message.requestId,
          );
          break;
        default:
          this.send(socket, {
            type: "error",
            code: "unknown_message",
            message: "Unsupported message type.",
          });
      }
    } catch (error) {
      const quotaLimited = isUsageLimitError(error);
      const code = quotaLimited ? "usage_limit_reached" : error instanceof GatewayRequestError ? error.code : "request_failed";
      this.send(socket, {
        type: "error",
        requestId: "requestId" in message ? message.requestId : undefined,
        code,
        ...(message.type === "turn.start" ? { threadId: message.threadId } : {}),
        message: quotaLimited ? USAGE_LIMIT_MESSAGE : error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  private async refreshThreadDiff(threadId: string, broadcast: boolean): Promise<GitDiffSnapshot> {
    const cwd = this.threadCwds.get(threadId)
      ?? (typeof this.desktopThreads.get(threadId)?.cwd === "string" ? this.desktopThreads.get(threadId)!.cwd as string : undefined);
    if (!cwd) {
      const snapshot = emptyGitDiff(threadId, "", "任务工作目录尚未同步。");
      if (broadcast) this.broadcastThread(threadId, { type: "thread.diff", snapshot });
      return snapshot;
    }
    try {
      const snapshot = await readGitDiff(threadId, cwd);
      this.gitDiffs.set(threadId, snapshot);
      if (broadcast) this.broadcastThread(threadId, { type: "thread.diff", snapshot });
      return snapshot;
    } catch (error) {
      const message = error instanceof GitDiffError ? error.message : `读取 Git Diff 失败：${error instanceof Error ? error.message : String(error)}`;
      const snapshot = emptyGitDiff(threadId, cwd, message);
      this.gitDiffs.set(threadId, snapshot);
      if (broadcast) this.broadcastThread(threadId, { type: "thread.diff", snapshot });
      return snapshot;
    }
  }

  private async desktopProjectSource(cwd?: string) {
    await this.ensureThreadIndex();
    const threads = this.threadIndex.snapshot().filter(row => !row.parentThreadId);
    const source = threads.find(row => this.desktopIpc?.hasOwner(row.id)) ?? threads.find(row => row.cwd === cwd)
      ?? threads.find(row => !row.mobileManaged && !row.projectless) ?? threads[0];
    if (!source) throw new Error("请先在电脑 Codex 中打开一个对话。");
    return source;
  }

  private rememberThreadSource(thread: Record<string, unknown>, authoritative = false) {
    if (typeof thread.id !== "string") return false;
    if (thread.threadSource === MOBILE_PROJECTLESS_SOURCE) this.mobileProjectlessIds.add(thread.id);
    const mobile = this.mobileThreads.has(thread.id) || isMobileThreadSource(thread.threadSource);
    if (mobile) {
      this.mobileThreads.add(thread.id);
      this.desktopThreadIds.delete(thread.id);
    } else if (authoritative) {
      // The lightweight list can omit threadSource even for a mobile-owned thread.
      this.desktopThreadIds.add(thread.id);
    }
    return mobile;
  }

  private async isMobileThread(threadId: string): Promise<boolean> {
    if (!this.config.desktopOnly) return false;
    if (this.mobileThreads.has(threadId)) return true;
    if (this.desktopThreadIds.has(threadId) || this.desktopIpc?.hasOwner(threadId)) return false;
    const result = await this.bridge.request("thread/read", { threadId, includeTurns: false }).catch(() => undefined);
    const thread = asRecord(asRecord(result)?.thread);
    return thread?.id === threadId && this.rememberThreadSource(thread, true);
  }

  private withMobileThread<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mobileOperations.get(threadId);
    const next = (previous ? previous.catch(() => {}) : Promise.resolve()).then(operation);
    this.mobileOperations.set(threadId, next);
    return next.finally(() => {
      if (this.mobileOperations.get(threadId) === next) this.mobileOperations.delete(threadId);
    });
  }

  private async loadMobileThread(threadId: string): Promise<void> {
    if (this.subscribedMobileThreads.has(threadId)) return;
    if (this.desktopIpc?.hasOwner(threadId)) {
      throw new GatewayRequestError("desktop_owns_thread", "这段对话已在桌面打开，请先在桌面结束或退出这段对话。");
    }
    const snapshot = await this.runDesktopAction({ action: "native-read", threadId }).catch(() => undefined);
    if (conversationIsActive(asRecord(asRecord(snapshot?.snapshot)?.thread) ?? undefined)) {
      throw new GatewayRequestError("desktop_owns_thread", "桌面正在运行这段对话，请等当前任务结束。");
    }
    try {
      const result = asRecord(await this.bridge.request("thread/resume", { threadId, excludeTurns: true, config: MOBILE_THREAD_CONFIG }));
      if (asRecord(result?.thread)?.id !== threadId) throw new Error("thread id mismatch");
    } catch (error) {
      if (/writ(?:er|ing)|locked|in use/i.test(String(error))) {
        throw new GatewayRequestError("desktop_owns_thread", "这段对话正在由桌面使用，请退出桌面上的这段对话后再试。");
      }
      throw error;
    }
    this.subscribedMobileThreads.add(threadId);
  }

  private scheduleMobileThreadRelease(threadId: string): void {
    if (!this.mobileThreads.has(threadId) || !this.subscribedMobileThreads.has(threadId)) return;
    void Promise.resolve().then(async () => {
      await this.queueDrains.get(threadId);
      await this.withMobileThread(threadId, async () => {
        if (this.appServerThreadIsActive(threadId) || !this.subscribedMobileThreads.has(threadId)) return;
        await this.bridge.request("thread/unsubscribe", { threadId });
        this.subscribedMobileThreads.delete(threadId);
      });
    }).catch(() => console.warn("[mobile-thread] unable to release idle subscription"));
  }

  private async mobileWorkspace(message: Extract<ClientMessage, { type: "thread.start" }>): Promise<{ cwd: string; projectId?: string }> {
    if (message.destination === "projectless") {
      const cwd = join(dirname(this.config.promptQueueFile), "mobile-workspaces", randomUUID());
      await mkdir(cwd, { recursive: true });
      return { cwd };
    }
    if (message.destination === "newProject") {
      const name = requiredString(message.projectName, "项目名称");
      const source = await this.desktopProjectSource();
      const result = await this.runDesktopAction({ action: "native-project-create", threadId: source.id, projectName: name });
      return { cwd: requiredAbsolutePath(result.project?.path, "项目目录"), ...(result.project?.id ? { projectId: result.project.id } : {}) };
    }
    if (message.destination !== undefined) throw new Error("未知的对话位置。");
    const cwd = requiredAbsolutePath(message.cwd, "cwd");
    if (!(await stat(cwd)).isDirectory()) throw new Error("电脑工作目录不存在。");
    return { cwd };
  }

  private async startMobileThread(socket: WebSocket, message: Extract<ClientMessage, { type: "thread.start" }>): Promise<void> {
    const prompt = requiredString(message.prompt, "首条任务");
    if (prompt.length > 4000) throw new Error("首条消息最多 4000 个字符。");
    const { cwd, projectId } = await this.mobileWorkspace(message);
    const projectless = message.destination === "projectless";
    const first = asRecord(await this.bridge.request("thread/start", {
      cwd, ...(message.model ? { model: message.model } : {}),
      ...(projectId ? { projectId } : {}),
      ...(message.modelProvider ? { modelProvider: message.modelProvider } : {}),
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      threadSource: projectless ? MOBILE_PROJECTLESS_SOURCE : MOBILE_THREAD_SOURCE,
      config: MOBILE_THREAD_CONFIG,
    }));
    const thread = asRecord(first?.thread);
    const id = requiredString(thread?.id, "新对话编号");
    this.mobileThreads.add(id);
    if (projectless) this.mobileProjectlessIds.add(id);
    this.subscribedMobileThreads.add(id);
    this.threadCwds.set(id, cwd);
    this.socketThreads.get(socket)?.add(id);
    try {
      const clientUserMessageId = randomUUID();
      const result = asRecord(await this.withMobileThread(id, () => this.bridge.request("turn/start", {
        threadId: id,
        clientUserMessageId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      })));
      this.rememberAppServerStartedTurn(id, result);
      const turn = asRecord(result?.turn) ?? result ?? {};
      const turnId = requiredString(turn.id ?? turn.turnId, "首轮任务编号");
      const items = Array.isArray(turn.items) ? turn.items : [];
      const userItem = {
        id: `local_start_${turnId}`, type: "userMessage", deliveryAcknowledged: true, clientUserMessageId,
        content: [{ type: "text", text: prompt }],
      };
      this.recentMobileStarts.set(id, {
        thread: { ...threadMetadataFromPayload(first, id), cwd, preview: thread?.preview || prompt,
          updatedAt: thread?.updatedAt ?? Math.floor(Date.now() / 1000), mobileManaged: true, projectless },
        turn: { ...turn, id: turnId, startedAt: turn.startedAt ?? Math.floor(Date.now() / 1000),
          items: items.some(item => String(asRecord(item)?.type).toLowerCase() === "usermessage") ? items : [userItem, ...items] },
        expiresAt: Date.now() + 120_000,
      });
      if (this.recentMobileStarts.size > 128)
        this.recentMobileStarts.delete(this.recentMobileStarts.keys().next().value!);
      this.threadIndexLoadedAt = 0;
      this.sendMobileThreadStart(socket, id, message.requestId);
      void this.syncNewMobileHistory(socket, id);
    } catch (error) {
      this.scheduleMobileThreadRelease(id);
      throw error;
    }
  }

  private sendMobileThreadStart(socket: WebSocket, threadId: string, requestId?: string): boolean {
    const start = this.recentMobileStarts.get(threadId);
    if (!start) return false;
    if (start.expiresAt <= Date.now() || this.archivedIds.has(threadId)) {
      this.recentMobileStarts.delete(threadId);
      return false;
    }
    const activeTurn = this.appServerCurrentTurnIds.get(threadId);
    const status = this.mergedThreadStatus(threadId, { type: "idle" });
    const initialStatus = String(start.turn.status);
    const statusWhenInactive = ["completed", "failed", "interrupted"].includes(initialStatus) ? initialStatus : undefined;
    const turn = { ...start.turn, status: activeTurn === start.turn.id ? "inProgress" : statusWhenInactive };
    const thread = { ...start.thread, status, threadRuntimeStatus: status, turns: [turn],
      mobileRuntimeActive: Boolean(activeTurn), mobileActiveTurnId: activeTurn };
    this.upsertThreadSummary(toThreadSummary(thread));
    this.send(socket, { type: "thread", requestId, thread: { thread } });
    return true;
  }

  private async syncNewMobileHistory(socket: WebSocket, threadId: string): Promise<void> {
    for (const wait of [250, 750, 1500, 3000]) {
      await delay(wait, undefined, { ref: false });
      if (socket.readyState !== WebSocket.OPEN || !this.socketThreads.get(socket)?.has(threadId) ||
          !this.recentMobileStarts.has(threadId) || this.archivedIds.has(threadId)) return;
      try {
        await this.openThreadPage(socket, threadId);
        return;
      } catch (error) {
        if (!isMobileHistoryPending(error)) return;
      }
    }
  }

  private async ensureDesktopOwner(threadId: string): Promise<void> {
    if (!this.config.desktopOnly || this.desktopIpc?.hasOwner(threadId)) return;
    if (!this.desktopIpc?.ready) throw new Error("电脑 Codex Desktop 当前离线。");
    await desktopAction({ action: "open", threadId });
    await this.desktopIpc.openConversation(threadId, "local", 8_000, false);
    if (!this.desktopIpc.hasOwner(threadId)) throw new Error("桌面尚未加载此对话，请稍后再试。");
  }

  private async listModels(): Promise<ModelOption[]> {
    const result = (await this.bridge.request("model/list", { limit: 100, includeHidden: false })) as ModelListResult;
    return (result.data ?? []).map(toModelOption);
  }

  private async setNativeModelOverride(threadId: string, model?: string, effort?: string) {
    const stored = model || this.nativeDesktopModelOverrides.has(threadId) ? undefined
      : asRecord(asRecord(await this.bridge.request("thread/read", { threadId, includeTurns: false }))?.thread)?.model;
    const selected = model ?? this.nativeDesktopModelOverrides.get(threadId)?.model ?? (typeof stored === "string" ? stored : undefined);
    if (!selected) throw new Error("请先选择本对话的模型，再调整思考强度。");
    const option = (await this.listModels()).find(entry => entry.model === selected && !entry.hidden);
    if (!option) throw new Error("电脑当前的模型列表中没有这个模型，请重新选择。");
    if (effort && !option.supportedReasoningEfforts.some(entry => entry.reasoningEffort === effort))
      throw new Error("这个模型不支持所选思考强度。");
    const settings = { model: option.model, effort: effort ?? null };
    await this.runDesktopAction({ action: "native-model-check", threadId, model: settings.model,
      ...(settings.effort ? { thinking: settings.effort } : {}) });
    this.nativeDesktopModelOverrides.delete(threadId);
    this.nativeDesktopModelOverrides.set(threadId, settings);
    if (this.nativeDesktopModelOverrides.size > 1_000)
      this.nativeDesktopModelOverrides.delete(this.nativeDesktopModelOverrides.keys().next().value!);
    return settings;
  }

  private async submitNativeDesktopPrompt(threadId: string, text: string, messageId: string, uploadIds: string[], queued: boolean) {
    const receipt = await this.submitTurnIdempotently(threadId, messageId, JSON.stringify(["native-desktop", queued, text, uploadIds]), async () => {
      if (!queued && this.nativeDesktopTurns.has(threadId))
        throw new GatewayRequestError("desktop_turn_pending", "上次发送还在确认，请稍候。");
      if (!queued) this.nativeDesktopTurns.set(threadId, null);
      const pinned: string[] = [];
      let retainUploads = false;
      try {
        const paths: string[] = [];
        for (const id of uploadIds) {
          if (!this.files) throw new Error("电脑未启用上传。");
          const upload = await this.files.getUpload(id);
          if (!this.files.pinUpload(id)) throw new Error("上传已过期，请重新选择文件。");
          pinned.push(id);
          paths.push(upload.path);
        }
        const prompt = paths.length
          ? `${text}\n\n手机上传到电脑的文件（请查看这些本地文件）：\n${paths.map(path => `- ${JSON.stringify(path)}`).join("\n")}`
          : text;
        if (prompt.length > 20_000) throw new Error("消息和文件路径合计过长，请缩短文字或减少文件。");
        if (queued) {
          const result = await this.runDesktopAction({
            action: "native-queue", threadId, prompt, codexBin: this.config.codexBin, codexHome: this.config.codexHome,
          });
          if (!result.queue_id) throw new DesktopActionError("桌面未返回排队回执，请核对桌面队列。", true);
          retainUploads = true;
          return { queueId: result.queue_id };
        }
        const selected = this.nativeDesktopModelOverrides.get(threadId);
        const result = await this.runDesktopAction({ action: "native-send", threadId, prompt,
          ...(selected ? { model: selected.model } : {}), ...(selected?.effort ? { thinking: selected.effort } : {}) });
        retainUploads = true;
        this.pollNativeDesktopTurn(threadId, result.previous_turn_id ?? null, result.turn_id, Date.now() + 180_000);
        return { turn: { ...(result.turn_id ? { id: result.turn_id } : {}), ...(paths.length ? { submittedText: prompt } : {}) } };
      } catch (error) {
        if (!queued) this.nativeDesktopTurns.delete(threadId);
        if (error instanceof DesktopActionError && error.outcomeUnknown) {
          retainUploads = true;
          throw new GatewayRequestError("submission_state_unknown", queued
            ? "桌面未确认排队结果，请先核对桌面队列。"
            : "桌面未确认发送结果，请核对对话后再试。");
        }
        if (error instanceof DesktopActionError && (error.code === "desktop_turn_active" || error.code === "desktop_state_unconfirmed")) {
          void this.refreshNativeSenderSnapshot(threadId);
          throw new GatewayRequestError(error.code, error.message);
        }
        throw error;
      } finally {
        if (retainUploads) {
          const retained = await Promise.allSettled(pinned.map(id => this.files!.commitUpload(id)));
          if (retained.some(item => item.status === "rejected" || !item.value)) console.warn("[files] could not retain a desktop upload");
        }
        for (const id of pinned) this.files?.releaseUpload(id);
      }
    });
    return receipt as { queueId?: string; turn?: Record<string, unknown> };
  }

  private pollNativeDesktopTurn(threadId: string, previous: string | null, turnId: string | undefined, deadline: number): void {
    if (!this.nativeDesktopTurns.has(threadId)) return;
    if (Date.now() >= deadline) { this.nativeDesktopTurns.delete(threadId); return; }
    const timer = setTimeout(async () => {
      try {
        const result = await this.runDesktopAction({ action: "native-read", threadId });
        if (!this.nativeDesktopTurns.has(threadId)) return;
        const payload = asRecord(result.snapshot);
        const thread = asRecord(payload?.thread);
        const turns = Array.isArray(payload?.turns) ? payload.turns : [];
        const latest = asRecord(turns.at(-1));
        const id = typeof latest?.id === "string" ? latest.id : undefined;
        if (thread?.id === threadId && latest && id && (turnId ? id === turnId : id !== previous)) {
          const settings = this.nativeDesktopModelOverrides.get(threadId);
          const projected = { ...thread, status: nativeSnapshotStatus(thread, turns), name: thread.title, turns,
            ...(settings ? { latestThreadSettings: { ...settings, mobileSendOnly: true } } : {}) };
          await this.trustDesktopAttachments(projected);
          if (!this.nativeDesktopTurns.has(threadId)) return;
          this.upsertThreadSummary(toThreadSummary(projected));
          for (const socket of this.wss.clients) {
            if (this.socketThreads.get(socket)?.has(threadId))
              this.send(socket, { type: "thread", thread: { thread: projected } });
          }
          if (["completed", "failed", "interrupted", "cancelled"].includes(String(latest.status))) {
            this.nativeDesktopTurns.delete(threadId);
            return;
          }
        }
      } catch { /* Continue reading through a temporary desktop restart. */ }
      this.pollNativeDesktopTurn(threadId, previous, turnId, deadline);
    }, 2300);
    timer.unref();
    this.nativeDesktopTurns.set(threadId, timer);
  }

  private async observeNativeDesktop(): Promise<void> {
    if (this.observingNativeDesktop) return;
    const watched = new Set<string>();
    for (const socket of this.wss.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const selected = [...(this.socketThreads.get(socket) ?? [])].at(-1);
      if (selected && !this.desktopIpc?.hasOwner(selected)) watched.add(selected);
    }
    for (const threadId of this.nativeObservationDigests.keys()) {
      if (!watched.has(threadId)) this.nativeObservationDigests.delete(threadId);
    }
    this.observingNativeDesktop = true;
    try {
      for (const threadId of watched) {
        if (!this.nativeObservationTimer) break;
        if (this.nativeDesktopTurns.has(threadId) || this.archivedIds.has(threadId) || this.subscribedMobileThreads.has(threadId)) continue;
        const result = await this.runDesktopAction({ action: "native-read", threadId }).catch(() => null);
        if (!this.nativeObservationTimer || this.desktopIpc?.hasOwner(threadId) || this.nativeDesktopTurns.has(threadId) || this.archivedIds.has(threadId) || this.subscribedMobileThreads.has(threadId)) continue;
        const snapshot = asRecord(result?.snapshot);
        const thread = asRecord(snapshot?.thread);
        if (thread?.id !== threadId || !Array.isArray(snapshot?.turns)) continue;
        const settings = this.nativeDesktopModelOverrides.get(threadId);
        const projected = { ...thread, status: nativeSnapshotStatus(thread, snapshot.turns), name: thread.title, turns: snapshot.turns,
          ...(settings ? { latestThreadSettings: { ...settings, mobileSendOnly: true } } : {}) };
        const digest = createHash("sha256").update(JSON.stringify(projected)).digest("hex");
        if (this.nativeObservationDigests.get(threadId) === digest) continue;
        await this.trustDesktopAttachments(projected);
        if (!this.nativeObservationTimer || this.desktopIpc?.hasOwner(threadId) || this.nativeDesktopTurns.has(threadId) || this.archivedIds.has(threadId) || this.subscribedMobileThreads.has(threadId)) continue;
        this.nativeObservationDigests.set(threadId, digest);
        const stored = await this.bridge.request("thread/read", { threadId, includeTurns: false }).catch(() => undefined);
        if (this.subscribedMobileThreads.has(threadId)) continue;
        const metadata = threadMetadataFromPayload(stored, threadId);
        const projection = { ...metadata, ...projected, mobileRuntimeActive: false };
        this.upsertThreadSummary(toThreadSummary(projection));
        for (const socket of this.wss.clients) {
          if (this.socketThreads.get(socket)?.has(threadId)) this.send(socket, { type: "thread", thread: { thread: projection } });
        }
      }
    } finally {
      this.observingNativeDesktop = false;
    }
  }

  private async refreshNativeSenderSnapshot(threadId: string) {
    try {
      const snapshot = asRecord((await this.runDesktopAction({ action: "native-read", threadId })).snapshot);
      const thread = asRecord(snapshot?.thread);
      const turns = snapshot?.turns;
      if (thread?.id !== threadId || !Array.isArray(turns) || this.nativeDesktopTurns.has(threadId) || this.archivedIds.has(threadId)) return;
      const status = nativeSnapshotStatus(thread, turns);
      this.upsertThreadStatus(threadId, status);
      this.broadcastThread(threadId, { type: "event", method: "thread/status/changed", params: { threadId, status } });
    } catch { /* The send rejection still preserves the draft. */ }
  }

  private async submitPreparedTurn(
    threadId: string,
    turnParams: Record<string, unknown>,
    deliveryMode: "auto" | "steer",
  ): Promise<unknown> {
    const clientUserMessageId = typeof turnParams.clientUserMessageId === "string" ? turnParams.clientUserMessageId : undefined;
    if (this.mobileThreads.has(threadId)) {
      return this.submitTurnIdempotently(threadId, clientUserMessageId, JSON.stringify([deliveryMode, turnParams]), () =>
        this.withMobileThread(threadId, async () => {
          if (deliveryMode === "steer") return this.steerCurrentTurn(threadId, turnParams);
          if (this.appServerThreadIsActive(threadId)) throw new GatewayRequestError("turn_active", "当前任务正在执行，请选择引导或排队。");
          await this.loadMobileThread(threadId);
          const selected = this.mobileModelOverrides.get(threadId);
          try {
            const result = await this.bridge.request("turn/start", {
              ...turnParams, ...(selected ? { model: selected.model, ...(selected.effort ? { effort: selected.effort } : {}) } : {}),
            });
            this.mobileModelOverrides.delete(threadId);
            this.rememberAppServerStartedTurn(threadId, result);
            return result;
          } catch (error) {
            this.scheduleMobileThreadRelease(threadId);
            throw error;
          }
        }));
    }
    const desktopOwned = this.desktopIpc?.hasOwner(threadId) === true;
    const result = await this.submitTurnIdempotently(threadId, clientUserMessageId, JSON.stringify(turnParams), async () => {
      if (this.config.desktopOnly && !this.desktopIpc?.hasOwner(threadId)) throw new Error("桌面对话已断开，请重新打开。");
      if (deliveryMode === "steer") return this.steerCurrentTurn(threadId, turnParams);
      if (!desktopOwned) return this.bridge.request("turn/start", turnParams);
      try {
        return await this.desktopIpc.steerTurn(threadId, turnParams);
      } catch (error) {
        if (isExplicitInactiveSteerError(error)) return this.desktopIpc.startTurn(threadId, turnParams);
        if (isUncertainDesktopSubmissionError(error)) {
          throw new GatewayRequestError(
            "submission_state_unknown",
            "提交结果不确定：Desktop IPC 未确认响应。为避免重复消息，未自动新建 turn；请刷新任务历史确认。",
          );
        }
        throw error;
      }
    });
    if (deliveryMode !== "steer" && !desktopOwned) this.rememberAppServerStartedTurn(threadId, result);
    return result;
  }

  private async steerCurrentTurn(threadId: string, turnParams: Record<string, unknown>): Promise<unknown> {
    if (!this.mobileThreads.has(threadId) && this.desktopIpc?.hasOwner(threadId)) {
      if (turnParams.expectedTurnId && turnParams.expectedTurnId !== activeConversationTurnId(this.desktopIpc.getConversation(threadId)))
        throw new GatewayRequestError("no_active_turn", "当前轮已切换，请核对后再引导。");
      try {
        return await this.desktopIpc.steerTurn(threadId, turnParams);
      } catch (error) {
        if (isExplicitInactiveSteerError(error)) throw new GatewayRequestError("no_active_turn", "当前 turn 已结束，无法引导；请选择普通发送或排队下一轮。");
        if (isUncertainDesktopSubmissionError(error)) {
          throw new GatewayRequestError("submission_state_unknown", "引导结果不确定：Desktop IPC 未确认响应。请刷新任务历史确认，避免重复发送。");
        }
        throw error;
      }
    }
    const expectedTurnId = this.appServerCurrentTurnIds.get(threadId);
    if (!expectedTurnId) throw new GatewayRequestError("no_active_turn", "尚未确认当前 turnId，无法安全引导。");
    if (turnParams.expectedTurnId && turnParams.expectedTurnId !== expectedTurnId)
      throw new GatewayRequestError("no_active_turn", "当前轮已切换，请核对后再引导。");
    return this.bridge.request("turn/steer", {
      threadId,
      clientUserMessageId: turnParams.clientUserMessageId,
      input: turnParams.input,
      expectedTurnId,
    });
  }

  private rememberAppServerStartedTurn(threadId: string, value: unknown): void {
    const outer = asRecord(value);
    const turn = asRecord(outer?.turn) ?? outer;
    const turnId = typeof turn?.id === "string" ? turn.id : typeof turn?.turnId === "string" ? turn.turnId : null;
    if (turnId && this.appServerCompletedTurnIds.get(threadId) === turnId) return;
    this.quotaFailedTurns.delete(threadId);
    if (turnId) this.appServerCurrentTurnIds.set(threadId, turnId);
    const previous = asRecord(this.appServerThreadStatuses.get(threadId));
    this.appServerThreadStatuses.set(threadId, {
      type: "active",
      activeFlags: activeFlags(previous),
    });
  }

  private rememberAppServerCompletedTurn(threadId: string, turn: Record<string, unknown> | null): void {
    const completedTurnId = typeof turn?.id === "string"
      ? turn.id
      : typeof turn?.turnId === "string"
        ? turn.turnId
        : null;
    const currentTurnId = this.appServerCurrentTurnIds.get(threadId);
    if (currentTurnId && completedTurnId && currentTurnId !== completedTurnId) return;
    this.appServerCurrentTurnIds.delete(threadId);
    if (completedTurnId) this.appServerCompletedTurnIds.set(threadId, completedTurnId);
    this.appServerThreadStatuses.set(threadId, { type: "idle" });
  }

  private rememberAppServerThreadStatus(threadId: string, status: unknown): void {
    const normalized = asRecord(status);
    if (!normalized || typeof normalized.type !== "string") return;
    this.appServerThreadStatuses.set(threadId, normalized);
  }

  currentTurnForPowerHold(threadId: string): string | undefined {
    const desktopTurn = this.desktopIpc?.hasOwner(threadId)
      ? activeConversationTurnId(this.desktopIpc.getConversation(threadId))
      : null;
    return desktopTurn ?? this.appServerCurrentTurnIds.get(threadId);
  }

  turnFinishedForPowerHold(threadId: string, turnId: string): boolean {
    if (this.appServerCompletedTurnIds.get(threadId) === turnId) return true;
    const conversation = this.desktopIpc?.getConversation(threadId);
    return Array.isArray(conversation?.turns) && conversation.turns.some(value => {
      const turn = asRecord(value);
      const status = String(turn?.status ?? "").toLowerCase();
      return (turn?.id ?? turn?.turnId) === turnId && ["completed", "failed", "interrupted", "cancelled", "canceled"].includes(status);
    });
  }

  private appServerThreadIsActive(threadId: string): boolean {
    if (this.appServerCurrentTurnIds.has(threadId)) return true;
    return statusType(this.appServerThreadStatuses.get(threadId)) === "active";
  }

  private rememberQuotaFailure(threadId: string, turnId: string): boolean {
    const current = this.appServerCurrentTurnIds.get(threadId);
    if (current && current !== turnId) return false;
    this.quotaFailedTurns.set(threadId, turnId);
    if (this.quotaFailedTurns.size > 1000)
      this.quotaFailedTurns.delete(this.quotaFailedTurns.keys().next().value!);
    return true;
  }

  private upsertThreadStatus(threadId: string, status: unknown): void {
    const change = this.threadIndex.patch(threadId, { status });
    if (change) this.broadcast({ type: "threads.delta", baseVersion: change.version - 1, version: change.version,
      upserts: this.withMembership(change.upserts), removedIds: [] });
  }

  private isThreadActive(threadId: string): boolean {
    if (this.appServerThreadIsActive(threadId)) return true;
    return this.desktopIpc?.hasOwner(threadId) === true && conversationIsActive(this.desktopIpc.getConversation(threadId));
  }

  private mergedThreadStatus(threadId: string, fallback: unknown): unknown {
    const appServerStatus = this.appServerThreadStatuses.get(threadId);
    const desktopThread = this.desktopThreads.get(threadId);
    const desktopStatus = desktopThread?.threadRuntimeStatus ?? desktopThread?.status;
    const appServerActive = this.appServerThreadIsActive(threadId);
    const desktopActive = conversationIsActive(desktopThread);
    if (statusType(fallback) === "quotalimited" || (!appServerActive && this.quotaFailedTurns.has(threadId))) return { type: "quotaLimited" };
    if (appServerActive || desktopActive) {
      return {
        type: "active",
        activeFlags: [...new Set([
          ...activeFlags(appServerStatus),
          ...activeFlags(desktopStatus),
        ])],
      };
    }
    if (isLoadedStatus(appServerStatus)) return appServerStatus;
    if (isLoadedStatus(desktopStatus)) return desktopStatus;
    return appServerStatus ?? desktopStatus ?? fallback;
  }

  private projectThreadRuntimeStatus(thread: Record<string, unknown>): Record<string, unknown> {
    const status = this.mergedThreadStatus(String(thread.id ?? ""), nativeSnapshotStatus(thread, canonicalTurns(thread)));
    return { ...thread, status, threadRuntimeStatus: status };
  }

  private scheduleQueueDrain(threadId: string): void {
    if (!this.promptQueue || this.queueDrains.has(threadId)) return;
    const drain = Promise.resolve().then(() => this.drainPromptQueue(threadId)).catch((error) => {
      console.warn("[prompt-queue] drain", threadId, error);
    }).finally(() => {
      this.queueDrains.delete(threadId);
    });
    this.queueDrains.set(threadId, drain);
  }

  private async drainPromptQueue(threadId: string): Promise<void> {
    if (this.config.desktopOnly && !await this.isMobileThread(threadId)) return;
    if (!this.promptQueue || this.isThreadActive(threadId)) return;
    // Strict single-owner rule: Desktop native queue and Host queue cannot share
    // an atomic lock. Never auto-start while Desktop owns the conversation.
    if (this.desktopIpc?.hasOwner(threadId)) return;
    const item = await this.promptQueue.claimNext(threadId);
    if (!item) return;
    this.broadcastQueue(threadId);
    await this.deliverClaimedQueueItem(item, "queue");
  }

  private async deliverClaimedQueueItem(item: StoredPromptQueueItem, mode: "queue" | "promote"): Promise<unknown> {
    if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
    try {
      if (mode === "queue" && this.isThreadActive(item.threadId)) {
        await this.promptQueue.requeue(item.id, "检测到新的活动 turn，继续等待下一轮，未创建竞争 turn。");
        this.broadcastQueue(item.threadId);
        return {};
      }
      const result = mode === "queue"
        ? await this.startQueuedTurn(item.threadId, item.turnParams)
        : this.isThreadActive(item.threadId)
          ? await this.submitPreparedTurn(item.threadId, item.turnParams, "steer")
          : await this.startQueuedTurn(item.threadId, item.turnParams);
      await this.promptQueue.complete(item.id);
      await Promise.all(item.uploadIds.map((uploadId) => this.files?.commitUpload(uploadId)));
      this.broadcastQueue(item.threadId);
      return result;
    } catch (error) {
      if (mode === "queue" && error instanceof GatewayRequestError && ["queue_turn_active", "desktop_owns_thread"].includes(error.code)) {
        await this.promptQueue.requeue(item.id, error.message);
        this.broadcastQueue(item.threadId);
        return {};
      }
      const uncertain = error instanceof GatewayRequestError && error.code === "submission_state_unknown";
      await this.promptQueue.fail(item.id, error instanceof Error ? error.message : String(error), uncertain);
      this.broadcastQueue(item.threadId);
      throw error;
    }
  }

  private async startQueuedTurn(threadId: string, turnParams: Record<string, unknown>): Promise<unknown> {
    if (await this.isMobileThread(threadId)) return this.submitPreparedTurn(threadId, turnParams, "auto");
    await this.ensureDesktopOwner(threadId);
    if (this.isThreadActive(threadId)) throw new GatewayRequestError("queue_turn_active", "检测到新的活动 turn，队列继续等待，未创建竞争 turn。");
    const clientUserMessageId = typeof turnParams.clientUserMessageId === "string" ? turnParams.clientUserMessageId : undefined;
    const desktopOwned = this.desktopIpc?.hasOwner(threadId) === true;
    const result = await this.submitTurnIdempotently(threadId, clientUserMessageId, JSON.stringify(turnParams), async () => {
      try {
        return desktopOwned
          ? await this.desktopIpc!.startTurn(threadId, turnParams)
          : await this.bridge.request("turn/start", turnParams);
      } catch (error) {
        if (isUncertainDesktopSubmissionError(error)) {
          throw new GatewayRequestError("submission_state_unknown", "排队提示词的启动结果不确定；已暂停自动重试，请刷新历史确认。");
        }
        throw error;
      }
    });
    if (!desktopOwned) this.rememberAppServerStartedTurn(threadId, result);
    return result;
  }

  private async pausePromptQueue(threadId: string, reason: string): Promise<void> {
    if (!this.promptQueue) return;
    if (await this.promptQueue.pauseThread(threadId, reason)) this.broadcastQueue(threadId);
  }

  private async trustDesktopAttachments(thread: Record<string, unknown>): Promise<void> {
    if (!this.files) return;
    const paths = desktopAttachmentPaths(thread);
    await Promise.all(paths.map(async (path) => {
      try {
        await this.files!.trustDesktopAttachment(path);
      } catch (error) {
        console.warn("[desktop-attachment]", path, error instanceof Error ? error.message : error);
      }
    }));
  }

  private releaseQueueUploads(item: StoredPromptQueueItem): void {
    for (const uploadId of item.uploadIds) this.files?.releaseUpload(uploadId);
  }

  private broadcastQueue(threadId: string): void {
    if (this.promptQueue) this.broadcast({ type: "prompt.queue.updated", threadId, items: this.promptQueue.list(threadId) });
  }

  private submitTurnIdempotently(
    threadId: string,
    clientUserMessageId: string | undefined,
    fingerprint: string,
    submit: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!clientUserMessageId) return submit();
    this.pruneTurnSubmissions();
    const key = `${threadId}:${clientUserMessageId}`;
    const existing = this.turnSubmissions.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new GatewayRequestError(
          "idempotency_conflict",
          "同一个 clientUserMessageId 被用于不同内容，已拒绝以避免重复或错配。",
        );
      }
      return existing.promise;
    }
    const promise = Promise.resolve().then(submit);
    this.turnSubmissions.set(key, {
      fingerprint,
      createdAt: Date.now(),
      promise,
    });
    return promise;
  }

  private pruneTurnSubmissions(now = Date.now()): void {
    for (const [key, entry] of this.turnSubmissions) {
      if (now - entry.createdAt > TURN_SUBMISSION_TTL_MS)
        this.turnSubmissions.delete(key);
    }
    while (this.turnSubmissions.size >= MAX_TURN_SUBMISSIONS) {
      const oldest = this.turnSubmissions.keys().next().value as
        string | undefined;
      if (!oldest) break;
      this.turnSubmissions.delete(oldest);
    }
  }

  private markArchived(threadId: string): void {
    this.archivedIds.add(threadId);
    for (const socket of this.wss.clients) this.socketThreads.get(socket)?.delete(threadId);
    this.desktopThreads.delete(threadId);
    const change = this.threadIndex.remove(threadId);
    if (change) this.broadcast({ type: "threads.delta", baseVersion: change.version - 1, version: change.version, upserts: [], removedIds: [threadId] });
  }

  private projectlessIds = new Set<string>();
  private membershipKnown = false;

  private withMembership(threads: ThreadSummary[]): ThreadSummary[] {
    return threads.map(thread => {
      if (this.mobileProjectlessIds.has(thread.id) || this.projectlessIds.has(thread.id)) return { ...thread, projectless: true };
      return this.membershipKnown ? { ...thread, projectless: false } : thread;
    });
  }

  private async refreshProjectMembership(): Promise<void> {
    if (!this.config.desktopOnly) return;
    return this.membershipLoad ??= (async () => {
      const metadata = await stat(this.projectMembershipPath);
      const stamp = `${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}:${metadata.ino}`;
      if (stamp === this.membershipStamp) return;
      const state = asRecord(JSON.parse(await readFile(this.projectMembershipPath, "utf8")));
      if (!state) return;
      const ids = state["projectless-thread-ids"];
      if (ids !== undefined && !Array.isArray(ids)) return;
      this.membershipStamp = stamp;
      const next = new Set((ids ?? []).filter((id): id is string => typeof id === "string"));
      if (this.membershipKnown && next.size === this.projectlessIds.size
          && [...next].every(id => this.projectlessIds.has(id))) return;
      this.projectlessIds = next;
      this.membershipKnown = true;
      for (const thread of this.threadIndex.snapshot()) {
        const projectless = next.has(thread.id) || this.mobileProjectlessIds.has(thread.id);
        if (thread.projectless === projectless) continue;
        const change = this.threadIndex.patch(thread.id, { projectless });
        if (change) this.broadcast({
          type: "threads.delta", baseVersion: change.version - 1, version: change.version,
          upserts: change.upserts, removedIds: [],
        });
      }
    })().catch(() => {
      // Desktop can replace its state file while we read it.
    }).finally(() => { this.membershipLoad = undefined; });
  }

  private async ensureThreadIndex(): Promise<void> {
    await this.refreshProjectMembership();
    if (this.threadIndex.isInitialized) {
      const ttl = this.threadIndex.snapshot().length === 0
        ? EMPTY_THREAD_INDEX_TTL_MS
        : THREAD_INDEX_TTL_MS;
      if (Date.now() - this.threadIndexLoadedAt < ttl) return;
    }
    if (this.threadIndexLoad) return this.threadIndexLoad;
    this.threadIndexLoad = (async () => {
      const data: Array<Record<string, unknown>> = [];
      const seenCursors = new Set<string>();
      let cursor: string | null | undefined;
      do {
        const result = (await this.bridge.request("thread/list", {
          limit: 100,
          ...(cursor ? { cursor } : {}),
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: THREAD_SOURCE_KINDS,
        })) as ThreadListResult;
        data.push(...(result.data ?? []));
        cursor = result.nextCursor;
        if (cursor && seenCursors.has(cursor)) throw new Error("Codex returned a repeated thread-list cursor.");
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      const byId = new Map(data.map((thread) => {
        this.rememberThreadSource(thread);
        const summary = toThreadSummary(thread);
        return [summary.id, summary] as const;
      }));
      for (const desktopThread of this.desktopThreads.values()) {
        const summary = toThreadSummary(desktopThread);
        if (summary.id) byId.set(summary.id, summary);
      }
      await this.refreshProjectMembership();
      this.threadIndex.replace(this.withMembership([...byId.values()].filter(thread => !this.archivedIds.has(thread.id))).map((thread) => ({
        ...thread,
        status: this.mergedThreadStatus(thread.id, thread.status),
      })));
      this.threadIndexLoadedAt = Date.now();
      for (const thread of this.threadIndex.snapshot()) {
        if (isAbsoluteHostPath(thread.cwd)) this.threadCwds.set(thread.id, thread.cwd);
      }
    })().finally(() => {
      this.threadIndexLoad = null;
    });
    return this.threadIndexLoad;
  }

  private async syncThreads(socket: WebSocket, requestId?: string, knownVersion?: number): Promise<void> {
    await this.ensureThreadIndex();
    if (typeof knownVersion === "number") {
      const delta = this.threadIndex.deltaAfter(knownVersion);
      if (delta) {
        this.send(socket, {
          type: "threads.delta",
          requestId,
          baseVersion: knownVersion,
          version: delta.version,
          upserts: this.withMembership(delta.upserts),
          removedIds: delta.removedIds,
        });
        return;
      }
    }
    this.send(socket, {
      type: "threads.snapshot",
      requestId,
      version: this.threadIndex.currentVersion,
      threads: this.withMembership(this.threadIndex.snapshot()),
    });
  }

  private async listThreads(
    socket: WebSocket,
    requestId?: string,
    requestedLimit?: number,
  ): Promise<void> {
    await this.ensureThreadIndex();
    const limit = requestedLimit == null ? undefined : Math.max(requestedLimit, 1);
    this.send(socket, {
      type: "threads",
      requestId,
      threads: this.withMembership(this.threadIndex.snapshot().slice(0, limit)),
      nextCursor: null,
    });
  }

  private upsertThreadSummary(summary: ThreadSummary): void {
    if (!summary.id || this.archivedIds.has(summary.id)) return;
    if (isAbsoluteHostPath(summary.cwd)) this.threadCwds.set(summary.id, summary.cwd);
    if (summary.mobileManaged && summary.projectless === true) this.mobileProjectlessIds.add(summary.id);
    const change = this.threadIndex.upsert(this.withMembership([summary])[0]!);
    if (!change) return;
    this.broadcast({
      type: "threads.delta",
      baseVersion: change.version - 1,
      version: change.version,
      upserts: this.withMembership(change.upserts),
      removedIds: change.removedIds,
    });
  }

  private async publishStartedThread(params: Record<string, unknown>): Promise<void> {
    const thread = asRecord(params.thread);
    if (!thread || typeof thread.id !== "string") return;
    if (!isMobileThreadSource(thread.threadSource) && !this.projectlessIds.has(thread.id)) {
      // The Desktop event can arrive before it persists the new thread's project assignment.
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    await this.refreshProjectMembership();
    if (this.archivedIds.has(thread.id)) return;
    this.updateThreadIndexFromNotification("thread/started", params);
    const [summary] = this.withMembership([toThreadSummary(thread)]);
    this.broadcast({ type: "event", method: "thread/started", params: {
      ...params, thread: { ...thread, projectless: summary?.projectless },
    } });
  }

  private updateThreadIndexFromNotification(method: string, params: Record<string, unknown> | null): void {
    if (!params) return;
    const nestedThread = asRecord(params.thread);
    if (method === "thread/started" && nestedThread) {
      this.rememberThreadSource(nestedThread);
      const summary = toThreadSummary(nestedThread);
      this.upsertThreadSummary({ ...summary, status: this.mergedThreadStatus(summary.id, summary.status) });
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return;
    if (method === "thread/archived") {
      this.markArchived(threadId);
      return;
    }
    if (method === "thread/unarchived") {
      this.archivedIds.delete(threadId);
      this.threadIndexLoadedAt = 0;
      return;
    }
    if (method === "thread/deleted") {
      const change = this.threadIndex.remove(threadId);
      if (change) this.broadcast({ type: "threads.delta", baseVersion: change.version - 1, version: change.version, upserts: [], removedIds: [threadId] });
      return;
    }
    const updatedAt = Math.floor(Date.now() / 1_000);
    const patch: Partial<ThreadSummary> = { updatedAt };
    if (method === "thread/status/changed") patch.status = this.mergedThreadStatus(threadId, params.status);
    else if (method === "turn/started") patch.status = { type: "active", activeFlags: [] };
    else if (method === "turn/completed") patch.status = this.mergedThreadStatus(threadId, { type: "idle" });
    else return;
    const change = this.threadIndex.patch(threadId, patch);
    if (change) this.broadcast({ type: "threads.delta", baseVersion: change.version - 1, version: change.version, upserts: this.withMembership(change.upserts), removedIds: [] });
  }

  private async openThreadPage(
    socket: WebSocket,
    threadId: string,
    requestId?: string,
    requestedLimit?: number,
    knownTurnIds?: string[],
  ): Promise<void> {
    const limit = boundedHistoryLimit(requestedLimit);
    const mobile = await this.isMobileThread(threadId);
    const desktopThread = !this.subscribedMobileThreads.has(threadId) && this.desktopIpc?.ready
      ? await this.desktopIpc.openConversation(threadId, "local", 2_500, false)
      : null;
    let metadataPayload: unknown;
    let liveTurns: unknown[] = [];
    if (desktopThread && this.desktopIpc?.hasOwner(threadId)) {
      this.desktopThreads.set(threadId, desktopThread);
      const projected = projectDesktopLiveThread(desktopThread);
      liveTurns = canonicalTurns(projected);
      if (this.config.desktopOnly) {
        const settings = await this.desktopIpc.readModelSettings(threadId).catch(() => null);
        if (settings) projected.latestThreadSettings = { ...asRecord(projected.latestThreadSettings), ...settings };
      }
      metadataPayload = { thread: projected };
    } else {
      metadataPayload = this.config.desktopOnly
        ? await this.bridge.request("thread/read", { threadId, includeTurns: false })
        : await this.bridge.request("thread/resume", { threadId, excludeTurns: true });
      if (this.config.desktopOnly && !this.subscribedMobileThreads.has(threadId) && (!this.desktopIpc?.ready || mobile)) {
        const native = await this.runDesktopAction({ action: "native-read", threadId }).catch(() => null);
        const snapshot = asRecord(native?.snapshot);
        const live = asRecord(snapshot?.thread);
        const stored = asRecord(asRecord(metadataPayload)?.thread);
        if (live?.id === threadId && stored) {
          metadataPayload = { thread: { ...stored, status: live.status } };
          if (Array.isArray(snapshot?.turns)) liveTurns = snapshot.turns;
        }
      }
    }
    this.rememberThreadCwd(threadId, metadataPayload);
    // Older clients report a turn as known as soon as they have any item from it.
    // Replay the newest turns so a reconnect can recover a missed final response.
    const page = await this.readTurnsPage(threadId, null, limit, knownTurnIds, RECENT_TURNS_TO_REPLAY);
    const metadata = threadMetadataFromPayload(metadataPayload, threadId);
    await this.refreshProjectMembership();
    if (metadata.threadSource === MOBILE_PROJECTLESS_SOURCE) this.mobileProjectlessIds.add(threadId);
    const nativeSettings = this.config.desktopOnly && !mobile && !this.desktopIpc?.ready ? this.nativeDesktopModelOverrides.get(threadId) : undefined;
    const managedSettings = mobile ? this.mobileModelOverrides.get(threadId) : undefined;
    if (nativeSettings || managedSettings) {
      metadata.latestThreadSettings = { ...asRecord(metadata.latestThreadSettings), ...nativeSettings, ...managedSettings,
        ...(nativeSettings ? { mobileSendOnly: true } : {}) };
    }
    if (mobile) {
      const activeTurn = this.appServerCurrentTurnIds.get(threadId);
      metadata.mobileManaged = true;
      metadata.mobileRuntimeActive = Boolean(activeTurn);
      metadata.mobileActiveTurnId = activeTurn;
    }
    const turns = mergeTurns(page.turns, liveTurns);
    if (this.archivedIds.has(threadId)) throw new Error("这段对话已归档，可在已归档列表中恢复。");
    const start = this.recentMobileStarts.get(threadId);
    if (start) {
      if (turns.some(turn => turn.id === start.turn.id) || start.expiresAt <= Date.now()) this.recentMobileStarts.delete(threadId);
      else if (turns.length === 0) throw new GatewayRequestError("mobile_history_pending", "新对话历史正在写入。");
    }
    const [membership] = this.withMembership([toThreadSummary(metadata)]);
    const status = nativeSnapshotStatus(metadata, turns);
    const thread = { ...metadata, turns, status, threadRuntimeStatus: status, projectless: membership?.projectless };
    await this.trustDesktopAttachments({ turns: [...turns, ...page.cachedTurns] });
    this.replayCachedItems(socket, threadId, page.cachedTurns);
    const summary = toThreadSummary(thread);
    this.upsertThreadSummary({ ...summary, status: this.mergedThreadStatus(threadId, summary.status) });
    this.send(socket, {
      type: "thread",
      requestId,
      thread: { thread },
      history: page.history,
    });
    this.scheduleQueueDrain(threadId);
  }

  private async sendThreadHistoryPage(
    socket: WebSocket,
    threadId: string,
    requestId?: string,
    cursor?: string | null,
    requestedLimit?: number,
    knownTurnIds?: string[],
  ): Promise<void> {
    const page = await this.readTurnsPage(threadId, cursor ?? null, boundedHistoryLimit(requestedLimit), knownTurnIds);
    await this.trustDesktopAttachments({ turns: [...page.turns, ...page.cachedTurns] });
    this.replayCachedItems(socket, threadId, page.cachedTurns);
    this.send(socket, {
      type: "thread.history",
      requestId,
      threadId,
      turns: page.turns,
      history: page.history,
    });
  }

  private async readTurnsPage(
    threadId: string,
    cursor: string | null,
    limit: number,
    knownTurnIds?: string[],
    replayLatest = 0,
  ): Promise<{
    turns: Array<Record<string, unknown>>;
    cachedTurns: Array<Record<string, unknown>>;
    history: { nextCursor: string | null; backwardsCursor: string | null; hasMore: boolean; legacyFullHistory?: boolean };
  }> {
    const known = new Set((knownTurnIds ?? []).slice(0, 500));
    const cached = (turn: Record<string, unknown>) => known.has(String(turn.id ?? "")) && !turnInProgress(turn);
    try {
      const result = (await this.bridge.request("thread/turns/list", {
        threadId,
        ...(cursor ? { cursor } : {}),
        limit,
        sortDirection: "desc",
        itemsView: "full",
      })) as ThreadTurnsListResult;
      const recent = result.data ?? [];
      return {
        turns: recent.filter((turn, index) => index < replayLatest || !cached(turn)).reverse(),
        cachedTurns: recent.filter(cached).reverse(),
        history: {
          nextCursor: result.nextCursor ?? null,
          backwardsCursor: result.backwardsCursor ?? null,
          hasMore: Boolean(result.nextCursor),
        },
      };
    } catch (error) {
      if (!isMethodUnavailable(error)) throw error;
      const result = await this.bridge.request("thread/read", { threadId, includeTurns: true });
      const metadata = threadMetadataFromPayload(result, threadId);
      const allTurns = Array.isArray(metadata.turns) ? metadata.turns.filter((turn): turn is Record<string, unknown> => Boolean(asRecord(turn))) : [];
      return {
        turns: allTurns.filter((turn, index) => index >= allTurns.length - replayLatest || !cached(turn)),
        cachedTurns: allTurns.filter(cached),
        history: { nextCursor: null, backwardsCursor: null, hasMore: false, legacyFullHistory: true },
      };
    }
  }

  private replayCachedItems(socket: WebSocket, threadId: string, cachedTurns: Record<string, unknown>[]): void {
    // A cached turn may be missing its final reply or a user message containing an image.
    for (const turn of cachedTurns) {
      const turnId = turn.id;
      if (typeof turnId !== "string" || !Array.isArray(turn.items)) continue;
      const rawTime = turn.completedAtMs ?? turn.turnCompletedAtMs ?? turn.completedAt ?? turnTimestamp(turn);
      const completedAtMs = typeof rawTime === "number" && rawTime > 0
        ? rawTime < 1_000_000_000_000 ? rawTime * 1_000 : rawTime
        : undefined;
      for (const rawItem of turn.items) {
        const item = asRecord(rawItem);
        if (!item || typeof item.id !== "string") continue;
        const finalReply = item.type === "agentMessage" && item.phase !== "commentary";
        const hasImage = item.type === "userMessage" && canonicalContentImagePaths(item).length > 0;
        if (!finalReply && !hasImage) continue;
        this.send(socket, {
          type: "event",
          method: "item/completed",
          params: { threadId, turnId, ...(finalReply ? { completedAtMs } : {}), item },
        });
      }
    }
  }

  private rememberThreadCwd(threadId: string, payload: unknown): void {
    const outer = asRecord(payload);
    const thread = asRecord(outer?.thread) ?? outer;
    if (typeof thread?.cwd === "string" && isAbsoluteHostPath(thread.cwd))
      this.threadCwds.set(threadId, thread.cwd);
  }

  private permissionCwd(
    threadId: string,
    mode:
      "auto" | "granular" | "read-only" | "guardian-approvals" | "full-access",
  ): string | undefined {
    if (mode === "read-only" || mode === "full-access") return undefined;
    const desktopCwd = this.desktopThreads.get(threadId)?.cwd;
    const cwd =
      typeof desktopCwd === "string"
        ? desktopCwd
        : this.threadCwds.get(threadId);
    if (!cwd || !isAbsoluteHostPath(cwd))
      throw new Error(
        "Task working directory is unavailable; refusing to widen workspace permissions.",
      );
    return cwd;
  }

  private syncDesktopApprovals(
    threadId: string,
    thread: Record<string, unknown>,
  ): void {
    const activeKeys = new Set<number | string>();
    const requests = Array.isArray(thread.requests) ? thread.requests : [];
    for (const value of requests) {
      const request = asRecord(value);
      if (!request || !isApprovalMethod(String(request.method ?? ""))) continue;
      const originalId =
        typeof request.id === "string" || typeof request.id === "number"
          ? request.id
          : null;
      if (originalId == null) continue;
      const wireId = `desktop:${threadId}:${String(originalId)}`;
      activeKeys.add(wireId);
      const params = {
        ...(asRecord(request.params) ?? {}),
        threadId,
        _desktopRequestId: originalId,
        _desktopOrigin: true,
      };
      const envelope: RpcEnvelope = {
        id: wireId,
        method: String(request.method),
        params,
      };
      const wasPending = this.approvals.has(wireId);
      this.approvals.set(wireId, envelope);
      this.desktopApprovalKeys.add(wireId);
      if (!wasPending)
        this.broadcast({
          type: "approval",
          approval: normalizeApproval(envelope),
        });
    }
    for (const wireId of [...this.desktopApprovalKeys]) {
      if (
        !String(wireId).startsWith(`desktop:${threadId}:`) ||
        activeKeys.has(wireId)
      )
        continue;
      this.desktopApprovalKeys.delete(wireId);
      if (this.approvals.delete(wireId))
        this.broadcast({
          type: "approval.resolved",
          approvalRequestId: wireId,
        });
    }
  }

  private onServerRequest(message: RpcEnvelope): void {
    if (!isApprovalMethod(message.method)) {
      this.bridge.respondError(
        message.id,
        -32601,
        `Unsupported client callback: ${message.method}`,
      );
      return;
    }
    const requestThreadId =
      typeof message.params?.threadId === "string" ? message.params.threadId : undefined;
    const desktopOwnsThread = Boolean(
      requestThreadId &&
      this.desktopIpc?.ready &&
      this.desktopThreads.has(requestThreadId),
    );
    // Desktop IPC is authoritative for command/file/permission approvals on a
    // Desktop-owned task. app-server mirrors can receive the same callback even
    // when Desktop auto-approves it, which previously produced a phone-only card.
    // Native MCP elicitation is not exposed by Desktop IPC and must remain routed.
    if (desktopOwnsThread && message.method !== "mcpServer/elicitation/request") return;
    const wasPending = this.approvals.has(message.id);
    this.approvals.set(message.id, message);
    if (wasPending) return;
    const params = message.params ?? {};
    const diff =
      typeof params.threadId === "string" && typeof params.turnId === "string"
        ? this.turnDiffs.get(turnKey(params.threadId, params.turnId))
        : undefined;
    this.broadcast({
      type: "approval",
      approval: normalizeApproval(message, diff),
    });
  }

  private clearAppServerApprovals(
    threadId: string,
    match: { turnId?: string; itemId?: string } = {},
  ): void {
    for (const [requestId, pending] of [...this.approvals]) {
      const params = pending.params ?? {};
      if (params._desktopOrigin === true || params.threadId !== threadId) continue;
      if (match.turnId && params.turnId !== match.turnId) continue;
      if (match.itemId && params.itemId !== match.itemId) continue;
      this.approvals.delete(requestId);
      this.broadcast({ type: "approval.resolved", approvalRequestId: requestId });
    }
  }

  private async resolveApproval(
    socket: WebSocket,
    approvalRequestId: number | string,
    decision: ApprovalDecision,
    requestId?: string,
  ): Promise<void> {
    const pending = this.approvals.get(approvalRequestId);
    if (!pending) throw new Error("Approval request is no longer pending.");
    const result = approvalResult(pending.method, decision, pending.params);
    if (pending.params?._desktopOrigin === true) {
      const threadId = requiredString(pending.params.threadId, "threadId");
      const originalId = pending.params._desktopRequestId;
      if (typeof originalId !== "string" && typeof originalId !== "number")
        throw new Error("Desktop approval request ID is invalid.");
      await this.desktopIpc?.resolveApproval(
        threadId,
        pending.method,
        originalId,
        result,
      );
      this.desktopApprovalKeys.delete(approvalRequestId);
    } else {
      this.bridge.respond(approvalRequestId, result);
    }
    if (this.approvals.delete(approvalRequestId)) {
      const notification: ServerMessage = {
        type: "approval.resolved",
        requestId,
        approvalRequestId,
      };
      this.broadcast(notification);
    }
  }

  private broadcast(message: ServerMessage): void {
    const synced = this.syncJournal.append(message);
    const payload = JSON.stringify(synced);
    for (const socket of this.wss.clients)
      this.sendPayload(socket, payload);
  }

  private broadcastThread(threadId: string, message: ServerMessage): void {
    const sockets = [...this.wss.clients].filter(
      (socket) =>
        socket.readyState === WebSocket.OPEN &&
        this.socketThreads.get(socket)?.has(threadId),
    );
    const isDesktopSnapshot =
      message.type === "event" &&
      message.method === "desktop/threadSnapshot";
    if (isDesktopSnapshot) {
      if (sockets.length === 0) return;
      const payload = JSON.stringify(message);
      for (const socket of sockets) this.sendPayload(socket, payload);
      return;
    }
    const synced = this.syncJournal.append(message, threadId);
    const payload = JSON.stringify(synced);
    for (const socket of sockets) this.sendPayload(socket, payload);
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    this.sendPayload(socket, JSON.stringify(message));
  }

  private sendPayload(socket: WebSocket, payload: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      socket.terminate();
      return;
    }
    socket.send(payload);
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }

  private isRateLimited(address: string): boolean {
    const entry = this.failedAuth.get(address);
    if (!entry) return false;
    if (Date.now() >= entry.resetAt) {
      this.failedAuth.delete(address);
      return false;
    }
    return entry.count >= 10;
  }

  private recordAuthFailure(address: string): void {
    const now = Date.now();
    const entry = this.failedAuth.get(address);
    if (!entry || now >= entry.resetAt) {
      this.failedAuth.set(address, { count: 1, resetAt: now + 60_000 });
    } else {
      entry.count += 1;
    }
  }
}

function canonicalContentImagePaths(item: Record<string, unknown>): string[] {
  return Array.isArray(item.content) ? item.content.flatMap(value => {
    const part = asRecord(value);
    return part?.type === "localImage" && typeof part.path === "string" && isAbsoluteHostPath(part.path) ? [part.path] : [];
  }) : [];
}

export function desktopAttachmentPaths(thread: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && isAbsoluteHostPath(value)) paths.add(value);
  };
  for (const turnValue of canonicalTurns(thread)) {
    const turn = asRecord(turnValue);
    for (const itemValue of Array.isArray(turn?.items) ? turn.items : []) {
      const item = asRecord(itemValue);
      if (!item || !String(item.type ?? "").toLowerCase().includes("user")) continue;
      for (const inputValue of Array.isArray(item.input) ? item.input : []) {
        const input = asRecord(inputValue);
        const type = String(input?.type ?? "").toLowerCase();
        if (type.includes("image") || type.includes("file") || type.includes("mention")) add(input?.path);
      }
      for (const path of canonicalContentImagePaths(item)) paths.add(path);
      for (const attachmentValue of Array.isArray(item.attachments) ? item.attachments : []) {
        const attachment = asRecord(attachmentValue);
        add(attachment?.fsPath);
        add(attachment?.path);
      }
      const restore = asRecord(item.restoreMessage);
      const context = asRecord(restore?.context);
      for (const key of ["imageAttachments", "fileAttachments"]) {
        for (const attachmentValue of Array.isArray(context?.[key]) ? context[key] as unknown[] : []) {
          const attachment = asRecord(attachmentValue);
          add(attachment?.localPath);
          add(attachment?.fsPath);
          add(attachment?.path);
        }
      }
    }
  }
  return [...paths];
}

export function projectDesktopLiveThread(thread: Record<string, unknown>): Record<string, unknown> {
  const { turnHistory: _turnHistory, turns: _turns, ...metadata } = thread;
  const turns = canonicalTurns(thread);
  const active = turns.filter((turn) => turnInProgress(asRecord(turn) ?? {}));
  const recent = turns.slice(-2);
  return { ...metadata, turns: mergeTurns(recent.filter((turn): turn is Record<string, unknown> => Boolean(asRecord(turn))), active.filter((turn): turn is Record<string, unknown> => Boolean(asRecord(turn)))) };
}

function threadMetadataFromPayload(payload: unknown, threadId: string): Record<string, unknown> {
  const outer = asRecord(payload) ?? {};
  const nested = asRecord(outer.thread) ?? outer;
  const latestThreadSettings = {
    ...(typeof nested.model === "string" ? { model: nested.model } : {}),
    ...(typeof nested.reasoningEffort === "string" ? { effort: nested.reasoningEffort } : {}),
    ...(asRecord(nested.latestThreadSettings) ?? {}),
    ...(typeof outer.model === "string" ? { model: outer.model } : {}),
    ...(typeof outer.reasoningEffort === "string" ? { effort: outer.reasoningEffort } : {}),
    ...(outer.sandbox != null ? { sandboxPolicy: outer.sandbox } : {}),
    ...(outer.approvalPolicy != null ? { approvalPolicy: outer.approvalPolicy } : {}),
    ...(outer.approvalsReviewer != null ? { approvalsReviewer: outer.approvalsReviewer } : {}),
  };
  return {
    ...nested,
    id: typeof nested.id === "string" ? nested.id : threadId,
    ...(typeof outer.cwd === "string" ? { cwd: outer.cwd } : {}),
    ...(typeof outer.modelProvider === "string" ? { modelProvider: outer.modelProvider } : {}),
    latestThreadSettings,
    turns: Array.isArray(nested.turns) ? nested.turns : [],
  };
}

function isMobileThreadSource(value: unknown): boolean {
  return value === MOBILE_THREAD_SOURCE || value === MOBILE_PROJECTLESS_SOURCE;
}

function mergeTurns(...groups: unknown[][]): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  let fallback = 0;
  for (const group of groups) {
    for (const value of group) {
      const turn = asRecord(value);
      if (!turn) continue;
      const canonicalId = typeof turn.id === "string"
        ? turn.id
        : typeof turn.turnId === "string"
          ? turn.turnId
          : `turn_${fallback++}`;
      const previous = byId.get(canonicalId);
      byId.set(canonicalId, {
        ...previous,
        ...turn,
        id: canonicalId,
        ...(previous || Array.isArray(turn.items)
          ? { items: mergeTurnItems(previous?.items, turn.items) }
          : {}),
      });
    }
  }
  return [...byId.values()].sort((a, b) => turnTimestamp(a) - turnTimestamp(b));
}

function mergeTurnItems(previousValue: unknown, nextValue: unknown): unknown[] {
  const previous = Array.isArray(previousValue) ? previousValue : [];
  const next = Array.isArray(nextValue) ? nextValue : [];
  const merged: unknown[] = [];
  const indexById = new Map<string, number>();
  for (const value of [...previous, ...next]) {
    const item = asRecord(value);
    const id = typeof item?.id === "string"
      ? item.id
      : typeof item?.itemId === "string"
        ? item.itemId
        : undefined;
    if (!id) {
      merged.push(value);
      continue;
    }
    const existingIndex = indexById.get(id);
    if (existingIndex == null) {
      indexById.set(id, merged.length);
      merged.push(value);
      continue;
    }
    const existing = asRecord(merged[existingIndex]);
    merged[existingIndex] = existing && item ? { ...existing, ...item, id } : value;
  }
  return merged;
}

function turnTimestamp(turn: Record<string, unknown>): number {
  const value = turn.startedAt ?? turn.turnStartedAtMs ?? turn.startedAtMs ?? 0;
  return typeof value === "number" ? value : 0;
}

function turnInProgress(turn: Record<string, unknown>): boolean {
  return String(turn.status ?? "").toLowerCase().includes("progress");
}

function boundedHistoryLimit(value: unknown): number {
  return Math.min(Math.max(typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 20, 5), 50);
}

function isMethodUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /method not found|unknown method|unsupported method|-32601/i.test(text);
}

function isMobileHistoryPending(error: unknown): boolean {
  return error instanceof GatewayRequestError && error.code === "mobile_history_pending"
    || error instanceof Error && /failed to read session metadata|rollout.*(?:is empty|not found)/i.test(error.message);
}

function isThreadContentEvent(method: string): boolean {
  return method.startsWith("item/")
    || method.includes("/delta")
    || method === "turn/diff/updated"
    || method === "thread/tokenUsage/updated";
}

function emptyGitDiff(threadId: string, cwd: string, error: string): GitDiffSnapshot {
  return { threadId, cwd, repositoryRoot: "", diff: "", files: 0, additions: 0, deletions: 0, truncated: false, generatedAt: Date.now(), error };
}


function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function statusType(value: unknown): string {
  return String(asRecord(value)?.type ?? "").toLowerCase();
}

function nativeSnapshotStatus(thread: Record<string, unknown>, turns: unknown[]): unknown {
  const status = thread.threadRuntimeStatus ?? thread.status;
  const last = asRecord(turns.at(-1));
  if (String(last?.status).toLowerCase() === "failed" && isUsageLimitError(last?.error) && activeFlags(status).length === 0) {
    return { type: "quotaLimited" };
  }
  return status;
}

function activeFlags(value: unknown): string[] {
  const flags = asRecord(value)?.activeFlags;
  return Array.isArray(flags) ? flags.map(String) : [];
}

function isLoadedStatus(value: unknown): boolean {
  const type = statusType(value);
  return type === "idle" || type === "systemerror";
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} is required.`);
  return value;
}

export function isAbsoluteHostPath(value: string): boolean {
  return isAbsolute(value);
}

function requiredAbsolutePath(value: unknown, name: string): string {
  const text = requiredString(value, name);
  if (!isAbsoluteHostPath(text))
    throw new Error(`${name} must be an absolute path.`);
  return text;
}

function toThreadSummary(thread: Record<string, unknown>): ThreadSummary {
  const source = asRecord(thread.source);
  const subAgent = asRecord(source?.subAgent ?? source?.sub_agent);
  const threadSpawn = asRecord(subAgent?.thread_spawn ?? subAgent?.threadSpawn);
  return {
    ...(isMobileThreadSource(thread.threadSource) || thread.mobileManaged === true ? { mobileManaged: true } : {}),
    ...(thread.threadSource === MOBILE_PROJECTLESS_SOURCE ? { projectless: true } : {}),
    ...(typeof thread.model === "string" ? { model: thread.model } : {}),
    ...(typeof thread.reasoningEffort === "string" ? { effort: thread.reasoningEffort } : {}),
    id: String(thread.id ?? ""),
    name:
      typeof thread.name === "string"
        ? thread.name
        : typeof thread.title === "string"
          ? thread.title
          : null,
    preview:
      typeof thread.preview === "string"
        ? thread.preview
        : typeof thread.title === "string"
          ? thread.title
          : "",
    cwd: typeof thread.cwd === "string" ? thread.cwd : "",
    modelProvider:
      typeof thread.modelProvider === "string" ? thread.modelProvider : "",
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : 0,
    status: thread.status ?? thread.threadRuntimeStatus ?? null,
    parentThreadId:
      typeof thread.parentThreadId === "string"
        ? thread.parentThreadId
        : typeof threadSpawn?.parent_thread_id === "string"
          ? threadSpawn.parent_thread_id
          : typeof threadSpawn?.parentThreadId === "string"
            ? threadSpawn.parentThreadId
            : null,
    agentNickname:
      typeof thread.agentNickname === "string"
        ? thread.agentNickname
        : typeof threadSpawn?.agent_nickname === "string"
          ? threadSpawn.agent_nickname
          : typeof threadSpawn?.agentNickname === "string"
            ? threadSpawn.agentNickname
            : null,
    agentRole:
      typeof thread.agentRole === "string"
        ? thread.agentRole
        : typeof threadSpawn?.agent_role === "string"
          ? threadSpawn.agent_role
          : typeof threadSpawn?.agentRole === "string"
            ? threadSpawn.agentRole
            : null,
    source: thread.source ?? null,
  };
}

function toModelOption(model: Record<string, unknown>): ModelOption {
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((value) => {
        const entry = asRecord(value);
        const reasoningEffort =
          typeof entry?.reasoningEffort === "string"
            ? entry.reasoningEffort
            : typeof entry?.effort === "string"
              ? entry.effort
              : null;
        return reasoningEffort
          ? [
              {
                reasoningEffort,
                ...(typeof entry?.description === "string"
                  ? { description: entry.description }
                  : {}),
              },
            ]
          : [];
      })
    : [];
  return {
    id: String(model.id ?? model.model ?? ""),
    model: String(model.model ?? model.id ?? ""),
    displayName:
      typeof model.displayName === "string"
        ? model.displayName
        : String(model.model ?? model.id ?? ""),
    description: typeof model.description === "string" ? model.description : "",
    hidden: model.hidden === true,
    isDefault: model.isDefault === true,
    defaultReasoningEffort:
      typeof model.defaultReasoningEffort === "string"
        ? model.defaultReasoningEffort
        : null,
    supportedReasoningEfforts: efforts,
  };
}

function flattenSkills(result: SkillsListResult): SkillOption[] {
  return (result.data ?? []).flatMap((entry) => {
    const cwd = typeof entry.cwd === "string" ? entry.cwd : "";
    return (entry.skills ?? []).map((skill) => ({
      cwd,
      name: String(skill.name ?? ""),
      description:
        typeof skill.description === "string" ? skill.description : "",
      ...(typeof skill.shortDescription === "string"
        ? { shortDescription: skill.shortDescription }
        : {}),
      path: typeof skill.path === "string" ? skill.path : "",
      scope: skill.scope ?? null,
      enabled: skill.enabled !== false,
    }));
  });
}

function isApprovalMethod(method: string): boolean {
  return [
    "item/tool/requestUserInput",
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
    "mcpServer/elicitation/request",
  ].includes(method);
}

function normalizeApprovalDecision(value: unknown): ApprovalDecision | null {
  if (
    ["accept", "acceptForSession", "decline", "cancel"].includes(String(value))
  ) {
    return value as ApprovalDecision;
  }
  const decision = asRecord(value);
  const execpolicy = asRecord(decision?.acceptWithExecpolicyAmendment);
  if (execpolicy && "execpolicy_amendment" in execpolicy) {
    return {
      kind: "acceptWithExecpolicyAmendment",
      execpolicyAmendment: execpolicy.execpolicy_amendment,
    };
  }
  const network = asRecord(decision?.applyNetworkPolicyAmendment);
  if (network && "network_policy_amendment" in network) {
    return {
      kind: "applyNetworkPolicyAmendment",
      networkPolicyAmendment: network.network_policy_amendment,
    };
  }
  return null;
}

function normalizeApproval(
  message: RpcEnvelope,
  diff?: string,
): ApprovalRequest {
  const params = message.params ?? {};
  const command =
    typeof params.command === "string"
      ? params.command
      : Array.isArray(params.command)
        ? params.command.map(String).join(" ")
        : undefined;
  const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  const isFileChange =
    message.method.includes("fileChange") ||
    message.method === "applyPatchApproval";
  const isPermissions = message.method === "item/permissions/requestApproval";
  const isMcpElicitation = message.method === "mcpServer/elicitation/request";
  const meta = asRecord(params._meta);
  const connectorName = typeof meta?.connector_name === "string"
    ? meta.connector_name
    : typeof params.serverName === "string"
      ? params.serverName
      : "MCP 工具";
  const persistentChoices = Array.isArray(meta?.persist)
    ? meta.persist.map(String)
    : [];
  const rawDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.flatMap((value) => {
        const normalized = normalizeApprovalDecision(value);
        return normalized ? [normalized] : [];
      })
    : undefined;

  return {
    requestId: message.id,
    method: message.method,
    threadId:
      typeof params.threadId === "string"
        ? params.threadId
        : typeof params.conversationId === "string"
          ? params.conversationId
          : undefined,
    turnId: typeof params.turnId === "string" ? params.turnId : undefined,
    itemId:
      typeof params.itemId === "string"
        ? params.itemId
        : typeof params.callId === "string"
          ? params.callId
          : undefined,
    title: message.method === "item/tool/requestUserInput" ? "Codex 等你回答" : isMcpElicitation
      ? `允许 ${connectorName} 操作？`
      : isPermissions
      ? "允许额外权限？"
      : isFileChange
        ? "允许修改文件？"
        : "允许执行命令？",
    detail:
      (isMcpElicitation && typeof params.message === "string" ? params.message : undefined) ??
      diff ??
      command ??
      reason ??
      (isPermissions
        ? JSON.stringify(params.permissions ?? {}, null, 2)
        : undefined),
    command,
    cwd,
    reason,
    availableDecisions: message.method === "item/tool/requestUserInput" ? [] : isMcpElicitation
      ? ["decline", "accept", ...(persistentChoices.includes("session") ? ["acceptForSession" as const] : [])]
      : rawDecisions?.length
      ? rawDecisions
      : ["accept", "acceptForSession", "decline"],
    raw: params,
  };
}

function permissionSettings(
  mode:
    "auto" | "granular" | "read-only" | "guardian-approvals" | "full-access",
  cwd?: string,
): Record<string, unknown> {
  if (mode === "full-access")
    return {
      activePermissionProfile: { id: ":danger-full-access", extends: null },
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  if (mode === "read-only")
    return {
      activePermissionProfile: { id: ":read-only", extends: null },
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
  if (!cwd || !isAbsoluteHostPath(cwd))
    throw new Error(
      "A verified task working directory is required for workspace permissions.",
    );
  return {
    activePermissionProfile: { id: ":workspace", extends: null },
    approvalPolicy:
      mode === "granular"
        ? {
            granular: {
              sandbox_approval: false,
              rules: false,
              skill_approval: false,
              request_permissions: true,
              mcp_elicitations: false,
            },
          }
        : "on-request",
    approvalsReviewer:
      mode === "guardian-approvals" ? "guardian_subagent" : "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
      networkAccess: false,
    },
  };
}

export function accountUsage(raw: unknown): AccountUsage {
  const reply = asRecord(raw);
  const primary = asRecord(reply?.rateLimits);
  const buckets = new Map(Object.entries(asRecord(reply?.rateLimitsByLimitId) ?? {}));
  if (primary) buckets.set(typeof primary.limitId === "string" ? primary.limitId : "codex", primary);
  const windows: AccountUsage["windows"] = [];
  for (const [id, entry] of buckets) {
    const bucket = asRecord(entry);
    for (const key of ["primary", "secondary"]) {
      const window = asRecord(bucket?.[key]);
      if (typeof window?.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
      windows.push({
        group: typeof bucket?.limitName === "string" ? bucket.limitName : id,
        minutes: typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
        remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
        resetsAt: typeof window.resetsAt === "number" && window.resetsAt > 0 ? window.resetsAt * 1000 : null,
      });
    }
  }
  return { plan: typeof primary?.planType === "string" ? primary.planType : null, checkedAt: Date.now(), windows };
}

function approvalResult(
  method: string,
  decision: ApprovalDecision,
  params?: Record<string, unknown>,
): unknown {
  if (method === "item/tool/requestUserInput") {
    if (!decision || typeof decision !== "object" || decision.kind !== "answerQuestions" || !Array.isArray(params?.questions) || !params.questions.length) throw new Error("请回答当前问题。");
    const answers = Object.fromEntries(params.questions.map(question => {
      const id = asRecord(question)?.id;
      const value = typeof id === "string" ? decision.answers?.[id] : undefined;
      if (typeof value !== "string" || !value.trim()) throw new Error("请补全所有问题的答案。");
      return [id, { answers: [value.trim()] }];
    }));
    return { answers };
  }
  if (typeof decision === "object" && decision.kind === "answerQuestions") throw new Error("该请求需要审批决定。");
  if (method === "mcpServer/elicitation/request") {
    if (decision === "accept" || decision === "acceptForSession") {
      const persistForSession = decision === "acceptForSession";
      return {
        action: "accept",
        content: {},
        _meta: persistForSession ? { persist: "session" } : null,
      };
    }
    return {
      action: decision === "decline" ? "decline" : "cancel",
      content: null,
      _meta: null,
    };
  }
  if (method === "item/permissions/requestApproval") {
    const requested = asRecord(params?.permissions) ?? {};
    const accepted = decision === "accept" || decision === "acceptForSession";
    const permissions = accepted
      ? Object.fromEntries(
          Object.entries(requested).filter(([, value]) => value != null),
        )
      : {};
    return {
      permissions,
      scope: decision === "acceptForSession" ? "session" : "turn",
    };
  }
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    if (typeof decision === "object") {
      return {
        decision:
          decision.kind === "acceptWithExecpolicyAmendment"
            ? {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: decision.execpolicyAmendment,
                },
              }
            : {
                applyNetworkPolicyAmendment: {
                  network_policy_amendment: decision.networkPolicyAmendment,
                },
              },
      };
    }
    return { decision };
  }
  const legacyDecision: string =
    decision === "accept"
      ? "approved"
      : decision === "acceptForSession"
        ? "approved_for_session"
        : decision === "decline"
          ? "denied"
          : "abort";
  return { decision: legacyDecision };
}
