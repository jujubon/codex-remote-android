import type { Assistant } from '../types/protocol';
import { ChatIcon, FolderIcon, MailIcon, MonitorIcon } from './Icons';

export type HomePage = Assistant | 'computer' | 'mail';

export function HomeNav({ page, onNavigate }: { page: HomePage; onNavigate: (page: HomePage) => void }) {
  return <nav className="home-nav" aria-label="主导航">
    <button type="button" aria-current={page === 'codex' ? 'page' : undefined} onClick={() => onNavigate('codex')}>
      <FolderIcon aria-hidden="true" /> <span>Codex</span>
    </button>
    <button type="button" aria-current={page === 'antigravity' ? 'page' : undefined} onClick={() => onNavigate('antigravity')}>
      <ChatIcon aria-hidden="true" /> <span>Antigravity</span>
    </button>
    <button type="button" aria-current={page === 'mail' ? 'page' : undefined} onClick={() => onNavigate('mail')}>
      <MailIcon aria-hidden="true" /> <span>邮件</span>
    </button>
    <button type="button" aria-current={page === 'computer' ? 'page' : undefined} onClick={() => onNavigate('computer')}>
      <MonitorIcon aria-hidden="true" /> <span>电脑</span>
    </button>
  </nav>;
}
