import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest } from '../lib/deviceTools';
import { cacheScope } from '../lib/remoteCache';
import { AssistantSettingsSheet } from './AssistantSettingsSheet';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ClipboardIcon, MailIcon, MonitorIcon, PowerIcon, SettingsIcon, UpdateIcon } from './Icons';
import { SearchField } from './SearchField';

type Importance = 'important' | 'normal' | 'promotion';
type Provider = 'antigravity' | 'ollama' | 'off';
type Task = { state: 'pending' | 'review' | 'done'; remindAt?: number };
type Row = { id: string; subject: string; sender: string; receivedAt: number; priority: boolean; summary?: string;
  importance?: Importance; task?: Task; action?: string; deadline?: string };
type Mailbox = { id: string; address: string; kind: 'csu' | 'qq'; pending: number };
type Detail = Omit<Row, 'summary'> & { mailboxId?: string; address: string; body: string; truncated: boolean; summaryFailed?: boolean;
  importanceOverride?: Importance; translation?: string;
  summary?: { overview: string; action: string; deadline: string; quote: string; needsTranslation?: boolean } };
type Inbox = { configured: boolean; mailbox?: 'csu' | 'qq'; mailboxId?: string; syncing: boolean; status: string;
  mailboxes?: Mailbox[];
  lastSyncAt: number | null; model: string | null; modelReady: boolean | null;
  smartMail?: boolean; antigravityModelFallback?: boolean; provider?: Provider; prioritySenders?: string[];
  analysisStatus?: string; analyzingId?: string; pendingAnalysis?: number; rows: Row[] };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateLabel = (date: number) => dateFormat.format(date);
const mailboxName = (kind: Mailbox['kind']) => kind === 'qq' ? 'QQ 邮箱' : '学校邮箱';
const mailboxPath = (id?: string) => id ? `mail/account/${id}` : 'mail';
const analysisOptions = [
  { id: 'antigravity', name: 'Antigravity', icon: UpdateIcon },
  { id: 'ollama', name: '本地模型', icon: MonitorIcon },
  { id: 'off', name: '关闭自动分析', icon: PowerIcon },
] as const;

function savedMailbox(key: string) {
  try {
    const value = localStorage.getItem(key);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

export function CampusMailScreen({ config, connectionUrl, connected, revision, target, onTargetClosed }: {
  config: RemoteConfig; connectionUrl?: string; connected: boolean; revision: number; target?: string;
  onTargetClosed: () => void;
}) {
  const endpoint = useMemo(() => ({ ...config, serverUrl: connectionUrl || config.serverUrl }), [config, connectionUrl]);
  const accountKey = `codex-mobile.mailbox.${cacheScope(config.serverUrl, config.pairingToken)}`;
  const [inbox, setInbox] = useState<Inbox>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'inbox' | 'tasks'>('inbox');
  const [filter, setFilter] = useState<'all' | 'important'>('all');
  const [taskFilter, setTaskFilter] = useState<Task['state']>('pending');
  const [bodyVersion, setBodyVersion] = useState<'original' | 'translated'>('original');
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [detailError, setDetailError] = useState('');
  const [syncRequested, setSyncRequested] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [senders, setSenders] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const request = useRef(0);
  const detailSheet = useRef<HTMLDialogElement>(null);
  const settingsSheet = useRef<HTMLDialogElement>(null);
  const consentSheet = useRef<HTMLDialogElement>(null);
  const accountSheet = useRef<HTMLDialogElement>(null);
  const activeMailbox = useRef<string | undefined>(undefined);

  useEffect(() => {
    activeMailbox.current = savedMailbox(accountKey);
  }, [accountKey]);

  const rememberMailbox = useCallback((id?: string) => {
    activeMailbox.current = id;
    try {
      if (id) localStorage.setItem(accountKey, id);
      else localStorage.removeItem(accountKey);
    } catch { /* Selection remains available in memory. */ }
  }, [accountKey]);

  const load = useCallback(async () => {
    const sequence = ++request.current;
    const id = activeMailbox.current;
    try {
      const next = await deviceRequest<Inbox>(endpoint, mailboxPath(id)).catch(error => {
        if (!id || !(error instanceof Error) || !error.message.includes('未提供这项功能')) throw error;
        return deviceRequest<Inbox>(endpoint, 'mail');
      });
      if (request.current === sequence) {
        if (next.mailboxes) rememberMailbox(next.mailboxId);
        else if (id) rememberMailbox(undefined);
        setInbox(next);
        setError('');
      }
    } catch (failure) {
      if (request.current === sequence) setError(failure instanceof Error ? failure.message : '暂时无法读取邮箱。');
    }
  }, [endpoint, rememberMailbox]);

  useEffect(() => {
    if (connected) void load();
    return () => { request.current++; };
  }, [connected, load, revision]);

  const selectMailbox = useCallback((id: string, fromNotification = false) => {
    accountSheet.current?.close();
    if (id === activeMailbox.current) return;
    if (!fromNotification) {
      detailSheet.current?.close();
      setSelected(undefined);
      setDetail(undefined);
    }
    consentSheet.current?.close();
    settingsSheet.current?.close();
    rememberMailbox(id);
    setInbox(undefined);
    setError('');
    setQuery('');
    setFilter('all');
    setView('inbox');
    void load();
  }, [load, rememberMailbox]);

  const showMail = useCallback((id: string) => {
    setDetail(undefined);
    setDetailError('');
    setActionError('');
    setBodyVersion('original');
    setSelected(id);
    const dialog = detailSheet.current;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector('.assistant-sheet-body')?.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (target) showMail(target);
  }, [target, showMail]);

  useEffect(() => {
    if (!selected || !connected) return;
    let active = true;
    void deviceRequest<Detail>(endpoint, `mail/${selected}`).then(mail => {
      if (active) {
        if (mail.mailboxId) selectMailbox(mail.mailboxId, true);
        setDetail(mail);
        setDetailError('');
      }
    }).catch(() => { if (active) setDetailError('暂时无法读取这封邮件，请稍后重试。'); });
    return () => { active = false; };
  }, [connected, endpoint, revision, selected, selectMailbox]);

  async function sync() {
    const id = activeMailbox.current;
    setSyncRequested(true);
    ++request.current;
    try {
      const next = await deviceRequest<Inbox>(endpoint, `${mailboxPath(id)}/sync`, {});
      if (activeMailbox.current === id) { setInbox(next); setError(''); void load(); }
    } catch (failure) {
      if (activeMailbox.current === id) setError(failure instanceof Error ? failure.message : '无法刷新邮件。');
    } finally { setSyncRequested(false); }
  }

  function openSettings() {
    setSettingsError('');
    setSenders((inbox?.prioritySenders ?? []).join('\n'));
    settingsSheet.current?.showModal();
  }

  async function saveSettings(values: { provider?: Provider; cloudConsent?: boolean; prioritySenders?: string[] }) {
    if (settingsBusy || !connected) return false;
    const id = activeMailbox.current;
    setSettingsBusy(true);
    setSettingsError('');
    try {
      const result = await deviceRequest<Inbox>(endpoint, `${mailboxPath(id)}/settings`, values);
      if (activeMailbox.current !== id) return false;
      ++request.current;
      setInbox(result);
      return true;
    } catch (failure) {
      if (activeMailbox.current === id) setSettingsError(failure instanceof Error ? failure.message : '无法保存邮箱设置。');
      return false;
    } finally { setSettingsBusy(false); }
  }

  async function mailAction(operation: string) {
    if (!detail || !connected || actionBusy) return;
    const id = detail.id;
    setActionBusy(true);
    setActionError('');
    try {
      const result = await deviceRequest<Detail>(endpoint, `mail/${id}/action`, { operation });
      setDetail(current => current?.id === id ? result : current);
      void load();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : '暂时无法保存邮件状态。');
    } finally { setActionBusy(false); }
  }

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return inbox?.rows.filter(row => (view === 'tasks' ? row.task?.state === taskFilter :
      filter === 'all' || row.importance === filter || (filter === 'important' && !row.importance && row.priority)) &&
      (!term || `${row.subject} ${row.sender} ${row.summary ?? ''} ${row.action ?? ''}`.toLowerCase().includes(term))) ?? [];
  }, [inbox, view, filter, taskFilter, query]);
  const pendingTasks = inbox?.rows.filter(row => row.task?.state === 'pending').length ?? 0;
  const reviewing = inbox?.rows.filter(row => row.task?.state === 'review').length ?? 0;
  const canChange = connected && !actionBusy;
  const mailboxLabel = inbox?.mailbox ? mailboxName(inbox.mailbox) : '邮件';
  const accounts = inbox?.mailboxes ?? [];
  const account = accounts.find(item => item.id === inbox?.mailboxId);
  const provider = inbox?.provider ?? (inbox?.model ? 'ollama' : 'off');
  const allowSettings = connected && !settingsBusy;
  const senderList = [...new Set(senders.trim().toLowerCase().split(/[\s,，;；]+/).filter(Boolean))];
  const savedSenders = inbox?.prioritySenders ?? [];
  const sendersChanged = senderList.length !== savedSenders.length || senderList.some(address => !savedSenders.includes(address));
  const senderAddress = detail?.address && detail.address.toLowerCase() !== detail.sender.trim().toLowerCase() ? detail.address : '';

  return <main className="app-screen computer-screen campus-mail-screen">
    <header className="top-bar computer-top-bar">
      <span className="project-symbol"><MailIcon /></span>
      <div className="mail-account-heading">
        <h1>{accounts.length > 1 ? <button type="button" className="mail-account-trigger" aria-label="切换邮箱"
          aria-haspopup="dialog" onClick={() => accountSheet.current?.showModal()}>
          <span>{mailboxLabel}</span><ChevronDownIcon aria-hidden="true" /></button> : mailboxLabel}</h1>
        {account && <small title={account.address}>{account.address}</small>}
      </div>
      <div className="mail-header-actions">
        <button className="nav-icon-button" type="button" aria-label="同步邮件" disabled={!connected || syncRequested || inbox?.syncing || !inbox?.configured}
          onClick={() => void sync()}><UpdateIcon /></button>
        <button className="nav-icon-button" type="button" aria-label="邮箱设置" onClick={openSettings}><SettingsIcon /></button>
      </div>
    </header>
    <div className="computer-scroll campus-mail-scroll">
      {!connected && <p className="computer-feedback" role="status">电脑未连接。恢复连接后会补同步邮件。</p>}
      {error && <p className="computer-feedback" role="alert" data-tone="error">{error}</p>}
      {inbox?.status && <p className="computer-feedback" role="status">{inbox.status}</p>}
      {inbox?.analysisStatus && <p className="computer-feedback" role="status">{inbox.analysisStatus}</p>}
      {connected && !inbox && !error && <p className="computer-feedback" role="status">正在读取邮箱…</p>}
      {inbox && !inbox.configured && <section className="mail-connect-card">
        <span className="mail-symbol"><MailIcon /></span><h2>连接邮箱</h2>
        <p>在电脑上完成授权后，这里会同步最近的邮件。</p>
        <button className="primary-button" type="button" onClick={openSettings}>查看连接方法</button>
      </section>}
      {inbox?.configured && <>
        {inbox.smartMail && <nav className="segmented-controls mail-view-tabs" data-selected={view === 'inbox' ? 0 : 1} aria-label="邮件与待办">
          <button type="button" aria-pressed={view === 'inbox'} onClick={() => { setView('inbox'); setQuery(''); }}>收件箱</button>
          <button type="button" aria-pressed={view === 'tasks'} onClick={() => { setView('tasks'); setQuery(''); }}>待办{pendingTasks ? ` ${pendingTasks}` : ''}</button>
        </nav>}
        <SearchField label="搜索邮件" placeholder="搜索主题、发件人或摘要" value={query} onChange={setQuery} />
        <div className="mail-list-controls">
          {view === 'tasks' ? <div className="mail-filters" aria-label="筛选待办">
            <button type="button" aria-pressed={taskFilter === 'pending'} onClick={() => setTaskFilter('pending')}>待处理</button>
            <button type="button" aria-pressed={taskFilter === 'review'} onClick={() => setTaskFilter('review')}>待确认{reviewing ? ` ${reviewing}` : ''}</button>
            <button type="button" aria-pressed={taskFilter === 'done'} onClick={() => setTaskFilter('done')}>已完成</button>
          </div> : <>
            <div className="mail-filters" aria-label="筛选邮件">
              <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
              <button type="button" aria-pressed={filter === 'important'} onClick={() => setFilter('important')}>{inbox.smartMail ? '重要' : '重点'}</button>
            </div>
            <small role="status">{inbox.syncing || syncRequested ? '同步中…' : inbox.pendingAnalysis ? `${inbox.pendingAnalysis} 封待分析`
              : inbox.lastSyncAt ? `${dateLabel(inbox.lastSyncAt)} 同步` : ''}</small>
          </>}
        </div>
        {view === 'inbox' && inbox.smartMail && inbox.provider === 'off' && <button type="button" className="secondary-button mail-enable-ai"
          onClick={openSettings}>开启自动摘要与分类<ChevronRightIcon aria-hidden="true" /></button>}
        {rows.length === 0 && <p className="mail-empty">{view === 'tasks' ? '这个列表暂时是空的' : query || filter !== 'all' ? '没有符合条件的邮件' : '暂时没有邮件'}</p>}
        <ul className="mail-list">{rows.map(row => <li key={row.id}>
          <button className="mail-row" type="button" onClick={() => showMail(row.id)}>
            <span className="mail-row-icon" data-priority={row.importance === 'important' || row.priority}><MailIcon /></span>
            <span className="mail-row-copy">
              <span className="mail-row-meta"><span>{row.sender}</span>{row.importance === 'important' && <strong>重要</strong>}
                {!row.importance && row.priority && <strong>重点</strong>}<time>{dateLabel(row.receivedAt)}</time></span>
              <strong className="mail-subject">{view === 'tasks' ? row.action || row.subject : row.subject}</strong>
              {view === 'tasks' ? <span className="mail-preview">{row.deadline || '未注明截止时间'}
                {row.task?.remindAt && row.task.remindAt > Date.now() ? ` · ${dateLabel(row.task.remindAt)} 提醒` : ''}</span>
                : row.summary && <span className="mail-preview">{row.summary}</span>}
            </span>
            <ChevronRightIcon className="mail-row-arrow" />
          </button>
        </li>)}</ul>
      </>}
    </div>
    <AssistantSettingsSheet dialogRef={accountSheet} title="选择邮箱" titleId="select-mailbox-title" closeLabel="关闭邮箱选择" onClosed={() => undefined}>
      <ul className="mail-account-list">{accounts.map(item => <li key={item.id}>
        <button type="button" aria-current={inbox?.mailboxId === item.id ? 'true' : undefined}
          className="mail-account-option" onClick={() => selectMailbox(item.id)}>
          <span className="mail-row-icon"><MailIcon aria-hidden="true" /></span>
          <span className="mail-account-name"><strong>{mailboxName(item.kind)}</strong><small>{item.address}</small></span>
          {item.pending > 0 && <span className="mail-account-count">{item.pending} 项待办</span>}
          {inbox?.mailboxId === item.id && <span className="mail-account-current">当前</span>}
        </button>
      </li>)}</ul>
    </AssistantSettingsSheet>
    <AssistantSettingsSheet className="mail-sheet mail-reader-sheet" dialogRef={detailSheet} title="邮件详情" titleId="mail-detail-title" closeLabel="关闭邮件详情" onClosed={() => {
      setSelected(undefined); onTargetClosed();
    }}>
      {detail ? <article className="mail-detail" key={detail.id}>
        <header className="mail-detail-heading">
          <h3>{detail.subject}</h3>
          <div className="mail-detail-byline">
            <span className="mail-row-icon"><MailIcon /></span>
            <span className="mail-detail-sender"><strong>{detail.sender}</strong>
              {senderAddress && <small>{senderAddress}</small>}
            </span>
            <time dateTime={new Date(detail.receivedAt).toISOString()}>{dateLabel(detail.receivedAt)}</time>
          </div>
        </header>
        {detailError && <p className="computer-feedback" role="status">暂时无法刷新，正在显示上次读取的邮件。</p>}
        {detail.summary ? <section className="mail-summary">
          <div className="mail-summary-heading"><h4><ClipboardIcon />AI 摘要</h4>
            {detail.importance === 'important' && <span className="mail-classification">重要</span>}</div>
          <p>{detail.summary.overview}</p>
          {detail.importance !== 'promotion' && (detail.summary.action || detail.summary.deadline) && <dl className="mail-summary-facts">
            {detail.summary.action && <div><dt>{detail.task?.state === 'review' ? '待确认' : '待办'}</dt><dd>{detail.summary.action}</dd></div>}
            {detail.summary.deadline && <div><dt>截止时间</dt><dd>{detail.summary.deadline}</dd></div>}
          </dl>}
          {detail.importance !== 'promotion' && detail.summary.quote && <details className="mail-detail-disclosure">
            <summary>查看原文依据<ChevronRightIcon aria-hidden="true" /></summary>
            <blockquote>{detail.summary.quote}</blockquote>
          </details>}
        </section> : ((inbox?.provider && inbox.provider !== 'off' || !inbox?.smartMail && inbox?.model) && <p className="computer-feedback" role="status">
          {detail.summaryFailed || inbox.modelReady === false ? '摘要暂未完成，电脑会稍后重试。'
            : inbox.analyzingId === detail.id ? '正在分析邮件…' : '等待生成摘要…'}</p>)}
        {inbox?.smartMail && detail.task && <section className="mail-detail-actions" aria-label="处理待办">
          <div className="mail-action-buttons">
            <button className="mail-task-primary" type="button" disabled={!canChange}
              onClick={() => void mailAction(detail.task?.state === 'pending' ? 'complete' : detail.task?.state === 'done' ? 'reopen' : 'add')}>
              {detail.task?.state === 'pending' ? '标为完成' : detail.task?.state === 'done' ? '恢复待办' : '加入待办'}</button>
            {detail.task?.state === 'pending' && <button className="secondary-button" type="button" disabled={!canChange}
              onClick={() => void mailAction('snooze')}>{detail.task.remindAt && detail.task.remindAt > Date.now() ? '重新延后 1 小时' : '1 小时后提醒'}</button>}
            {detail.task?.state === 'review' && <button className="secondary-button" type="button" disabled={!canChange}
              onClick={() => void mailAction('dismiss')}>忽略建议</button>}
          </div>
          {detail.task?.remindAt && detail.task.remindAt > Date.now() ? <small>将在 {dateLabel(detail.task.remindAt)} 提醒</small> : null}
        </section>}
        {inbox?.smartMail && <details className="mail-detail-disclosure mail-detail-menu">
          <summary>邮件操作<ChevronRightIcon aria-hidden="true" /></summary>
          <div>
            {!detail.task && <button className="secondary-button" type="button" disabled={!canChange}
              onClick={() => void mailAction('add')}>加入待办</button>}
            <label className="mail-importance-control"><span>调整分类</span>
              <select aria-label="调整分类" disabled={!canChange} value={detail.importanceOverride ?? 'automatic'}
                onChange={event => void mailAction(event.target.value)}>
                <option value="automatic">AI 自动判断</option><option value="important">重要</option>
                <option value="normal">普通</option><option value="promotion">静默处理</option>
              </select>
            </label>
          </div>
        </details>}
        {actionError && <p className="computer-feedback" role="alert" data-tone="error">{actionError}</p>}
        <section className="mail-body">
          <h4>{detail.translation ? '正文' : '原文'}</h4>
          {detail.translation && <div className="segmented-controls mail-body-tabs" data-selected={bodyVersion === 'original' ? 0 : 1} aria-label="正文语言">
            <button type="button" aria-pressed={bodyVersion === 'original'} onClick={() => setBodyVersion('original')}>原文</button>
            <button type="button" aria-pressed={bodyVersion === 'translated'} onClick={() => setBodyVersion('translated')}>中文译文</button>
          </div>}
          {!detail.translation && detail.summary?.needsTranslation && <small>{inbox?.provider === 'off' ? '开启自动摘要后可生成中文译文'
            : detail.summaryFailed ? '译文暂未完成，稍后会重试。' : '中文译文生成中…'}</small>}
          <p><span key={bodyVersion}>{(bodyVersion === 'translated' ? detail.translation : detail.body) || '这封邮件没有可预览的正文。'}</span></p>
        </section>
        {detail.truncated && <p className="computer-feedback">内容较长或含大附件，可到原邮箱查看完整版。</p>}
      </article> : <p className="computer-feedback" role="status">{detailError || (!connected ? '电脑未连接，等待重连。' : '正在读取邮件…')}</p>}
    </AssistantSettingsSheet>
    <AssistantSettingsSheet className="mail-sheet" dialogRef={settingsSheet} title="邮箱设置" titleId="mail-settings-title" closeLabel="关闭邮箱设置" onClosed={() => undefined}>
      <section className="mail-settings-card">
        {inbox?.smartMail && inbox.configured ? <>
          <header className="mail-settings-account">
            <span className="mail-symbol"><MailIcon /></span>
            <div><h3>{mailboxLabel}</h3>{account && <p>{account.address}</p>}</div>
          </header>
          <section className="mail-settings-panel" aria-labelledby="mail-analysis-heading">
            <h3 id="mail-analysis-heading">自动摘要与分类</h3>
            <div className="mail-analysis-options" role="group" aria-labelledby="mail-analysis-heading">
              {analysisOptions.map(({ id, name, icon: Icon }) => <button type="button" className="mail-analysis-option" key={id}
                aria-pressed={provider === id} disabled={!allowSettings || (id === 'ollama' && !inbox.model && provider !== id)}
                onClick={() => {
                  if (provider === id) return;
                  if (id === 'antigravity') { setSettingsError(''); consentSheet.current?.showModal(); }
                  else void saveSettings({ provider: id });
                }}>
                <span className="mail-row-icon"><Icon /></span>
                <span className="mail-analysis-copy"><strong>{name}</strong>
                  {id === 'antigravity' && <small>{inbox.antigravityModelFallback
                    ? 'Gemini 优先 · 额度用完切换 Claude' : '使用 CLI 模型 · 额度不足时稍后重试'}</small>}
                  {id === 'ollama' && <small>{inbox.model ?? '电脑尚未配置 Ollama'}</small>}
                </span>
                <span className="mail-option-check" aria-hidden="true">{provider === id && <CheckIcon />}</span>
              </button>)}
            </div>
          </section>
          <form className="mail-settings-panel mail-contact-form" onSubmit={event => {
            event.preventDefault();
            if (allowSettings && sendersChanged) void saveSettings({ prioritySenders: senderList });
          }}>
            <div className="mail-contact-heading">
              <label htmlFor="mail-priority-senders">重点联系人</label>
              {savedSenders.length > 0 && <small>{savedSenders.length} 位</small>}
            </div>
            <textarea id="mail-priority-senders" rows={3} value={senders} placeholder="输入邮箱地址，每行一个"
              autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => setSenders(event.target.value)} />
            <button className="secondary-button" type="submit" disabled={!allowSettings || !sendersChanged}>保存联系人</button>
          </form>
          {settingsError && <p className="computer-feedback" role="alert" data-tone="error">{settingsError}</p>}
          <details className="mail-detail-disclosure mail-source-help">
            <summary>在电脑添加邮箱<ChevronRightIcon aria-hidden="true" /></summary>
            <div>
              <p>QQ 邮箱使用 IMAP 授权码。在电脑运行 <code>Set-CampusMail.cmd -Provider qq</code>。</p>
              <p>添加学校邮箱，运行 <code>Set-CampusMail.cmd -Provider csu</code>。添加同类的另一个地址时，可用 <code>-Address</code> 指定完整邮箱地址。</p>
              <p>各账号会同时同步，点邮件页顶部的邮箱名称即可切换。</p>
            </div>
          </details>
        </> : <><h3>{inbox?.configured ? '邮箱已配置' : '在 Windows 上配置'}</h3>
          <ol><li>登录中南大学网页邮箱，在「个人信息 → 邮箱密码」生成客户端专用密码。</li>
          <li>在 Windows 配套服务目录运行 <code>Set-CampusMail.cmd</code>，按提示填写邮箱和专用密码。</li>
          <li>接入 QQ 邮箱时，生成 IMAP 授权码，并运行 <code>Set-CampusMail.cmd -Provider qq</code>。</li>
          <li>回到邮件页刷新，然后在邮箱设置里选择摘要方式。</li></ol>
        <p>重点发件人可在电脑配置。通知在锁屏时隐藏主题和摘要。</p>
          {inbox?.model && <p>摘要模型 <strong>{inbox.model}</strong>{inbox.modelReady === false ? ' · 未连接' : ''}</p>}</>}
      </section>
    </AssistantSettingsSheet>
    <AssistantSettingsSheet className="mail-sheet" dialogRef={consentSheet} title="开启 Antigravity 自动分析" titleId="mail-consent-title" closeLabel="关闭授权确认" onClosed={() => undefined}>
      <section className="mail-settings-card">
        <p>开启后，电脑会把已同步邮件的标题和所需正文发送给 Google Antigravity，用于摘要、分类、提取待办和中文翻译，并使用你已登录账号的额度。</p>
        <p>邮箱凭据与附件留在电脑上。你随时可以在邮箱设置里关闭自动分析。</p>
        {settingsError && <p className="computer-feedback" role="alert" data-tone="error">{settingsError}</p>}
        <div className="mail-action-buttons">
          <button className="secondary-button" type="button" onClick={() => consentSheet.current?.close()}>取消</button>
          <button className="primary-button" type="button" disabled={!connected || settingsBusy} onClick={async () => {
            if (await saveSettings({ provider: 'antigravity', cloudConsent: true })) consentSheet.current?.close();
          }}>确认开启</button>
        </div>
      </section>
    </AssistantSettingsSheet>
  </main>;
}
