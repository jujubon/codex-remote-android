import type { CSSProperties } from 'react';
import type { Assistant } from '../types/protocol';
import { ChatIcon, FolderIcon, MailIcon, MonitorIcon } from './Icons';

export type HomePage = Assistant | 'computer' | 'mail';

const homeTabs = [
  { page: 'codex', label: 'Codex', Icon: FolderIcon },
  { page: 'antigravity', label: 'Antigravity', Icon: ChatIcon },
  { page: 'mail', label: '邮件', Icon: MailIcon },
  { page: 'computer', label: '电脑', Icon: MonitorIcon },
] as const;

export function HomeNav({ page, onNavigate }: { page: HomePage; onNavigate: (page: HomePage) => void }) {
  return <nav className="home-nav" aria-label="主导航"
    style={{ '--nav-index': homeTabs.findIndex(tab => tab.page === page) } as CSSProperties}>
    {homeTabs.map(({ page: target, label, Icon }) => (
      <button key={target} type="button" aria-current={page === target ? 'page' : undefined} onClick={() => onNavigate(target)}>
        <Icon aria-hidden="true" /> <span>{label}</span>
      </button>
    ))}
  </nav>;
}
