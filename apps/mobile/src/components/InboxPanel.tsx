import { useEffect, useId, useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, loadInboxImage, type InboxFile } from '../lib/deviceTools';
import { ArchiveIcon, ChevronDownIcon, CloseIcon, EyeIcon, MoreIcon, TrashIcon } from './Icons';
import { SwipeActions } from './SwipeActions';
import { ComputerCardHeading } from './ComputerCardHeading';

const INBOX_PAGE_SIZE = 6;

function useInboxImage(config: RemoteConfig, id: string, thumbnail: boolean, enabled: boolean, attempt = 0) {
  const [result, setResult] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (!enabled) return;
    let url: string | undefined;
    const controller = new AbortController();
    setResult({});
    void loadInboxImage(config, id, thumbnail, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setResult({ url });
    }).catch(error => {
      if (!controller.signal.aborted) {
        setResult({ error: error instanceof Error && error.name === 'Error' ? error.message : '加载图片超时，请重试。' });
      }
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [config, id, thumbnail, enabled, attempt]);
  return result;
}

function InboxImageRow({ config, file, label, onPreview }: {
  config: RemoteConfig; file: InboxFile; label: string; onPreview: (url?: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [decodeFailed, setDecodeFailed] = useState(false);
  useEffect(() => {
    if (file.size > 1024 * 1024 || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      setVisible(true);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [file.size]);
  const thumb = useInboxImage(config, file.id, file.size <= 384 * 1024, visible).url;
  return <button ref={ref} type="button" className="inbox-image-entry" aria-label={`预览图片 · ${label}`} onClick={() => onPreview(decodeFailed ? undefined : thumb)}>
    <span className="inbox-thumb" aria-hidden="true">{thumb && !decodeFailed
      ? <img src={thumb} alt="" onError={() => setDecodeFailed(true)} />
      : <EyeIcon />}</span>
    <span className="inbox-file-copy"><strong>图片</strong><small>{label}</small></span>
  </button>;
}

function ImagePreview({ config, file, initialUrl, onClose, onUse }: {
  config: RemoteConfig; file: InboxFile; initialUrl?: string; onClose: () => void; onUse: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const remote = useInboxImage(config, file.id, false, !initialUrl || attempt > 0, attempt);
  const url = attempt === 0 ? initialUrl || remote.url : remote.url;
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="inbox-preview" onClose={onClose} aria-label="图片预览">
    <div className="inbox-preview-controls">
      <strong>图片预览</strong>
      <button type="button" className="nav-icon-button" onClick={() => dialog.current?.close()} aria-label="关闭预览"><CloseIcon /></button>
    </div>
    <div className="inbox-preview-content">
      {remote.error || decodeFailed ? <div role="status">
        <p>{remote.error || '无法显示这张图片。'}</p>
        <button type="button" className="secondary-button" onClick={() => { setDecodeFailed(false); setAttempt(attempt + 1); }}>重试</button>
      </div> : url ? <img src={url} alt="收件箱图片" onError={() => setDecodeFailed(true)} /> : <p role="status">正在读取原图…</p>}
    </div>
    <div className="inbox-preview-controls">
      <details><summary>文件信息</summary><small>{file.fileName}</small><small>{file.path}</small></details>
      <button type="button" className="primary-button" onClick={onUse}>用于对话</button>
    </div>
  </dialog>;
}

function fileLabel(file: InboxFile): string {
  const time = new Date(file.receivedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const size = file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  return `${time} · ${size} · ${file.source === 'share' ? '手机分享' : '对话附件'}`;
}

export function InboxPanel({ config, onUse, deleteAfterTurn, onChangeAttachmentCleanup }: {
  config: RemoteConfig; onUse: (file: InboxFile) => void; deleteAfterTurn?: boolean;
  onChangeAttachmentCleanup: (enabled: boolean) => Promise<void>;
}) {
  const bodyId = useId();
  const deleteTitleId = useId();
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<InboxFile[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [visibleCount, setVisibleCount] = useState(INBOX_PAGE_SIZE);
  const [swiped, setSwiped] = useState<string | null>(null);
  const [pendingSetting, setPendingSetting] = useState(false);
  const [settingError, setSettingError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<InboxFile>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [preview, setPreview] = useState<{ file: InboxFile; url?: string }>();

  async function changeAttachmentCleanup(enabled: boolean) {
    setPendingSetting(true);
    setSettingError('');
    try { await onChangeAttachmentCleanup(enabled); }
    catch { setSettingError('附件设置未保存，请重试。'); }
    finally { setPendingSetting(false); }
  }

  async function refresh() {
    setLoading(true);
    setError('');
    setSwiped(null);
    try {
      const result = await deviceRequest<{ files: InboxFile[] }>(config, 'inbox');
      setFiles(result.files);
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取收件箱失败。');
    } finally {
      setLoading(false);
    }
  }

  function confirmDelete(file: InboxFile) {
    setDeleteTarget(file);
    setDeleteError('');
    deleteDialog.current?.showModal();
  }

  async function deleteFile(file: InboxFile) {
    if (deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const result = await deviceRequest<{ id: string; deleted: boolean }>(config, 'inbox/delete', { id: file.id });
      if (result.id !== file.id || !result.deleted) throw new Error('电脑未确认删除，请刷新收件箱。');
      setFiles(current => current?.filter(entry => entry.id !== file.id));
      deleteDialog.current?.close();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除失败，请重试。');
    } finally { setDeleting(false); }
  }

  return <section className="computer-utility computer-inbox">
    <ComputerCardHeading title="手机收件箱" icon={<ArchiveIcon />}>
      <button className="inbox-disclosure secondary-button" type="button" aria-controls={bodyId} aria-expanded={open} onClick={() => {
        setOpen(!open);
        if (!open && !loading) { setVisibleCount(INBOX_PAGE_SIZE); void refresh(); }
        if (open) setSwiped(null);
      }}>{open ? '收起' : '展开'}<ChevronDownIcon aria-hidden="true" /></button>
    </ComputerCardHeading>
    <div id={bodyId} hidden={!open} className="inbox-body">
      {open && <>
      <label className="computer-setting-row computer-switch">
        <span><strong>任务结束后自动清理附件</strong><small>仅影响之后上传到对话的文件。</small></span>
        <input type="checkbox" role="switch" aria-label="任务结束后自动清理附件" checked={deleteAfterTurn === true}
          disabled={pendingSetting || deleteAfterTurn === undefined} onChange={event => void changeAttachmentCleanup(event.target.checked)} />
      </label>
      {settingError && <p className="inbox-feedback" role="alert">{settingError}</p>}
      <div className="computer-utility-header">
        <span className="utility-muted">{loading ? '正在读取…' : files ? `最近 ${files.length} 项` : ''}</span>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void refresh()}>刷新</button>
      </div>
      {error && <p className="inbox-feedback" role="status">{error}</p>}
      {!loading && !error && files?.length === 0 && <p>暂无收件。</p>}
      {files && files.length > 0 && <ul className="computer-inbox-list">{files.slice(0, visibleCount).map(file => {
        const image = /\.(?:avif|gif|jpe?g|png|webp)$/i.test(file.fileName);
        const label = fileLabel(file);
        return <li key={file.id}>
          <SwipeActions id={file.id} open={swiped === file.id} onChange={setSwiped} actions={[
            { label: '删除', tone: 'delete', icon: <TrashIcon />, onSelect: () => confirmDelete(file) },
          ]}>
            <div className="inbox-row">
              {image ? <InboxImageRow config={config} file={file} label={label} onPreview={url => setPreview({ file, url })} />
                : <div className="inbox-file-copy"><strong title={file.fileName}>{file.fileName}</strong><small>{label}</small></div>}
              <div className="inbox-row-actions">
                <button className="secondary-button" type="button" onClick={() => onUse(file)}>用于对话</button>
                <button className="nav-icon-button" type="button" data-swipe-toggle aria-label={`${file.fileName}的操作`}
                  aria-expanded={swiped === file.id} onClick={() => setSwiped(swiped === file.id ? null : file.id)}><MoreIcon /></button>
              </div>
            </div>
          </SwipeActions>
        </li>;
      })}</ul>}
      {files && visibleCount < files.length && <button className="secondary-button inbox-show-more" type="button"
        onClick={() => setVisibleCount(count => count + INBOX_PAGE_SIZE)}>显示更多 · 还剩 {files.length - visibleCount} 项</button>}
      </>}
    </div>
    <dialog className="session-dialog" ref={deleteDialog} aria-labelledby={deleteTitleId}
      onCancel={event => { if (deleting) event.preventDefault(); }} onClose={() => setDeleteTarget(undefined)}>
      {deleteTarget && <div className="session-sheet archive-sheet inbox-delete-sheet">
        <header className="sheet-title-row"><h2 id={deleteTitleId}>删除电脑上的文件？</h2>
          <button className="nav-icon-button" type="button" aria-label="取消删除" disabled={deleting}
            onClick={() => deleteDialog.current?.close()}><CloseIcon /></button>
        </header>
        <p>{deleteTarget.fileName}</p>
        <small>文件将从电脑和收件箱移除。{deleteTarget.source === 'chat' ? '聊天记录中的这份附件也将无法打开。' : ''}</small>
        {deleteError && <p className="inbox-feedback" role="alert">{deleteError}</p>}
        <div className="sheet-actions">
          <button className="secondary-button" type="button" autoFocus disabled={deleting}
            onClick={() => deleteDialog.current?.close()}>取消</button>
          <button className="swipe-delete-confirm" type="button" disabled={deleting}
            onClick={() => void deleteFile(deleteTarget)}>{deleting ? '正在删除…' : '确认删除'}</button>
        </div>
      </div>}
    </dialog>
    {preview && <ImagePreview key={preview.file.id} config={config} file={preview.file} initialUrl={preview.url}
      onClose={() => setPreview(undefined)} onUse={() => onUse(preview.file)} />}
  </section>;
}
