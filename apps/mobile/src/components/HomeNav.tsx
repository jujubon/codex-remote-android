import { FolderIcon, MonitorIcon } from './Icons';

export type HomePage = 'projects' | 'computer';

export function HomeNav({ page, onNavigate }: { page: HomePage; onNavigate: (page: HomePage) => void }) {
  return <nav className="home-nav" aria-label="主导航">
    <button type="button" aria-current={page === 'projects' ? 'page' : undefined} onClick={() => onNavigate('projects')}>
      <FolderIcon /> 项目
    </button>
    <button type="button" aria-current={page === 'computer' ? 'page' : undefined} onClick={() => onNavigate('computer')}>
      <MonitorIcon /> 电脑
    </button>
  </nav>;
}
