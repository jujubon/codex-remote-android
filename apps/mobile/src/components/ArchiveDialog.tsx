import { useEffect, useRef, useState } from 'react';
import type { ArchiveRequest, ArchiveResult, ThreadSummary } from '../types/protocol';
import { CloseIcon } from './Icons';

export type ArchiveTarget = 'list' | { id: string; title: string };

export function ArchiveDialog({ target, connected, request, onClose }: {
  target: ArchiveTarget;
  connected: boolean;
  request: (input: ArchiveRequest) => Promise<ArchiveResult>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<ThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<{ after?: string }>({});
  const [loading, setLoading] = useState(target === 'list');
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (target !== 'list' || !connected) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    request({ type: 'archive.list', cursor: pages.after }).then(page => {
      if (cancelled) return;
      setRows(previous => {
        const merged = new Map((pages.after ? previous : []).map(row => [row.id, row]));
        for (const row of page.threads ?? []) merged.set(row.id, row);
        return [...merged.values()];
      });
      setCursor(page.nextCursor ?? null);
    }).catch(reason => { if (!cancelled) setError(String(reason.message || reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [target, connected, pages, request]);

  async function change(id: string, archived: boolean) {
    if (changing) return;
    setChanging(true);
    setError('');
    try {
      const result = await request({ type: 'archive.set', threadId: id, archived });
      if (result.threadId !== id || result.archived !== archived) throw new Error('请刷新列表核对电脑上的状态。');
      if (archived) dialog.current?.close();
      else setRows(previous => previous.filter(row => row.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setChanging(false); }
  }

  return <dialog className="session-dialog" ref={dialog} onClose={onClose} aria-labelledby="archive-heading">
    <div className="session-sheet archive-sheet">
      <header className="sheet-title-row"><h2 id="archive-heading">{target === 'list' ? '已归档对话' : '归档对话'}</h2>
        <button type="button" className="icon-button nav-icon-button" aria-label="关闭" onClick={() => dialog.current?.close()}><CloseIcon /></button></header>
      {target === 'list' ? <>
        {rows.map(row => <div className="archive-row" key={row.id}><div><strong>{row.name || row.preview || '未命名对话'}</strong><small>{row.cwd}</small></div>
          <button type="button" className="secondary-button" disabled={changing || loading || !connected} onClick={() => void change(row.id, false)}>恢复</button></div>)}
        {connected && !error && !rows.length && !loading && <p>暂无已归档对话。</p>}
        {loading && connected && <p role="status">正在读取电脑上的归档…</p>}
        {cursor && !loading && !error && <button type="button" disabled={!connected || changing} onClick={() => setPages({ after: cursor })}>加载更多</button>}
        {error && connected && <button type="button" disabled={changing} onClick={() => setPages({})}>刷新归档列表</button>}
      </> : <>
        <p>将「{target.title}」移到电脑的已归档对话？之后可从手机首页「管理 → 已归档对话」恢复。</p>
        <button type="button" className="primary-button" disabled={changing || !connected || !!error} onClick={() => void change(target.id, true)}>确认归档</button>
      </>}
      {changing && <p role="status">等待电脑确认…</p>}
      {!connected && <p role="status">电脑未连接。</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  </dialog>;
}
