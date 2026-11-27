import { memo, useEffect, useState } from 'react';
import type { RemoteAttachment, RemoteMessage } from '../types/protocol';
import { DiffView } from './DiffView';
import { Markdown } from './Markdown';
import { ChevronRightIcon } from './Icons';
import { canDiscardLocalMessage } from '../hooks/useRemote';

export function displayTime(timestamp: number, source?: RemoteMessage['timestampSource']): string {
  if (!source || source === 'turn' || !timestamp || timestamp <= 0) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const formatted = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
  return source === 'observed' ? `≈${formatted}` : formatted;
}

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs < 0) return '';
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}分${seconds}秒`;
}

function rawDetail(detail: unknown): string {
  if (detail == null) return '';
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function RawEventDetails({ detail }: { detail: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="raw-event" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>原始事件</summary>
      {open && <pre><code>{rawDetail(detail)}</code></pre>}
    </details>
  );
}

function firstLine(content: string): string {
  return content.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}


interface LoadedAttachment {
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
}

type AttachmentLoader = (path: string, signal?: AbortSignal) => Promise<LoadedAttachment>;

function AttachmentView({ attachment, onLoad, onDownload }: {
  attachment: RemoteAttachment;
  onLoad?: AttachmentLoader;
  onDownload?: (path: string) => void;
}) {
  const [loaded, setLoaded] = useState<LoadedAttachment | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attachment.type !== 'image' || !onLoad) return;
    const controller = new AbortController();
    let objectUrl = '';
    setLoaded(null);
    setError('');
    onLoad(attachment.path, controller.signal).then((result) => {
      if (controller.signal.aborted) { URL.revokeObjectURL(result.url); return; }
      objectUrl = result.url;
      setLoaded(result);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '图片加载失败');
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment.path, attachment.type, onLoad, attempt]);

  if (attachment.type === 'image') {
    return (
      <figure className="message-attachment message-image-attachment">
        {error ? <div className="attachment-loading" role="status"><span>{error}</span>
          <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重试</button>
        </div> : loaded ? <img src={loaded.url} alt={attachment.name} onError={() => setError('无法显示这张图片。')} />
          : <div className="attachment-loading" role="status">{onLoad ? '正在加载图片…' : '图片预览不可用。'}</div>}
        <figcaption><span>{attachment.name}</span><button type="button" onClick={() => onDownload?.(attachment.path)}>下载</button></figcaption>
      </figure>
    );
  }
  return (
    <button className="message-attachment message-file-attachment" type="button" onClick={() => onDownload?.(attachment.path)}>
      <span>文件</span><strong>{attachment.name}</strong><small>下载</small>
    </button>
  );
}

function AttachmentGallery({ message, onLoad, onDownload }: {
  message: RemoteMessage;
  onLoad?: AttachmentLoader;
  onDownload?: (path: string) => void;
}) {
  if (!message.attachments?.length) return null;
  return <div className="message-attachments">{message.attachments.map((attachment) => (
    <AttachmentView key={attachment.path} attachment={attachment} onLoad={onLoad} onDownload={onDownload} />
  ))}</div>;
}

interface MessageBubbleProps {
  assistantName?: string;
  onDiscardLocalMessage?: (threadId: string, messageId: string) => void;
  message: RemoteMessage;
  agentTargets?: Array<{ id: string; label: string; state: string }>;
  onOpenAgent?: (agentId: string) => void;
  onLoadAttachment?: AttachmentLoader;
  onDownloadAttachment?: (path: string) => void;
}

function sameAgentTargets(left: MessageBubbleProps['agentTargets'], right: MessageBubbleProps['agentTargets']): boolean {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((agent, index) => {
    const other = right?.[index];
    return agent.id === other?.id && agent.label === other.label && agent.state === other.state;
  });
}

function sameAttachments(left: RemoteMessage['attachments'], right: RemoteMessage['attachments']): boolean {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((attachment, index) => {
    const other = right?.[index];
    return attachment.path === other?.path && attachment.name === other.name
      && attachment.type === other.type && attachment.mimeType === other.mimeType;
  });
}

export function messageBubblePropsEqual(previous: MessageBubbleProps, next: MessageBubbleProps): boolean {
  const left = previous.message;
  const right = next.message;
  const messageEqual = left === right || (
    left.id === right.id && left.role === right.role && left.content === right.content
    && left.status === right.status && left.createdAt === right.createdAt
    && left.timestampSource === right.timestampSource
    && left.completedAt === right.completedAt && left.durationMs === right.durationMs
    && left.assistantPhase === right.assistantPhase && left.itemType === right.itemType && left.toolName === right.toolName
    && left.collapsible === right.collapsible && left.detail === right.detail
    && sameAttachments(left.attachments, right.attachments)
  );
  return messageEqual && sameAgentTargets(previous.agentTargets, next.agentTargets)
    && previous.assistantName === next.assistantName
    && left.deliveryAcknowledged === right.deliveryAcknowledged
    && previous.onDiscardLocalMessage === next.onDiscardLocalMessage
    && previous.onOpenAgent === next.onOpenAgent
    && previous.onLoadAttachment === next.onLoadAttachment
    && previous.onDownloadAttachment === next.onDownloadAttachment;
}

export const MessageBubble = memo(function MessageBubble({ message, agentTargets = [], onOpenAgent, onLoadAttachment, onDownloadAttachment, onDiscardLocalMessage, assistantName = 'Codex' }: MessageBubbleProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const normalizedType = message.itemType?.toLowerCase() ?? '';
  const normalizedName = message.toolName?.toLowerCase() ?? '';
  const isSubagent = normalizedType.includes('subagent')
    || normalizedType.includes('collabagent')
    || normalizedName.includes('subagent');
  const isProgress = message.role === 'assistant' && message.assistantPhase === 'commentary';
  const author = isProgress ? '进度说明' : isUser ? '你' : isTool ? message.toolName || '工具' : message.role === 'system' ? message.toolName || '系统' : assistantName;
  const duration = formatDuration(message.durationMs);
  const isDiff = message.toolName === '本轮 Diff' || /^diff --git /m.test(message.content);
  const inspectable = message.collapsible || isTool || isSubagent;
  const eventPreview = isSubagent
    ? (agentTargets.length > 0 ? '' : '查看 Subagent 活动')
    : (firstLine(message.content) || '查看详情');
  const body = () => <>
    {isDiff
      ? <DiffView diff={message.content} />
      : isTool
        ? <pre><code>{message.content}</code></pre>
        : <Markdown content={message.content} hideDesktopDirectives={message.role === 'assistant'} />}
    <AttachmentGallery message={message} onLoad={onLoadAttachment} onDownload={onDownloadAttachment} />
  </>;

  return (
    <article className={`message-row role-${message.role} ${isProgress ? 'is-progress' : ''} ${isSubagent ? 'is-subagent' : ''} ${message.status === 'failed' ? 'is-failed' : ''}`}>
      <div className="message-column">
        {inspectable ? (
          <details
            className={`message-detail-card ${message.status === 'streaming' ? 'is-streaming' : ''}`}
            open={detailsOpen}
            onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
          >
            <summary>
              <ChevronRightIcon className="event-disclosure" />
              <span className="event-kind">{isSubagent ? 'Agent' : isDiff ? 'Diff' : '工具'}</span>
              <span className="event-summary">
                <strong>{author}</strong>
                {eventPreview && <small>{eventPreview}</small>}
                {agentTargets.length > 0 && (
                  <span className="message-agent-actions" aria-label="此工具调用关联的 Subagent">
                    {agentTargets.map((agent) => (
                      <button
                        className="message-agent-button"
                        key={agent.id}
                        type="button"
                        title={`打开 ${agent.label}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onOpenAgent?.(agent.id);
                        }}
                      >
                        <span className="message-agent-dot" aria-hidden="true" />
                        <strong>{agent.label}</strong>
                      </button>
                    ))}
                  </span>
                )}
              </span>
              <span className="message-meta">
                {duration && <span>{duration}</span>}
                {message.status === 'failed' && <span className="failed-label">失败</span>}
                <time>{displayTime(message.createdAt, message.timestampSource)}</time>
              </span>
            </summary>
            {detailsOpen && <div className="message-detail-content">{body()}</div>}
            {detailsOpen && message.detail != null && <RawEventDetails detail={message.detail} />}
            {message.status === 'streaming' && <span className="typing-caret" />}
          </details>
        ) : (
          <>
            <header className="message-label">
              <strong>{author}</strong>
              <span className="message-meta">
                <time>{displayTime(message.createdAt, message.timestampSource)}</time>
                {duration && <span>{duration}</span>}
                {message.status === 'failed' && <span className="failed-label">失败</span>}
              </span>
            </header>
            <div className={`message-bubble ${message.status === 'streaming' ? 'is-streaming' : ''}`}>
              {body()}
              {message.status === 'streaming' && <span className="typing-caret" />}
            </div>
            {onDiscardLocalMessage && canDiscardLocalMessage(message) &&
              <button type="button" className="secondary-button message-delete-local"
                onClick={() => onDiscardLocalMessage(message.threadId, message.id)}>删除本地消息</button>}
          </>
        )}
      </div>
    </article>
  );
}, messageBubblePropsEqual);
