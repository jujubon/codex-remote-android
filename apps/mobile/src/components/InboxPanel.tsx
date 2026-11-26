import { useEffect, useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, loadInboxImage, type InboxFile } from '../lib/deviceTools';
import { CloseIcon, EyeIcon } from './Icons';

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
    if (file.size > 384 * 1024 || !ref.current) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      setVisible(true);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [file.size]);
  const thumb = useInboxImage(config, file.id, true, visible).url;
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

export function InboxPanel({ config, onUse, onAttachmentSettings }: {
  config: RemoteConfig; onUse: (file: InboxFile) => void; onAttachmentSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<InboxFile[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ file: InboxFile; url?: string }>();
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const result = await deviceRequest<{ files: InboxFile[] }>(config, 'inbox');
      setFiles(result.files);
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取收件箱失败。');
    } finally {
      setLoading(false);
    }
  }
  return <section className="computer-utility">
    <div className="computer-utility-header">
      <h2>手机收件箱</h2>
      <button className="secondary-button" type="button" aria-expanded={open} onClick={() => {
        setOpen(!open);
        if (!open && !loading) void refresh();
      }}>{open ? '收起' : '打开'}</button>
    </div>
    {open && <>
      <div className="computer-utility-header">
        <span className="utility-muted">{loading ? '正在读取…' : files ? `最近 ${files.length} 项` : ''}</span>
        <div className="inbox-toolbar-actions">
          <button className="secondary-button" type="button" onClick={onAttachmentSettings}>附件保存设置</button>
          <button className="secondary-button" type="button" disabled={loading} onClick={() => void refresh()}>刷新</button>
        </div>
      </div>
      {error && <p role="status">{error}</p>}
      {!loading && !error && files?.length === 0 && <p>暂无收件。</p>}
      {files && files.length > 0 && <ul className="computer-inbox-list">{files.map(file => {
        const image = /\.(?:avif|gif|jpe?g|png|webp)$/i.test(file.fileName);
        const label = fileLabel(file);
        return <li key={file.id}>
          {image ? <InboxImageRow config={config} file={file} label={label} onPreview={url => setPreview({ file, url })} />
            : <div className="inbox-file-copy"><strong title={file.fileName}>{file.fileName}</strong><small>{label}</small></div>}
          <button className="secondary-button" type="button" onClick={() => onUse(file)}>用于对话</button>
        </li>;
      })}</ul>}
    </>}
    {preview && <ImagePreview key={preview.file.id} config={config} file={preview.file} initialUrl={preview.url}
      onClose={() => setPreview(undefined)} onUse={() => onUse(preview.file)} />}
  </section>;
}
