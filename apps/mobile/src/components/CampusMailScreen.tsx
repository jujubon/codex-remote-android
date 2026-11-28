import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest } from '../lib/deviceTools';
import { AssistantSettingsSheet } from './AssistantSettingsSheet';
import { ChevronRightIcon, MailIcon, SettingsIcon, UpdateIcon } from './Icons';
import { SearchField } from './SearchField';

type Row = { id: string; subject: string; sender: string; receivedAt: number; priority: boolean; summary?: string };
type Detail = Omit<Row, 'summary'> & { address: string; body: string; truncated: boolean; summaryFailed?: boolean;
  summary?: { overview: string; action: string; deadline: string; quote: string } };
type Inbox = { configured: boolean; syncing: boolean; status: string; lastSyncAt: number | null; model: string | null; modelReady: boolean | null; rows: Row[] };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateLabel = (date: number) => dateFormat.format(date);

export function CampusMailScreen({ config, connectionUrl, connected, revision, target, onTargetClosed, footer }: {
  config: RemoteConfig; connectionUrl?: string; connected: boolean; revision: number; target?: string;
  onTargetClosed: () => void; footer: ReactNode;
}) {
  const endpoint = useMemo(() => ({ ...config, serverUrl: connectionUrl || config.serverUrl }), [config, connectionUrl]);
  const [inbox, setInbox] = useState<Inbox>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [detailError, setDetailError] = useState('');
  const [syncRequested, setSyncRequested] = useState(false);
  const request = useRef(0);
  const detailSheet = useRef<HTMLDialogElement>(null);
  const settingsSheet = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const next = await deviceRequest<Inbox>(endpoint, 'mail');
      if (request.current === sequence) { setInbox(next); setError(''); }
    } catch (failure) {
      if (request.current === sequence) setError(failure instanceof Error ? failure.message : '暂时无法读取学校邮箱。');
    }
  }, [endpoint]);

  useEffect(() => {
    if (connected) void load();
    return () => { request.current++; };
  }, [connected, load, revision]);

  const showMail = useCallback((id: string) => {
    setDetail(undefined);
    setDetailError('');
    setSelected(id);
    if (!detailSheet.current?.open) detailSheet.current?.showModal();
  }, []);

  useEffect(() => {
    if (target) showMail(target);
  }, [target, showMail]);

  useEffect(() => {
    if (!selected || !connected) return;
    let active = true;
    void deviceRequest<Detail>(endpoint, `mail/${selected}`).then(mail => {
      if (active) { setDetail(mail); setDetailError(''); }
    }).catch(() => { if (active) setDetailError('暂时无法读取这封邮件，请稍后重试。'); });
    return () => { active = false; };
  }, [connected, endpoint, revision, selected]);

  async function sync() {
    setSyncRequested(true);
    ++request.current;
    try {
      const next = await deviceRequest<Inbox>(endpoint, 'mail/sync', {});
      setInbox(next);
      setError('');
      void load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法刷新邮件。');
    } finally { setSyncRequested(false); }
  }

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return inbox?.rows.filter(row => (!priorityOnly || row.priority) && (!term ||
      `${row.subject} ${row.sender} ${row.summary ?? ''}`.toLowerCase().includes(term))) ?? [];
  }, [inbox, priorityOnly, query]);

  return <main className="app-screen computer-screen campus-mail-screen">
    <header className="top-bar computer-top-bar">
      <span className="project-symbol"><MailIcon /></span><h1>学校邮箱</h1>
      <div className="mail-header-actions">
        <button className="nav-icon-button" type="button" aria-label="同步邮件" disabled={!connected || syncRequested || inbox?.syncing || !inbox?.configured}
          onClick={() => void sync()}><UpdateIcon /></button>
        <button className="nav-icon-button" type="button" aria-label="邮箱设置" onClick={() => settingsSheet.current?.showModal()}><SettingsIcon /></button>
      </div>
    </header>
    <div className="computer-scroll campus-mail-scroll">
      {!connected && <p className="computer-feedback" role="status">电脑未连接。恢复连接后会补同步邮件。</p>}
      {error && <p className="computer-feedback" role="alert" data-tone="error">{error}</p>}
      {inbox?.status && <p className="computer-feedback" role="status">{inbox.status}</p>}
      {connected && !inbox && !error && <p className="computer-feedback" role="status">正在读取学校邮箱…</p>}
      {inbox && !inbox.configured && <section className="mail-connect-card">
        <span className="mail-symbol"><MailIcon /></span><h2>连接中南大学邮箱</h2>
        <p>在电脑上完成授权后，这里会同步最近的邮件。</p>
        <button className="primary-button" type="button" onClick={() => settingsSheet.current?.showModal()}>查看连接方法</button>
      </section>}
      {inbox?.configured && <>
        <SearchField label="搜索邮件" placeholder="搜索主题、发件人或摘要" value={query} onChange={setQuery} />
        <div className="mail-list-controls">
          <div className="mail-filters" aria-label="筛选邮件">
            <button type="button" aria-pressed={!priorityOnly} onClick={() => setPriorityOnly(false)}>全部</button>
            <button type="button" aria-pressed={priorityOnly} onClick={() => setPriorityOnly(true)}>重点</button>
          </div>
          <small role="status">{inbox.syncing || syncRequested ? '同步中…' : inbox.lastSyncAt ? `${dateLabel(inbox.lastSyncAt)} 同步` : ''}</small>
        </div>
        {rows.length === 0 && <p className="mail-empty">{query || priorityOnly ? '没有符合条件的邮件' : '暂时没有邮件'}</p>}
        <ul className="mail-list">{rows.map(row => <li key={row.id}>
          <button className="mail-row" type="button" onClick={() => showMail(row.id)}>
            <span className="mail-row-icon" data-priority={row.priority}><MailIcon /></span>
            <span className="mail-row-copy">
              <span className="mail-row-meta"><span>{row.sender}</span>{row.priority && <strong>重点</strong>}<time>{dateLabel(row.receivedAt)}</time></span>
              <strong className="mail-subject">{row.subject}</strong>
              {row.summary && <span className="mail-preview">{row.summary}</span>}
            </span>
            <ChevronRightIcon className="mail-row-arrow" />
          </button>
        </li>)}</ul>
      </>}
    </div>
    {footer}
    <AssistantSettingsSheet dialogRef={detailSheet} title="邮件详情" titleId="mail-detail-title" closeLabel="关闭邮件详情" onClosed={() => {
      setSelected(undefined); onTargetClosed();
    }}>
      {detail ? <article className="mail-detail">
        <header><h3>{detail.subject}</h3><p>{detail.sender}{detail.address && detail.address !== detail.sender ? ` · ${detail.address}` : ''}</p>
          <time>{dateLabel(detail.receivedAt)}</time></header>
        {detail.summary ? <section className="mail-summary">
          <h4>AI 摘要</h4><p>{detail.summary.overview}</p>
          {detail.summary.action && <p><strong>待办</strong> {detail.summary.action}</p>}
          {detail.summary.deadline && <p><strong>截止时间</strong> {detail.summary.deadline}</p>}
          {detail.summary.quote && <blockquote>{detail.summary.quote}</blockquote>}
        </section> : (inbox?.model && detail.body && <p className="computer-feedback">{detail.summaryFailed || inbox.modelReady === false
          ? '本地摘要暂不可用，请查看原文。' : '等待本地模型生成摘要。'}</p>)}
        <section className="mail-body"><h4>原文</h4><p>{detail.body || '这封邮件没有可预览的正文。'}</p></section>
        {detail.truncated && <p className="computer-feedback">内容较长或含大附件，可到学校网页邮箱查看完整版。</p>}
      </article> : <p className="computer-feedback" role="status">{detailError || (!connected ? '电脑未连接，等待重连。' : '正在读取邮件…')}</p>}
    </AssistantSettingsSheet>
    <AssistantSettingsSheet dialogRef={settingsSheet} title="邮箱设置" titleId="mail-settings-title" closeLabel="关闭邮箱设置" onClosed={() => undefined}>
      <section className="mail-settings-card">
        <h3>{inbox?.configured ? '中南大学邮箱已配置' : '在 Windows 上配置'}</h3>
        <ol><li>登录中南大学网页邮箱，在「个人信息 → 邮箱密码」生成客户端专用密码。</li>
          <li>在 Windows 配套服务目录运行 <code>Set-CampusMail.cmd</code>，按提示填写邮箱和专用密码。</li>
          <li>回到邮件页刷新。AI 摘要需在 Windows 配置本地 Ollama 模型。</li></ol>
        <p>重点发件人可在电脑配置。通知在锁屏时隐藏主题和摘要。</p>
        {inbox?.model && <p>摘要模型 <strong>{inbox.model}</strong>{inbox.modelReady === false ? ' · 未连接' : ''}</p>}
      </section>
    </AssistantSettingsSheet>
  </main>;
}
