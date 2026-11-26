export const WIRE_PROTOCOL = "codex-mobile-v1" as const;

export type ApprovalDecision =
  | { kind: "answerQuestions"; answers: Record<string, string> }
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { kind: "acceptWithExecpolicyAmendment"; execpolicyAmendment: unknown }
  | { kind: "applyNetworkPolicyAmendment"; networkPolicyAmendment: unknown };

export interface AccountUsage {
  plan: string | null;
  checkedAt: number;
  windows: { group: string; minutes: number | null; remainingPercent: number; resetsAt: number | null }[];
}

export interface ThreadSummary {
  projectless?: boolean;
  mobileManaged?: boolean;
  model?: string | null;
  effort?: string | null;
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  modelProvider: string;
  updatedAt: number;
  status: unknown;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  source: unknown;
}

export interface ModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
}


export type PermissionMode = "auto" | "granular" | "read-only" | "guardian-approvals" | "full-access";
export type PromptDeliveryMode = "auto" | "steer" | "queue";
export type PromptQueueStatus = "queued" | "sending" | "paused" | "failed" | "uncertain";

export interface PromptQueueItem {
  id: string;
  threadId: string;
  clientUserMessageId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  status: PromptQueueStatus;
  fileNames: string[];
  error?: string;
}


export interface GitDiffSnapshot {
  threadId: string;
  cwd: string;
  repositoryRoot: string;
  diff: string;
  files: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  generatedAt: number;
  error?: string;
}

export interface SkillOption {
  cwd: string;
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: unknown;
  enabled: boolean;
}

export interface ThreadHistoryPageInfo {
  nextCursor: string | null;
  backwardsCursor: string | null;
  hasMore: boolean;
  legacyFullHistory?: boolean;
}

export interface SyncMetadata {
  syncVersion?: string;
  syncCursor?: number;
}

export interface ApprovalRequest {
  requestId: number | string;
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  availableDecisions: ApprovalDecision[];
  raw: unknown;
}

export type ArchiveRequest =
  | { type: "archive.list"; cursor?: string }
  | { type: "archive.set"; threadId: string; archived: boolean };

export type ArchiveResult = { type: "archive.result"; requestId: string; threads?: ThreadSummary[]; nextCursor?: string | null; threadId?: string; archived?: boolean };

export type ClientMessage =
  | (ArchiveRequest & { requestId: string })
  | { type: "usage.read"; requestId: string }
  | { type: "ping"; id?: string }
  | { type: "threads.list"; requestId?: string; limit?: number }
  | { type: "threads.sync"; requestId?: string; knownVersion?: number }
  | { type: "sync.resume"; requestId?: string; syncVersion?: string; cursor?: number; threadIds?: string[] }
  | { type: "models.list"; requestId?: string }
  | { type: "projects.list"; requestId?: string }
  | { type: "skills.list"; requestId?: string; cwd?: string }
  | { type: "thread.open"; requestId?: string; threadId: string; historyLimit?: number; knownTurnIds?: string[] }
  | { type: "thread.close"; requestId?: string; threadId: string }
  | { type: "thread.history"; requestId?: string; threadId: string; cursor?: string | null; limit?: number; knownTurnIds?: string[] }
  | { type: "thread.start"; requestId?: string; cwd?: string; destination?: "projectless" | "newProject"; projectName?: string; model?: string; modelProvider?: string; prompt?: string; mobileManaged?: boolean }
  | { type: "thread.compact"; requestId?: string; threadId: string }
  | { type: "thread.settings"; requestId?: string; threadId: string; model?: string; effort?: string; summary?: "auto" | "concise" | "detailed" | "none"; permissionMode?: PermissionMode; collaborationMode?: unknown }
  | { type: "prompt.queue.list"; requestId?: string; threadId?: string }
  | { type: "prompt.queue.cancel"; requestId?: string; itemId: string }
  | { type: "prompt.queue.promote"; requestId?: string; itemId: string }
  | { type: "prompt.queue.resume"; requestId?: string; threadId: string }
  | { type: "thread.diff.get"; requestId?: string; threadId: string }
  | {
      type: "turn.start";
      requestId?: string;
      threadId: string;
      text: string;
      clientUserMessageId?: string;
      deliveryMode?: PromptDeliveryMode;
      expectedTurnId?: string;
      model?: string;
      effort?: string;
      summary?: "auto" | "concise" | "detailed" | "none";
      skill?: { name: string; path: string };
      permissionMode?: PermissionMode;
      collaborationMode?: unknown;
      attachments?: Array<{ type: "image" | "file"; uploadId: string; fileName: string; mimeType: string; localPath?: string }>;
    }
  | { type: "turn.interrupt"; requestId?: string; threadId: string; turnId: string }
  | { type: "approval.resolve"; requestId?: string; approvalRequestId: number | string; decision: ApprovalDecision };

export type ServerMessagePayload =
  | ArchiveResult
  | { type: "welcome"; version: string; serverId: string; codexReady: boolean; desktopOnly?: boolean; desktopIpcReady?: boolean; projectCreation?: boolean; mobileManagedThreads?: boolean; archiveManagement?: boolean; syncVersion?: string; latestCursor?: number; threadIndexVersion?: number }
  | { type: "pong"; id?: string }
  | { type: "sync.replay"; requestId?: string; syncVersion: string; fromCursor: number; toCursor: number; events: ServerMessage[] }
  | { type: "sync.reset"; requestId?: string; syncVersion: string; latestCursor: number; reason: string }
  | { type: "threads"; requestId?: string; threads: ThreadSummary[]; nextCursor?: string | null }
  | { type: "threads.snapshot"; requestId?: string; version: number; threads: ThreadSummary[] }
  | { type: "threads.delta"; requestId?: string; baseVersion: number; version: number; upserts: ThreadSummary[]; removedIds: string[] }
  | { type: "models"; requestId?: string; models: ModelOption[] }
  | { type: "projects"; requestId?: string; projects: { path: string; name: string }[] }
  | { type: "skills"; requestId?: string; skills: SkillOption[] }
  | { type: "thread"; requestId?: string; thread: unknown; history?: ThreadHistoryPageInfo }
  | { type: "thread.history"; requestId?: string; threadId: string; turns: unknown[]; history: ThreadHistoryPageInfo }
  | { type: "thread.compaction.accepted"; requestId?: string; threadId: string }
  | { type: "thread.settings.updated"; requestId?: string; threadId: string; settings?: { model: string | null; effort: string | null; mobileSendOnly?: boolean } }
  | { type: "usage.result"; requestId: string; usage: AccountUsage }
  | { type: "prompt.queue"; requestId?: string; items: PromptQueueItem[] }
  | { type: "prompt.queued"; requestId?: string; threadId: string; item: PromptQueueItem }
  | { type: "prompt.desktopQueued"; requestId?: string; threadId: string; queueId: string }
  | { type: "prompt.queue.updated"; threadId: string; items: PromptQueueItem[] }
  | { type: "prompt.queue.cancelled"; requestId?: string; threadId: string; itemId: string }
  | { type: "thread.diff"; requestId?: string; snapshot: GitDiffSnapshot }
  | { type: "turn.started"; requestId?: string; threadId: string; turn: unknown }
  | { type: "approval"; approval: ApprovalRequest }
  | { type: "approvals.snapshot"; approvals: ApprovalRequest[] }
  | { type: "approval.resolved"; requestId?: string; approvalRequestId: number | string }
  | { type: "event"; method: string; params: unknown }
  | { type: "status"; codexReady: boolean; detail?: string; desktopIpcReady?: boolean }
  | { type: "error"; requestId?: string; threadId?: string; code: string; message: string; detail?: unknown };

export type ServerMessage = ServerMessagePayload & SyncMetadata;
