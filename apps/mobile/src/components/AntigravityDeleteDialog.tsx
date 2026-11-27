import { useEffect, useRef, useState } from 'react';

export interface AntigravityDeleteTarget {
  id: string;
  title: string;
}

export function AntigravityDeleteDialog({ target, disabled, onDelete, onClose }: {
  target: AntigravityDeleteTarget;
  disabled: boolean;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const deleting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  async function remove() {
    if (deleting.current || disabled) return;
    deleting.current = true;
    setBusy(true);
    setError('');
    try {
      await onDelete(target.id);
      dialog.current?.close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '未能删除对话，请重试。');
    } finally {
      deleting.current = false;
      setBusy(false);
    }
  }

  return <dialog className="session-dialog" ref={dialog} aria-labelledby="delete-antigravity-title" onClose={onClose}
    data-confirming={busy || undefined} onCancel={event => { if (deleting.current) event.preventDefault(); }}>
    <div className="session-sheet archive-sheet">
      <header className="sheet-title-row"><h2 id="delete-antigravity-title">删除 Antigravity 对话</h2></header>
      <p>将从 App 的同步记录中删除「{target.title}」。电脑上 Antigravity CLI 的原始会话仍可通过 <code>/resume</code> 查看。</p>
      {disabled && <p role="status">电脑需要在线，且当前对话已结束，才能删除。</p>}
      {error && <p role="alert">{error}</p>}
      <div className="usage-reset-actions">
        <button className="secondary-button" type="button" autoFocus disabled={busy} onClick={() => dialog.current?.close()}>取消</button>
        <button className="swipe-delete-confirm" type="button" disabled={busy || disabled} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</button>
      </div>
    </div>
  </dialog>;
}
