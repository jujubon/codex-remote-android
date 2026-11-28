import { useState } from 'react';
import type { GitDiffSnapshot } from '../types/protocol';
import { DiffView } from './DiffView';
import { ChevronDownIcon, FolderIcon, UpdateIcon } from './Icons';

interface GitDiffPanelProps {
  snapshot: GitDiffSnapshot | null;
  onRefresh: () => void;
}

export function shouldShowGitDiff(snapshot: GitDiffSnapshot | null): boolean {
  return Boolean(snapshot?.repositoryRoot && (snapshot.files > 0 || snapshot.error || snapshot.truncated));
}

export function GitDiffPanel({ snapshot, onRefresh }: GitDiffPanelProps) {
  const [expanded, setExpanded] = useState(false);
  if (!shouldShowGitDiff(snapshot)) return null;
  return (
    <section className="git-diff-panel" aria-label="Git 变更">
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary aria-label={`Git 变更，${expanded ? '收起' : '展开'}`}>
          <span className="git-diff-icon"><FolderIcon aria-hidden="true" /></span>
          <span className="git-diff-title">
            <strong>Git 变更</strong>
            <span className="git-diff-counts">
              {snapshot && !snapshot.error ? <><b>{snapshot.files} 个文件</b><i>+{snapshot.additions}</i><em>−{snapshot.deletions}</em></> : <b>未载入</b>}
            </span>
          </span>
          <ChevronDownIcon className="git-diff-disclosure" aria-hidden="true" />
        </summary>
        {expanded && <div className="git-diff-content">
          <header>
            <div>
              <strong title={snapshot?.repositoryRoot}>{snapshot?.repositoryRoot}</strong>
              <small>{snapshot?.generatedAt ? `更新于 ${new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未刷新'}{snapshot?.truncated ? ' · 已截断' : ''}</small>
            </div>
            <button type="button" className="nav-icon-button usage-icon-button" aria-label="刷新 Git 变更" onClick={onRefresh}><UpdateIcon aria-hidden="true" /></button>
          </header>
          <div className="git-diff-scroll" tabIndex={0} aria-label="Git 变更文件，可上下滚动">
            {snapshot?.error ? <p className="git-diff-error">{snapshot.error}</p> : <DiffView diff={snapshot?.diff ?? ''} />}
          </div>
        </div>}
      </details>
    </section>
  );
}
