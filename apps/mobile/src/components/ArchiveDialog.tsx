import { useEffect, useRef, useState } from 'react';
import type { ArchiveRequest, ArchiveResult, ThreadSummary } from '../types/protocol';
import { ArchiveIcon, ChatIcon, CloseIcon } from './Icons';

export type ArchiveTarget = 'list' | { id: string; title: string };

function archiveDate(updatedAt: number) {
  const timestamp = updatedAt < 1_000_000_000_000 ? updatedAt * 1000 : updatedAt;
  const date = new Date(timestamp);
  return timestamp > 0 && Number.isFinite(date.getTime()) ? date : undefined;
}

export function ArchiveDialog({ target, connected, request, onClose }: {
  target: ArchiveTarget;
  connected: boolean;
  request: (input: ArchiveRequest) => Promise<ArchiveResult>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<ThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pageRequest, setPageRequest] = useState<{ after?: string }>({});
  const [loading, setLoading] = useState(target === 'list');
  const [changing, setChanging] = useState<string>();
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (target !== 'list' || !connected) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    request({ type: 'archive.list', cursor: pageRequest.after }).then(page => {
      if (cancelled) return;
      setRows(previous => {
        const merged = new Map((pageRequest.after ? previous : []).map(row => [row.id, row]));
        for (const row of page.threads ?? []) merged.set(row.id, row);
        return [...merged.values()];
      });
      setCursor(page.nextCursor ?? null);
    }).catch(reason => { if (!cancelled) setError(String(reason.message || reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [target, connected, pageRequest, request]);

  async function change(id: string, archived: boolean) {
    if (changing) return;
    setChanging(id);
    setError('');
    setRestored(false);
    try {
      const result = await request({ type: 'archive.set', threadId: id, archived });
      if (result.threadId !== id || result.archived !== archived) throw new Error('请刷新列表核对电脑上的状态。');
      if (archived) dialog.current?.close();
      else {
        setRows(previous => previous.filter(row => row.id !== id));
        setRestored(true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setChanging(undefined); }
  }

  return <dialog className={`session-dialog${target === 'list' ? ' management-dialog archive-browser' : ''}`} ref={dialog} onClose={onClose} aria-labelledby="archive-heading"
    onClick={event => { if (event.currentTarget === event.target) dialog.current?.close(); }}>
    <div className={`session-sheet ${target === 'list' ? 'list-management' : 'archive-sheet'}`}>
      <header className="sheet-title-row">
        <div className="archive-title">
          {target === 'list' && <span className="management-icon" aria-hidden="true"><ArchiveIcon /></span>}
          <h2 id="archive-heading">{target === 'list' ? '已归档对话' : '归档对话'}</h2>
        </div>
        <button type="button" className="icon-button nav-icon-button" aria-label="关闭" onClick={() => dialog.current?.close()}><CloseIcon /></button>
      </header>
      {target === 'list' ? <div className="management-body archive-browser-body" aria-busy={loading || Boolean(changing)}>
        {rows.length > 0 && <ul className="management-card archive-thread-list">
          {rows.map(row => {
            const date = archiveDate(row.updatedAt);
            const project = (!row.projectless && row.cwd?.split(/[\\/]/).filter(Boolean).at(-1)) || '无项目';
            return <li className="management-item archive-thread-row" key={row.id}>
              <span className="management-icon" aria-hidden="true"><ChatIcon /></span>
              <div className="management-item-copy">
                <strong title={row.name || row.preview || undefined}>{row.name || row.preview || '未命名对话'}</strong>
                <small title={row.projectless ? undefined : row.cwd}>{project}{date && <> · <time dateTime={date.toISOString()}>{date.toLocaleDateString()}</time></>}</small>
              </div>
              <button type="button" className="management-restore" aria-label={`恢复 ${row.name || row.preview || '未命名对话'}`}
                disabled={Boolean(changing) || loading || !connected} onClick={() => void change(row.id, false)}>{changing === row.id ? '恢复中…' : '恢复'}</button>
            </li>;
          })}
        </ul>}
        {!rows.length && !error && <div className="archive-empty" role="status">
          <span className="management-icon" aria-hidden="true"><ArchiveIcon /></span>
          <strong>{!connected ? '电脑未连接' : loading ? '正在读取归档…' : '暂无已归档对话'}</strong>
        </div>}
        {loading && connected && rows.length > 0 && <p className="archive-message" role="status">正在加载更多…</p>}
        {!connected && rows.length > 0 && <p className="computer-feedback" role="status">电脑未连接，重新连接后可恢复对话。</p>}
        {restored && <p className="archive-message" role="status">已恢复到 Codex 对话列表。</p>}
        {error && <p className="computer-feedback" data-tone="error" role="alert">{error}</p>}
        {error && connected && <button type="button" className="secondary-button archive-more" disabled={Boolean(changing)} onClick={() => setPageRequest({ after: pageRequest.after })}>重新读取</button>}
        {cursor && !loading && !error && <button type="button" className="secondary-button archive-more" disabled={!connected || Boolean(changing)} onClick={() => setPageRequest({ after: cursor })}>加载更多</button>}
      </div> : <>
        <p>将「{target.title}」移到电脑的已归档对话？之后可从手机首页「管理 → 已归档对话」恢复。</p>
        <button type="button" className="primary-button" disabled={Boolean(changing) || !connected} onClick={() => void change(target.id, true)}>{changing ? '正在归档…' : '确认归档'}</button>
        {!connected && <p role="status">电脑未连接。</p>}
        {error && <p role="alert">{error}</p>}
      </>}
    </div>
  </dialog>;
}
