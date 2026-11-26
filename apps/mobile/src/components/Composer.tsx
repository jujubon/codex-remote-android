import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ModelOption, SkillOption } from '../types/protocol';
import { clearSentComposerDraft, onComposerDraftSent, readComposerDraft, saveComposerDraft } from '../lib/composerDraft';
import { CloseIcon, PlusIcon, SendIcon, StopIcon } from './Icons';
import type { InboxFile } from '../lib/deviceTools';
import { AttachmentDraftPreview, isImageFile, type AttachmentDraft } from './AttachmentDraftPreview';
import { emptyAttachmentDraft, onAttachmentDraftChange, readAttachmentDraft, saveAttachmentDraft } from '../lib/attachmentDrafts';

export type DeliveryMode = 'auto' | 'steer' | 'queue';

export function effectiveDeliveryMode(running: boolean, selectedMode: DeliveryMode, canSteer = true): DeliveryMode {
  if (!running) return 'auto';
  return !canSteer || selectedMode === 'queue' ? 'queue' : 'steer';
}

export function shouldSubmitComposerShortcut(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }): boolean {
  return event.key === 'Enter' && !event.isComposing && Boolean(event.ctrlKey || event.metaKey);
}

interface CommandOption {
  value: string;
  title: string;
  description: string;
  group: '命令' | '模型' | '技能';
}

interface ComposerProps {
  draftKey: string;
  connected: boolean;
  running: boolean;
  canInterrupt: boolean;
  canSteer?: boolean;
  models: ModelOption[];
  skills: SkillOption[];
  inboxFile?: InboxFile;
  loadInboxPreview: (id: string, signal: AbortSignal) => Promise<Blob>;
  onClearInboxFile: (id: string) => void;
  onSend: (content: string, files: File[] | undefined, deliveryMode: DeliveryMode, waitForReceipt?: boolean, inboxId?: string) => Promise<boolean> | boolean;
  onInterrupt: () => void;
}

export function Composer({ draftKey, connected, running, onSend, onInterrupt, canInterrupt, canSteer = true, models, skills, inboxFile: selectedInboxFile, loadInboxPreview, onClearInboxFile }: ComposerProps) {
  const [content, setContent] = useState(() => readComposerDraft(draftKey));
  const [attachmentDraft, setAttachmentDraft] = useState(emptyAttachmentDraft);
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState('');
  const { files, inbox: inboxFile } = attachmentDraft;
  const [preview, setPreview] = useState<AttachmentDraft | null>(null);
  const hasAttachments = files.length > 0 || Boolean(inboxFile);
  const [sending, setSending] = useState(false);
  const [selectedDeliveryMode, setSelectedDeliveryMode] = useState<DeliveryMode>('auto');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [multiline, setMultiline] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);

  useEffect(() => onComposerDraftSent(draftKey, () => setContent('')), [draftKey]);
  useEffect(() => {
    let active = true;
    const stop = onAttachmentDraftChange(draftKey, setAttachmentDraft);
    void readAttachmentDraft(draftKey).then(draft => { if (active) setAttachmentDraft(draft); })
      .catch(() => { if (active) setDraftError('暂时无法读取附件草稿。'); })
      .finally(() => { if (active) setDraftReady(true); });
    return () => { active = false; stop(); };
  }, [draftKey]);
  useEffect(() => {
    if (!draftReady || !selectedInboxFile) return;
    if (selectedInboxFile.id !== inboxFile?.id) updateAttachments({ files, inbox: selectedInboxFile });
    onClearInboxFile(selectedInboxFile.id);
  }, [draftReady, files, inboxFile?.id, selectedInboxFile]);

  function updateAttachments(draft: typeof attachmentDraft) {
    setDraftError('');
    void saveAttachmentDraft(draftKey, draft).catch(() => setDraftError('附件暂时只能保留在本次打开的 App 里。'));
  }

  useEffect(() => {
    setSelectedDeliveryMode(running ? 'steer' : 'auto');
  }, [running]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const measure = measureRef.current;
    if (!textarea || !measure) return;
    const fit = () => {
      const multiple = measure.scrollHeight > parseFloat(getComputedStyle(measure).lineHeight);
      if (multiple !== multiline) {
        setMultiline(multiple);
        return;
      }
      textarea.style.height = '0px';
      const maximum = parseFloat(getComputedStyle(textarea).maxHeight);
      textarea.style.height = `${Math.min(textarea.scrollHeight, maximum)}px`;
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(measure);
    return () => resize.disconnect();
  }, [content, multiline]);

  const commandOptions = useMemo<CommandOption[]>(() => [
    { value: '/status', title: '/status', description: '查看状态、目录、模型与计时', group: '命令' },
    { value: '/compact', title: '/compact', description: '压缩当前任务上下文', group: '命令' },
    { value: '/download ', title: '/download <路径>', description: '从电脑下载允许目录内的文件', group: '命令' },
    { value: '/help', title: '/help', description: '显示手机端支持的命令', group: '命令' },
    { value: '/models', title: '/models', description: '列出可用模型', group: '命令' },
    { value: '/skills', title: '/skills', description: '列出当前目录可用技能', group: '命令' },
    ...models.filter((model) => !model.hidden).map((model) => ({
      value: `/model:${model.model}`,
      title: `/model:${model.model}`,
      description: model.description || model.displayName,
      group: '模型' as const,
    })),
    ...skills.filter((skill) => skill.enabled).map((skill) => ({
      value: `/skill:${skill.name} `,
      title: `/skill:${skill.name}`,
      description: skill.shortDescription || skill.description || '使用此技能执行任务',
      group: '技能' as const,
    })),
  ], [models, skills]);

  const suggestions = useMemo(() => {
    if (!content.startsWith('/') || content.includes('\n')) return [];
    const query = content.toLowerCase();
    return commandOptions.filter((option) =>
      option.title.toLowerCase().includes(query) || option.description.toLowerCase().includes(query.slice(1)),
    ).slice(0, 8);
  }, [commandOptions, content]);

  const deliveryMode = effectiveDeliveryMode(running, selectedDeliveryMode, canSteer);

  function changeContent(value: string) {
    setContent(value);
    saveComposerDraft(draftKey, value);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!connected || !draftReady || sendingRef.current || sending || (!content.trim() && !hasAttachments)) return;
    sendingRef.current = true;
    setSending(true);
    try {
      if (await onSend(content, files, deliveryMode, true, inboxFile?.id)) {
        clearSentComposerDraft(draftKey, content);
        setContent('');
        const latest = await readAttachmentDraft(draftKey).catch(() => attachmentDraft);
        updateAttachments({
          files: latest.files.filter(file => !files.includes(file)),
          inbox: latest.inbox?.id === inboxFile?.id ? undefined : latest.inbox,
        });
        if (deliveryMode === 'queue') setSelectedDeliveryMode('steer');
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function chooseCommand(value: string) {
    changeContent(value);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(value.length, value.length);
    });
  }

  const placeholder = sending
    ? '正在发送…'
    : !connected ? '等待重新连接…'
      : '给 Codex 发消息…';
  const sendLabel = deliveryMode === 'queue' ? '排队' : deliveryMode === 'steer' ? '引导' : '发送';

  return (
    <div className="composer-shell">
      {running && (
        <div className="composer-running-controls">
          <div className="delivery-mode-picker" role="group" aria-label="运行中消息发送方式">
            <button
              type="button"
              className={deliveryMode === 'steer' ? 'is-selected' : ''}
              aria-pressed={deliveryMode === 'steer'}
              onClick={() => setSelectedDeliveryMode('steer')}
              disabled={sending || !canSteer}
            >
              <strong>引导当前</strong>
            </button>
            <button
              type="button"
              className={`queue-mode-option${deliveryMode === 'queue' ? ' is-selected' : ''}`}
              aria-pressed={deliveryMode === 'queue'}
              onClick={() => setSelectedDeliveryMode('queue')}
              disabled={sending}
            >
              <strong>排队下一轮</strong>
            </button>
          </div>
          <button className="interrupt-button" type="button" onClick={onInterrupt} disabled={!canInterrupt || sending}>
            <StopIcon /> <span>停止</span>
          </button>
        </div>
      )}
      {draftError && <p className="attachment-draft-status" role="status">{draftError}</p>}
      {suggestions.length > 0 && (
        <div className="command-palette" role="listbox" aria-label="斜杠命令">
          {suggestions.map((option) => (
            <button key={option.value} type="button" onClick={() => chooseCommand(option.value)}>
              <span className="command-kind">{option.group}</span>
              <span className="command-copy"><strong>{option.title}</strong><small>{option.description}</small></span>
            </button>
          ))}
        </div>
      )}
      {hasAttachments && (
        <div className="attachment-strip">
          {inboxFile && <div className="attachment-chip">
            <button className="attachment-chip-body" type="button" aria-label={`预览 ${inboxFile.fileName}`}
              onClick={() => setPreview({ name: inboxFile.fileName, size: inboxFile.size,
                loadImage: isImageFile(inboxFile.fileName) ? signal => loadInboxPreview(inboxFile.id, signal) : undefined })}>
              <span>收件箱</span><strong>{inboxFile.fileName}</strong>
            </button>
            <button className="attachment-chip-remove" type="button" disabled={sending} onClick={() => updateAttachments({ files })}
              aria-label={`移除 ${inboxFile.fileName}`}><CloseIcon /></button>
          </div>}
          {files.map((file, index) => (
            <div className="attachment-chip" key={`${file.name}:${file.size}:${index}`}>
              <button className="attachment-chip-body" type="button" aria-label={`预览 ${file.name}`}
                onClick={() => setPreview({ name: file.name, size: file.size, file })}>
                <span>{isImageFile(file.name, file.type) ? '图片' : '文件'}</span><strong>{file.name}</strong>
              </button>
              <button className="attachment-chip-remove" type="button" disabled={sending} aria-label={`移除 ${file.name}`}
                onClick={() => updateAttachments({ files: files.filter((_, itemIndex) => itemIndex !== index), inbox: inboxFile })}><CloseIcon /></button>
            </div>
          ))}
        </div>
      )}
      {preview && <AttachmentDraftPreview draft={preview} onClose={() => setPreview(null)} />}
      <form className={`composer${multiline ? ' composer-multiline' : ''}`} onSubmit={(event) => void submit(event)}>
        <div ref={measureRef} className="composer-measure" aria-hidden="true">{content}{'\u200b'}</div>
        <input
          ref={fileInputRef}
          className="file-picker-input"
          type="file"
          multiple
          onChange={(event) => {
            const selected = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (selected.length) updateAttachments({ files: [...files, ...selected], inbox: inboxFile });
          }}
          disabled={!connected || sending || !draftReady}
        />
        <button className="attach-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={!connected || sending || !draftReady} aria-label="上传图片或文件" title="可选择多个附件"><PlusIcon /></button>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => changeContent(event.target.value)}
          onKeyDown={(event) => {
            if (shouldSubmitComposerShortcut({
              key: event.key,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              isComposing: event.nativeEvent.isComposing,
            })) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          aria-label="消息"
          rows={1}
          disabled={!connected || sending}
        />
        <button
          className={`send-button send-mode-${deliveryMode}`}
          type="submit"
          disabled={!connected || sending || !draftReady || (!content.trim() && !hasAttachments)}
          aria-label={sendLabel}
          title={deliveryMode === 'queue' ? '排队到下一轮' : deliveryMode === 'steer' ? '引导当前执行' : '发送'}
        >
          <SendIcon />
        </button>
      </form>
    </div>
  );
}
