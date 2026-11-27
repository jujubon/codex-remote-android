import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RemoteThread } from '../types/protocol';
import { afterDialogClose } from '../lib/dialogMotion';
import { CloseIcon, EditIcon } from './Icons';

export type RenameThreadTarget = Pick<RemoteThread, 'id' | 'title' | 'assistant'>;

export function RenameThreadDialog({ target, connected, onRename, onClose }: {
  target: RenameThreadTarget;
  connected: boolean;
  onRename: (id: string, title: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [draft, setDraft] = useState(target.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = draft.trim();
  const count = [...title].length;
  const valid = count >= 1 && count <= 120 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cs}]/u.test(title);
  const canSave = connected && !busy && valid && title !== target.title;

  useEffect(() => {
    if (dialog.current?.open) return;
    dialog.current?.showModal();
    input.current?.select();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canSave || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      await onRename(target.id, title);
      dialog.current?.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '未取得改名回执，请刷新列表核对。');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return <dialog className="session-dialog rename-thread-dialog" ref={dialog} data-confirming={busy || undefined}
    aria-labelledby="rename-thread-heading" onClose={event => afterDialogClose(event, onClose)}
    onCancel={event => { if (saving.current) event.preventDefault(); }}
    onClick={event => { if (event.target === event.currentTarget && !saving.current) dialog.current?.close(); }}>
    <div className="session-sheet">
      <header className="sheet-title-row">
        <div className="archive-title">
          <span className="management-icon" aria-hidden="true"><EditIcon /></span>
          <h2 id="rename-thread-heading">重命名对话</h2>
        </div>
        <button className="nav-icon-button" type="button" aria-label="关闭" disabled={busy} onClick={() => dialog.current?.close()}><CloseIcon /></button>
      </header>
      <form className="rename-thread-form" aria-busy={busy} onSubmit={event => void save(event)}>
        <label>
          <span>新标题</span>
          <input ref={input} autoFocus value={draft} maxLength={240} disabled={busy}
            aria-describedby="rename-thread-detail" onChange={event => { setDraft(event.target.value); setError(''); }} />
        </label>
        <div className="rename-thread-detail" id="rename-thread-detail">
          <span>{target.assistant === 'antigravity' ? '标题将保存到电脑配套服务' : '标题将同步到电脑 Codex'}</span>
          <span data-invalid={!valid || undefined}>{count}/120</span>
        </div>
        {!connected && <p className="computer-feedback" role="status">连接电脑后可保存标题。</p>}
        {error && <p className="computer-feedback" data-tone="error" role="alert">{error}</p>}
        <div className="sheet-actions balanced-sheet-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={() => dialog.current?.close()}>取消</button>
          <button className="primary-button" type="submit" disabled={!canSave}>{busy ? '正在保存…' : '保存'}</button>
        </div>
      </form>
    </div>
  </dialog>;
}
