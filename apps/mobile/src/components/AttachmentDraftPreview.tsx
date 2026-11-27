import { useEffect, useRef, useState } from 'react';
import { afterDialogClose } from '../lib/dialogMotion';
import { CloseIcon } from './Icons';

const previewBytes = 64 * 1024;

export type AttachmentDraft = {
  name: string;
  size: number;
  file?: File;
  loadImage?: (signal: AbortSignal) => Promise<Blob>;
};

export function isImageFile(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('image/') || /\.(?:jpe?g|png|gif|webp|bmp|avif|heic|heif|svg)$/i.test(name));
}

type Preview =
  | { kind: 'image' | 'audio' | 'video'; url: string }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'loading' | 'details' | 'error' };

export function AttachmentDraftPreview({ draft, onClose }: { draft: AttachmentDraft; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const cancel = new AbortController();
    let url: string | undefined;
    const file = draft.file;
    const showMedia = (kind: 'image' | 'audio' | 'video', blob: Blob) => {
      if (cancel.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPreview({ kind, url });
    };
    const showError = () => { if (!cancel.signal.aborted) setPreview({ kind: 'error' }); };
    if (draft.loadImage) {
      void draft.loadImage(cancel.signal).then(blob => showMedia('image', blob)).catch(showError);
    } else if (file && isImageFile(file.name, file.type)) {
      showMedia('image', file);
    } else if (file?.type.startsWith('audio/')) {
      showMedia('audio', file);
    } else if (file?.type.startsWith('video/')) {
      showMedia('video', file);
    } else if (file && (file.type.startsWith('text/') || /\.(?:txt|md|csv|json|log|ya?ml|xml)$/i.test(file.name))) {
      void file.slice(0, previewBytes).text().then(text => {
        if (!cancel.signal.aborted) setPreview({ kind: 'text', text, truncated: file.size > previewBytes });
      }).catch(showError);
    } else {
      setPreview({ kind: 'details' });
    }
    return () => {
      cancel.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [draft]);

  const unavailable = () => setPreview({ kind: 'error' });
  const size = draft.size < 1024 ? `${draft.size} B` : draft.size < 1024 ** 2
    ? `${(draft.size / 1024).toFixed(1)} KB` : `${(draft.size / 1024 ** 2).toFixed(1)} MB`;
  return <dialog ref={dialog} className="inbox-preview attachment-draft-preview" onClose={event => afterDialogClose(event, onClose)}
    onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }} aria-label="附件预览">
    <div className="inbox-preview-controls">
      <strong title={draft.name}>{draft.name}</strong>
      <button type="button" className="nav-icon-button" onClick={() => dialog.current?.close()} aria-label="关闭预览"><CloseIcon /></button>
    </div>
    <div className="inbox-preview-content">
      {preview.kind === 'image' && <img src={preview.url} alt={draft.name} onError={unavailable} />}
      {preview.kind === 'video' && <video src={preview.url} controls playsInline preload="metadata" onError={unavailable} />}
      {preview.kind === 'audio' && <audio src={preview.url} controls preload="metadata" onError={unavailable} />}
      {preview.kind === 'text' && <div className="attachment-draft-text"><pre tabIndex={0}>{preview.text || '空文件'}</pre>
        {preview.truncated && <small>显示前 64 KB</small>}</div>}
      {preview.kind === 'loading' && <p role="status">正在读取附件…</p>}
      {preview.kind === 'details' && <p>此格式可查看文件信息。</p>}
      {preview.kind === 'error' && <p role="status">暂时无法预览该附件内容。</p>}
    </div>
    <small>{size}</small>
  </dialog>;
}
