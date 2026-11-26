import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { threadStateLabel } from '../hooks/useRemote';
import type { ConnectionPhase, RemoteThread } from '../types/protocol';
import { ConnectionStatus } from './ConnectionStatus';
import { ElapsedTime } from './ElapsedTime';
import { ArchiveIcon, ChatIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, EyeIcon, FolderIcon, GaugeIcon, MoreIcon, PlusIcon, SearchIcon, SettingsIcon, TrashIcon } from './Icons';
import { SwipeActions } from './SwipeActions';
import type { useHiddenProjects } from '../lib/hiddenProjects';
import type { AttentionTarget } from '../lib/attention';

export const PROJECT_COLLAPSE_STORAGE_KEY = 'codex-mobile.project-collapse.v1';
export const PROJECT_AUTO_COLLAPSE_THRESHOLD = 6;

type ProjectCollapsePreferences = Record<string, boolean>;
export const NO_PROJECT = '无项目对话';
const emptyChildren = new Map<string, RemoteThread[]>();
type ProjectCollapseStorage = Pick<Storage, 'getItem' | 'setItem'>;

type HistoryVisibility = 'chats' | 'loaded' | 'all';
const historyVisibilityKey = 'codex-mobile.history-visibility.v1';

function readHistoryVisibility(): HistoryVisibility {
  try {
    const value = browserStorage()?.getItem(historyVisibilityKey);
    return value === 'loaded' || value === 'all' ? value : 'chats';
  } catch { return 'chats'; }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

export function visibleInHistory(thread: RemoteThread, visibility: HistoryVisibility): boolean {
  if (visibility === 'all' || thread.unread > 0 || ['running', 'waiting_approval', 'waiting_input', 'error'].includes(thread.state)) return true;
  if (visibility === 'loaded' && thread.state === 'not_loaded') return false;
  const source = asObject(thread.source);
  return ![source, asObject(source?.original)].some(value => {
    const agent = asObject(value?.subAgent ?? value?.subagent ?? value?.sub_agent);
    return agent?.other === 'guardian';
  });
}

export interface ProjectThreadGroup {
  cwd: string;
  items: RemoteThread[];
}

function browserStorage(): ProjectCollapseStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readProjectCollapsePreferences(storage: ProjectCollapseStorage | null = browserStorage()): ProjectCollapsePreferences {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(PROJECT_COLLAPSE_STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([cwd, collapsed]) => cwd.length > 0 && typeof collapsed === 'boolean'),
    );
  } catch {
    return {};
  }
}

export function writeProjectCollapsePreferences(
  preferences: ProjectCollapsePreferences,
  storage: ProjectCollapseStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Browsing storage can be unavailable or full; folding must remain usable in memory.
  }
}

export function groupThreadsByCwd(threads: RemoteThread[], isRemoved: (path: string) => boolean = () => false): ProjectThreadGroup[] {
  const byCwd = new Map<string, RemoteThread[]>();
  for (const thread of threads) {
    const cwd = thread.projectless || !thread.cwd || isRemoved(thread.cwd) ? NO_PROJECT : thread.cwd;
    const list = byCwd.get(cwd) ?? [];
    list.push(thread);
    byCwd.set(cwd, list);
  }
  return [...byCwd.entries()]
    .map(([cwd, items]) => ({ cwd, items: [...items].sort((a, b) => b.updatedAt - a.updatedAt) }))
    .sort((a, b) => Number(a.cwd === NO_PROJECT) - Number(b.cwd === NO_PROJECT) || (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0));
}

export function defaultProjectCollapsed(items: RemoteThread[]): boolean {
  if (items.length < PROJECT_AUTO_COLLAPSE_THRESHOLD) return false;
  const needsAttention = items.some((thread) =>
    thread.unread > 0
    || thread.state === 'running'
    || thread.state === 'waiting_approval'
    || thread.state === 'waiting_input',
  );
  return !needsAttention;
}

export function projectCollapsed(
  cwd: string,
  items: RemoteThread[],
  preferences: ProjectCollapsePreferences,
): boolean {
  return Object.prototype.hasOwnProperty.call(preferences, cwd)
    ? preferences[cwd]
    : cwd === NO_PROJECT || defaultProjectCollapsed(items);
}

export function toggleProjectCollapsePreference(
  cwd: string,
  items: RemoteThread[],
  preferences: ProjectCollapsePreferences,
): ProjectCollapsePreferences {
  return {
    ...preferences,
    [cwd]: !projectCollapsed(cwd, items, preferences),
  };
}

export interface ThreadListPosition {
  query: string;
  filter: string;
  scrollTop: number;
}

interface ThreadListProps {
  position: RefObject<ThreadListPosition>;
  onArchives?: () => void;
  quota?: React.ReactNode;
  onOpenQuota?: () => void;
  onArchive?: (thread: RemoteThread) => void;
  hidden: ReturnType<typeof useHiddenProjects>;
  hiddenThreads: ReturnType<typeof useHiddenProjects>;
  removed: ReturnType<typeof useHiddenProjects>;
  footer: React.ReactNode;
  threads: RemoteThread[];
  attention: Record<string, AttentionTarget>;
  phase: ConnectionPhase;
  phaseDetail: string;
  onSelect: (threadId: string, target?: AttentionTarget) => void;
  onCreate: (cwd?: string) => void;
  notice?: React.ReactNode;
  onSettings: () => void;
  onReconnect: () => void;
}

function relativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86400)} 天`;
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path || '未指定目录';
  return `…/${parts.slice(-3).join('/')}`;
}

function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || path || '未指定目录';
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`;
}

function ThreadRow({
  thread,
  attention,
  childrenByParent,
  depth,
  onSelect,
  expandedParents,
  onToggleChildren,
  wrap,
}: {
  thread: RemoteThread;
  attention?: AttentionTarget;
  childrenByParent: Map<string, RemoteThread[]>;
  depth: number;
  onSelect: (threadId: string, target?: AttentionTarget) => void;
  expandedParents: Set<string>;
  onToggleChildren: (threadId: string) => void;
  wrap?: (thread: RemoteThread, card: React.ReactNode) => React.ReactNode;
}) {
  const children = childrenByParent.get(thread.id) ?? [];
  const isAgent = Boolean(thread.parentThreadId || thread.agentNickname || thread.agentRole);
  const childrenCollapsed = !expandedParents.has(thread.id);
  const completedDuration = thread.lastTurnDurationMs != null
    ? formatDuration(thread.lastTurnDurationMs)
    : '';
  const rowStyle = {
    '--thread-indent': `${Math.min(depth, 4) * 14}px`,
  } as React.CSSProperties;

  const card = <button
        className={`thread-card ${isAgent ? 'thread-card-agent' : ''}`}
        style={rowStyle}
        type="button"
        aria-keyshortcuts={wrap && !isAgent ? 'ArrowLeft' : undefined}
        onClick={() => onSelect(thread.id, attention)}
      >
        <span className={`thread-state state-${thread.state}`} aria-hidden={thread.state === 'not_loaded'} aria-label={threadStateLabel(thread.state)}><span /></span>
        <span className="thread-main">
          <span className="thread-title-row">
            <strong>{isAgent ? thread.agentNickname || thread.title || 'Subagent' : thread.title || '未命名任务'}</strong>
            <span className="thread-time">{thread.state === 'running' && thread.currentTurnStartedAt
              ? <ElapsedTime startedAt={thread.currentTurnStartedAt} />
              : relativeTime(thread.updatedAt)}</span>
          </span>
          {isAgent && (
            <span className="agent-meta">
              <span>Subagent</span>
              {thread.agentRole && <span>{thread.agentRole}</span>}
            </span>
          )}
          {thread.preview && thread.preview.trim() !== thread.title?.trim() && <span className="thread-preview">{thread.preview}</span>}
          <span className="thread-meta">
            {!['idle', 'not_loaded'].includes(thread.state) && <span className={`state-label state-label-${thread.state}`}>{threadStateLabel(thread.state)}</span>}
            {attention && <span className="duration-label">
              {attention.kind === 'queue' ? '队列待处理' : attention.kind === 'input' ? '等待回复' : '审批待处理'} · {attention.handling === 'phone' ? '手机可处理' : attention.handling === 'desktop' ? '到电脑处理' : '打开查看'}
            </span>}
            {completedDuration && thread.state !== 'running' && <span className="duration-label">用时 {completedDuration}</span>}
            {thread.tokenUsage && <span className="token-label">{thread.tokenUsage.totalTokens.toLocaleString()} tokens</span>}
            {children.length > 0 && <span className="agent-count">{children.length} 个 Subagent</span>}
          </span>
        </span>
        {Boolean(thread.unread) && <span className="unread-badge">{thread.unread}</span>}
      </button>;
  return (
    <>
      {wrap && !isAgent ? wrap(thread, card) : card}
      {children.length > 0 && (
        <button
          className="subagent-toggle"
          style={rowStyle}
          type="button"
          onClick={() => onToggleChildren(thread.id)}
          aria-expanded={!childrenCollapsed}
        >
          <span>{childrenCollapsed ? '展开' : '收起'} {children.length} 个 Subagent</span>
          <ChevronDownIcon className="subagent-chevron" />
        </button>
      )}
      {!childrenCollapsed && children.map((child) => (
        <ThreadRow
          key={child.id}
          thread={child}
          childrenByParent={childrenByParent}
          depth={depth + 1}
          onSelect={onSelect}
          expandedParents={expandedParents}
          onToggleChildren={onToggleChildren}
        />
      ))}
    </>
  );
}

function ProjectThreads({ collapsed, children }: { collapsed: boolean; children: React.ReactNode }) {
  const [opened, setOpened] = useState(!collapsed);
  if (!collapsed && !opened) setOpened(true);
  return <div className="project-disclosure" inert={collapsed} aria-hidden={collapsed}>
    <div className="project-threads">{opened || !collapsed ? children : null}</div>
  </div>;
}

function RestoreGroup({ label, items, icon, isProject, onRestore }: {
  label: string; items: { id: string; title: string; detail?: string }[]; icon: React.ReactNode;
  isProject?: boolean; onRestore: (id: string) => void;
}) {
  if (!items.length) return null;
  return <section className="management-group">
    <h3>{label}<span>{items.length}</span></h3>
    <ul className="management-card">
      {items.map(item => <li key={item.id} className="management-item">
        <span className="management-icon" aria-hidden="true">{icon}</span>
        <div className="management-item-copy">
          <strong title={item.title}>{item.title}</strong>
          {item.detail && <small title={item.id}>{item.detail}</small>}
        </div>
        <button className="management-restore" type="button" aria-label={`恢复 ${item.title}`} onClick={() => onRestore(item.id)}>
          {isProject ? '恢复项目' : '恢复'}
        </button>
      </li>)}
    </ul>
  </section>;
}

const historyFilters: { value: HistoryVisibility; label: string; hint: string }[] = [
  { value: 'chats', label: '普通', hint: '隐藏闲置的审阅记录。' },
  { value: 'loaded', label: '已载入', hint: '同时隐藏未载入的历史对话。' },
  { value: 'all', label: '全部', hint: '显示所有对话，包括审阅记录。' },
];
const projectFilters = ['全部项目', '最近', '进行中', '待处理'];

export function ThreadList({ position, onArchives, onArchive, quota, onOpenQuota, threads, attention, phase, phaseDetail, onSelect, onCreate, onSettings, onReconnect, footer, notice, hidden, hiddenThreads, removed }: ThreadListProps) {
  const [visibility, setVisibility] = useState(readHistoryVisibility);
  const listRef = useRef<HTMLElement>(null);
  const manageRef = useRef<HTMLDialogElement>(null);
  const quotaRef = useRef<HTMLDialogElement>(null);
  const removeRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState(position.current.query);
  const [swipe, setSwipe] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [filter, setFilter] = useState(position.current.filter);

  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = position.current.scrollTop;
  }, [position]);

  const updateQuery = (next: string) => {
    setSwipe(null);
    position.current.query = next;
    setQuery(next);
    position.current.scrollTop = 0;
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const updateFilter = (next: string) => {
    setSwipe(null);
    position.current.filter = next;
    setFilter(next);
    position.current.scrollTop = 0;
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [projectCollapsePreferences, setProjectCollapsePreferences] = useState<ProjectCollapsePreferences>(
    () => readProjectCollapsePreferences(),
  );
  useEffect(() => {
    writeProjectCollapsePreferences(projectCollapsePreferences);
  }, [projectCollapsePreferences]);

  const toggleChildren = (threadId: string) => {
    setExpandedParents((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return threads.filter(thread => {
      if (!visibleInHistory(thread, visibility)) return false;
      if (hiddenThreads.isHidden(thread.id)) return false;
      if (!thread.projectless && thread.cwd && hidden.isHidden(thread.cwd)) return false;
      if (filter === '进行中' && thread.state !== 'running') return false;
      if (filter === '待处理' && !attention[thread.id]) return false;
      return !term || [thread.title, thread.cwd, thread.preview, thread.agentNickname].some(value => value?.toLocaleLowerCase().includes(term));
    });
  }, [threads, query, filter, hidden, hiddenThreads, visibility, attention]);
  const groups = useMemo(() => groupThreadsByCwd(filtered, removed.isHidden), [filtered, removed]);
  const titles = useMemo(() => new Map(threads.map(thread => [thread.id, thread.title])), [threads]);
  const flatList = filter !== '全部项目' || Boolean(query.trim());
  const recent = useMemo(() => flatList ? [...filtered].sort((a, b) => b.updatedAt - a.updatedAt) : [], [filtered, flatList]);

  const toggleProject = (cwd: string, items: RemoteThread[]) => {
    setProjectCollapsePreferences((current) => toggleProjectCollapsePreference(cwd, items, current));
  };

  const wrapThread = (thread: RemoteThread, card: React.ReactNode) => {
    const id = `thread:${thread.id}`;
    return <SwipeActions id={id} open={swipe === id} onChange={setSwipe} actions={[
      { label: '隐藏', tone: 'hide', icon: <EyeIcon off />, onSelect: () => hiddenThreads.setHidden(thread.id, true) },
      ...(onArchive ? [{ label: '归档', tone: 'archive' as const, icon: <ArchiveIcon />, onSelect: () => onArchive(thread) }] : []),
    ]}>{card}</SwipeActions>;
  };

  return (
    <main className="app-screen thread-screen" onPointerDownCapture={event => {
      if (swipe && (!(event.target instanceof Element) || event.target.closest<HTMLElement>('[data-swipe-id]')?.dataset.swipeId !== swipe)) setSwipe(null);
    }}>
      <header className="top-bar thread-top-bar">
        <div className="app-identity">
          <img src="/logo.svg?v=4" alt="" className="top-logo" />
          <div>
            <div className="home-title"><strong>Codex Remote</strong>
              {phase === 'connected' && !phaseDetail && <ConnectionStatus phase={phase} onReconnect={onReconnect} />}
            </div>
          </div>
        </div>
        <div className="top-actions">
          <button className="icon-button nav-icon-button" type="button" onClick={onSettings} aria-label="连接设置"><SettingsIcon /></button>
          <button className="new-thread-button" type="button" onClick={() => onCreate()} disabled={phase !== 'connected'}>
            <PlusIcon /> <span>新聊天</span>
          </button>
        </div>
      </header>

      {(phase !== 'connected' || phaseDetail) && <div className="status-row">
        <ConnectionStatus phase={phase} detail={phaseDetail} onReconnect={onReconnect} />
      </div>}
      <div className="thread-browser">
        <div className="project-search">
          <SearchIcon />
          <input type="search" aria-label="搜索项目或对话" placeholder="搜索项目、对话或消息" value={query} onChange={event => updateQuery(event.target.value)} />
          {query && <button className="nav-icon-button" type="button" aria-label="清空搜索" onClick={() => updateQuery('')}><CloseIcon /></button>}
        </div>
        <nav className="segmented-controls project-filters" data-selected={Math.max(0, projectFilters.indexOf(filter))} aria-label="对话筛选">{projectFilters.map(label =>
          <button key={label} type="button" aria-pressed={label === filter} onClick={() => { if (label !== filter) updateFilter(label); }}>{label}</button>
        )}</nav>
        <div className="project-list-toolbar">
          <span>{flatList ? `${filtered.length} 个对话` : `${groups.filter(group => group.cwd !== NO_PROJECT).length} 个项目 · ${filtered.length} 个对话`}</span>
          <div className="project-list-actions">
            {quota && <button type="button" className="nav-icon-button quota-button" aria-label="查看 Codex 额度" aria-haspopup="dialog"
              onClick={() => { quotaRef.current?.showModal(); onOpenQuota?.(); }}><GaugeIcon /></button>}
            <button type="button" className="manage-button" aria-haspopup="dialog" onClick={() => manageRef.current?.showModal()}>管理</button>
          </div>
        </div>
      </div>

      {quota && <dialog className="session-dialog" ref={quotaRef} aria-labelledby="project-quota-title"
        onClick={event => { if (event.target === event.currentTarget) quotaRef.current?.close(); }}>
        <div className="session-sheet">
          <header className="sheet-title-row"><h2 id="project-quota-title">Codex 额度</h2>
            <button type="button" className="nav-icon-button" aria-label="关闭额度" onClick={() => quotaRef.current?.close()}><CloseIcon /></button>
          </header>
          {quota}
        </div>
      </dialog>}
      <dialog className="session-dialog management-dialog" ref={manageRef} aria-labelledby="project-management-title"
        onClick={event => { if (event.target === event.currentTarget) manageRef.current?.close(); }}>
        <div className="session-sheet list-management">
          <header className="sheet-title-row">
            <h2 id="project-management-title">管理项目与对话</h2>
            <button className="icon-button nav-icon-button" type="button" aria-label="关闭管理" onClick={() => manageRef.current?.close()}><CloseIcon /></button>
          </header>
          <div className="management-body">
            {onArchives && <button type="button" className="management-row management-card" onClick={() => {
              manageRef.current?.close();
              onArchives();
            }}><span className="management-icon"><ArchiveIcon /></span><strong>已归档对话</strong><ChevronRightIcon /></button>}
            <fieldset className="management-filter">
              <legend>对话显示</legend>
              <div className="management-segments">
                {historyFilters.map(({ value, label }) => <label key={value}>
                  <input type="radio" name="history-visibility" value={value} checked={visibility === value}
                    onChange={() => {
                      setVisibility(value);
                      try { browserStorage()?.setItem(historyVisibilityKey, value); } catch { /* Keep the in-memory choice. */ }
                    }} />
                  <span>{label}</span>
                </label>)}
              </div>
              <p>{historyFilters.find(filter => filter.value === visibility)?.hint}</p>
            </fieldset>
            <RestoreGroup label="已隐藏项目" items={hidden.paths.map(path => ({ id: path, title: projectName(path), detail: compactPath(path) }))}
              icon={<FolderIcon />} onRestore={path => hidden.setHidden(path, false)} />
            <RestoreGroup label="已隐藏对话" items={hiddenThreads.paths.map(id => ({ id, title: titles.get(id) || '隐藏的对话' }))}
              icon={<ChatIcon />} onRestore={id => hiddenThreads.setHidden(id, false)} />
            <RestoreGroup label="已移除项目卡片" items={removed.paths.map(path => ({ id: path, title: projectName(path), detail: compactPath(path) }))}
              icon={<FolderIcon />} isProject onRestore={path => removed.setHidden(path, false)} />
          </div>
        </div>
      </dialog>
      <dialog className="session-dialog" ref={removeRef} aria-labelledby="remove-project-title" onClose={() => setRemoveTarget(null)}>
        <div className="session-sheet archive-sheet">
          <header className="sheet-title-row">
            <h2 id="remove-project-title">删除项目卡片</h2>
            <button type="button" className="icon-button nav-icon-button" aria-label="取消删除" onClick={() => removeRef.current?.close()}><CloseIcon /></button>
          </header>
          {removeTarget && <p>从手机列表移除「{projectName(removeTarget)}」的项目卡片。对话会显示在「无项目对话」，电脑上的项目目录会保留。</p>}
          <button type="button" className="swipe-delete-confirm" onClick={() => {
            if (removeTarget) removed.setHidden(removeTarget, true);
            removeRef.current?.close();
          }}>删除项目卡片</button>
        </div>
      </dialog>

      <section ref={listRef} className="thread-list" aria-label="任务列表"
        onScroll={event => { position.current.scrollTop = event.currentTarget.scrollTop; }}>
        {threads.length === 0 ? (
          <div className="empty-state">
            <div className="empty-glyph" aria-hidden="true"><span /></div>
            <h2>{phase === 'connected' ? '暂无任务' : '正在等待 Codex'}</h2>
            <p>{phase === 'connected' ? '创建任务，或等待电脑端的任务同步到这里。' : '连接就绪后，历史任务会自动显示。'}</p>
          </div>
        ) : !filtered.length ? (
          <div className="empty-state"><h2>没有匹配的对话</h2>{visibility !== 'all' && <p>可在「管理 → 对话显示」中查看隐藏的记录。</p>}<button className="secondary-button" onClick={() => { updateQuery(''); updateFilter('全部项目'); }}>查看全部项目</button></div>
        ) : flatList ? recent.map(thread => (
          <div key={thread.id} className="recent-thread"><small>{(thread.projectless || !thread.cwd || removed.isHidden(thread.cwd)) ? NO_PROJECT : projectName(thread.cwd)}</small>
            <ThreadRow thread={thread} attention={filter === '待处理' ? attention[thread.id] : undefined}
              childrenByParent={emptyChildren} depth={0} onSelect={onSelect} expandedParents={expandedParents} onToggleChildren={toggleChildren} wrap={wrapThread} />
          </div>
        )) : groups.map(({ cwd, items }) => {
          const ids = new Set(items.map((thread) => thread.id));
          const childrenByParent = new Map<string, RemoteThread[]>();
          for (const thread of items) {
            if (!thread.parentThreadId) continue;
            const list = childrenByParent.get(thread.parentThreadId) ?? [];
            list.push(thread);
            childrenByParent.set(thread.parentThreadId, list);
          }
          const roots = items.filter((thread) => !thread.parentThreadId || !ids.has(thread.parentThreadId));
          const collapsed = projectCollapsed(cwd, items, projectCollapsePreferences);
          const id = `project:${cwd}`;
          const group = (
            <section className={`project-group ${collapsed ? 'project-group-collapsed' : ''}`}>
              <header className="project-heading">
                <button
                  className="project-heading-button"
                  type="button"
                  onClick={() => toggleProject(cwd, items)}
                  aria-expanded={!collapsed}
                  aria-keyshortcuts={cwd !== NO_PROJECT ? 'ArrowLeft ArrowRight' : undefined}
                  aria-label={`${projectName(cwd)}，${items.length} 个任务，${collapsed ? '展开目录' : '折叠目录'}`}
                >
                  <span className="project-symbol">{cwd === NO_PROJECT ? <ChatIcon /> : <FolderIcon />}</span>
                  <span className="project-heading-copy">
                    <strong>{projectName(cwd)}</strong>
                    {cwd !== NO_PROJECT && <code title={cwd}>{compactPath(cwd)}</code>}
                  </span>
                  <span className="project-heading-meta">
                    <span className="project-task-count">{items.length}</span>
                    <ChevronDownIcon className="project-chevron" />
                  </span>
                </button>
                <button className="project-new nav-icon-button" type="button" aria-label={`在 ${projectName(cwd)} 新建对话`} disabled={phase !== 'connected'} onClick={() => onCreate(cwd === NO_PROJECT ? undefined : cwd)}><PlusIcon /></button>
                {cwd !== NO_PROJECT && <button className="project-hide nav-icon-button" type="button" data-swipe-toggle aria-label={`${projectName(cwd)} 的项目菜单`} aria-expanded={swipe === id} onClick={() => setSwipe(swipe === id ? null : id)}><MoreIcon /></button>}
              </header>
              <ProjectThreads collapsed={collapsed}>
                {roots.map((thread) => (
                  <ThreadRow key={thread.id} thread={thread} childrenByParent={childrenByParent} depth={0} onSelect={onSelect} expandedParents={expandedParents} onToggleChildren={toggleChildren} wrap={wrapThread} />
                ))}
              </ProjectThreads>
            </section>
          );
          return cwd === NO_PROJECT ? <div key={cwd}>{group}</div> :
            <SwipeActions key={id} id={id} open={swipe === id} onChange={setSwipe} project actions={[
              { label: '隐藏', tone: 'hide', icon: <EyeIcon off />, onSelect: () => hidden.setHidden(cwd, true) },
              { label: '删除', tone: 'delete', icon: <TrashIcon />, onSelect: () => { setRemoveTarget(cwd); removeRef.current?.showModal(); } },
            ]}>{group}</SwipeActions>;
        })}
      </section>
      {notice && <div className="home-notice">{notice}</div>}
      {footer}
    </main>
  );
}
