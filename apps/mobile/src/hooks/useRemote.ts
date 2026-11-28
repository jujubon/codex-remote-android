import { App as CapacitorApp } from '@capacitor/app';
import { isAbsoluteHostPath } from '../lib/hostPath';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { RemoteSocket } from '../lib/RemoteSocket';
import { asyncQuestionDetail, describeAsyncAnswer, pendingAsyncQuestions } from '../lib/asyncQuestions';
import { deviceRequest, registerInboxUpload } from '../lib/deviceTools';
import { attentionForThread, queueNeedsAttention } from '../lib/attention';
import { cancelApprovalNotification, cancelQueueNotification, cancelThreadAttentionNotification, notifyApprovalRequested, notifyCompactionFailed, notifyQueueProblem, notifyThreadAttention, notifyTurnFinished } from '../lib/notifications';
import { downloadHostFile, fileServerUrl, saveHostFile, uploadRemoteFile } from '../lib/fileTransfer';
import { NotificationGenerationGuard, NotificationOperationQueue, settleGuardedNotification } from '../lib/notificationGuard';
import { cacheScope, clearRemoteCache, loadRemoteCache, messagesForThread, saveRemoteCache, type CachedHistoryState, type RemoteCacheSnapshot } from '../lib/remoteCache';
import type {
  AccountUsage,
  ArchiveResult,
  ArchiveRequest,
  ApprovalDecision,
  ApprovalRequest,
  CompactionStatus,
  ConnectionPhase,
  ModelOption,
  RemoteMessage,
  RemoteAttachment,
  RemoteThread,
  ServerMessage,
  PromptDeliveryMode,
  PromptQueueItem,
  GitDiffSnapshot,
  SkillOption,
  ThreadState,
  PermissionMode,
  ThreadSummary,
  Assistant,
  MessageAttachment,
  WireApprovalRequest,
} from '../types/protocol';
import { createRequestId } from '../types/protocol';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

export function shouldNotifyThreadCompletion(thread: Pick<RemoteThread, 'parentThreadId'> | undefined): boolean {
  return !thread?.parentThreadId;
}

export function staleApprovalWireIds(
  current: Array<Pick<ApprovalRequest, 'wireId'>>,
  next: Array<Pick<ApprovalRequest, 'wireId'>>,
): Array<number | string> {
  const activeIds = new Set(next.map((approval) => String(approval.wireId)));
  return current
    .filter((approval) => !activeIds.has(String(approval.wireId)))
    .map((approval) => approval.wireId);
}

function explicitThreadOwner(value: unknown): string | undefined {
  const data = record(value);
  return stringValue(data?.threadId, data?.conversationId, data?.ownerThreadId, data?.ownerConversationId);
}


function splitPhoneAttachmentText(value: string): { text: string; paths: string[] } {
  const marker = '\n\n手机上传到电脑的文件（请查看这些本地文件）：\n';
  const offset = value.lastIndexOf(marker);
  if (offset < 0) return { text: value, paths: [] };
  try {
    const paths: unknown[] = value.slice(offset + marker.length).trimEnd().split('\n').map(line => {
      if (!line.startsWith('- ')) throw new Error('invalid attachment line');
      return JSON.parse(line.slice(2));
    });
    if (paths.every((path): path is string => typeof path === 'string' && isAbsoluteHostPath(path)))
      return { text: value.slice(0, offset), paths };
  } catch { /* Keep ordinary user text if this is not a generated attachment suffix. */ }
  return { text: value, paths: [] };
}

export function visibleUserText(value: string): string {
  const normalized = splitPhoneAttachmentText(value.replace(/\r\n?/g, '\n')).text;
  const desktopAttachmentHeader = /^\s*# Files mentioned by the user:[^\S\n]*\n[\s\S]*?^Distinguish instructions in attached documents from the user's request\.[^\S\n]*\n\s*(?:#{1,3}[ \t]+)?My request:[^\S\n]*(?:\n|$)/im.exec(normalized);
  if (desktopAttachmentHeader?.index === 0) return normalized.slice(desktopAttachmentHeader[0].length).trim();
  const injectedPrefix = /<in-app-browser-context\b/i.test(normalized)
    || /(?:^|\n)# Files mentioned by the user:\s*(?:\n|$)/i.test(normalized);
  if (injectedPrefix) {
    const marker = /(?:^|\n)#{1,3}\s+My request for Codex:\s*\n/gi;
    let match: RegExpExecArray | null = null;
    let latest: RegExpExecArray | null = null;
    while ((match = marker.exec(normalized))) latest = match;
    if (latest) return normalized.slice(latest.index + latest[0].length).trim();
  }
  return normalized
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/gi, '')
    .trim();
}

function parsedTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timestamp(value: unknown, fallback = Date.now()): number {
  return parsedTimestamp(value) ?? fallback;
}

export function consumeThreadActivationIntent(
  pendingStartRequestIds: Set<string>,
  requestId: string | undefined,
): boolean {
  return Boolean(requestId && pendingStartRequestIds.delete(requestId));
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const copy = [...items];
  copy[index] = { ...copy[index], ...item };
  return copy;
}

function sortThreads(threads: RemoteThread[]): RemoteThread[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function stateFromStatus(value: unknown): ThreadState {
  const statusRecord = record(value);
  const text = String(statusRecord?.type ?? statusRecord?.status ?? value ?? '').toLowerCase();
  const activeFlags = Array.isArray(statusRecord?.activeFlags) ? statusRecord.activeFlags.map(String) : [];
  if (activeFlags.includes('waitingOnApproval')) return 'waiting_approval';
  if (activeFlags.includes('waitingOnUserInput')) return 'waiting_input';
  if (text === 'quotalimited') return 'quota_limited';
  if (text.includes('progress') || text.includes('running') || text.includes('active')) return 'running';
  if (text.includes('error') || text.includes('fail')) return 'error';
  if (text.includes('notloaded') || text.includes('not_loaded') || text.includes('unloaded')) return 'not_loaded';
  if (text.includes('idle') || text.includes('complete')) return 'idle';
  return 'unknown';
}

export function isActiveTurnStatus(value: unknown): boolean {
  const status = String(value ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return status === 'inprogress' || status === 'running' || status === 'active' || status === 'started';
}

function isTerminalTurnStatus(value: unknown): boolean {
  return /^(completed|complete|failed|interrupted|cancelled|canceled|aborted)$/i.test(String(value ?? '').trim());
}

function subagentMetadataFromSource(sourceValue: unknown): { parentThreadId?: string; agentNickname?: string; agentRole?: string } {
  const source = record(sourceValue);
  const original = record(source?.original);
  const candidates = [source, original].filter((value): value is UnknownRecord => Boolean(value));
  for (const candidate of candidates) {
    const subagent = record(candidate.subAgent) ?? record(candidate.sub_agent) ?? record(candidate.subagent);
    const spawn = record(subagent?.thread_spawn) ?? record(subagent?.threadSpawn) ?? subagent;
    const parentThreadId = stringValue(spawn?.parent_thread_id, spawn?.parentThreadId, subagent?.parent_thread_id, subagent?.parentThreadId);
    const agentNickname = stringValue(spawn?.agent_nickname, spawn?.agentNickname, subagent?.agent_nickname, subagent?.agentNickname);
    const agentRole = stringValue(spawn?.agent_role, spawn?.agentRole, subagent?.agent_role, subagent?.agentRole);
    if (parentThreadId || agentNickname || agentRole) return { parentThreadId, agentNickname, agentRole };
  }
  return {};
}

function normalizeSummary(thread: ThreadSummary): RemoteThread {
  const sourceMetadata = subagentMetadataFromSource(thread.source);
  return {
    id: thread.id,
    ...(thread.assistant === 'antigravity' ? { assistant: 'antigravity' } : {}),
    title: visibleUserText(thread.name || thread.preview || '未命名任务'),
    preview: visibleUserText(thread.preview),
    cwd: thread.cwd,
    ...(typeof thread.projectless === 'boolean' ? { projectless: thread.projectless } : {}),
    ...(thread.mobileManaged ? { mobileManaged: true } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.effort ? { effort: thread.effort } : {}),
    modelProvider: thread.modelProvider,
    updatedAt: timestamp(thread.updatedAt),
    state: stateFromStatus(thread.status),
    unread: 0,
    parentThreadId: thread.parentThreadId ?? sourceMetadata.parentThreadId ?? null,
    agentNickname: thread.agentNickname ?? sourceMetadata.agentNickname ?? null,
    agentRole: thread.agentRole ?? sourceMetadata.agentRole ?? null,
    source: thread.source,
  };
}

export function mergeThreadSummaries(current: RemoteThread[], incoming: ThreadSummary[], replace: boolean, activeTurns?: Readonly<Record<string, string>>): RemoteThread[] {
  const previousById = new Map(current.map((thread) => [thread.id, thread]));
  const merged = incoming.map((thread) => {
    const summary = normalizeSummary(thread);
    const previous = previousById.get(summary.id);
    const keepObservedState = previous && ((summary.state === 'not_loaded' && !['not_loaded', 'unknown'].includes(previous.state))
      || (activeTurns?.[summary.id] && ['running', 'waiting_input', 'waiting_approval'].includes(previous.state)
        && ['idle', 'unknown'].includes(summary.state)));
    previousById.delete(summary.id);
    return {
      ...previous,
      ...summary,
      ...(previous?.mobileSendOnly ? { model: previous.model, effort: previous.effort } : {}),
      state: keepObservedState ? previous.state : summary.state,
      parentThreadId: summary.parentThreadId ?? previous?.parentThreadId ?? null,
      agentNickname: summary.agentNickname ?? previous?.agentNickname ?? null,
      agentRole: summary.agentRole ?? previous?.agentRole ?? null,
      unread: previous?.unread ?? 0,
      currentTurnStartedAt: previous?.currentTurnStartedAt,
      lastTurnDurationMs: previous?.lastTurnDurationMs,
      tokenUsage: previous?.tokenUsage,
      model: summary.assistant === 'antigravity' ? summary.model : previous?.model ?? summary.model,
      effort: previous?.model ? previous.effort : summary.effort,
      permissionMode: previous?.permissionMode,
    };
  });
  return sortThreads(replace ? merged : [...previousById.values(), ...merged]);
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join('\n');
  const data = record(value);
  if (!data) return '';
  return (
    stringValue(data.text, data.diff, data.content, data.output, data.message, data.delta, data.reason, data.path) ??
    (Array.isArray(data.content) ? textFromContent(data.content) : '')
  );
}

function canonicalUserText(item: UnknownRecord, restoreMessage: UnknownRecord | null): string {
  const restored = stringValue(restoreMessage?.text);
  if (restored) return visibleUserText(restored);
  const direct = stringValue(item.text, item.message);
  if (direct) return visibleUserText(direct);
  const source = item.input ?? item.content;
  if (!Array.isArray(source)) return visibleUserText(textFromContent(source));
  const textParts = source.flatMap((value) => {
    if (typeof value === 'string') return [value];
    const part = record(value);
    if (!part) return [];
    const type = String(part.type ?? '').toLowerCase();
    if (type && !type.includes('text') && !type.includes('prompt')) return [];
    const text = stringValue(part.text, part.content, part.message);
    return text ? [text] : [];
  });
  return visibleUserText(textParts.join('\n'));
}

function attachmentName(path: string, fallback = '附件'): string {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1);
  return name || fallback;
}

function attachmentType(type: unknown, path: string, mimeType?: string): 'image' | 'file' {
  const hint = `${String(type ?? '')} ${mimeType ?? ''} ${path}`.toLowerCase();
  return /image|\.(png|jpe?g|gif|webp|avif|heic)$/.test(hint) ? 'image' : 'file';
}

export function optimisticAttachmentsFromUploads(attachments: Array<{
  type: 'image' | 'file';
  fileName: string;
  mimeType: string;
  localPath?: string;
}>): RemoteAttachment[] {
  return attachments.flatMap((attachment) => attachment.localPath ? [{
    type: attachment.type,
    name: attachment.fileName,
    path: attachment.localPath,
    mimeType: attachment.mimeType,
  }] : []);
}

export function attachmentsFromCanonicalUserItem(itemValue: unknown): RemoteAttachment[] {
  const item = record(itemValue);
  if (!item) return [];
  const byPath = new Map<string, RemoteAttachment>();
  const add = (pathValue: unknown, nameValue?: unknown, typeValue?: unknown, mimeValue?: unknown) => {
    if (typeof pathValue !== 'string' || !isAbsoluteHostPath(pathValue)) return;
    const mimeType = typeof mimeValue === 'string' ? mimeValue : undefined;
    byPath.set(pathValue, {
      type: attachmentType(typeValue, pathValue, mimeType),
      name: typeof nameValue === 'string' && nameValue.trim() ? nameValue : attachmentName(pathValue),
      path: pathValue,
      ...(mimeType ? { mimeType } : {}),
    });
  };
  for (const inputValue of Array.isArray(item.input) ? item.input : []) {
    const input = record(inputValue);
    add(input?.path, input?.name, input?.type, input?.mimeType);
  }
  for (const partValue of Array.isArray(item.content) ? item.content : []) {
    const part = record(partValue);
    if (part?.type === 'localImage') add(part.path, part.name, part.type, part.mimeType);
  }
  const uploadedText = stringValue(item.text, item.message)
    ?? textFromContent(item.input ?? item.content);
  for (const path of splitPhoneAttachmentText(uploadedText.replace(/\r\n?/g, '\n')).paths) {
    if (!byPath.has(path)) add(path);
  }
  for (const attachmentValue of Array.isArray(item.attachments) ? item.attachments : []) {
    const attachment = record(attachmentValue);
    add(attachment?.fsPath ?? attachment?.path, attachment?.label ?? attachment?.name, attachment?.type, attachment?.mimeType);
  }
  const restore = record(item.restoreMessage);
  const context = record(restore?.context);
  for (const key of ['imageAttachments', 'fileAttachments']) {
    for (const attachmentValue of Array.isArray(context?.[key]) ? context[key] as unknown[] : []) {
      const attachment = record(attachmentValue);
      add(attachment?.localPath ?? attachment?.fsPath ?? attachment?.path, attachment?.filename ?? attachment?.name, key, attachment?.mimeType);
    }
  }
  return [...byPath.values()];
}

function stableProjectedItemValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProjectedItemValue);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .filter((key) => key !== 'id' && key !== 'itemId')
      .sort()
      .map((key) => [key, stableProjectedItemValue(object[key])]),
  );
}

function projectedItemFingerprint(value: unknown): string {
  return JSON.stringify(stableProjectedItemValue(value));
}

function projectedUserCorrelation(value: unknown): string | undefined {
  const item = record(value);
  const type = String(item?.type ?? '').toLowerCase();
  if (!type.includes('user')) return undefined;
  return stringValue(item?.clientUserMessageId, item?.clientId, item?.serverUserMessageId);
}

export function canonicalProjectedItems(items: unknown[]): unknown[] {
  if (!items.some(value => {
    const item = record(value);
    return /^item-\d+$/.test(stringValue(item?.id, item?.itemId) ?? '');
  })) return items;
  const canonicalCounts = new Map<string, number>();
  const canonicalUserCorrelations = new Map<string, number>();
  for (const value of items) {
    const item = record(value);
    const id = stringValue(item?.id, item?.itemId);
    if (!id || /^item-\d+$/.test(id)) continue;
    const fingerprint = projectedItemFingerprint(value);
    canonicalCounts.set(fingerprint, (canonicalCounts.get(fingerprint) ?? 0) + 1);
    const correlation = projectedUserCorrelation(value);
    if (correlation) canonicalUserCorrelations.set(correlation, (canonicalUserCorrelations.get(correlation) ?? 0) + 1);
  }
  const remainingAliases = new Map(canonicalCounts);
  const remainingUserAliases = new Map(canonicalUserCorrelations);
  return items.filter((value) => {
    const item = record(value);
    const id = stringValue(item?.id, item?.itemId);
    if (!id || !/^item-\d+$/.test(id)) return true;
    const correlation = projectedUserCorrelation(value);
    const remainingCorrelation = correlation ? (remainingUserAliases.get(correlation) ?? 0) : 0;
    if (correlation && remainingCorrelation > 0) {
      remainingUserAliases.set(correlation, remainingCorrelation - 1);
      return false;
    }
    const fingerprint = projectedItemFingerprint(value);
    const remaining = remainingAliases.get(fingerprint) ?? 0;
    if (remaining <= 0) return true;
    remainingAliases.set(fingerprint, remaining - 1);
    return false;
  });
}

export function itemToMessage(itemValue: unknown, threadId: string, turnId: string, index: number, fallbackCreatedAt = Date.now(), turnInProgress = false): RemoteMessage | null {
  const item = record(itemValue);
  if (!item) return null;
  const type = String(item.type ?? 'item');
  const id = stringValue(item.id, item.itemId) ?? `${turnId}_${index}`;
  const normalizedType = type.toLowerCase();
  const restoreMessage = record(item.restoreMessage);
  const attachments = normalizedType.includes('user') ? attachmentsFromCanonicalUserItem(item) : [];
  let role: RemoteMessage['role'] = 'tool';
  let content = '';
  let toolName: string | undefined;
  let collapsible = false;

  if (normalizedType.includes('user')) {
    role = 'user';
    content = canonicalUserText(item, restoreMessage);
  } else if (normalizedType.includes('agentmessage') || normalizedType.includes('assistant')) {
    role = 'assistant';
    content = textFromContent(item.text ?? item.content ?? item.message);
    if (!content && Array.isArray(item.questions) && item.questions.length) content = 'Codex 等你回答';
  } else if (isContextCompactionItem(item)) {
    role = 'system';
    content = item.completed === true ? '上下文压缩完成' : item.completed === false ? '已开始压缩上下文' : '上下文压缩';
  } else if (normalizedType.includes('reasoning')) {
    role = 'system';
    toolName = '思考梗概';
    content = textFromContent(item.summary ?? item.text ?? item.content);
    collapsible = true;
  } else if (normalizedType.includes('command')) {
    toolName = '命令';
    const command = textFromContent(item.command);
    const output = textFromContent(item.aggregatedOutput ?? item.output);
    content = [command ? `$ ${command}` : '', output].filter(Boolean).join('\n');
    collapsible = true;
  } else if (normalizedType.includes('file')) {
    toolName = '文件修改';
    const changes = Array.isArray(item.changes) ? item.changes.flatMap((value) => {
      const change = record(value);
      if (!change) return [];
      const path = stringValue(change.path) ?? '未命名文件';
      const kind = stringValue(change.kind) ?? 'update';
      const diff = stringValue(change.diff);
      return [diff || `${kind} · ${path}`];
    }) : [];
    content = changes.join('\n') || textFromContent(item.patch ?? item.content) || '文件已修改';
    collapsible = true;
  } else if (normalizedType.includes('mcptoolcall')) {
    toolName = `${stringValue(item.server) ?? 'MCP'} · ${stringValue(item.tool) ?? '工具'}`;
    content = textFromContent(item.result ?? item.error ?? item.arguments) || '工具调用';
    collapsible = true;
  } else if (normalizedType.includes('dynamictoolcall')) {
    toolName = [stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join(' · ') || '工具调用';
    content = textFromContent(item.contentItems ?? item.arguments) || '工具调用';
    collapsible = true;
  } else if (normalizedType.includes('collabagenttoolcall')) {
    toolName = `Subagent · ${stringValue(item.tool) ?? '协作'}`;
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String).join(', ') : '';
    const states = record(item.agentsStates);
    const stateLines = states ? Object.entries(states).map(([agentId, value]) => {
      const agent = record(value);
      return `${agentId}: ${String(agent?.status ?? 'unknown')}${typeof agent?.message === 'string' ? ` — ${agent.message}` : ''}`;
    }).join('\n') : '';
    content = [textFromContent(item.prompt), receivers ? `Agent: ${receivers}` : '', stateLines].filter(Boolean).join('\n') || 'Subagent 协作事件';
    collapsible = true;
  } else if (normalizedType.includes('subagentactivity')) {
    toolName = 'Subagent 活动';
    content = [textFromContent(item.kind), stringValue(item.agentThreadId), stringValue(item.agentPath)].filter(Boolean).join('\n');
    collapsible = true;
  } else if (normalizedType.includes('plan') || normalizedType.includes('todo')) {
    role = 'system';
    toolName = '计划';
    const plan = Array.isArray(item.plan) ? item.plan.map((entry) => {
      const row = record(entry);
      const status = String(row?.status ?? 'pending').toLowerCase();
      const marker = status.includes('complete') ? 'x' : ' ';
      return `- [${marker}] ${String(row?.step ?? row?.text ?? '')}`;
    }).filter((line) => line.trim() !== '- [ ]') : [];
    content = [textFromContent(item.explanation), ...plan, textFromContent(item.text ?? item.content)].filter(Boolean).join('\n');
    collapsible = true;
  } else {
    toolName = type;
    content = textFromContent(item.content ?? item.text ?? item.output ?? item.message ?? item);
    collapsible = role === 'tool';
  }

  const assistantPhase = role === 'assistant' && (item.phase === 'commentary' || item.phase === 'final_answer') ? item.phase : undefined;
  if (!content && attachments.length === 0 && !(assistantPhase && turnInProgress)) return null;
  if (!content && attachments.length > 0) content = attachments.every((attachment) => attachment.type === 'image')
    ? `发送了 ${attachments.length} 张图片`
    : `发送了 ${attachments.length} 个附件`;
  const statusText = String(item.status ?? '').toLowerCase();
  const asyncAnswer = role === 'user' ? describeAsyncAnswer(content) : undefined;
  const itemCreatedAt = parsedTimestamp(item.createdAt ?? item.created_at ?? restoreMessage?.createdAt);
  return {
    id,
    threadId,
    turnId,
    role,
    content: asyncAnswer?.text ?? content,
    ...(role === 'user' && id.startsWith('local_start_') && item.deliveryAcknowledged === true ? { deliveryAcknowledged: true } : {}),
    ...(asyncAnswer ? { asyncAnswerIds: asyncAnswer.ids } : {}),
    ...(assistantPhase ? { assistantPhase } : {}),
    ...(attachments.length ? { attachments } : {}),
    createdAt: itemCreatedAt ?? fallbackCreatedAt,
    timestampSource: itemCreatedAt != null ? 'item' : 'turn',
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
    status: statusText.includes('progress') || (turnInProgress && normalizedType.includes('reasoning')) ? 'streaming' : statusText.includes('fail') ? 'failed' : 'complete',
    toolName,
    itemType: type,
    detail: item,
    collapsible,
  };
}


function isSyntheticProjectedMessage(message: RemoteMessage): boolean {
  return /^item-\d+$/.test(message.id);
}

function messageProjectionFingerprint(message: RemoteMessage): string {
  const itemType = message.role === 'user' || message.role === 'assistant'
    ? message.role
    : (message.itemType ?? message.toolName ?? message.role).toLowerCase();
  return JSON.stringify([
    message.turnId ?? '',
    message.role,
    itemType,
    message.content,
    message.attachments ?? [],
    message.status,
    message.toolName ?? '',
    message.durationMs ?? null,
    message.completedAt ?? null,
    stableProjectedItemValue(message.detail),
  ]);
}

function withoutProjectedMessageAliases(
  messages: RemoteMessage[],
  authoritative: RemoteMessage[],
): RemoteMessage[] {
  if (!messages.some(message => message.role === 'assistant' && isSyntheticProjectedMessage(message))) return messages;
  const canonicalCounts = new Map<string, number>();
  for (const message of authoritative) {
    if (message.role !== 'assistant' || isSyntheticProjectedMessage(message)) continue;
    const fingerprint = messageProjectionFingerprint(message);
    canonicalCounts.set(fingerprint, (canonicalCounts.get(fingerprint) ?? 0) + 1);
  }
  return messages.filter((message) => {
    // Cross-source fallback aliasing is intentionally limited to assistant output.
    // User items have explicit correlation IDs; tool/system items can legitimately render
    // identical text while carrying different opaque semantics.
    if (!isSyntheticProjectedMessage(message) || message.role !== 'assistant') return true;
    const fingerprint = messageProjectionFingerprint(message);
    const remaining = canonicalCounts.get(fingerprint) ?? 0;
    if (remaining <= 0) return true;
    canonicalCounts.set(fingerprint, remaining - 1);
    return false;
  });
}

function preserveQuestionDetail(current: RemoteMessage | undefined, incoming: RemoteMessage): RemoteMessage {
  const question = incoming.role === 'assistant' && !asyncQuestionDetail(incoming) ? asyncQuestionDetail(current) : undefined;
  return question ? { ...incoming, detail: { ...record(incoming.detail), ...question } } : incoming;
}

function preserveFresherLiveMessage(current: RemoteMessage | undefined, incoming: RemoteMessage): RemoteMessage {
  if (!current) return incoming;
  incoming = preserveQuestionDetail(current, incoming);
  if (current.assistantPhase && !incoming.assistantPhase) incoming = { ...incoming, assistantPhase: current.assistantPhase };
  if (current.turnDurationMs != null && incoming.turnDurationMs == null) incoming = { ...incoming, turnDurationMs: current.turnDurationMs };
  const preserveObservedTimestamp = current.timestampSource != null && current.timestampSource !== 'turn' && incoming.timestampSource === 'turn';
  const incomingType = incoming.itemType?.toLowerCase() ?? '';
  // Reasoning summaries are replaceable activity labels, not append-only answer text.
  // A newer Desktop snapshot may legitimately replace a long old summary with a short
  // current one, so content length must never decide which reasoning text wins.
  const currentHasLongerContent = !incomingType.includes('reasoning') && !incoming.asyncAnswerIds
    && current.content.length > incoming.content.length;
  const preventsTerminalDowngrade = current.status !== 'streaming' && incoming.status === 'streaming';
  if (!currentHasLongerContent && !preventsTerminalDowngrade && !preserveObservedTimestamp) return incoming;
  return {
    ...incoming,
    ...(preserveObservedTimestamp ? { createdAt: current.createdAt, timestampSource: current.timestampSource } : {}),
    ...((currentHasLongerContent || preventsTerminalDowngrade)
      ? { content: current.content, detail: asyncQuestionDetail(incoming) ? incoming.detail : current.detail ?? incoming.detail }
      : {}),
    ...(preventsTerminalDowngrade ? { status: current.status } : {}),
    completedAt: current.completedAt ?? incoming.completedAt,
    durationMs: current.durationMs ?? incoming.durationMs,
    attachments: (current.attachments?.length ?? 0) > (incoming.attachments?.length ?? 0)
      ? current.attachments
      : incoming.attachments,
  };
}

function messageCorrelationIds(message: RemoteMessage): string[] {
  if (message.role !== 'user') return [];
  const detail = record(message.detail);
  return [detail?.clientUserMessageId, detail?.clientId, detail?.serverUserMessageId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function dedupeMessages(messages: RemoteMessage[]): RemoteMessage[] {
  const byId = new Map<string, RemoteMessage>();
  for (const message of messages) {
    const previous = byId.get(message.id);
    byId.set(message.id, previous ? { ...previous, ...preserveQuestionDetail(previous, message) } : message);
  }
  const output: RemoteMessage[] = [];
  const correlationIndex = new Map<string, number>();
  for (const message of byId.values()) {
    const keys = messageCorrelationIds(message);
    const existingIndex = keys.map((key) => correlationIndex.get(key)).find((value): value is number => value != null);
    if (existingIndex == null) {
      const index = output.push(message) - 1;
      keys.forEach((key) => correlationIndex.set(key, index));
      continue;
    }
    const existing = output[existingIndex]!;
    if (existing.id.startsWith('local_') && !message.id.startsWith('local_')) output[existingIndex] = message;
    messageCorrelationIds(output[existingIndex]!).forEach((key) => correlationIndex.set(key, existingIndex));
  }
  return output;
}

const EMPTY_SELECTED_MESSAGES: RemoteMessage[] = [];

function sameJsonLikeValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJsonLikeValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
    && sameJsonLikeValue(leftRecord[key], rightRecord[key]));
}

function sameRemoteMessage(left: RemoteMessage, right: RemoteMessage): boolean {
  return left.id === right.id
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.role === right.role
    && left.content === right.content
    && left.createdAt === right.createdAt
    && left.completedAt === right.completedAt
    && left.durationMs === right.durationMs
    && left.turnDurationMs === right.turnDurationMs
    && left.assistantPhase === right.assistantPhase
    && left.deliveryAcknowledged === right.deliveryAcknowledged
    && left.deliveryState === right.deliveryState
    && left.status === right.status
    && left.toolName === right.toolName
    && left.itemType === right.itemType
    && left.collapsible === right.collapsible
    && sameJsonLikeValue(left.attachments, right.attachments)
    && sameJsonLikeValue(left.detail, right.detail);
}

export type SelectedMessagesSelector = (
  selectedThreadId: string | null,
  messagesByThread: Record<string, RemoteMessage[]>,
  todoByThread: Record<string, RemoteMessage>,
) => RemoteMessage[];

export function createSelectedMessagesSelector(): SelectedMessagesSelector {
  let previousThreadId: string | null | undefined;
  let previousSource: RemoteMessage[] | undefined;
  let previousTodo: RemoteMessage | undefined;
  let previousResult = EMPTY_SELECTED_MESSAGES;

  return (selectedThreadId, messagesByThread, todoByThread) => {
    const source = selectedThreadId ? messagesByThread[selectedThreadId] : undefined;
    const todo = selectedThreadId ? todoByThread[selectedThreadId] : undefined;
    if (selectedThreadId === previousThreadId && source === previousSource && todo === previousTodo) {
      return previousResult;
    }

    const oldThreadId = previousThreadId;
    const oldResult = previousResult;
    previousThreadId = selectedThreadId;
    previousSource = source;
    previousTodo = todo;

    if (!selectedThreadId) {
      previousResult = EMPTY_SELECTED_MESSAGES;
      return previousResult;
    }

    const sourceWithTodo = todo ? [...(source ?? EMPTY_SELECTED_MESSAGES), todo] : (source ?? EMPTY_SELECTED_MESSAGES);
    const projected = dedupeMessages(messagesForThread(selectedThreadId, sourceWithTodo));
    if (projected.length === 0) {
      previousResult = oldThreadId === selectedThreadId && oldResult.length === 0 ? oldResult : EMPTY_SELECTED_MESSAGES;
      return previousResult;
    }

    const previousById = oldThreadId === selectedThreadId
      ? new Map(oldResult.map((message) => [message.id, message]))
      : new Map<string, RemoteMessage>();
    const stabilized = projected.map((message) => {
      const previous = previousById.get(message.id);
      return previous && sameRemoteMessage(previous, message) ? previous : message;
    });
    const resultUnchanged = oldThreadId === selectedThreadId
      && stabilized.length === oldResult.length
      && stabilized.every((message, index) => message === oldResult[index]);
    previousResult = resultUnchanged ? oldResult : stabilized;
    return previousResult;
  };
}


export interface PendingMessageDelta {
  threadId: string;
  turnId?: string;
  itemId: string;
  delta: string;
  role: RemoteMessage['role'];
  toolName?: string;
  itemType?: string;
  createdAt: number;
}

function liveInsertIndex(items: RemoteMessage[], turnId?: string): number {
  if (!turnId || items.at(-1)?.turnId === turnId) return items.length;
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index]!.turnId === turnId) return index + 1;
  }
  return items.length;
}

export function upsertLiveItem(items: RemoteMessage[], message: RemoteMessage): RemoteMessage[] {
  const previous = items.find(item => item.id === message.id);
  if (previous) return upsertById(items, message.status === 'streaming'
    ? preserveFresherLiveMessage(previous, message) : preserveQuestionDetail(previous, message));
  const index = liveInsertIndex(items, message.turnId);
  return [...items.slice(0, index), message, ...items.slice(index)];
}

export function applyPendingMessageDeltas(
  current: Record<string, RemoteMessage[]>,
  pending: PendingMessageDelta[],
): Record<string, RemoteMessage[]> {
  if (pending.length === 0) return current;
  const byThread = new Map<string, PendingMessageDelta[]>();
  for (const delta of pending) {
    const bucket = byThread.get(delta.threadId);
    if (bucket) bucket.push(delta);
    else byThread.set(delta.threadId, [delta]);
  }
  const next = { ...current };
  for (const [threadId, deltas] of byThread) {
    const items = [...messagesForThread(threadId, current[threadId] ?? [])];
    const indexById = new Map(items.map((item, index) => [item.id, index]));
    for (const delta of deltas) {
      const index = indexById.get(delta.itemId);
      if (index != null) {
        const previous = items[index]!;
        if (previous.status !== 'streaming') continue;
        items[index] = {
          ...previous,
          turnId: previous.turnId ?? delta.turnId,
          content: previous.content + delta.delta,
          status: 'streaming',
          ...(delta.toolName ? { toolName: delta.toolName } : {}),
          ...(delta.itemType ? { itemType: delta.itemType } : {}),
        };
      } else {
        const insertAt = liveInsertIndex(items, delta.turnId);
        for (let i = insertAt; i < items.length; i++) indexById.set(items[i]!.id, i + 1);
        indexById.set(delta.itemId, insertAt);
        items.splice(insertAt, 0, {
          id: delta.itemId,
          threadId,
          turnId: delta.turnId,
          role: delta.role,
          content: delta.delta,
          createdAt: delta.createdAt,
          timestampSource: 'live',
          status: 'streaming',
          toolName: delta.toolName,
          itemType: delta.itemType,
        });
      }
    }
    next[threadId] = items;
  }
  return next;
}

function latestPlanMessage(messages: RemoteMessage[]): RemoteMessage | undefined {
  return [...messages].reverse().find((message) => {
    const itemType = message.itemType?.toLowerCase() ?? '';
    return itemType.includes('plan') || itemType.includes('todo') || message.toolName === '计划';
  });
}

function pendingUser(message: RemoteMessage): boolean {
  return message.role === 'user' && message.id.startsWith('local_');
}

export function canDiscardLocalMessage(message: RemoteMessage): boolean {
  return pendingUser(message) && !message.deliveryAcknowledged;
}

export function orderConversationTurns(messages: RemoteMessage[]): RemoteMessage[] {
  const groups = new Map<string, RemoteMessage[]>();
  const order: RemoteMessage[][] = [];
  for (const message of messages) {
    const key = message.turnId;
    const existing = key ? groups.get(key) : undefined;
    if (existing) {
      existing.push(message);
      continue;
    }
    const group = [message];
    order.push(group);
    if (key) groups.set(key, group);
  }
  return order.flatMap(group => {
    const firstPrompt = group.findIndex(message => message.role === 'user');
    const replies = new Set(group.filter((message, index) => message.role === 'assistant' &&
      (message.assistantPhase === 'final_answer' || (!message.assistantPhase && index < firstPrompt))));
    return replies.size ? [...group.filter(message => !replies.has(message)), ...replies] : group;
  });
}

// Replace each local echo in its existing slot. A replay of an already known
// user item is never evidence that a second, identical prompt was delivered.
function matchPendingUsers(current: RemoteMessage[], incoming: RemoteMessage[], allowTextMatch = true): RemoteMessage[] {
  if (!current.some(pendingUser)) return current;
  const existingIds = new Set(current.map(message => message.id));
  const result = [...current];
  for (const canonical of incoming) {
    if (canonical.role !== 'user' || pendingUser(canonical)) continue;
    const keys = messageCorrelationIds(canonical);
    const index = result.findIndex(local => {
      if (!pendingUser(local) || local.deliveryState === 'uploading') return false;
      const localKeys = messageCorrelationIds(local);
      if (keys.length && localKeys.length) return localKeys.some(key => keys.includes(key));
      const text = local.content.trim().replace(/\s+/g, ' ');
      if (!text || text !== canonical.content.trim().replace(/\s+/g, ' ')) return false;
      if (local.deliveryAcknowledged && local.turnId && local.turnId === canonical.turnId) return true;
      return allowTextMatch && !existingIds.has(canonical.id)
        && !(local.turnId && canonical.turnId && local.turnId !== canonical.turnId)
        && Math.abs(local.createdAt - canonical.createdAt) <= 300_000;
    });
    if (index >= 0) result[index] = canonical;
  }
  return result;
}

function insertHistoryBeforePending(current: RemoteMessage[], incoming: RemoteMessage[]): RemoteMessage[] {
  const index = current.findIndex(pendingUser);
  if (index < 0) return [...current, ...incoming];
  // Disjoint history has no common item to anchor it. Compare turn starts to
  // the local send only at this boundary, keeping wire order within each turn.
  const pendingAt = current[index]!.createdAt;
  const newer = incoming.findIndex(item => item.createdAt > pendingAt);
  const split = newer < 0 ? incoming.length : newer;
  return [...current.slice(0, index), ...incoming.slice(0, split), ...current.slice(index), ...incoming.slice(split)];
}

function knownTurnIds(messages: RemoteMessage[]): string[] {
  const prompts = new Set<string>();
  const replies = new Set<string>();
  for (const message of messages) {
    if (!message.turnId) continue;
    if (message.role === 'user' && !pendingUser(message)) prompts.add(message.turnId);
    if (message.role === 'assistant' && message.assistantPhase !== 'commentary'
      && message.status === 'complete' && message.content.trim()) replies.add(message.turnId);
  }
  return [...prompts].filter(id => replies.has(id)).slice(-500);
}

export function turnIdsAfterSnapshot(current: Record<string, string>, threadId: string, currentTurnId?: string): Record<string, string> {
  if (currentTurnId) return current[threadId] === currentTurnId ? current : { ...current, [threadId]: currentTurnId };
  if (!(threadId in current)) return current;
  const next = { ...current };
  delete next[threadId];
  return next;
}

export function reconcileMessages(
  current: RemoteMessage[],
  incoming: RemoteMessage[],
  placement: 'append' | 'prepend' = 'append',
  targetThreadId = incoming[0]?.threadId ?? current[0]?.threadId,
): RemoteMessage[] {
  const ownedCurrent = targetThreadId ? messagesForThread(targetThreadId, current) : [];
  const ownedIncoming = targetThreadId ? messagesForThread(targetThreadId, incoming) : [];
  if (ownedIncoming.length === 0) return ownedCurrent;
  const currentById = new Map(ownedCurrent.map(message => [message.id, message]));
  const authoritative = dedupeMessages(ownedIncoming.map(message => preserveQuestionDetail(currentById.get(message.id), message)));
  const incomingIds = new Set(authoritative.map((message) => message.id));
  const incomingCorrelations = new Set(authoritative.flatMap(messageCorrelationIds));
  const overlaps = (message: RemoteMessage) => incomingIds.has(message.id)
    || messageCorrelationIds(message).some((id) => incomingCorrelations.has(id));
  const aligned = matchPendingUsers(ownedCurrent, authoritative, placement !== 'prepend');
  const overlapIndexes = aligned.flatMap((message, index) => overlaps(message) ? [index] : []);
  const preserved = aligned.filter(message => !overlaps(message));

  // The wire arrays are the canonical order. Timestamps are turn-level fallbacks and
  // may be identical for every item, so sorting ties by item id can invert user/assistant
  // chronology. Older history pages prepend. A live snapshot replaces its overlapping
  // window in place, keeping previously loaded older history before it and local/newer
  // state after it.
  if (placement === 'prepend') return dedupeMessages([...authoritative, ...preserved]);
  if (overlapIndexes.length === 0) return dedupeMessages(insertHistoryBeforePending(preserved, authoritative));
  const firstOverlap = Math.min(...overlapIndexes);
  const beforeIds = new Set(aligned.slice(0, firstOverlap).map((message) => message.id));
  const before = preserved.filter((message) => beforeIds.has(message.id));
  const after = preserved.filter((message) => !beforeIds.has(message.id));
  return dedupeMessages([...before, ...authoritative, ...after]);
}



export function reconcileThreadSnapshot(
  current: RemoteMessage[],
  incoming: RemoteMessage[],
  targetThreadId = incoming[0]?.threadId ?? current[0]?.threadId,
  observedTurnId?: string,
  observedAt = Date.now(),
): RemoteMessage[] {
  const ownedCurrent = targetThreadId ? messagesForThread(targetThreadId, current) : [];
  const ownedIncoming = targetThreadId ? messagesForThread(targetThreadId, incoming) : [];
  if (ownedIncoming.length === 0) return ownedCurrent;
  const currentById = new Map(ownedCurrent.map((message) => [message.id, message]));
  const canObserveNewItems = ownedCurrent.length > 0 && Boolean(observedTurnId);
  // A live user item can arrive before the corresponding new-chat receipt.
  const authoritative = dedupeMessages(matchPendingUsers(ownedIncoming, ownedCurrent, false))
    .map((message) => {
      const currentMessage = currentById.get(message.id);
      const observedMessage = !currentMessage && canObserveNewItems && message.turnId === observedTurnId && message.timestampSource === 'turn'
        ? { ...message, createdAt: observedAt, timestampSource: 'observed' as const }
        : message;
      return preserveFresherLiveMessage(currentMessage, observedMessage);
    });
  const coveredTurnIds = [...new Set(authoritative.flatMap((message) => message.turnId ? [message.turnId] : []))];
  if (coveredTurnIds.length === 0) return reconcileMessages(ownedCurrent, authoritative, 'append', targetThreadId);

  const incomingIds = new Set(authoritative.map((message) => message.id));
  const incomingCorrelations = new Set(authoritative.flatMap(messageCorrelationIds));
  const overlaps = (message: RemoteMessage) => incomingIds.has(message.id)
    || messageCorrelationIds(message).some((id) => incomingCorrelations.has(id));
  const cleanedCurrent = withoutProjectedMessageAliases(
    matchPendingUsers(ownedCurrent, authoritative),
    authoritative,
  );
  const covered = new Set(coveredTurnIds);
  const authoritativeByTurn = new Map<string, RemoteMessage[]>();
  for (const message of authoritative) {
    if (!message.turnId) continue;
    const bucket = authoritativeByTurn.get(message.turnId) ?? [];
    bucket.push(message);
    authoritativeByTurn.set(message.turnId, bucket);
  }
  const liveByTurn = new Map<string, RemoteMessage[]>();
  for (const message of cleanedCurrent) {
    if (!message.turnId || !covered.has(message.turnId)) continue;
    const bucket = liveByTurn.get(message.turnId) ?? [];
    bucket.push(message);
    liveByTurn.set(message.turnId, bucket);
  }
  const mergedByTurn = new Map<string, RemoteMessage[]>();

  for (const turnId of coveredTurnIds) {
    const canonical = authoritativeByTurn.get(turnId) ?? [];
    const canonicalHasReasoning = canonical.some((message) => message.itemType?.toLowerCase().includes('reasoning'));
    const canonicalHasPlan = canonical.some((message) => {
      const type = message.itemType?.toLowerCase() ?? '';
      return type.includes('plan') || type.includes('todo');
    });
    const live = liveByTurn.get(turnId) ?? [];
    const unmatched = new Set(live.filter((message) => {
      if (overlaps(message)) return false;
      const type = message.itemType?.toLowerCase() ?? '';
      // Drop only projection/fallback reasoning aliases once a canonical snapshot has
      // them. A real opaque live item that is not in the snapshot yet must remain as the
      // event tail; otherwise a delayed Desktop snapshot can erase a newer live summary.
      if (canonicalHasReasoning && type.includes('reasoning')) {
        const syntheticDeltaId = Boolean(message.turnId && message.id.startsWith(`${message.turnId}_item/reasoning/`));
        if (isSyntheticProjectedMessage(message) || syntheticDeltaId) return false;
      }
      if (canonicalHasPlan && (type.includes('plan') || type.includes('todo'))) return false;
      return true;
    }));
    if (unmatched.size === 0) {
      mergedByTurn.set(turnId, canonical);
      continue;
    }
    // Keep event-only items between known neighbors. If there are no two
    // ordered anchors, the snapshot remains the prefix and the events stay in its tail.
    const positions = new Map(canonical.map((message, index) => [message.id, index]));
    const insertions = new Map<number, RemoteMessage[]>();
    let previousPosition: number | undefined;
    let pending: RemoteMessage[] = [];
    for (const message of live) {
      const position = positions.get(message.id);
      if (position === undefined) {
        if (unmatched.has(message)) pending.push(message);
        continue;
      }
      if (previousPosition !== undefined && position > previousPosition && pending.length) {
        const bucket = insertions.get(position) ?? [];
        bucket.push(...pending);
        insertions.set(position, bucket);
        pending.forEach(item => unmatched.delete(item));
        pending = [];
      }
      previousPosition = position;
      pending = [];
    }
    mergedByTurn.set(turnId, dedupeMessages([
      ...canonical.flatMap((message, index) => [...(insertions.get(index) ?? []), message]),
      ...unmatched,
    ]));
  }

  const result: RemoteMessage[] = [];
  const turnIndex = new Map(coveredTurnIds.map((id, index) => [id, index]));
  let cursor = 0;
  for (const message of cleanedCurrent) {
    const index = message.turnId ? turnIndex.get(message.turnId) : undefined;
    if (index === undefined) {
      if (!overlaps(message)) result.push(message);
      continue;
    }
    // Anchor missing earlier turns before the first known later turn.
    while (cursor <= index) result.push(...mergedByTurn.get(coveredTurnIds[cursor++]!)!);
  }
  const remaining = coveredTurnIds.slice(cursor).flatMap(id => mergedByTurn.get(id)!);
  return dedupeMessages(insertHistoryBeforePending(result, remaining));
}


function permissionModeFromThread(data: UnknownRecord): PermissionMode {
  const settings = record(data.latestThreadSettings) ?? record(data.currentPermissions) ?? {};
  const sandbox = record(settings.sandboxPolicy);
  const reviewer = String(settings.approvalsReviewer ?? 'user');
  if (sandbox?.type === 'dangerFullAccess' && settings.approvalPolicy === 'never') return 'full-access';
  if (sandbox?.type === 'readOnly') return 'read-only';
  if (reviewer === 'guardian_subagent' || reviewer === 'auto_review') return 'guardian-approvals';
  if (record(settings.approvalPolicy)?.granular) return 'granular';
  return 'auto';
}

function reportedTurnDuration(turn?: UnknownRecord | null): number | undefined {
  if (!turn) return undefined;
  const desktopStart = parsedTimestamp(turn.turnStartedAtMs ?? turn.startedAt);
  const finalStart = parsedTimestamp(turn.finalAssistantStartedAtMs);
  if (!isActiveTurnStatus(String(turn.status ?? '').toLowerCase()) && desktopStart != null && finalStart != null && finalStart >= desktopStart) return finalStart - desktopStart;
  if (typeof turn.durationMs === 'number' && Number.isFinite(turn.durationMs) && turn.durationMs >= 0) return turn.durationMs;
  const start = parsedTimestamp(turn.startedAt ?? turn.turnStartedAtMs ?? turn.startedAtMs);
  const end = parsedTimestamp(turn.completedAt ?? turn.turnCompletedAtMs ?? turn.completedAtMs);
  if (start != null && end != null && start > 0 && end >= start) return end - start;
  return undefined;
}

type NormalizedThreadPayload = {
  thread: RemoteThread | null;
  messages: RemoteMessage[];
  currentTurnId?: string;
  turnIds?: string[];
  completedTurnId?: string;
};

export function normalizeThreadPayload(payload: unknown): NormalizedThreadPayload {
  const outer = record(payload);
  const threadData = record(outer?.thread) ?? outer;
  if (!threadData) return { thread: null, messages: [] };
  const id = stringValue(threadData.id, threadData.threadId, threadData.conversationId);
  if (!id) return { thread: null, messages: [] };
  const turns = Array.isArray(threadData.turns) ? threadData.turns : [];
  const messages: RemoteMessage[] = [];
  const turnIds: string[] = [];
  let currentTurnId = stringValue(threadData.mobileActiveTurnId);
  let completedTurnId: string | undefined;
  const reportedState = stateFromStatus(threadData.threadRuntimeStatus ?? threadData.status);
  const lastOwnedTurn = [...turns].reverse().find(value => {
    const owner = explicitThreadOwner(value);
    return !owner || owner === id;
  });

  turns.forEach((turnValue, turnIndex) => {
    const turn = record(turnValue);
    if (!turn) return;
    const turnOwner = explicitThreadOwner(turn);
    if (turnOwner && turnOwner !== id) return;
    const turnId = stringValue(turn.id, turn.turnId) ?? `turn_${turnIndex}`;
    const turnStatus = String(turn.status ?? '').toLowerCase();
    turnIds.push(turnId);
    if (turnValue === lastOwnedTurn) {
      if (isActiveTurnStatus(turnStatus)) currentTurnId = turnId;
      if (isTerminalTurnStatus(turnStatus)) {
        completedTurnId = turnId;
        if (currentTurnId === turnId) currentTurnId = undefined;
      }
    }
    const ownedItems = (Array.isArray(turn.items) ? turn.items : []).filter((item) => {
      const itemOwner = explicitThreadOwner(item);
      return !itemOwner || itemOwner === id;
    });
    const turnDurationMs = reportedTurnDuration(turn);
    const items = canonicalProjectedItems(ownedItems);
    items.forEach((item, itemIndex) => {
      const message = itemToMessage(item, id, turnId, itemIndex, timestamp(turn.startedAt ?? turn.turnStartedAtMs ?? turn.startedAtMs, 0), isActiveTurnStatus(turnStatus));
      if (message) {
        if (turnDurationMs != null) message.turnDurationMs = turnDurationMs;
        messages.push(message);
      }
    });
  });

  return {
    thread: {
      id,
      ...(threadData.assistant === 'antigravity' ? { assistant: 'antigravity' } : {}),
      title: stringValue(threadData.name, threadData.title, threadData.preview) ?? '未命名任务',
      preview: stringValue(threadData.preview) ?? '',
      cwd: stringValue(threadData.cwd) ?? '',
      modelProvider: stringValue(threadData.modelProvider) ?? '',
      updatedAt: timestamp(threadData.updatedAt ?? threadData.updated_at),
      state: currentTurnId && reportedState !== 'waiting_input' && reportedState !== 'waiting_approval' && reportedState !== 'quota_limited'
        ? 'running' : reportedState,
      unread: 0,
      parentThreadId: stringValue(threadData.parentThreadId) ?? subagentMetadataFromSource(threadData.source).parentThreadId ?? null,
      agentNickname: stringValue(threadData.agentNickname) ?? subagentMetadataFromSource(threadData.source).agentNickname ?? null,
      agentRole: stringValue(threadData.agentRole) ?? subagentMetadataFromSource(threadData.source).agentRole ?? null,
      ...(threadData.mobileManaged === true || ['codex-remote-mobile', 'codex-remote-mobile-projectless'].includes(String(threadData.threadSource)) ? { mobileManaged: true } : {}),
      ...(typeof threadData.mobileRuntimeActive === 'boolean' ? { mobileRuntimeActive: threadData.mobileRuntimeActive } : {}),
      ...(typeof threadData.projectless === 'boolean' ? { projectless: threadData.projectless }
        : threadData.threadSource === 'codex-remote-mobile-projectless' ? { projectless: true } : {}),
      ...(record(threadData.latestThreadSettings)?.mobileSendOnly === true ? { mobileSendOnly: true } :
        typeof threadData.model === 'string' ? { mobileSendOnly: false } : {}),
      ...(() => {
        const settings = record(threadData.latestThreadSettings);
        const model = stringValue(settings?.model, threadData.model, threadData.latestModel, outer?.model);
        const effort = stringValue(settings?.effort, threadData.reasoningEffort, threadData.latestReasoningEffort, outer?.reasoningEffort);
        return model ? { model, effort: settings?.effort === null ? undefined : effort } : {};
      })(),
      permissionMode: permissionModeFromThread(threadData),
      source: {
        ...(record(threadData.source) ?? { original: threadData.source ?? null }),
        ...(threadData.threadGoal != null ? { threadGoal: threadData.threadGoal } : {}),
        ...(threadData.latestThreadSettings != null ? { latestThreadSettings: threadData.latestThreadSettings } : {}),
        ...(threadData.currentPermissions != null ? { currentPermissions: threadData.currentPermissions } : {}),
      },
      currentTurnStartedAt: currentTurnId
        ? (() => {
            const activeTurn = record(turns.find((value) => stringValue(record(value)?.id, record(value)?.turnId) === currentTurnId));
            return timestamp(activeTurn?.startedAt ?? activeTurn?.turnStartedAtMs ?? activeTurn?.startedAtMs);
          })()
        : undefined,
    },
    messages,
    currentTurnId,
    turnIds,
    completedTurnId,
  };
}

export function keepObservedTurn(snapshot: NormalizedThreadPayload, currentTurnId: string | undefined, finishedTurns: ReadonlySet<string>): boolean {
  const thread = snapshot.thread;
  if (!thread) return false;
  if (snapshot.currentTurnId && finishedTurns.has(`${thread.id}\u0000${snapshot.currentTurnId}`)) return true;
  if (!currentTurnId || snapshot.currentTurnId === currentTurnId) return false;
  return !snapshot.turnIds?.includes(currentTurnId) || (!snapshot.currentTurnId && !snapshot.completedTurnId);
}

function normalizeApproval(approval: WireApprovalRequest): ApprovalRequest {
  const questions = record(approval.raw)?.questions;
  return {
    questions: Array.isArray(questions) ? questions.flatMap(value => {
      const q = record(value);
      if (!q || typeof q.id !== 'string' || typeof q.question !== 'string') return [];
      const options = Array.isArray(q.options) ? q.options.flatMap(o => typeof record(o)?.label === 'string' ? [String(record(o)!.label)] : []) : [];
      return [{ id: q.id, question: q.question, secret: q.isSecret === true, options }];
    }) : undefined,
    id: String(approval.requestId),
    wireId: approval.requestId,
    threadId: approval.threadId,
    turnId: approval.turnId,
    title: approval.title,
    method: approval.method,
    description: approval.detail ?? approval.reason,
    command: approval.command,
    cwd: approval.cwd,
    availableDecisions: approval.availableDecisions,
    createdAt: Date.now(),
  };
}

export function eventThreadId(params: UnknownRecord | null): string | undefined {
  const nestedThread = record(params?.thread);
  const nestedConversation = record(params?.conversation);
  const nestedTurn = record(params?.turn);
  const nestedItem = record(params?.item);
  return stringValue(
    params?.threadId,
    params?.conversationId,
    nestedThread?.id,
    nestedThread?.threadId,
    nestedThread?.conversationId,
    nestedConversation?.id,
    nestedTurn?.threadId,
    nestedTurn?.conversationId,
    nestedItem?.threadId,
    nestedItem?.conversationId,
    nestedItem?.ownerThreadId,
    nestedItem?.ownerConversationId,
  );
}

function eventTurnId(params: UnknownRecord | null): string | undefined {
  const nestedTurn = record(params?.turn);
  return stringValue(params?.turnId, nestedTurn?.id);
}

export function isContextCompactionItem(value: unknown): boolean {
  const item = record(value);
  if (!item) return false;
  const type = String(item.type ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return type === 'contextcompaction' || type === 'compaction' || type === 'compactiontrigger';
}

function turnHasContextCompaction(value: unknown): boolean {
  const turn = record(value);
  return Array.isArray(turn?.items) && turn.items.some(isContextCompactionItem);
}

export interface ContextCompactionEvidence {
  id: string;
  turnId?: string;
  turnStatus: string;
  completed?: boolean;
  source?: 'manual' | 'automatic';
}

export function contextCompactionItemsFromThreadPayload(payload: unknown): ContextCompactionEvidence[] {
  const outer = record(payload);
  const thread = record(outer?.thread) ?? outer;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const evidence: ContextCompactionEvidence[] = [];
  turns.forEach((turnValue, turnIndex) => {
    const turn = record(turnValue);
    const turnId = stringValue(turn?.id, turn?.turnId);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    items.forEach((itemValue, itemIndex) => {
      if (!isContextCompactionItem(itemValue)) return;
      const item = record(itemValue);
      const source = item?.source === 'manual' || item?.source === 'automatic' ? item.source : undefined;
      evidence.push({
        id: stringValue(item?.id, item?.itemId) ?? `${turnId ?? `turn_${turnIndex}`}:${itemIndex}`,
        turnId,
        turnStatus: String(turn?.status ?? '').toLowerCase(),
        completed: typeof item?.completed === 'boolean' ? item.completed : undefined,
        source,
      });
    });
  });
  return evidence;
}

export function contextCompactionItemIdsFromThreadPayload(payload: unknown): string[] {
  return contextCompactionItemsFromThreadPayload(payload).map((item) => item.id);
}

export function compactionStatusFromThreadPayload(payload: unknown, now = Date.now()): CompactionStatus | null {
  const outer = record(payload);
  const thread = record(outer?.thread) ?? outer;
  const threadId = stringValue(thread?.id, thread?.threadId);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  if (!threadId) return null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = record(turns[index]);
    if (!turn || !turnHasContextCompaction(turn)) continue;
    const status = String(turn.status ?? '').toLowerCase();
    const startedAt = timestamp(turn.startedAt ?? turn.turnStartedAtMs ?? turn.startedAtMs, now);
    const completedAt = timestamp(turn.completedAt ?? turn.completedAtMs, now);
    const turnId = stringValue(turn.id, turn.turnId);
    if (isActiveTurnStatus(status)) {
      return { threadId, phase: 'running', startedAt, updatedAt: now, turnId, automatic: true };
    }
    if ((status.includes('fail') || status.includes('interrupt')) && now - completedAt <= 5 * 60_000) {
      const error = record(turn.error);
      return {
        threadId,
        phase: 'failed',
        startedAt,
        updatedAt: completedAt,
        turnId,
        message: stringValue(error?.message, error?.additionalDetails) ?? (status.includes('interrupt') ? '上下文压缩被中断' : '上下文压缩失败'),
        automatic: true,
      };
    }
    return null;
  }
  return null;
}

export function useRemote(config: RemoteConfig | null, deleteAttachmentsAfterTurn = false) {
  const socketRef = useRef<RemoteSocket | null>(null);
  const [archiveSupported, setArchiveSupported] = useState(false);
  const archiveRequests = useRef(new Map<string, { resolve: (value: ArchiveResult) => void; reject: (err: Error) => void }>());
  const archiveRequest = useCallback((request: ArchiveRequest): Promise<ArchiveResult> => {
    const requestId = createRequestId('archive');
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        archiveRequests.current.delete(requestId);
        reject(new Error('电脑回执超时，请重新打开已归档列表核对。'));
      }, 45_000);
      const finish = () => { window.clearTimeout(timer); archiveRequests.current.delete(requestId); };
      const entry = {
        resolve: (value: ArchiveResult) => { finish(); resolve(value); },
        reject: (error: Error) => { finish(); reject(error); },
      };
      archiveRequests.current.set(requestId, entry);
      if (!socketRef.current?.send({ ...request, requestId })) entry.reject(new Error('电脑未连接。'));
    });
  }, []);
  const selectedThreadRef = useRef<string | null>(null);
  const turnIdsRef = useRef<Record<string, string>>({});
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const threadsRef = useRef<RemoteThread[]>([]);
  const itemStartedAtRef = useRef<Record<string, number>>({});
  const notifiedApprovalIdsRef = useRef<Set<string>>(new Set());
  const notifiedTurnIdsRef = useRef<Set<string>>(new Set());
  const attentionStateByThreadRef = useRef<Record<string, 'waiting_approval' | 'waiting_input'>>({});
  const notifiedAttentionStateByThreadRef = useRef<Record<string, 'waiting_approval' | 'waiting_input'>>({});
  const attentionNotificationTimersRef = useRef<Record<string, number>>({});
  const notificationGuardRef = useRef(new NotificationGenerationGuard());
  const notificationQueueRef = useRef(new NotificationOperationQueue());
  const [phase, setPhase] = useState<ConnectionPhase>('idle');
  const [phaseDetail, setPhaseDetail] = useState('');
  const [connectionUrl, setConnectionUrl] = useState('');
  const [codexReady, setCodexReady] = useState(false);
  const [desktopOnly, setDesktopOnly] = useState(false);
  const mobileManagedSupportedRef = useRef(false);
  const [desktopIpcReady, setDesktopIpcReady] = useState<boolean>();
  const [hostVersion, setHostVersion] = useState('');
  const [antigravityAvailable, setAntigravityAvailable] = useState(false);
  const [antigravityAttachments, setAntigravityAttachments] = useState(false);
  const attachmentCleanupRef = useRef(false);
  const [desktopProjectMenus, setDesktopProjectMenus] = useState(false);
  const [desktopProjects, setDesktopProjects] = useState<{ path: string; name: string }[]>([]);
  const [projectStatus, setProjectStatus] = useState('');
  const projectRequest = useRef('');
  const refreshProjects = useCallback(() => {
    const id = createRequestId('projects');
    projectRequest.current = id;
    setProjectStatus(socketRef.current?.send({ type: 'projects.list', requestId: id }) ? '正在读取电脑项目…' : '电脑未连接');
  }, []);
  const [queueReceipt, setQueueReceipt] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [usageStatus, setUsageStatus] = useState('');
  const [mailRevision, setMailRevision] = useState(0);
  const usageSwitching = useRef(false);
  const usageRequest = useRef('');
  const usageTimers = useRef<{ fallback?: number; deadline?: number }>({});
  const cancelUsageRequest = useCallback(() => {
    window.clearTimeout(usageTimers.current.fallback);
    window.clearTimeout(usageTimers.current.deadline);
    usageTimers.current = {};
    usageRequest.current = '';
  }, []);
  const [modelPending, setModelPending] = useState(false);
  const modelRequest = useRef<{ id: string; threadId: string; model?: string; effort?: string } | null>(null);
  const refreshUsage = useCallback((force = false) => {
    if (!config || usageSwitching.current || (usageRequest.current && force !== true)) return;
    if (usageRequest.current) cancelUsageRequest();
    const requestId = createRequestId('usage');
    usageRequest.current = requestId;
    setUsageStatus('正在读取额度…');
    const sent = socketRef.current?.send({ type: 'usage.read', requestId });
    usageTimers.current.deadline = window.setTimeout(() => {
      if (usageRequest.current !== requestId) return;
      cancelUsageRequest();
      setUsageStatus('读取额度超时，可点击刷新重试。');
    }, 9_000);
    const readOverHttp = () => {
      void deviceRequest<AccountUsage>({ ...config, serverUrl: socketRef.current?.serverUrl ?? config.serverUrl }, 'usage').then(next => {
        if (usageRequest.current !== requestId) return;
        cancelUsageRequest();
        setUsage(next);
        setUsageStatus('');
      }).catch((error: unknown) => {
        if (sent || usageRequest.current !== requestId) return;
        cancelUsageRequest();
        setUsageStatus(error instanceof Error ? error.message : '暂时无法读取额度，可点击刷新重试。');
      });
    };
    if (sent) usageTimers.current.fallback = window.setTimeout(readOverHttp, 2_500);
    else readOverHttp();
  }, [config, cancelUsageRequest]);
  const changeModelSettings = useCallback((model?: string, effort?: string) => {
    const threadId = selectedThreadRef.current;
    if (!threadId || modelRequest.current || (model === undefined && !effort)) return false;
    const id = createRequestId('model-settings');
    if (!socketRef.current?.send({ type: 'thread.settings', requestId: id, threadId, model, effort })) return false;
    modelRequest.current = { id, threadId, model, effort };
    setModelPending(true);
    return true;
  }, []);
  const [selectedModel, setSelectedModelState] = useState('');
  const [selectedEffort, setSelectedEffortState] = useState('');
  const [selectedPermissionMode, setSelectedPermissionModeState] = useState<PermissionMode>('auto');
  const selectedPermissionModeRef = useRef<PermissionMode>('auto');
  const [permissionModeStatus, setPermissionModeStatus] = useState('');
  const permissionModeStatusTimerRef = useRef<number | null>(null);
  const pendingPermissionSettingsRef = useRef<Map<string, { threadId: string; mode: PermissionMode; previous: PermissionMode }>>(new Map());
  const permissionModeOverridesRef = useRef<Record<string, { requestId: string; mode: PermissionMode; expiresAt: number }>>({});
  const [threads, setThreads] = useState<RemoteThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messagesByThread, setMessagesByThread] = useState<Record<string, RemoteMessage[]>>({});
  const [todoByThread, setTodoByThread] = useState<Record<string, RemoteMessage>>({});
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [turnIds, setTurnIds] = useState<Record<string, string>>({});
  const [lastError, setLastError] = useState('');
  const [compactionsByThread, setCompactionsByThread] = useState<Record<string, CompactionStatus>>({});
  const [promptQueueByThread, setPromptQueueByThread] = useState<Record<string, PromptQueueItem[]>>({});
  const notifiedQueueItems = useRef(new Map<string, string>());
  useEffect(() => {
    const next = new Map(Object.values(promptQueueByThread).flat().filter(queueNeedsAttention).map(item => [item.id, item]));
    for (const item of next.values()) {
      if (notifiedQueueItems.current.has(item.id)) continue;
      notifiedQueueItems.current.set(item.id, item.threadId);
      void notifyQueueProblem(item, threadsRef.current.find(thread => thread.id === item.threadId)?.title || '打开任务查看队列');
    }
    for (const id of notifiedQueueItems.current.keys()) {
      if (next.has(id)) continue;
      notifiedQueueItems.current.delete(id);
      void cancelQueueNotification(id);
    }
  }, [promptQueueByThread]);
  const [gitDiffByThread, setGitDiffByThread] = useState<Record<string, GitDiffSnapshot>>({});
  const compactionsRef = useRef<Record<string, CompactionStatus>>({});
  const compactionTurnIdsRef = useRef<Record<string, Set<string>>>({});
  const pendingCompactionRequestsRef = useRef<Map<string, string>>(new Map());
  const pendingThreadStartRequestsRef = useRef<Set<string>>(new Set());
  const sendReceipts = useRef<Map<string, (accepted: boolean) => void>>(new Map());
  const syncChecks = useRef(new Map<string, (success: boolean) => void>());
  const checkConversationSync = useCallback(() => new Promise<void>((resolve, reject) => {
    const requestId = createRequestId('diagnostic-sync');
    const finish = (success: boolean) => {
      window.clearTimeout(timer);
      syncChecks.current.delete(requestId);
      if (success) resolve();
      else reject(new Error('未收到对话同步回执。'));
    };
    const timer = window.setTimeout(() => finish(false), 8000);
    syncChecks.current.set(requestId, finish);
    if (!socketRef.current?.send({ type: 'threads.sync', requestId, knownVersion: threadIndexVersionRef.current })) finish(false);
  }), []);
  const notifiedCompactionFailuresRef = useRef<Set<string>>(new Set());
  const seenCompactionItemsRef = useRef<Record<string, Map<string, boolean | undefined>>>({});
  const [historyByThread, setHistoryByThread] = useState<Record<string, CachedHistoryState>>({});
  const [historyLoadingByThread, setHistoryLoadingByThread] = useState<Record<string, boolean>>({});
  const olderHistoryRequests = useRef(new Map<string, string>());
  const historyByThreadRef = useRef<Record<string, CachedHistoryState>>({});

  const setSelectedPermissionMode = useCallback((mode: PermissionMode) => {
    selectedPermissionModeRef.current = mode;
    setSelectedPermissionModeState(mode);
  }, []);

  const showPermissionModeStatus = useCallback((text: string, autoDismiss = true) => {
    if (permissionModeStatusTimerRef.current != null) window.clearTimeout(permissionModeStatusTimerRef.current);
    permissionModeStatusTimerRef.current = null;
    setPermissionModeStatus(text);
    if (text && autoDismiss) {
      permissionModeStatusTimerRef.current = window.setTimeout(() => {
        permissionModeStatusTimerRef.current = null;
        setPermissionModeStatus('');
      }, 6_000);
    }
  }, []);

  const applyPermissionModeSnapshot = useCallback((threadId: string, mode: PermissionMode) => {
    if (selectedThreadRef.current !== threadId) return;
    const override = permissionModeOverridesRef.current[threadId];
    if (!shouldApplyPermissionModeSnapshot(mode, override, Date.now())) return;
    if (override?.mode === mode) override.expiresAt = Date.now() + 3_000;
    setSelectedPermissionMode(mode);
  }, [setSelectedPermissionMode]);
  const messagesByThreadRef = useRef<Record<string, RemoteMessage[]>>({});
  const pendingMessageDeltasRef = useRef<Map<string, PendingMessageDelta>>(new Map());
  const pendingMessageDeltaTimerRef = useRef<number | null>(null);
  const terminalMessageItemsRef = useRef<Set<string>>(new Set());
  const terminalMessageTurnsRef = useRef<Set<string>>(new Set());
  const syncVersionRef = useRef<string | undefined>(undefined);
  const syncCursorRef = useRef(0);
  const threadIndexVersionRef = useRef(0);
  const serverIdRef = useRef<string | undefined>(undefined);
  const cacheScopeRef = useRef<string | null>(null);
  const cacheHydratedRef = useRef(false);
  const cacheSaveTimerRef = useRef<number | null>(null);
  const cacheWriteRef = useRef<Promise<void>>(Promise.resolve());
  const cacheEpochRef = useRef(0);
  const handleMessageRef = useRef<(message: ServerMessage) => void>(() => undefined);

  useEffect(() => {
    selectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    approvalsRef.current = approvals;
  }, [approvals]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    messagesByThreadRef.current = messagesByThread;
  }, [messagesByThread]);

  useEffect(() => () => {
    if (pendingMessageDeltaTimerRef.current != null) window.clearTimeout(pendingMessageDeltaTimerRef.current);
    pendingMessageDeltaTimerRef.current = null;
    pendingMessageDeltasRef.current.clear();
    terminalMessageItemsRef.current.clear();
    terminalMessageTurnsRef.current.clear();
  }, []);

  useEffect(() => {
    historyByThreadRef.current = historyByThread;
  }, [historyByThread]);

  useEffect(() => {
    compactionsRef.current = compactionsByThread;
  }, [compactionsByThread]);

  const updateCompactionStatus = useCallback((threadId: string, next: Omit<CompactionStatus, 'threadId' | 'startedAt' | 'updatedAt'> & { startedAt?: number; updatedAt?: number }) => {
    const now = Date.now();
    setCompactionsByThread((current) => {
      const previous = current[threadId];
      const status: CompactionStatus = {
        threadId,
        startedAt: next.startedAt ?? previous?.startedAt ?? now,
        updatedAt: next.updatedAt ?? now,
        automatic: next.automatic ?? previous?.automatic,
        turnId: next.turnId ?? previous?.turnId,
        message: next.message,
        phase: next.phase,
      };
      const updated = { ...current, [threadId]: status };
      compactionsRef.current = updated;
      return updated;
    });
  }, []);

  const reportCompactionFailure = useCallback((threadId: string, message: string, turnId?: string) => {
    const normalizedMessage = message.trim() || '上下文压缩失败';
    updateCompactionStatus(threadId, { phase: 'failed', message: normalizedMessage, turnId });
    setLastError(`上下文压缩失败：${normalizedMessage}`);
    const key = `${threadId}:${turnId ?? normalizedMessage}`;
    if (notifiedCompactionFailuresRef.current.has(key)) return;
    notifiedCompactionFailuresRef.current.add(key);
    const threadTitle = threadsRef.current.find((thread) => thread.id === threadId)?.title ?? 'Codex 任务';
    void notifyCompactionFailed({ threadId, threadTitle, message: normalizedMessage });
  }, [updateCompactionStatus]);

  const observeCompactionSnapshot = useCallback((payload: unknown, threadId: string) => {
    const items = contextCompactionItemsFromThreadPayload(payload);
    const nextItems = new Map(items.map((item) => [item.id, item.completed]));
    const previousItems = seenCompactionItemsRef.current[threadId];
    seenCompactionItemsRef.current[threadId] = nextItems;
    if (previousItems) {
      for (const item of items) {
        const previousCompleted = previousItems.get(item.id);
        const isNew = !previousItems.has(item.id);
        const becameComplete = previousCompleted === false && item.completed === true;
        if (item.completed === false && isNew) {
          if (item.turnId) {
            compactionTurnIdsRef.current[threadId] ??= new Set();
            compactionTurnIdsRef.current[threadId].add(item.turnId);
          }
          updateCompactionStatus(threadId, {
            phase: 'running',
            turnId: item.turnId,
            message: '正在压缩上下文',
            automatic: item.source === 'automatic',
          });
        } else if (item.completed === true && (isNew || becameComplete)) {
          updateCompactionStatus(threadId, {
            phase: 'succeeded',
            turnId: item.turnId,
            message: '上下文压缩完成',
            automatic: item.source === 'automatic',
          });
        }
      }
    }

    const active = compactionsRef.current[threadId];
    if (!active || !['requested', 'running', 'retrying'].includes(active.phase)) return;
    const outer = record(payload);
    const thread = record(outer?.thread) ?? outer;
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const activeTurn = [...turns].reverse().map(record).find((turn) => turn && isActiveTurnStatus(turn.status));
    const latestTurn = record(turns.at(-1));
    if (!activeTurn && latestTurn && String(latestTurn.status ?? '').toLowerCase().includes('fail')) {
      const error = record(latestTurn.error);
      reportCompactionFailure(threadId, stringValue(error?.message, error?.additionalDetails) ?? '上下文压缩失败', stringValue(latestTurn.id, latestTurn.turnId));
    }
  }, [reportCompactionFailure, updateCompactionStatus]);

  const setCurrentTurn = useCallback((threadId: string, turnId?: string) => {
    const next = turnIdsAfterSnapshot(turnIdsRef.current, threadId, turnId);
    if (next === turnIdsRef.current) return;
    turnIdsRef.current = next;
    setTurnIds(next);
  }, []);

  const updateThreadState = useCallback((threadId: string, state: ThreadState,
    runtime?: Partial<Pick<RemoteThread, 'currentTurnStartedAt' | 'lastTurnDurationMs' | 'mobileManaged' | 'mobileRuntimeActive'>>,
  ) => {
    const updated = sortThreads(threadsRef.current.map(thread =>
      thread.id === threadId ? { ...thread, state, updatedAt: Date.now(), ...runtime } : thread,
    ));
    threadsRef.current = updated;
    setThreads(updated);
  }, []);

  const queueAttentionCancellation = useCallback((threadId: string, kind: 'approval' | 'input') => {
    return notificationQueueRef.current.run(
      `attention:${kind}:${threadId}`,
      () => cancelThreadAttentionNotification(threadId, kind),
    );
  }, []);

  const queueApprovalCancellation = useCallback((requestId: string | number) => {
    return notificationQueueRef.current.run(
      `approval:${String(requestId)}`,
      () => cancelApprovalNotification(requestId),
    );
  }, []);

  const clearThreadAttentionNotification = useCallback((threadId: string) => {
    const previousState = attentionStateByThreadRef.current[threadId];
    const notifiedState = notifiedAttentionStateByThreadRef.current[threadId];
    const pendingTimer = attentionNotificationTimersRef.current[threadId];
    if (previousState === undefined && notifiedState === undefined && pendingTimer === undefined) return;

    notificationGuardRef.current.invalidate(`attention:${threadId}`);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    delete attentionNotificationTimersRef.current[threadId];
    delete attentionStateByThreadRef.current[threadId];
    delete notifiedAttentionStateByThreadRef.current[threadId];

    // A pending timer that never fired did not post anything. Once scheduling has started,
    // its timer entry is removed first, so cancel the one relevant deterministic ID to
    // close that race without issuing two native calls for every ordinary thread snapshot.
    const stateToCancel = notifiedState ?? (pendingTimer === undefined ? previousState : undefined);
    if (stateToCancel === 'waiting_approval' || stateToCancel === 'waiting_input') {
      void queueAttentionCancellation(threadId, stateToCancel === 'waiting_input' ? 'input' : 'approval');
    }
  }, [queueAttentionCancellation]);

  const updateAttentionNotification = useCallback((threadId: string, state: ThreadState) => {
    if (state !== 'waiting_approval' && state !== 'waiting_input') {
      clearThreadAttentionNotification(threadId);
      return;
    }

    if (state === 'waiting_approval' && approvalsRef.current.some((approval) => approval.threadId === threadId)) {
      const pending = attentionNotificationTimersRef.current[threadId];
      if (pending !== undefined) window.clearTimeout(pending);
      delete attentionNotificationTimersRef.current[threadId];
      attentionStateByThreadRef.current[threadId] = state;
      return;
    }

    const previous = attentionStateByThreadRef.current[threadId];
    const pendingTimer = attentionNotificationTimersRef.current[threadId];
    const alreadyNotified = notifiedAttentionStateByThreadRef.current[threadId] === state;
    if (previous === state && (pendingTimer !== undefined || alreadyNotified)) return;

    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    delete attentionNotificationTimersRef.current[threadId];
    const previouslyNotified = notifiedAttentionStateByThreadRef.current[threadId];
    if (previouslyNotified && previouslyNotified !== state) {
      void queueAttentionCancellation(threadId, previouslyNotified === 'waiting_input' ? 'input' : 'approval');
      delete notifiedAttentionStateByThreadRef.current[threadId];
    }

    attentionStateByThreadRef.current[threadId] = state;
    const kind = state === 'waiting_input' ? 'input' : 'approval';
    const ticket = notificationGuardRef.current.begin(`attention:${threadId}`);
    const showNotification = () => {
      if (!notificationGuardRef.current.isCurrent(ticket) || attentionStateByThreadRef.current[threadId] !== state) return;
      const threadTitle = threadsRef.current.find((thread) => thread.id === threadId)?.title ?? 'Codex 任务';
      void settleGuardedNotification({
        guard: notificationGuardRef.current,
        ticket,
        queue: notificationQueueRef.current,
        operationKey: `attention:${kind}:${threadId}`,
        schedule: () => notifyThreadAttention({ threadId, threadTitle, kind }),
        isRelevant: () => attentionStateByThreadRef.current[threadId] === state
          && !(kind === 'approval' && approvalsRef.current.some((approval) => approval.threadId === threadId)),
        cancel: () => cancelThreadAttentionNotification(threadId, kind),
      }).then((result) => {
        if (result === 'stale') return;
        if (result === 'shown') {
          notifiedAttentionStateByThreadRef.current[threadId] = state;
          return;
        }
        delete notifiedAttentionStateByThreadRef.current[threadId];
        setLastError('Android 通知未能发送，请检查通知权限及通知分类的声音设置');
      });
    };
    if (kind === 'approval') {
      // A detailed approval event normally follows the coarse waiting status. Delay the
      // fallback briefly; repeated snapshots must not keep cancelling the same timer.
      attentionNotificationTimersRef.current[threadId] = window.setTimeout(() => {
        delete attentionNotificationTimersRef.current[threadId];
        showNotification();
      }, 2_000);
    } else {
      showNotification();
    }
  }, [clearThreadAttentionNotification, queueAttentionCancellation]);

  const replaceThreadsAndSyncAttention = useCallback((nextThreads: RemoteThread[]) => {
    const nextIds = new Set(nextThreads.map((thread) => thread.id));
    for (const threadId of Object.keys(attentionStateByThreadRef.current)) {
      if (!nextIds.has(threadId)) clearThreadAttentionNotification(threadId);
    }
    threadsRef.current = nextThreads;
    setThreads(nextThreads);
    for (const thread of nextThreads) {
      const waiting = thread.state === 'waiting_approval' || thread.state === 'waiting_input';
      const tracked = attentionStateByThreadRef.current[thread.id] !== undefined
        || notifiedAttentionStateByThreadRef.current[thread.id] !== undefined
        || attentionNotificationTimersRef.current[thread.id] !== undefined;
      if (waiting || tracked) updateAttentionNotification(thread.id, thread.state);
    }
  }, [clearThreadAttentionNotification, updateAttentionNotification]);

  const applyThreadSnapshot = useCallback((snapshot: NormalizedThreadPayload) => {
    const thread = snapshot.thread;
    if (!thread) return;
    const previous = threadsRef.current.find(candidate => candidate.id === thread.id);
    if (previous && keepObservedTurn(snapshot, turnIdsRef.current[thread.id], terminalMessageTurnsRef.current)) {
      replaceThreadsAndSyncAttention(sortThreads(upsertById(threadsRef.current, {
        ...thread, state: previous.state, currentTurnStartedAt: previous.currentTurnStartedAt, updatedAt: Math.max(thread.updatedAt, previous.updatedAt),
        lastTurnDurationMs: previous.lastTurnDurationMs, mobileRuntimeActive: previous.mobileRuntimeActive,
      })));
      return;
    }
    if (snapshot.completedTurnId) terminalMessageTurnsRef.current.add(`${thread.id}\u0000${snapshot.completedTurnId}`);
    setCurrentTurn(thread.id, snapshot.currentTurnId);
    replaceThreadsAndSyncAttention(sortThreads(upsertById(threadsRef.current, thread)));
  }, [replaceThreadsAndSyncAttention, setCurrentTurn]);

  const forgetAntigravityThread = useCallback((threadId: string) => {
    if (!threadId.startsWith('antigravity:')) return;
    replaceThreadsAndSyncAttention(threadsRef.current.filter(thread => thread.id !== threadId));
    setMessagesByThread(current => {
      const { [threadId]: removed, ...remaining } = current;
      return removed ? remaining : current;
    });
    setHistoryByThread(current => {
      const { [threadId]: removed, ...remaining } = current;
      return removed ? remaining : current;
    });
    if (selectedThreadRef.current === threadId) {
      selectedThreadRef.current = null;
      setSelectedThreadId(null);
    }
  }, [replaceThreadsAndSyncAttention]);

  const deleteAntigravityThread = useCallback(async (threadId: string) => {
    if (!config) throw new Error('电脑未连接。');
    const result = await deviceRequest<{ threadId: string }>({ ...config, serverUrl: socketRef.current?.serverUrl ?? config.serverUrl },
      'antigravity/thread/delete', { threadId });
    if (result.threadId !== threadId) throw new Error('电脑未确认删除，请刷新列表核对。');
    forgetAntigravityThread(threadId);
  }, [config, forgetAntigravityThread]);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    if (!config || phase !== 'connected') throw new Error('电脑未连接。');
    const result = await deviceRequest<{ threadId: string; title: string; scope: 'desktop' | 'companion' }>(
      { ...config, serverUrl: socketRef.current?.serverUrl ?? config.serverUrl }, 'thread/rename', { threadId, title });
    const expectedScope = threadId.startsWith('antigravity:') ? 'companion' : 'desktop';
    if (result.threadId !== threadId || result.title !== title || result.scope !== expectedScope)
      throw new Error('电脑未确认改名，请刷新列表核对。');
    replaceThreadsAndSyncAttention(threadsRef.current.map(thread => thread.id === threadId ? { ...thread, title: result.title } : thread));
  }, [config, phase, replaceThreadsAndSyncAttention]);

  const flushPendingMessageDeltas = useCallback(() => {
    if (pendingMessageDeltaTimerRef.current != null) {
      window.clearTimeout(pendingMessageDeltaTimerRef.current);
      pendingMessageDeltaTimerRef.current = null;
    }
    if (pendingMessageDeltasRef.current.size === 0) return;
    const pending = [...pendingMessageDeltasRef.current.values()];
    pendingMessageDeltasRef.current.clear();
    setMessagesByThread((current) => applyPendingMessageDeltas(current, pending));
  }, []);

  const appendDelta = useCallback(
    (threadId: string, turnId: string | undefined, itemId: string, delta: string, role: RemoteMessage['role'], toolName?: string, itemType?: string) => {
      if (!delta) return;
      const itemKey = `${threadId}\u0000${itemId}`;
      const turnKey = turnId ? `${threadId}\u0000${turnId}` : '';
      if (terminalMessageItemsRef.current.has(itemKey) || (turnKey && terminalMessageTurnsRef.current.has(turnKey))) return;
      const key = itemKey;
      const previous = pendingMessageDeltasRef.current.get(key);
      pendingMessageDeltasRef.current.set(key, previous ? {
        ...previous,
        turnId: previous.turnId ?? turnId,
        delta: previous.delta + delta,
        ...(toolName ? { toolName } : {}),
        ...(itemType ? { itemType } : {}),
      } : { threadId, turnId, itemId, delta, role, toolName, itemType, createdAt: Date.now() });
      if (pendingMessageDeltaTimerRef.current == null) {
        pendingMessageDeltaTimerRef.current = window.setTimeout(flushPendingMessageDeltas, 32);
      }
    },
    [flushPendingMessageDeltas],
  );

  const handleEvent = useCallback(
    (method: string, rawParams: unknown) => {
      const params = record(rawParams);
      const threadId = eventThreadId(params);
      const turnId = eventTurnId(params);
      const item = record(params?.item);
      const itemId = stringValue(params?.itemId, item?.id) ?? `${turnId ?? 'turn'}_${method}`;
      const lowerMethod = method.toLowerCase();
      const isBufferedTextDelta = method === 'item/reasoning/summaryTextDelta'
        || method === 'item/reasoning/textDelta'
        || method === 'item/plan/delta'
        || method === 'item/mcpToolCall/progress'
        || method === 'turn/diff/updated'
        || (lowerMethod.includes('agentmessage') && lowerMethod.includes('delta'))
        || lowerMethod.includes('outputdelta');
      if (!isBufferedTextDelta) flushPendingMessageDeltas();

      if ((method === 'thread/started' || method === 'desktop/threadSnapshot') && params?.thread) {
        const normalized = normalizeThreadPayload({ thread: params.thread });
        if (normalized.thread) {
          observeCompactionSnapshot({ thread: params.thread }, normalized.thread.id);
          const latestTodo = latestPlanMessage(normalized.messages);
          if (latestTodo) setTodoByThread((current) => ({ ...current, [normalized.thread!.id]: latestTodo }));
          applyThreadSnapshot(normalized);
          if (selectedThreadRef.current === normalized.thread.id) {
            const observedTurnId = normalized.currentTurnId ?? normalized.messages.at(-1)?.turnId;
            setMessagesByThread((current) => ({ ...current, [normalized.thread!.id]: reconcileThreadSnapshot(current[normalized.thread!.id] ?? [], normalized.messages, normalized.thread!.id, observedTurnId) }));
            if (normalized.thread.model) setSelectedModelState(normalized.thread.model);
            if (normalized.thread.effort) setSelectedEffortState(normalized.thread.effort);
            if (normalized.thread.permissionMode) applyPermissionModeSnapshot(normalized.thread.id, normalized.thread.permissionMode);
          }
        }
        return;
      }
      if (method === 'thread/status/changed' && threadId) {
        if (turnId && turnIdsRef.current[threadId] && turnId !== turnIdsRef.current[threadId]) return;
        const nextState = stateFromStatus(params?.status);
        updateThreadState(threadId, nextState);
        updateAttentionNotification(threadId, nextState);
        if (!['running', 'waiting_approval', 'waiting_input'].includes(nextState)) {
          setCurrentTurn(threadId);
        }
        return;
      }
      if (method === 'thread/tokenUsage/updated' && threadId) {
        const tokenUsage = record(params?.tokenUsage);
        const total = record(tokenUsage?.total);
        if (total) {
          setThreads((current) => {
            const updated = current.map((thread) => thread.id === threadId ? {
              ...thread,
              tokenUsage: {
                totalTokens: Number(total.totalTokens ?? 0),
                inputTokens: Number(total.inputTokens ?? 0),
                outputTokens: Number(total.outputTokens ?? 0),
                reasoningOutputTokens: Number(total.reasoningOutputTokens ?? 0),
              },
            } : thread);
            threadsRef.current = updated;
            return updated;
          });
        }
        return;
      }
      if (method === 'turn/started' && threadId && turnId) {
        if (terminalMessageTurnsRef.current.has(`${threadId}\u0000${turnId}`)) return;
        setCurrentTurn(threadId, turnId);
        const turn = record(params?.turn);
        const startedAt = timestamp(turn?.startedAt ?? turn?.turnStartedAtMs ?? turn?.startedAtMs ?? params?.startedAtMs ?? Date.now());
        if (turnHasContextCompaction(turn)) {
          compactionTurnIdsRef.current[threadId] ??= new Set();
          compactionTurnIdsRef.current[threadId].add(turnId);
          updateCompactionStatus(threadId, { phase: 'running', startedAt, turnId, automatic: !compactionsRef.current[threadId] });
        }
        updateThreadState(threadId, 'running', { currentTurnStartedAt: startedAt,
          ...(params?.mobileRuntimeActive === true ? { mobileManaged: true, mobileRuntimeActive: true } : {}) });
        updateAttentionNotification(threadId, 'running');
        return;
      }
      if (method === 'turn/completed' && threadId) {
        if (turnId) terminalMessageTurnsRef.current.add(`${threadId}\u0000${turnId}`);
        const turn = record(params?.turn);
        const activeTurn = turnIdsRef.current[threadId];
        const belongsToPreviousTurn = Boolean(activeTurn && turnId && activeTurn !== turnId);
        const failed = String(turn?.status ?? '').toLowerCase() === 'failed';
        const quotaLimited = turn?.quotaLimited === true;
        const error = record(turn?.error);
        const errorText = stringValue(error?.message, error?.additionalDetails, params?.message);
        const turnStatus = String(turn?.status ?? '').toLowerCase();
        const trackedCompaction = Boolean(turnId && compactionTurnIdsRef.current[threadId]?.has(turnId));
        const activeCompaction = compactionsRef.current[threadId];
        const isCompactionTurn = trackedCompaction || (Boolean(activeCompaction) && ['requested', 'running', 'retrying'].includes(activeCompaction.phase) && turnHasContextCompaction(turn));
        if (!belongsToPreviousTurn && isCompactionTurn) {
          if (failed || turnStatus.includes('interrupt')) {
            reportCompactionFailure(threadId, errorText ?? (turnStatus.includes('interrupt') ? '上下文压缩被中断' : '上下文压缩失败'), turnId);
          } else {
            updateCompactionStatus(threadId, { phase: 'succeeded', message: '上下文压缩完成', turnId });
          }
          if (turnId) compactionTurnIdsRef.current[threadId]?.delete(turnId);
        }
        const durationMs = reportedTurnDuration(turn);
        const completedThreadState: ThreadState = quotaLimited ? 'quota_limited' : failed ? 'error' : 'idle';
        if (!belongsToPreviousTurn) {
          setCurrentTurn(threadId);
          updateThreadState(threadId, completedThreadState, { currentTurnStartedAt: undefined, lastTurnDurationMs: durationMs });
        }
        setMessagesByThread((current) => {
          const completed = messagesForThread(threadId, current[threadId] ?? []).map((message) => {
            if (turnId && message.turnId && message.turnId !== turnId) return message;
            const finished = message.status === 'streaming'
              ? { ...message, status: failed ? ('failed' as const) : ('complete' as const), completedAt: Date.now() }
              : message;
            return durationMs != null && turnId && message.turnId === turnId
              ? { ...finished, turnDurationMs: durationMs } : finished;
          });
          if (failed && errorText) {
            return { ...current, [threadId]: upsertLiveItem(completed, {
              id: `${turnId ?? 'turn'}_error`,
              threadId,
              turnId,
              role: 'system',
              content: errorText,
              createdAt: Date.now(),
              timestampSource: 'live',
              status: 'failed',
              toolName: '错误',
            }) };
          }
          return { ...current, [threadId]: completed };
        });
        if (belongsToPreviousTurn) return;
        if (failed && errorText && !isCompactionTurn && !quotaLimited) setLastError(errorText);
        const completedThread = threadsRef.current.find((thread) => thread.id === threadId);
        const threadTitle = completedThread?.title ?? 'Codex 任务';
        // Subagent turns are implementation detail activity of their parent task.
        // Notifying every child completion creates noisy “task completed” alerts
        // that open the child instead of the task the user is following.
        if (!isCompactionTurn && shouldNotifyThreadCompletion(completedThread)) {
          const notificationKey = `${threadId}:${turnId ?? String(turn?.completedAt ?? turn?.startedAt ?? '')}`;
          if (!notifiedTurnIdsRef.current.has(notificationKey)) {
            notifiedTurnIdsRef.current.add(notificationKey);
            void notifyTurnFinished({
              threadId,
              threadTitle,
              status: quotaLimited ? 'quota_limited' : String(turn?.status ?? (failed ? 'failed' : 'completed')),
              durationMs,
              eventId: turnId ?? String(turn?.completedAt ?? turn?.startedAt ?? 'latest'),
            }).then((shown) => {
              if (!shown) {
                notifiedTurnIdsRef.current.delete(notificationKey);
                if (!quotaLimited) setLastError('Android 通知未能发送，请检查通知权限及通知分类的声音设置');
              }
            });
          }
        }
        clearThreadAttentionNotification(threadId);
        return;
      }
      if (method === 'error' && threadId) {
        const error = record(params?.error);
        if (params?.quotaLimited === true && params.willRetry === false) {
          updateThreadState(threadId, 'quota_limited');
          setCurrentTurn(threadId);
          clearThreadAttentionNotification(threadId);
          return;
        }
        const errorText = stringValue(error?.message, error?.additionalDetails) ?? 'Codex turn 发生错误';
        const activeCompaction = compactionsRef.current[threadId];
        const belongsToCompaction = Boolean(activeCompaction && ['requested', 'running', 'retrying'].includes(activeCompaction.phase)
          && (!turnId || !activeCompaction.turnId || activeCompaction.turnId === turnId || compactionTurnIdsRef.current[threadId]?.has(turnId)));
        if (belongsToCompaction) {
          if (params?.willRetry === true) {
            updateCompactionStatus(threadId, { phase: 'retrying', message: `发生错误，Codex 正在重试：${errorText}`, turnId });
            setLastError(`上下文压缩遇到错误，正在重试：${errorText}`);
          } else {
            reportCompactionFailure(threadId, errorText, turnId);
            updateThreadState(threadId, 'error');
          }
          return;
        }
        setLastError(errorText);
        if (params?.willRetry !== true) updateThreadState(threadId, 'error');
        return;
      }
      if ((method === 'thread/compacted' || method === 'context/compacted') && threadId) {
        updateCompactionStatus(threadId, { phase: 'succeeded', message: '上下文压缩完成', turnId });
        return;
      }
      if (method === 'item/reasoning/summaryTextDelta' && threadId) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.delta), 'system', '思考梗概', 'reasoning');
        return;
      }
      if (method === 'item/reasoning/textDelta' && threadId) {
        appendDelta(threadId, turnId, `${itemId}_detail`, textFromContent(params?.delta), 'system', '思考详情', 'reasoning');
        return;
      }
      if (method === 'item/plan/delta' && threadId) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.delta), 'system', '计划', 'plan');
        return;
      }
      if (method === 'turn/plan/updated' && threadId) {
        const plan = Array.isArray(params?.plan) ? params.plan : [];
        const text = plan.map((entry) => {
          const row = record(entry);
          return `${String(row?.status ?? 'pending')} · ${String(row?.step ?? '')}`;
        }).join('\n');
        if (text) {
          const id = `${turnId ?? 'turn'}_plan`;
          const planMessage: RemoteMessage = {
            id,
            threadId,
            turnId,
            role: 'system',
            content: [typeof params?.explanation === 'string' ? params.explanation : '', text].filter(Boolean).join('\n'),
            createdAt: Date.now(),
            timestampSource: 'live',
            status: 'streaming',
            toolName: '计划',
            itemType: 'plan',
            detail: rawParams,
            collapsible: true,
          };
          setTodoByThread((current) => ({ ...current, [threadId]: planMessage }));
          setMessagesByThread((current) => ({
            ...current,
            [threadId]: upsertLiveItem(messagesForThread(threadId, current[threadId] ?? []), planMessage),
          }));
        }
        return;
      }
      if (method === 'item/mcpToolCall/progress' && threadId) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.message), 'tool', 'MCP 进度');
        return;
      }
      if (method === 'turn/diff/updated' && threadId && turnId) {
        appendDelta(threadId, turnId, `${turnId}_diff`, textFromContent(params?.diff), 'tool', '本轮 Diff');
        return;
      }
      if (method === 'item/fileChange/patchUpdated' && threadId) {
        const normalized = itemToMessage(
          { type: 'fileChange', id: itemId, changes: params?.changes, status: 'inProgress' },
          threadId,
          turnId ?? 'turn',
          0,
        );
        if (normalized) {
          normalized.status = 'streaming';
          setMessagesByThread((current) => ({
            ...current,
            [threadId]: dedupeMessages(upsertLiveItem(messagesForThread(threadId, current[threadId] ?? []), normalized)),
          }));
        }
        return;
      }
      if ((method === 'item/started' || method === 'item/completed') && threadId && item) {
        const terminalItemKey = `${threadId}\u0000${itemId}`;
        if (method === 'item/started') {
          if (terminalMessageItemsRef.current.has(terminalItemKey)
            || (turnId && terminalMessageTurnsRef.current.has(`${threadId}\u0000${turnId}`))) return;
        } else {
          terminalMessageItemsRef.current.add(terminalItemKey);
          terminalMessageItemsRef.current.add(`${terminalItemKey}_detail`);
        }
        if (isContextCompactionItem(item)) {
          if (turnId) {
            compactionTurnIdsRef.current[threadId] ??= new Set();
            compactionTurnIdsRef.current[threadId].add(turnId);
          }
          if (method === 'item/started') {
            updateCompactionStatus(threadId, {
              phase: 'running',
              startedAt: typeof params?.startedAtMs === 'number' ? params.startedAtMs : Date.now(),
              turnId,
              automatic: !compactionsRef.current[threadId],
            });
          } else {
            updateCompactionStatus(threadId, {
              phase: 'succeeded',
              updatedAt: typeof params?.completedAtMs === 'number' ? params.completedAtMs : Date.now(),
              turnId,
              message: '上下文压缩完成',
            });
          }
          return;
        }
        const normalized = itemToMessage(item, threadId, turnId ?? 'turn', 0, Date.now(), method === 'item/started');
        const timingKey = `${threadId}:${turnId ?? 'turn'}:${itemId}`;
        if (method === 'item/started') {
          itemStartedAtRef.current[timingKey] = typeof params?.startedAtMs === 'number' ? params.startedAtMs : Date.now();
        }
        if (normalized) {
          if (method === 'item/started') {
            normalized.status = 'streaming';
            normalized.createdAt = itemStartedAtRef.current[timingKey] ?? normalized.createdAt;
            normalized.timestampSource = 'live';
          } else {
            const completedAt = typeof params?.completedAtMs === 'number' ? params.completedAtMs : Date.now();
            const startedAt = itemStartedAtRef.current[timingKey];
            normalized.createdAt = startedAt ?? completedAt;
            normalized.timestampSource = 'live';
            normalized.completedAt = completedAt;
            if (normalized.durationMs == null && startedAt != null) normalized.durationMs = Math.max(0, completedAt - startedAt);
            delete itemStartedAtRef.current[timingKey];
          }
          setMessagesByThread((current) => ({
            ...current,
            [threadId]: dedupeMessages(upsertLiveItem(
              normalized.role === 'user'
                ? matchPendingUsers(messagesForThread(threadId, current[threadId] ?? []), [normalized])
                : messagesForThread(threadId, current[threadId] ?? []),
              normalized,
            )),
          }));
        }
        return;
      }
      if (threadId && method.includes('agentMessage') && method.toLowerCase().includes('delta')) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.delta), 'assistant');
        return;
      }
      if (threadId && method.toLowerCase().includes('outputdelta')) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.delta), 'tool', '命令输出');
      }
    },
    [appendDelta, applyThreadSnapshot, clearThreadAttentionNotification, flushPendingMessageDeltas, observeCompactionSnapshot, reportCompactionFailure, setCurrentTurn, updateAttentionNotification, updateCompactionStatus, updateThreadState],
  );

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === 'sync.replay') {
        if (message.syncVersion !== syncVersionRef.current) return;
        for (const event of message.events) handleMessageRef.current(event);
        syncCursorRef.current = Math.max(syncCursorRef.current, message.toCursor);
        return;
      }
      if (message.type === 'sync.reset') {
        syncVersionRef.current = message.syncVersion;
        syncCursorRef.current = message.latestCursor;
        threadIndexVersionRef.current = 0;
        socketRef.current?.send({ type: 'threads.sync', requestId: createRequestId('threads-sync') });
        const threadId = selectedThreadRef.current;
        if (threadId) socketRef.current?.send({
          type: 'thread.open', requestId: createRequestId('open-reset'), threadId,
          historyLimit: 20, knownTurnIds: knownTurnIds(messagesForThread(threadId, messagesByThreadRef.current[threadId] ?? [])),
        });
        return;
      }
      if (message.type !== 'welcome' && message.syncVersion && syncVersionRef.current && message.syncVersion !== syncVersionRef.current) {
        syncVersionRef.current = message.syncVersion;
        syncCursorRef.current = 0;
      }
      if (typeof message.syncCursor === 'number' && message.syncCursor <= syncCursorRef.current) return;
      switch (message.type) {
        case 'welcome': {
          setAntigravityAvailable(message.antigravityAvailable === true);
          setAntigravityAttachments(message.antigravityAttachments === true);
          attachmentCleanupRef.current = message.attachmentCleanup === true;
          setHostVersion(message.version);
          setArchiveSupported(message.archiveManagement === true);
          setDesktopOnly(message.desktopOnly === true);
          mobileManagedSupportedRef.current = message.mobileManagedThreads === true;
          setDesktopIpcReady(message.desktopIpcReady);
          setDesktopProjectMenus(message.desktopOnly === true && message.projectCreation === true);
          setDesktopProjects([]);
          setCodexReady(message.codexReady);
          setLastError('');
          setPhaseDetail(message.codexReady ? '' : 'Bridge 已连接，但 Codex app-server 尚未就绪');
          const serverChanged = Boolean(serverIdRef.current && serverIdRef.current !== message.serverId);
          if (serverChanged) {
            replaceThreadsAndSyncAttention([]);
            setMessagesByThread({});
            setHistoryByThread({});
            turnIdsRef.current = {};
            setTurnIds({});
            pendingMessageDeltasRef.current.clear();
            terminalMessageItemsRef.current.clear();
            terminalMessageTurnsRef.current.clear();
            threadIndexVersionRef.current = 0;
            syncCursorRef.current = 0;
          }
          serverIdRef.current = message.serverId;
          const sameSyncVersion = !serverChanged && Boolean(message.syncVersion && syncVersionRef.current === message.syncVersion);
          if (message.syncVersion) {
            socketRef.current?.send({
              type: 'sync.resume', requestId: createRequestId('resume'),
              syncVersion: sameSyncVersion ? syncVersionRef.current : undefined,
              cursor: sameSyncVersion ? syncCursorRef.current : undefined,
              threadIds: selectedThreadRef.current ? [selectedThreadRef.current] : [],
            });
            syncVersionRef.current = message.syncVersion;
            socketRef.current?.send({
              type: 'threads.sync', requestId: createRequestId('threads-sync'),
              knownVersion: sameSyncVersion ? threadIndexVersionRef.current : undefined,
            });
          } else {
            syncVersionRef.current = undefined;
            syncCursorRef.current = 0;
            socketRef.current?.send({ type: 'threads.list', requestId: createRequestId('threads') });
          }
          socketRef.current?.send({ type: 'models.list', requestId: createRequestId('models') });
          socketRef.current?.send({ type: 'prompt.queue.list', requestId: createRequestId('queue') });
          if (selectedThreadRef.current) {
            const selected = selectedThreadRef.current;
            socketRef.current?.send({
              type: 'thread.open', requestId: createRequestId('open'), threadId: selected,
              historyLimit: 20, knownTurnIds: knownTurnIds(messagesForThread(selected, messagesByThreadRef.current[selected] ?? [])),
            });
            socketRef.current?.send({ type: 'thread.diff.get', requestId: createRequestId('diff'), threadId: selected });
          }
          break;
        }
        case 'status':
          if (typeof message.desktopIpcReady === 'boolean') setDesktopIpcReady(message.desktopIpcReady);
          setCodexReady(message.codexReady);
          if (message.codexReady) {
            setPhase('connected');
            setPhaseDetail('');
            setLastError('');
            socketRef.current?.send(syncVersionRef.current
              ? { type: 'threads.sync', requestId: createRequestId('threads-sync'), knownVersion: threadIndexVersionRef.current }
              : { type: 'threads.list', requestId: createRequestId('threads') });
          } else {
            const detail = message.detail || 'Bridge 已连接，但 Codex app-server 尚未就绪';
            setPhaseDetail(detail);
            setLastError(detail);
          }
          break;
        case 'threads': {
          replaceThreadsAndSyncAttention(mergeThreadSummaries(threadsRef.current, message.threads, true, turnIdsRef.current));
          break;
        }
        case 'threads.snapshot': {
          if (message.requestId) syncChecks.current.get(message.requestId)?.(true);
          threadIndexVersionRef.current = message.version;
          replaceThreadsAndSyncAttention(mergeThreadSummaries(threadsRef.current, message.threads, true, turnIdsRef.current));
          break;
        }
        case 'threads.delta':
          if (message.requestId) syncChecks.current.get(message.requestId)?.(true);
          if (message.baseVersion !== threadIndexVersionRef.current) {
            socketRef.current?.send({ type: 'threads.sync', requestId: createRequestId('threads-resync') });
            break;
          }
          threadIndexVersionRef.current = message.version;
          replaceThreadsAndSyncAttention(mergeThreadSummaries(
            threadsRef.current.filter((thread) => !message.removedIds.includes(thread.id)),
            message.upserts,
            false, turnIdsRef.current,
          ));
          break;
        case 'archive.result':
          archiveRequests.current.get(message.requestId)?.resolve(message);
          if (message.threadId && typeof message.archived === 'boolean') {
            setQueueReceipt(message.archived ? '电脑已归档这段对话' : '电脑已恢复这段对话');
            if (message.archived) replaceThreadsAndSyncAttention(threadsRef.current.filter(thread => thread.id !== message.threadId));
            if (message.archived && selectedThreadRef.current === message.threadId) {
              socketRef.current?.send({ type: 'thread.close', threadId: message.threadId });
              selectedThreadRef.current = null;
              setSelectedThreadId(null);
            }
            socketRef.current?.send({ type: 'threads.sync', requestId: createRequestId('threads-sync') });
          }
          break;
        case 'usage.result':
          if (message.requestId === usageRequest.current) {
            cancelUsageRequest();
            setUsage(message.usage);
            setUsageStatus('');
          }
          break;
        case 'projects':
          if (message.requestId === projectRequest.current) {
            setDesktopProjects(message.projects);
            setProjectStatus(message.projects.length ? '' : '电脑还没有已添加的项目。');
          }
          break;
        case 'models': {
          setModels(message.models);
          break;
        }
        case 'skills':
          setSkills(message.skills.filter((skill) => skill.enabled));
          break;
        case 'prompt.queue': {
          const grouped: Record<string, PromptQueueItem[]> = {};
          for (const item of message.items) (grouped[item.threadId] ??= []).push(item);
          setPromptQueueByThread(grouped);
          break;
        }
        case 'prompt.desktopQueued':
          if (message.requestId) sendReceipts.current.get(message.requestId)?.(true);
          setQueueReceipt('已加入桌面队列 · ' + message.queueId.slice(-8));
          if (message.threadId === selectedThreadRef.current) setLastError('');
          break;
        case 'prompt.queued':
          if (message.requestId) sendReceipts.current.get(message.requestId)?.(true);
          setPromptQueueByThread((current) => ({
            ...current,
            [message.threadId]: dedupeQueueItems([...(current[message.threadId] ?? []), message.item]),
          }));
          break;
        case 'prompt.queue.updated':
          setPromptQueueByThread((current) => ({ ...current, [message.threadId]: message.items }));
          break;
        case 'prompt.queue.cancelled':
          setPromptQueueByThread((current) => ({
            ...current,
            [message.threadId]: (current[message.threadId] ?? []).filter((item) => item.id !== message.itemId),
          }));
          break;
        case 'thread.diff':
          setGitDiffByThread((current) => ({ ...current, [message.snapshot.threadId]: message.snapshot }));
          break;
        case 'thread.compaction.accepted':
          if (message.requestId) pendingCompactionRequestsRef.current.delete(message.requestId);
          updateCompactionStatus(message.threadId, { phase: 'requested', message: '上下文压缩请求已受理' });
          break;
        case 'thread.settings.updated': {
          const change = modelRequest.current;
          if (change && message.requestId === change.id && change.threadId === message.threadId) {
            modelRequest.current = null;
            setModelPending(false);
            const confirmed = message.settings ?? change;
            if (message.settings) {
              setThreads(current => {
                const updated = current.map(thread => thread.id === change.threadId ? { ...thread,
                  model: message.settings?.model ?? undefined,
                  effort: message.settings?.effort ?? undefined,
                  mobileSendOnly: message.settings?.mobileSendOnly === true,
                } : thread);
                threadsRef.current = updated;
                return updated;
              });
            }
            if (selectedThreadRef.current === change.threadId) {
              if (message.settings || confirmed.model) setSelectedModelState(confirmed.model ?? '');
              if (message.settings || confirmed.effort) setSelectedEffortState(confirmed.effort ?? '');
            }
          }
          const pending = message.requestId ? pendingPermissionSettingsRef.current.get(message.requestId) : undefined;
          if (message.requestId) pendingPermissionSettingsRef.current.delete(message.requestId);
          if (pending) {
            const override = permissionModeOverridesRef.current[pending.threadId];
            if (override?.requestId === message.requestId) override.expiresAt = Date.now() + 15_000;
            if (selectedThreadRef.current === pending.threadId) {
              const hasPendingApproval = approvalsRef.current.some((approval) => approval.threadId === pending.threadId);
              showPermissionModeStatus(`已应用“${permissionModeLabel(pending.mode)}”到当前任务${hasPendingApproval ? '；切换前已挂起的审批仍需单独处理' : ''}`);
            }
          }
          break;
        }
        case 'thread': {
          flushPendingMessageDeltas();
          const normalized = normalizeThreadPayload(message.thread);
          if (!normalized.thread) break;
          if (message.requestId) sendReceipts.current.get(message.requestId)?.(true);
          observeCompactionSnapshot(message.thread, normalized.thread.id);
          const latestTodo = latestPlanMessage(normalized.messages);
          if (latestTodo) setTodoByThread((current) => ({ ...current, [normalized.thread!.id]: latestTodo }));
          applyThreadSnapshot(normalized);
          const isSelectedLiveSnapshot = selectedThreadRef.current === normalized.thread.id && !message.history;
          const observedTurnId = normalized.currentTurnId ?? normalized.messages.at(-1)?.turnId;
          setMessagesByThread((current) => ({
            ...current,
            [normalized.thread!.id]: reconcileThreadSnapshot(
              current[normalized.thread!.id] ?? [], normalized.messages, normalized.thread!.id,
              isSelectedLiveSnapshot ? observedTurnId : undefined,
            ),
          }));
          if (message.history) setHistoryByThread((current) => ({
            ...current,
            [normalized.thread!.id]: { ...message.history!, loaded: true },
          }));
          if (![...olderHistoryRequests.current.values()].includes(normalized.thread.id))
            setHistoryLoadingByThread((current) => ({ ...current, [normalized.thread!.id]: false }));
          const activatesThread = consumeThreadActivationIntent(
            pendingThreadStartRequestsRef.current,
            message.requestId,
          );
          if (activatesThread) {
            setLastError('');
            setSelectedModelState(normalized.thread.model ?? '');
            setSelectedEffortState(normalized.thread.effort ?? '');
            selectedThreadRef.current = normalized.thread.id;
            setSelectedThreadId(normalized.thread.id);
          }
          if (selectedThreadRef.current === normalized.thread.id) {
            if (normalized.thread.model) setSelectedModelState(normalized.thread.model);
            if (normalized.thread.model) setSelectedEffortState(normalized.thread.effort ?? '');
            if (normalized.thread.permissionMode) applyPermissionModeSnapshot(normalized.thread.id, normalized.thread.permissionMode);
          }
          break;
        }
        case 'thread.history': {
          if (message.requestId) olderHistoryRequests.current.delete(message.requestId);
          const normalized = normalizeThreadPayload({ thread: { id: message.threadId, turns: message.turns } });
          setMessagesByThread((current) => ({
            ...current,
            [message.threadId]: reconcileMessages(current[message.threadId] ?? [], normalized.messages, 'prepend', message.threadId),
          }));
          setHistoryByThread((current) => ({ ...current, [message.threadId]: { ...message.history, loaded: true } }));
          setHistoryLoadingByThread((current) => ({ ...current, [message.threadId]: false }));
          break;
        }
        case 'turn.started': {
          if (message.requestId) sendReceipts.current.get(message.requestId)?.(true);
          if (message.requestId?.startsWith('turn_') && message.threadId === selectedThreadRef.current) setLastError('');
          const turn = record(message.turn);
          const turnId = stringValue(turn?.id, turn?.turnId);
          const submittedText = stringValue(turn?.submittedText);
          const displayedText = submittedText && (describeAsyncAnswer(submittedText)?.text ?? visibleUserText(submittedText));
          if (message.requestId) setMessagesByThread(current => ({
            ...current,
            [message.threadId]: (current[message.threadId] ?? []).map(item =>
              item.id === `local_${message.requestId}`
                ? { ...item, deliveryAcknowledged: true, deliveryState: undefined, turnId: turnId ?? item.turnId, content: displayedText ?? item.content } : item),
          }));
          if (isTerminalTurnStatus(turn?.status) || (turnId && terminalMessageTurnsRef.current.has(`${message.threadId}\u0000${turnId}`))) break;
          if (message.threadId.startsWith('antigravity:') && !isActiveTurnStatus(turn?.status)) break;
          if (turnId && turnIdsRef.current[message.threadId] === turnId) break;
          if (turnId) setCurrentTurn(message.threadId, turnId);
          updateThreadState(message.threadId, 'running', { currentTurnStartedAt: timestamp(turn?.startedAt ?? turn?.turnStartedAtMs) });
          updateAttentionNotification(message.threadId, 'running');
          break;
        }
        case 'event':
          if (message.method === 'mail/changed') {
            setMailRevision(revision => revision + 1);
          } else if (message.method === 'antigravity/threadDeleted') {
            const threadId = record(message.params)?.threadId;
            if (typeof threadId === 'string') forgetAntigravityThread(threadId);
          } else if (message.method === 'codex/accountSwitch') {
            const switching = record(message.params)?.switching;
            if (typeof switching !== 'boolean') break;
            usageSwitching.current = switching;
            cancelUsageRequest();
            setUsage(null);
            if (switching) setUsageStatus('正在切换账号，稍后自动读取新额度。');
            else refreshUsage(true);
          } else handleEvent(message.method, message.params);
          break;
        case 'approvals.snapshot': {
          const next = message.approvals.map(normalizeApproval);
          const staleIds = new Set(staleApprovalWireIds(approvalsRef.current, next).map(String));
          const stale = approvalsRef.current.filter((approval) => staleIds.has(String(approval.wireId)));
          approvalsRef.current = next;
          setApprovals(next);
          for (const approval of stale) {
            const requestId = String(approval.wireId);
            notificationGuardRef.current.invalidate(`approval:${requestId}`);
            notifiedApprovalIdsRef.current.delete(requestId);
            void queueApprovalCancellation(approval.wireId);
            if (approval.threadId && !next.some((candidate) => candidate.threadId === approval.threadId)) {
              clearThreadAttentionNotification(approval.threadId);
              if (turnIdsRef.current[approval.threadId]) updateThreadState(approval.threadId, 'running');
            }
          }
          break;
        }
        case 'approval': {
          const normalized = normalizeApproval(message.approval);
          setApprovals((current) => {
            const next = upsertById(current, normalized);
            approvalsRef.current = next;
            return next;
          });
            const attention = normalized.method === 'item/tool/requestUserInput' ? 'waiting_input' : 'waiting_approval';
            if (normalized.threadId) updateThreadState(normalized.threadId, attention);
          const notificationKey = String(message.approval.requestId);
          if (normalized.threadId) {
            notificationGuardRef.current.invalidate(`attention:${normalized.threadId}`);
            const pendingTimer = attentionNotificationTimersRef.current[normalized.threadId];
            if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
            delete attentionNotificationTimersRef.current[normalized.threadId];
              attentionStateByThreadRef.current[normalized.threadId] = attention;
            delete notifiedAttentionStateByThreadRef.current[normalized.threadId];
            // Cancel unconditionally: an older async coarse schedule may have posted before
            // its Promise callback had a chance to record notifiedAttentionState.
            void queueAttentionCancellation(normalized.threadId, 'approval');
          }
          if (!notifiedApprovalIdsRef.current.has(notificationKey)) {
            notifiedApprovalIdsRef.current.add(notificationKey);
            const ticket = notificationGuardRef.current.begin(`approval:${notificationKey}`);
            void settleGuardedNotification({
              guard: notificationGuardRef.current,
              ticket,
              queue: notificationQueueRef.current,
              operationKey: `approval:${notificationKey}`,
              schedule: () => notifyApprovalRequested(message.approval),
              isRelevant: () => approvalsRef.current.some((approval) => String(approval.wireId) === notificationKey),
              cancel: () => cancelApprovalNotification(notificationKey),
            }).then((result) => {
              if (result === 'shown') return;
              notifiedApprovalIdsRef.current.delete(notificationKey);
              if (result === 'failed') setLastError('Android 审批通知未能发送，请检查通知权限及通知分类的声音设置');
            });
          }
          break;
        }
        case 'approval.resolved': {
          const resolved = approvalsRef.current.find((approval) => approval.wireId === message.approvalRequestId);
          const remaining = approvalsRef.current.filter((approval) => approval.wireId !== message.approvalRequestId);
          approvalsRef.current = remaining;
          setApprovals(remaining);
          const resolvedNotificationKey = String(message.approvalRequestId);
          notificationGuardRef.current.invalidate(`approval:${resolvedNotificationKey}`);
          notifiedApprovalIdsRef.current.delete(resolvedNotificationKey);
          void queueApprovalCancellation(message.approvalRequestId);
          if (resolved?.threadId) {
            const stillWaiting = remaining.some((approval) => approval.threadId === resolved.threadId);
            if (stillWaiting) {
              attentionStateByThreadRef.current[resolved.threadId] = 'waiting_approval';
              updateThreadState(resolved.threadId, 'waiting_approval');
            } else {
              clearThreadAttentionNotification(resolved.threadId);
              if (turnIdsRef.current[resolved.threadId]) updateThreadState(resolved.threadId, 'running');
            }
          }
          break;
        }
        case 'error': {
          if (message.requestId?.startsWith('usage_')) {
            if (message.requestId === usageRequest.current) {
              cancelUsageRequest();
              if (message.code === 'account_switching' || message.code === 'account_unverified') setUsage(null);
              setUsageStatus(message.message || '暂时无法读取额度，可点击刷新重试。');
            }
            break;
          }
          if (message.requestId && syncChecks.current.has(message.requestId)) {
            syncChecks.current.get(message.requestId)?.(false);
            break;
          }
          if (message.requestId) sendReceipts.current.get(message.requestId)?.(false);
          const sendRefused = message.code === 'usage_limit_reached' || message.code === 'desktop_turn_active' || message.code === 'desktop_state_unconfirmed';
          if (sendRefused && message.requestId?.startsWith('turn_')) {
            const localId = `local_${message.requestId}`;
            if (message.threadId) {
              const threadId = message.threadId;
              setMessagesByThread(current => ({ ...current,
                [threadId]: (current[threadId] ?? []).filter(item => item.id !== localId || !canDiscardLocalMessage(item)),
              }));
              if (message.code === 'usage_limit_reached') {
                updateThreadState(threadId, 'quota_limited');
                setCurrentTurn(threadId);
              }
            }
            if (!message.threadId || selectedThreadRef.current === message.threadId) setLastError(message.message);
            break;
          }
          if (message.requestId?.startsWith('turn_') && message.code !== 'submission_state_unknown') {
            const localId = `local_${message.requestId}`;
            setMessagesByThread(current => {
              const entry = Object.entries(current).find(([, items]) => items.some(item => item.id === localId && canDiscardLocalMessage(item)));
              if (!entry) return current;
              const [threadId, items] = entry;
              return { ...current, [threadId]: items.map(item => item.id === localId ? { ...item, deliveryState: undefined, status: 'failed' } : item) };
            });
          }
          const historyThreadId = message.requestId && olderHistoryRequests.current.get(message.requestId);
          if (historyThreadId && message.requestId) {
            olderHistoryRequests.current.delete(message.requestId);
            setHistoryLoadingByThread(current => ({ ...current, [historyThreadId]: false }));
          }
          const archive = message.requestId && archiveRequests.current.get(message.requestId);
          if (archive) { archive.reject(new Error(message.message)); break; }
          if (message.requestId && message.requestId === projectRequest.current) {
            setProjectStatus(message.message);
            break;
          }
          if (message.requestId?.startsWith('usage_')) {
            break;
          }
          if (modelRequest.current && message.requestId === modelRequest.current.id) {
            modelRequest.current = null;
            setModelPending(false);
          }
          const permissionSetting = message.requestId ? pendingPermissionSettingsRef.current.get(message.requestId) : undefined;
          if (message.requestId) pendingPermissionSettingsRef.current.delete(message.requestId);
          if (permissionSetting) {
            const override = permissionModeOverridesRef.current[permissionSetting.threadId];
            if (override?.requestId === message.requestId) {
              delete permissionModeOverridesRef.current[permissionSetting.threadId];
              if (selectedThreadRef.current === permissionSetting.threadId) setSelectedPermissionMode(permissionSetting.previous);
            }
            showPermissionModeStatus(`权限设置失败：[${message.code}] ${message.message}`);
          }
          const compactionThreadId = message.requestId ? pendingCompactionRequestsRef.current.get(message.requestId) : undefined;
          if (message.requestId) {
            pendingCompactionRequestsRef.current.delete(message.requestId);
            pendingThreadStartRequestsRef.current.delete(message.requestId);
          }
          if (compactionThreadId) reportCompactionFailure(compactionThreadId, `[${message.code}] ${message.message}`);
          else setLastError(`[${message.code}] ${message.message}`);
          break;
        }
        case 'pong':
          break;
      }
      if (typeof message.syncCursor === 'number') syncCursorRef.current = Math.max(syncCursorRef.current, message.syncCursor);
    },
    [applyPermissionModeSnapshot, applyThreadSnapshot, cancelUsageRequest, clearThreadAttentionNotification, flushPendingMessageDeltas, forgetAntigravityThread, handleEvent, observeCompactionSnapshot, refreshUsage, replaceThreadsAndSyncAttention, reportCompactionFailure, setCurrentTurn, setSelectedPermissionMode, showPermissionModeStatus, updateAttentionNotification, updateCompactionStatus, updateThreadState],
  );
  handleMessageRef.current = handleMessage;

  useEffect(() => {
    if (!config) {
      setPhase('idle');
      return;
    }

    let cancelled = false;
    let socket: RemoteSocket | null = null;
    let appListener: { remove: () => Promise<void> } | null = null;
    cacheHydratedRef.current = false;
    const scope = cacheScope(config.serverUrl, config.pairingToken);
    cacheScopeRef.current = scope;

    setModels([]);
    cancelUsageRequest();
    usageSwitching.current = false;
    setUsage(null);
    setUsageStatus('');
    setSkills([]);
    setSelectedModelState('');
    setSelectedEffortState('');
    setSelectedPermissionMode('auto');
    setTodoByThread({});
    setPromptQueueByThread({});
    setGitDiffByThread({});
    setApprovals([]);
    approvalsRef.current = [];
    notificationGuardRef.current.reset();
    notifiedApprovalIdsRef.current.clear();
    notifiedTurnIdsRef.current.clear();
    for (const timer of Object.values(attentionNotificationTimersRef.current)) window.clearTimeout(timer);
    attentionNotificationTimersRef.current = {};
    attentionStateByThreadRef.current = {};
    notifiedAttentionStateByThreadRef.current = {};
    setTurnIds({});
    turnIdsRef.current = {};
    pendingMessageDeltasRef.current.clear();
    terminalMessageItemsRef.current.clear();
    terminalMessageTurnsRef.current.clear();
    setLastError('');
    setCompactionsByThread({});
    compactionsRef.current = {};
    compactionTurnIdsRef.current = {};
    pendingCompactionRequestsRef.current.clear();
    pendingThreadStartRequestsRef.current.clear();
    pendingPermissionSettingsRef.current.clear();
    permissionModeOverridesRef.current = {};
    showPermissionModeStatus('');
    notifiedCompactionFailuresRef.current.clear();
    seenCompactionItemsRef.current = {};

    void (async () => {
      const cached = await loadRemoteCache(scope);
      if (cancelled) return;
      if (cached) {
        setModels(Array.isArray(cached.models) ? cached.models : []);
        setThreads(cached.threads);
        threadsRef.current = cached.threads;
        setMessagesByThread(cached.messagesByThread);
        setHistoryByThread(cached.historyByThread);
        setSelectedThreadId(cached.selectedThreadId);
        selectedThreadRef.current = cached.selectedThreadId;
        const cachedThread = cached.threads.find(thread => thread.id === cached.selectedThreadId);
        setSelectedModelState(cachedThread?.model ?? '');
        setSelectedEffortState(cachedThread?.effort ?? '');
        serverIdRef.current = cached.serverId;
        syncVersionRef.current = cached.syncVersion;
        syncCursorRef.current = cached.syncCursor;
        threadIndexVersionRef.current = cached.threadIndexVersion;
      } else {
        setThreads([]);
        threadsRef.current = [];
        setMessagesByThread({});
        setHistoryByThread({});
        setSelectedThreadId(null);
        selectedThreadRef.current = null;
        serverIdRef.current = undefined;
        syncVersionRef.current = undefined;
        syncCursorRef.current = 0;
        threadIndexVersionRef.current = 0;
      }
      olderHistoryRequests.current.clear();
      setHistoryLoadingByThread({});
      cacheHydratedRef.current = true;

      socket = new RemoteSocket({
        serverUrl: config.serverUrl,
        localUrl: config.localUrl,
        onRoute: setConnectionUrl,
        token: config.pairingToken,
        onMessage: (message) => handleMessageRef.current(message),
        onResume: () => {
          refreshUsage();
          const threadId = selectedThreadRef.current;
          const syncVersion = syncVersionRef.current;
          if (syncVersion) {
            socket?.send({
              type: 'sync.resume', requestId: createRequestId('resume'), syncVersion,
              cursor: syncCursorRef.current, threadIds: threadId ? [threadId] : [],
            });
          } else if (threadId) {
            socket?.send({
              type: 'thread.open', requestId: createRequestId('open'), threadId,
              historyLimit: 20, knownTurnIds: knownTurnIds(messagesForThread(threadId, messagesByThreadRef.current[threadId] ?? [])),
            });
          }
        },
        onPhase: (nextPhase, detail) => {
          setPhase(nextPhase);
          setPhaseDetail(detail ?? '');
          if (nextPhase !== 'connected') {
            for (const finish of sendReceipts.current.values()) finish(false);
            setArchiveSupported(false);
            for (const request of archiveRequests.current.values()) request.reject(new Error('连接已断开，请重连后查看已归档列表核对。'));
            setCodexReady(false);
            modelRequest.current = null;
            setModelPending(false);
            usageSwitching.current = false;
            cancelUsageRequest();
            setUsage(null);
            setUsageStatus('电脑未连接');
          } else {
            setUsageStatus(current => current === '电脑未连接' ? '' : current);
          }
        },
      });
      socketRef.current = socket;
      socket.connect();

      appListener = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) {
          socket?.suspend();
          return;
        }
        socket?.resume();
        for (const thread of threadsRef.current) {
          if (thread.state === 'waiting_approval' || thread.state === 'waiting_input') {
            updateAttentionNotification(thread.id, thread.state);
          }
        }
      });
      if (cancelled) void appListener.remove();
    })();

    return () => {
      cancelled = true;
      cancelUsageRequest();
      for (const finish of sendReceipts.current.values()) finish(false);
      for (const request of archiveRequests.current.values()) request.reject(new Error('连接已关闭。'));
      socket?.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
      void appListener?.remove();
    };
  }, [config, cancelUsageRequest, refreshUsage, setSelectedPermissionMode, showPermissionModeStatus, updateAttentionNotification]);

  useEffect(() => {
    if (!config || !cacheHydratedRef.current || !cacheScopeRef.current) return;
    if (cacheSaveTimerRef.current !== null) window.clearTimeout(cacheSaveTimerRef.current);
    const scope = cacheScopeRef.current;
    const epoch = cacheEpochRef.current;
    cacheSaveTimerRef.current = window.setTimeout(() => {
      cacheSaveTimerRef.current = null;
      if (!cacheHydratedRef.current || epoch !== cacheEpochRef.current) return;
      const snapshot: RemoteCacheSnapshot = {
        schema: 4,
        savedAt: Date.now(),
        serverId: serverIdRef.current,
        syncVersion: syncVersionRef.current,
        syncCursor: syncCursorRef.current,
        threadIndexVersion: threadIndexVersionRef.current,
        selectedThreadId,
        threads,
        models,
        messagesByThread,
        historyByThread,
      };
      cacheWriteRef.current = cacheWriteRef.current
        .catch(() => undefined)
        .then(async () => {
          if (!cacheHydratedRef.current || epoch !== cacheEpochRef.current) return;
          await saveRemoteCache(scope, snapshot);
        });
    }, 250);
    return () => {
      if (cacheSaveTimerRef.current !== null) window.clearTimeout(cacheSaveTimerRef.current);
    };
  }, [config, historyByThread, messagesByThread, models, selectedThreadId, threads]);


  const selectThread = useCallback((threadId: string | null) => {
    const previous = selectedThreadRef.current;
    if (previous && previous !== threadId) socketRef.current?.send({ type: 'thread.close', threadId: previous });
    selectedThreadRef.current = threadId;
    setSelectedThreadId(threadId);
    const cachedThread = threadsRef.current.find(candidate => candidate.id === threadId);
    setSelectedModelState(cachedThread?.model ?? '');
    setSelectedEffortState(cachedThread?.effort ?? '');
    if (!threadId) return;
    setThreads((current) => current.map((thread) => (thread.id === threadId ? { ...thread, unread: 0 } : thread)));
    setHistoryLoadingByThread((current) => ({ ...current, [threadId]: true }));
    const sent = socketRef.current?.send({
      type: 'thread.open', requestId: createRequestId('open'), threadId,
      historyLimit: 20, knownTurnIds: knownTurnIds(messagesForThread(threadId, messagesByThreadRef.current[threadId] ?? [])),
    });
    if (!sent) setHistoryLoadingByThread((current) => ({ ...current, [threadId]: false }));
    socketRef.current?.send({ type: 'thread.diff.get', requestId: createRequestId('diff'), threadId });
    const thread = threads.find((candidate) => candidate.id === threadId);
    setSelectedModelState(thread?.model ?? '');
    setSelectedEffortState(thread?.effort ?? '');
    const override = permissionModeOverridesRef.current[threadId];
    if (override && override.expiresAt > Date.now()) setSelectedPermissionMode(override.mode);
    else setSelectedPermissionMode(thread?.permissionMode ?? 'auto');
    showPermissionModeStatus('');
    if (thread?.cwd && thread.assistant !== 'antigravity') socketRef.current?.send({ type: 'skills.list', requestId: createRequestId('skills'), cwd: thread.cwd });
  }, [setSelectedPermissionMode, showPermissionModeStatus, threads]);

  const loadOlderHistory = useCallback(() => {
    const threadId = selectedThreadRef.current;
    if (!threadId) return false;
    const history = historyByThreadRef.current[threadId];
    if (!history?.hasMore || historyLoadingByThread[threadId]
        || [...olderHistoryRequests.current.values()].includes(threadId)) return false;
    const requestId = createRequestId('history');
    const sent = socketRef.current?.send({
      type: 'thread.history', requestId, threadId,
      cursor: history.nextCursor ?? undefined, limit: 20,
      knownTurnIds: knownTurnIds(messagesForThread(threadId, messagesByThreadRef.current[threadId] ?? [])),
    });
    if (!sent) return false;
    olderHistoryRequests.current.set(requestId, threadId);
    setHistoryLoadingByThread((current) => ({ ...current, [threadId]: true }));
    return true;
  }, [historyLoadingByThread]);

  const uploadAttachments = useCallback(async (files: File[], inboxId?: string): Promise<MessageAttachment[]> => {
    if (files.length === 0 && !inboxId) return [];
    if (!config) throw new Error('请先连接电脑。');
    const serverUrl = socketRef.current?.serverUrl ?? config.serverUrl;
    const uploads = inboxId ? [await registerInboxUpload({ ...config, serverUrl }, inboxId)] : [];
    for (const file of files) {
      uploads.push(await uploadRemoteFile({
        serverUrl, token: config.pairingToken, file, fileName: file.name,
        deleteAfterTurn: deleteAttachmentsAfterTurn && attachmentCleanupRef.current,
      }));
    }
    return uploads.map(upload => ({
      type: upload.mimeType.startsWith('image/') ? 'image' : 'file',
      uploadId: upload.uploadId, fileName: upload.fileName, mimeType: upload.mimeType, localPath: upload.path,
    }));
  }, [config, deleteAttachmentsAfterTurn]);

  const waitForSendReceipt = useCallback((requestId: string, onTimeout: () => void) => new Promise<boolean>(resolve => {
    const finish = (accepted: boolean) => {
      window.clearTimeout(timer);
      sendReceipts.current.delete(requestId);
      resolve(accepted);
    };
    const timer = window.setTimeout(() => { finish(false); onTimeout(); }, 30_000);
    sendReceipts.current.set(requestId, finish);
  }), []);

  const sendMessage = useCallback(async (content: string, files: File[] = [], deliveryMode: PromptDeliveryMode = 'auto', waitForReceipt = false, inboxId?: string): Promise<boolean> => {
    const threadId = selectedThreadRef.current;
    const text = content.trim();
    if (!threadId || (!text && files.length === 0 && !inboxId)) return false;
    const antigravity = threadsRef.current.find(thread => thread.id === threadId)?.assistant === 'antigravity';
    if (antigravity && (deliveryMode !== 'auto' || (!antigravityAttachments && (files.length || inboxId)))) {
      setLastError(deliveryMode === 'auto' ? '更新电脑配套服务后即可发送 Antigravity 附件。' : '请等 Antigravity 当前轮结束后再发送。');
      return false;
    }
    if (modelRequest.current?.threadId === threadId) {
      setLastError('正在确认模型设置，请稍后再发送。');
      return false;
    }
    const expectedTurnId = deliveryMode === 'steer' ? turnIdsRef.current[threadId] : undefined;

    const appendLocalSystemMessage = (title: string, body: string) => {
      const localMessage: RemoteMessage = {
        id: `local_${title}_${Date.now()}`,
        threadId,
        role: 'system',
        content: body,
        createdAt: Date.now(),
        timestampSource: 'live',
        status: 'complete',
        toolName: title,
        collapsible: true,
      };
      setMessagesByThread((current) => ({ ...current, [threadId]: [...messagesForThread(threadId, current[threadId] ?? []), localMessage] }));
    };

    const command = antigravity ? '' : text;
    const downloadMatch = command.match(/^\/download\s+(.+)$/i);
    if (downloadMatch) {
      if (!config) return false;
      try {
        const result = await saveHostFile({ serverUrl: config.serverUrl, token: config.pairingToken }, downloadMatch[1]!.trim());
        appendLocalSystemMessage('文件下载', `${result.fileName} · ${result.size.toLocaleString('zh-CN')} bytes`);
        return true;
      } catch (error) {
        setLastError(error instanceof Error ? error.message : '文件下载失败');
        return false;
      }
    }

    if (command === '/compact') {
      const requestId = createRequestId('compact');
      pendingCompactionRequestsRef.current.set(requestId, threadId);
      updateCompactionStatus(threadId, { phase: 'requested', message: '正在请求上下文压缩', automatic: false });
      const sent = socketRef.current?.send({ type: 'thread.compact', requestId, threadId });
      if (!sent) {
        pendingCompactionRequestsRef.current.delete(requestId);
        reportCompactionFailure(threadId, '当前未连接，无法压缩上下文');
      }
      return Boolean(sent);
    }
    if (command === '/status') {
      const thread = threads.find((candidate) => candidate.id === threadId);
      const elapsed = thread?.currentTurnStartedAt ? Math.max(0, Date.now() - thread.currentTurnStartedAt) : undefined;
      appendLocalSystemMessage('会话状态', [
        `状态：${threadStateLabel(thread?.state ?? 'idle')}`,
        `目录：${thread?.cwd || '未知'}`,
        `模型：${selectedModel || '主机默认'}${selectedEffort ? ` · ${selectedEffort}` : ''}`,
        elapsed != null ? `本轮已用时：${Math.floor(elapsed / 1000)} 秒` : '',
        thread?.tokenUsage ? `Token：${thread.tokenUsage.totalTokens.toLocaleString('zh-CN')}（输入 ${thread.tokenUsage.inputTokens.toLocaleString('zh-CN')} / 输出 ${thread.tokenUsage.outputTokens.toLocaleString('zh-CN')}）` : '',
      ].filter(Boolean).join('\n'));
      return true;
    }
    if (command === '/help') {
      appendLocalSystemMessage('手机命令', [
        '/status — 状态、目录、模型、计时和 Token',
        '/compact — 压缩当前上下文',
        '/download <电脑绝对路径> — 下载允许目录内的文件',
        '输入框 ＋ — 上传图片或文件并随任务发送',
        '/models — 列出主机报告的模型',
        '/model:<id> — 切换当前任务模型',
        '/effort:<level> — 切换思考强度',
        '/skills — 列出当前目录技能',
        '/skill:<name> <任务> — 带指定技能开始一轮',
      ].join('\n'));
      return true;
    }
    if (command === '/models') {
      appendLocalSystemMessage('可用模型', models.filter((model) => !model.hidden).map((model) => `${model.model}${model.isDefault ? '（默认）' : ''} — ${model.displayName}`).join('\n') || '主机未返回模型列表');
      return true;
    }
    if (command === '/skills') {
      appendLocalSystemMessage('目录技能', skills.filter((skill) => skill.enabled).map((skill) => `${skill.name} — ${skill.shortDescription || skill.description}`).join('\n') || '当前目录没有启用的技能');
      return true;
    }

    const modelMatch = command.match(/^\/model(?::|\s+)([^\s]+)$/i);
    if (modelMatch) {
      const requested = modelMatch[1] ?? '';
      const model = models.find((candidate) => candidate.model.toLowerCase() === requested.toLowerCase() || candidate.id.toLowerCase() === requested.toLowerCase());
      if (!model) {
        setLastError(`未找到模型：${requested}`);
        return false;
      }
      const effort = model.defaultReasoningEffort ?? '';
      return changeModelSettings(model.model, effort || undefined);
    }

    const effortMatch = command.match(/^\/effort(?::|\s+)([^\s]+)$/i);
    if (effortMatch) {
      const requested = effortMatch[1] ?? '';
      const activeModel = models.find((candidate) => candidate.model === selectedModel || candidate.id === selectedModel);
      const supported = activeModel?.supportedReasoningEfforts.some((option) => option.reasoningEffort === requested);
      if (activeModel && !supported) {
        setLastError(`模型 ${activeModel.displayName || activeModel.model} 不支持思考强度：${requested}`);
        return false;
      }
      return changeModelSettings(undefined, requested);
    }

    let prompt = text;
    let skill: SkillOption | undefined;
    const skillMatch = command.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/i);
    if (skillMatch) {
      skill = skills.find((candidate) => candidate.name.toLowerCase() === skillMatch[1]?.toLowerCase());
      if (!skill) {
        setLastError(`未找到技能：${skillMatch[1]}`);
        return false;
      }
      prompt = skillMatch[2]?.trim() || `请使用 ${skill.name} 技能处理当前任务。`;
    }

    const socket = socketRef.current;
    if (!socket) {
      setLastError('当前未连接，消息没有发送');
      return false;
    }
    const requestId = createRequestId('turn');
    const clientUserMessageId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : createRequestId('message');
    const localId = `local_${requestId}`;
    const attachmentCount = files.length + Number(Boolean(inboxId));
    const showInChat = deliveryMode !== 'queue';
    const updateLocalMessage = (change: (item: RemoteMessage) => RemoteMessage | undefined) => {
      if (!showInChat) return;
      setMessagesByThread(current => {
        const items = current[threadId];
        const index = items?.findIndex(item => item.id === localId) ?? -1;
        if (!items || index < 0) return current;
        const original = items[index]!;
        const next = change(original);
        if (next === original) return current;
        return { ...current, [threadId]: [...items.slice(0, index), ...(next ? [next] : []), ...items.slice(index + 1)] };
      });
    };
    if (showInChat) {
      const asyncAnswer = describeAsyncAnswer(prompt);
      const localMessage: RemoteMessage = {
        id: localId,
        threadId,
        turnId: expectedTurnId,
        role: 'user',
        content: asyncAnswer?.text ?? (prompt || `请查看我上传的 ${attachmentCount} 个文件。`),
        ...(asyncAnswer ? { asyncAnswerIds: asyncAnswer.ids } : {}),
        createdAt: Date.now(),
        timestampSource: 'live',
        status: 'complete',
        deliveryState: attachmentCount ? 'uploading' : waitForReceipt ? 'sending' : undefined,
        detail: { clientUserMessageId },
      };
      setMessagesByThread(current => ({
        ...current, [threadId]: [...messagesForThread(threadId, current[threadId] ?? []), localMessage],
      }));
    }
    let attachments: MessageAttachment[] = [];
    if (attachmentCount) {
      try {
        attachments = await uploadAttachments(files, inboxId);
      } catch (error) {
        updateLocalMessage(() => undefined);
        if (selectedThreadRef.current === threadId) setLastError(error instanceof Error ? error.message : '文件上传失败');
        return false;
      }
    }
    const sent = socketRef.current === socket && socket.send({
      type: 'turn.start',
      requestId,
      threadId,
      text: prompt || `请查看这 ${attachments.length} 个附件。`,
      clientUserMessageId,
      deliveryMode,
      ...(expectedTurnId ? { expectedTurnId } : {}),
      ...(!antigravity && !desktopOnly && selectedModel ? { model: selectedModel } : {}),
      ...(!antigravity && !desktopOnly && selectedEffort ? { effort: selectedEffort } : {}),
      ...(skill ? { skill: { name: skill.name, path: skill.path } } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(!antigravity && !desktopOnly ? { summary: 'concise', permissionMode: selectedPermissionMode } : {}),
    });
    if (!sent) {
      updateLocalMessage(() => undefined);
      if (selectedThreadRef.current === threadId) setLastError('当前未连接，消息没有发送');
      return false;
    }
    if (attachments.length) {
      updateLocalMessage(item => ({
        ...item, attachments: optimisticAttachmentsFromUploads(attachments), deliveryState: waitForReceipt ? 'sending' : undefined,
      }));
    }
    if (!waitForReceipt) {
      if (showInChat) updateThreadState(threadId, 'running');
      return true;
    }
    const accepted = await waitForSendReceipt(requestId, () => {
      if (selectedThreadRef.current === threadId) setLastError('未收到电脑发送回执，草稿已保留。请先查看对话再重发。');
    });
    updateLocalMessage(item => item.deliveryState === 'sending'
      ? { ...item, deliveryState: accepted ? undefined : 'unconfirmed' }
      : item);
    return accepted;
  }, [antigravityAttachments, changeModelSettings, desktopOnly, config, models, reportCompactionFailure, selectedEffort, selectedModel, selectedPermissionMode, skills, threads, updateCompactionStatus, updateThreadState, uploadAttachments, waitForSendReceipt]);

  const refreshGitDiff = useCallback(() => {
    const threadId = selectedThreadRef.current;
    if (threadId) socketRef.current?.send({ type: 'thread.diff.get', requestId: createRequestId('diff'), threadId });
  }, []);

  const discardLocalMessage = useCallback((threadId: string, messageId: string) => {
    setMessagesByThread(current => ({
      ...current,
      [threadId]: (current[threadId] ?? []).filter(item => item.id !== messageId || !canDiscardLocalMessage(item)),
    }));
  }, []);

  const resumePromptQueue = useCallback(() => {
    const threadId = selectedThreadRef.current;
    if (threadId) socketRef.current?.send({ type: 'prompt.queue.resume', requestId: createRequestId('queue-resume'), threadId });
  }, []);

  const cancelQueuedPrompt = useCallback((itemId: string) => {
    socketRef.current?.send({ type: 'prompt.queue.cancel', requestId: createRequestId('queue-cancel'), itemId });
  }, []);

  const promoteQueuedPrompt = useCallback((itemId: string) => {
    socketRef.current?.send({ type: 'prompt.queue.promote', requestId: createRequestId('queue-promote'), itemId });
  }, []);

  const interrupt = useCallback(() => {
    const threadId = selectedThreadRef.current;
    if (!threadId) return;
    const turnId = turnIds[threadId];
    if (!turnId) {
      setLastError('尚未收到当前 turnId，暂时无法中断');
      return;
    }
    const sent = socketRef.current?.send({
      type: 'turn.interrupt',
      requestId: createRequestId('interrupt'),
      threadId,
      turnId,
    });
    if (!sent) setLastError('连接已断开，重新连接后再停止。');
  }, [turnIds]);

  const resolveApproval = useCallback((approvalId: string, decision: ApprovalDecision) => {
    const approval = approvals.find((candidate) => candidate.id === approvalId);
    if (!approval) return;
    const sent = socketRef.current?.send({
      type: 'approval.resolve',
      requestId: createRequestId('approval'),
      approvalRequestId: approval.wireId,
      decision,
    });
    if (!sent) setLastError('连接已断开，待办仍保留。');
  }, [approvals]);

  const startThread = useCallback(async (cwd: string, model?: string, modelProvider?: string, prompt?: string, destination?: 'projectless' | 'newProject', projectName?: string, assistant: Assistant = 'codex', files: File[] = []) => {
    const normalizedCwd = cwd.trim();
    if (!destination && !isAbsoluteHostPath(normalizedCwd)) {
      setLastError('工作目录必须是电脑上的绝对路径');
      return false;
    }
    let attachments: MessageAttachment[];
    try { attachments = await uploadAttachments(files); }
    catch (error) { setLastError(error instanceof Error ? error.message : '文件上传失败'); return false; }
    const requestId = createRequestId('thread');
    pendingThreadStartRequestsRef.current.add(requestId);
    const sent = socketRef.current?.send({
      type: 'thread.start',
      prompt: prompt || (attachments.length ? `请查看这 ${attachments.length} 个附件。` : prompt),
      requestId,
      ...(assistant === 'antigravity' ? { assistant } : mobileManagedSupportedRef.current ? { mobileManaged: true } : {}),
      ...(destination ? { destination, projectName } : { cwd: normalizedCwd }),
      ...(model?.trim() ? { model: model.trim() } : {}),
      ...(modelProvider?.trim() ? { modelProvider: modelProvider.trim() } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    if (!sent) pendingThreadStartRequestsRef.current.delete(requestId);
    if (sent && assistant === 'antigravity') {
      return waitForSendReceipt(requestId, () => {
        pendingThreadStartRequestsRef.current.delete(requestId);
        setLastError('未收到新聊天回执，请先检查项目列表。');
      });
    }
    return Boolean(sent);
  }, [uploadAttachments, waitForSendReceipt]);

  const selectModel = useCallback((modelId: string) => {
    if (selectedThreadRef.current?.startsWith('antigravity:')) {
      changeModelSettings(modelId);
      return;
    }
    const model = models.find(option => option.model === modelId);
    if (model) changeModelSettings(model.model, model.defaultReasoningEffort || undefined);
  }, [models, changeModelSettings]);

  const selectEffort = useCallback((effort: string) => {
    changeModelSettings(undefined, effort);
  }, [changeModelSettings]);

  const selectPermissionMode = useCallback((permissionMode: PermissionMode) => {
    const threadId = selectedThreadRef.current;
    if (!threadId) return;
    const previous = selectedPermissionModeRef.current;
    const requestId = createRequestId('permission-settings');
    setSelectedPermissionMode(permissionMode);
    pendingPermissionSettingsRef.current.set(requestId, { threadId, mode: permissionMode, previous });
    permissionModeOverridesRef.current[threadId] = {
      requestId,
      mode: permissionMode,
      expiresAt: Date.now() + 15_000,
    };
    showPermissionModeStatus(`正在应用“${permissionModeLabel(permissionMode)}”…`, false);
    const sent = socketRef.current?.send({
      type: 'thread.settings',
      requestId,
      threadId,
      permissionMode,
    });
    if (!sent) {
      pendingPermissionSettingsRef.current.delete(requestId);
      delete permissionModeOverridesRef.current[threadId];
      setSelectedPermissionMode(previous);
      showPermissionModeStatus('权限设置失败：当前未连接');
    }
  }, [setSelectedPermissionMode, showPermissionModeStatus]);

  const loadHostAttachment = useCallback(async (path: string, signal?: AbortSignal) => {
    if (!config) throw new Error('尚未配置 Host 连接。');
    const primary = fileServerUrl(config.serverUrl);
    const current = fileServerUrl(socketRef.current?.serverUrl ?? primary);
    const route = (serverUrl: string, timeout: number) => downloadHostFile({ serverUrl, token: config.pairingToken }, path,
      signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout));
    try {
      const result = await route(current, current === primary ? 22000 : 5000).catch(error => {
        if (current === primary || signal?.aborted) throw error;
        return route(primary, 22000);
      });
      return { ...result, url: URL.createObjectURL(result.blob) };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && /file does not exist|no longer available/i.test(error.message))
        throw new Error('电脑上的原文件已移除。');
      throw new Error('图片暂时无法加载，请重试。');
    }
  }, [config]);

  const downloadHostAttachment = useCallback(async (path: string) => {
    if (!config) return;
    try {
      await saveHostFile({ serverUrl: socketRef.current?.serverUrl ?? config.serverUrl, token: config.pairingToken }, path);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : '附件下载失败');
    }
  }, [config]);

  const fullRefresh = useCallback(async () => {
    if (cacheSaveTimerRef.current !== null) {
      window.clearTimeout(cacheSaveTimerRef.current);
      cacheSaveTimerRef.current = null;
    }
    cacheHydratedRef.current = false;
    cacheEpochRef.current += 1;
    await cacheWriteRef.current.catch(() => undefined);
    await clearRemoteCache();

    setThreads([]);
    threadsRef.current = [];
    setMessagesByThread({});
    messagesByThreadRef.current = {};
    setHistoryByThread({});
    historyByThreadRef.current = {};
    olderHistoryRequests.current.clear();
    setHistoryLoadingByThread({});
    setTodoByThread({});
    setPromptQueueByThread({});
    setGitDiffByThread({});
    setApprovals([]);
    approvalsRef.current = [];
    notificationGuardRef.current.reset();
    notifiedApprovalIdsRef.current.clear();
    notifiedTurnIdsRef.current.clear();
    for (const timer of Object.values(attentionNotificationTimersRef.current)) window.clearTimeout(timer);
    attentionNotificationTimersRef.current = {};
    attentionStateByThreadRef.current = {};
    notifiedAttentionStateByThreadRef.current = {};
    setTurnIds({});
    turnIdsRef.current = {};
    itemStartedAtRef.current = {};
    setCompactionsByThread({});
    compactionsRef.current = {};
    compactionTurnIdsRef.current = {};
    pendingCompactionRequestsRef.current.clear();
    pendingThreadStartRequestsRef.current.clear();
    pendingPermissionSettingsRef.current.clear();
    permissionModeOverridesRef.current = {};
    showPermissionModeStatus('');
    notifiedCompactionFailuresRef.current.clear();
    seenCompactionItemsRef.current = {};
    serverIdRef.current = undefined;
    syncVersionRef.current = undefined;
    syncCursorRef.current = 0;
    threadIndexVersionRef.current = 0;
    cacheHydratedRef.current = true;
    setPhaseDetail('本地缓存已清空，正在从 Host 全量重新载入');
    socketRef.current?.reconnectNow();
  }, [showPermissionModeStatus]);

  const reconnect = useCallback(() => socketRef.current?.reconnectNow(), []);
  const dismissError = useCallback(() => setLastError(''), []);
  const dismissCompaction = useCallback((threadId: string) => {
    setCompactionsByThread((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      compactionsRef.current = next;
      return next;
    });
  }, []);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const selectedMessagesSelectorRef = useRef<SelectedMessagesSelector | null>(null);
  if (!selectedMessagesSelectorRef.current) selectedMessagesSelectorRef.current = createSelectedMessagesSelector();
  const selectedMessages = selectedMessagesSelectorRef.current(selectedThreadId, messagesByThread, todoByThread);
  const selectedCompaction = selectedThreadId ? (compactionsByThread[selectedThreadId] ?? null) : null;
  const selectedPromptQueue = selectedThreadId ? (promptQueueByThread[selectedThreadId] ?? []) : [];
  const selectedGitDiff = selectedThreadId ? (gitDiffByThread[selectedThreadId] ?? null) : null;
  const selectedSubagents = useMemo(
    () => selectedThreadId ? threads.filter((thread) => thread.parentThreadId === selectedThreadId) : [],
    [selectedThreadId, threads],
  );
  const selectedApprovals = useMemo(
    () => approvals.filter(approval => approval.threadId === selectedThreadId || (!approval.threadId && selectedThread?.assistant !== 'antigravity')),
    [approvals, selectedThreadId, selectedThread?.assistant],
  );
  const running = selectedThread?.state === 'running' || selectedThread?.state === 'waiting_input' || selectedThread?.state === 'waiting_approval';
  const isAntigravity = selectedThread?.assistant === 'antigravity';
  const canSteer = isAntigravity ? false : selectedThread?.mobileManaged ? selectedThread.mobileRuntimeActive === true && codexReady
    : !(desktopOnly && desktopIpcReady === false);
  const canInterrupt = (canSteer || isAntigravity) && Boolean(selectedThreadId && turnIds[selectedThreadId]);

  const threadAttention = useMemo(() => Object.fromEntries(threads.flatMap(thread => {
    const target = attentionForThread(thread, approvals, promptQueueByThread[thread.id] ?? [],
      thread.mobileManaged ? pendingAsyncQuestions(messagesByThread[thread.id] ?? [])[0]?.id : undefined,
      thread.assistant !== 'antigravity' && desktopOnly && !thread.mobileManaged && desktopIpcReady === false);
    return target ? [[thread.id, target]] : [];
  })), [threads, approvals, promptQueueByThread, messagesByThread, desktopOnly, desktopIpcReady]);

  return {
    phase,
    phaseDetail,
    mailRevision,
    connectionUrl: phase === 'connected' ? connectionUrl : '',
    hostVersion: phase === 'connected' ? hostVersion : '',
    checkConversationSync,
    threadAttention,
    codexReady,
    desktopOnly,
    antigravityAvailable,
    antigravityAttachments,
    canSteer,
    archiveSupported, archiveRequest, deleteAntigravityThread, renameThread,
    desktopProjectMenus, desktopProjects, projectStatus, refreshProjects, serverId: serverIdRef.current,
    usage, usageStatus, refreshUsage, modelPending,
    queueReceipt,
    dismissReceipt: () => setQueueReceipt(''),
    models,
    skills,
    selectedModel,
    selectedEffort,
    selectedPermissionMode,
    permissionModeStatus,
    threads,
    selectedThread,
    selectedThreadId,
    selectedMessages,
    selectedHistory: selectedThreadId ? (historyByThread[selectedThreadId] ?? null) : null,
    historyLoading: selectedThreadId ? Boolean(historyLoadingByThread[selectedThreadId]) : false,
    selectedCompaction,
    selectedPromptQueue,
    selectedGitDiff,
    selectedSubagents,
    selectedTurnId: selectedThreadId ? turnIds[selectedThreadId] : undefined,
    selectedApprovals,
    running,
    canInterrupt,
    lastError,
    selectThread,
    loadOlderHistory,
    sendMessage,
    discardLocalMessage,
    cancelQueuedPrompt,
    promoteQueuedPrompt,
    resumePromptQueue,
    refreshGitDiff,
    loadHostAttachment,
    downloadHostAttachment,
    interrupt,
    resolveApproval,
    startThread,
    selectModel,
    selectEffort,
    selectPermissionMode,
    reconnect,
    fullRefresh,
    dismissError,
    dismissCompaction,
  };
}

export function dedupeQueueItems(items: PromptQueueItem[]): PromptQueueItem[] {
  const byClientId = new Map<string, PromptQueueItem>();
  for (const item of items) byClientId.set(`${item.threadId}:${item.clientUserMessageId}`, item);
  return [...byClientId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function shouldApplyPermissionModeSnapshot(
  snapshotMode: PermissionMode,
  override: { mode: PermissionMode; expiresAt: number } | undefined,
  now: number,
): boolean {
  return !override || override.expiresAt <= now || override.mode === snapshotMode;
}

export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'granular': return '严格确认';
    case 'read-only': return '严格审阅 · 只读';
    case 'guardian-approvals': return '替我审阅';
    case 'full-access': return '完全访问';
    default: return '自动 · 工作区';
  }
}

export function threadStateLabel(state: ThreadState): string {
  switch (state) {
    case 'running':
      return '执行中';
    case 'waiting_approval':
      return '待审批';
    case 'waiting_input':
      return '待输入';
    case 'error':
      return '异常';
    case 'quota_limited':
      return '额度达上限';
    case 'idle':
      return '可继续';
    case 'not_loaded':
      return '未载入';
    default:
      return '等待同步';
  }
}
