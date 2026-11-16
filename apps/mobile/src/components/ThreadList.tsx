import { useEffect, useMemo, useState } from 'react';
import { threadStateLabel } from '../hooks/useRemote';
import type { ConnectionPhase, RemoteThread } from '../types/protocol';
import { ConnectionStatus } from './ConnectionStatus';
import { ElapsedTime } from './ElapsedTime';
import { PlusIcon, SettingsIcon } from './Icons';
import type { useHiddenProjects } from '../lib/hiddenProjects';

export const PROJECT_COLLAPSE_STORAGE_KEY = 'codex-mobile.project-collapse.v1';
export const PROJECT_AUTO_COLLAPSE_THRESHOLD = 6;

type ProjectCollapsePreferences = Record<string, boolean>;
export const NO_PROJECT = '无项目对话';
const emptyChildren = new Map<string, RemoteThread[]>();
type ProjectCollapseStorage = Pick<Storage, 'getItem' | 'setItem'>;

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

export function groupThreadsByCwd(threads: RemoteThread[]): ProjectThreadGroup[] {
  const byCwd = new Map<string, RemoteThread[]>();
  for (const thread of threads) {
    const cwd = thread.projectless || !thread.cwd ? NO_PROJECT : thread.cwd;
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

interface ThreadListProps {
  hidden: ReturnType<typeof useHiddenProjects>;
  footer: React.ReactNode;
  threads: RemoteThread[];
  phase: ConnectionPhase;
  phaseDetail: string;
  onSelect: (threadId: string) => void;
  onCreate: (cwd?: string) => void;
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
  childrenByParent,
  depth,
  onSelect,
  expandedParents,
  onToggleChildren,
}: {
  thread: RemoteThread;
  childrenByParent: Map<string, RemoteThread[]>;
  depth: number;
  onSelect: (threadId: string) => void;
  expandedParents: Set<string>;
  onToggleChildren: (threadId: string) => void;
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

  return (
    <>
      <button
        className={`thread-card ${isAgent ? 'thread-card-agent' : ''}`}
        style={rowStyle}
        type="button"
        onClick={() => onSelect(thread.id)}
      >
        <span className={`thread-state state-${thread.state}`} aria-label={threadStateLabel(thread.state)}><span /></span>
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
          <span className="thread-preview">{thread.preview || (thread.state === 'running' ? '正在执行…' : '等待新消息')}</span>
          <span className="thread-meta">
            {thread.state !== 'idle' && <span className={`state-label state-label-${thread.state}`}>{threadStateLabel(thread.state)}</span>}
            {completedDuration && thread.state !== 'running' && <span className="duration-label">用时 {completedDuration}</span>}
            {thread.tokenUsage && <span className="token-label">{thread.tokenUsage.totalTokens.toLocaleString()} tokens</span>}
            {children.length > 0 && <span className="agent-count">{children.length} 个 Subagent</span>}
          </span>
        </span>
        {Boolean(thread.unread) && <span className="unread-badge">{thread.unread}</span>}
      </button>
      {thread.state === 'not_loaded' && <details className="thread-state-help">
        <summary>关于「未载入」</summary>
        <p>这段历史保存在电脑上。点开对话后，手机会读取内容并同步当前状态。</p>
      </details>}
      {children.length > 0 && (
        <button
          className="subagent-toggle"
          style={rowStyle}
          type="button"
          onClick={() => onToggleChildren(thread.id)}
          aria-expanded={!childrenCollapsed}
        >
          <span>{childrenCollapsed ? '展开' : '收起'} {children.length} 个 Subagent</span>
          <span aria-hidden="true">{childrenCollapsed ? '⌄' : '⌃'}</span>
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

export function ThreadList({ threads, phase, phaseDetail, onSelect, onCreate, onSettings, onReconnect, footer, hidden }: ThreadListProps) {
  const [query, setQuery] = useState('');
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [filter, setFilter] = useState('全部项目');
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
      if (!thread.projectless && thread.cwd && hidden.isHidden(thread.cwd)) return false;
      if (filter === '进行中' && thread.state !== 'running') return false;
      if (filter === '待处理' && thread.state !== 'waiting_approval' && thread.state !== 'waiting_input') return false;
      return !term || [thread.title, thread.cwd, thread.preview, thread.agentNickname].some(value => value?.toLocaleLowerCase().includes(term));
    });
  }, [threads, query, filter, hidden]);
  const groups = useMemo(() => groupThreadsByCwd(filtered), [filtered]);
  const flatList = filter !== '全部项目' || Boolean(query.trim());
  const recent = useMemo(() => flatList ? [...filtered].sort((a, b) => b.updatedAt - a.updatedAt) : [], [filtered, flatList]);

  const toggleProject = (cwd: string, items: RemoteThread[]) => {
    setProjectCollapsePreferences((current) => toggleProjectCollapsePreference(cwd, items, current));
  };

  return (
    <main className="app-screen thread-screen">
      <header className="top-bar thread-top-bar">
        <div className="app-identity">
          <img src="/logo.svg?v=4" alt="" className="top-logo" />
          <div>
            <div className="home-title"><strong>Codex Remote</strong>
              {phase === 'connected' && !phaseDetail && <ConnectionStatus phase={phase} onReconnect={onReconnect} />}
            </div>
            <span>{groups.filter(group => group.cwd !== NO_PROJECT).length} 个项目 · {filtered.length} 个对话</span>
          </div>
        </div>
        <div className="top-actions">
          <button className="icon-button" type="button" onClick={onSettings} aria-label="连接设置"><SettingsIcon /></button>
          <button className="new-thread-button" type="button" onClick={() => onCreate()} disabled={phase !== 'connected'}>
            <PlusIcon /> <span>新聊天</span>
          </button>
        </div>
      </header>

      {(phase !== 'connected' || phaseDetail) && <div className="status-row">
        <ConnectionStatus phase={phase} detail={phaseDetail} onReconnect={onReconnect} />
      </div>}
      <div className="thread-browser">
        <input type="search" aria-label="搜索项目或对话" placeholder="搜索项目、对话或最近消息" value={query} onChange={event => setQuery(event.target.value)} />
        <nav aria-label="对话筛选">{['全部项目', '最近', '进行中', '待处理'].map(label =>
          <button key={label} type="button" aria-pressed={label === filter} onClick={() => setFilter(label)}>{label}</button>
        )}<button type="button" aria-label="项目菜单" aria-expanded={projectMenu === 'manage'} onClick={() => setProjectMenu(projectMenu === 'manage' ? null : 'manage')}>⋯</button></nav>
        {projectMenu === 'manage' && <section className="hidden-projects">
          <strong>已隐藏项目（{hidden.paths.length}）</strong>
          {hidden.paths.map(path => <div key={path}><span>{path}</span>
            <button type="button" onClick={() => hidden.setHidden(path, false)}>恢复显示</button></div>)}
        </section>}
      </div>

      <section className="thread-list" aria-label="任务列表">
        {threads.length === 0 ? (
          <div className="empty-state">
            <div className="empty-glyph" aria-hidden="true"><span /></div>
            <h2>{phase === 'connected' ? '暂无任务' : '正在等待 Codex'}</h2>
            <p>{phase === 'connected' ? '创建任务，或等待电脑端的任务同步到这里。' : '连接就绪后，历史任务会自动显示。'}</p>
          </div>
        ) : !filtered.length ? (
          <div className="empty-state"><h2>没有匹配的对话</h2><button className="secondary-button" onClick={() => { setQuery(''); setFilter('全部项目'); }}>查看全部项目</button></div>
        ) : flatList ? recent.map(thread => (
          <div key={thread.id} className="recent-thread"><small>{(thread.projectless || !thread.cwd) ? NO_PROJECT : projectName(thread.cwd)}</small>
            <ThreadRow thread={thread} childrenByParent={emptyChildren} depth={0} onSelect={onSelect} expandedParents={expandedParents} onToggleChildren={toggleChildren} />
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
          return (
            <section className={`project-group ${collapsed ? 'project-group-collapsed' : ''}`} key={cwd}>
              <header className="project-heading">
                <button className="project-new" type="button" aria-label={`在 ${projectName(cwd)} 新建对话`} disabled={phase !== 'connected'} onClick={() => onCreate(cwd === NO_PROJECT ? undefined : cwd)}><PlusIcon /></button>
                <button
                  className="project-heading-button"
                  type="button"
                  onClick={() => toggleProject(cwd, items)}
                  aria-expanded={!collapsed}
                  aria-label={`${projectName(cwd)}，${items.length} 个任务，${collapsed ? '展开目录' : '折叠目录'}`}
                >
                  <span className="project-heading-copy">
                    <strong>{projectName(cwd)}</strong>
                    {cwd !== NO_PROJECT && <code title={cwd}>{compactPath(cwd)}</code>}
                  </span>
                  <span className="project-heading-meta">
                    <span className="project-task-count">{items.length}</span>
                    <span className="project-chevron" aria-hidden="true">{collapsed ? '⌄' : '⌃'}</span>
                  </span>
                </button>
                {cwd !== NO_PROJECT && <button className="project-hide" type="button" aria-label={`${projectName(cwd)} 的项目菜单`} aria-expanded={projectMenu === cwd} onClick={() => setProjectMenu(projectMenu === cwd ? null : cwd)}>⋯</button>}
              </header>
              {projectMenu === cwd && <div className="project-menu-actions">
                <button type="button" onClick={() => { hidden.setHidden(cwd, true); setProjectMenu(null); }}>仅在本机隐藏此项目</button>
              </div>}
              {!collapsed && (
                <div className="project-threads">
                  {roots.map((thread) => (
                    <ThreadRow key={thread.id} thread={thread} childrenByParent={childrenByParent} depth={0} onSelect={onSelect} expandedParents={expandedParents} onToggleChildren={toggleChildren} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </section>
      {footer}
    </main>
  );
}
