import type { AccountUsage } from '../types/protocol';
import { ChevronDownIcon } from './Icons';

function windowName(minutes: number | null) {
  if (!minutes) return '额度窗口';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

export function AccountUsagePanel({ usage, status, refresh }: {
  usage: AccountUsage | null; status: string; refresh: () => void;
}) {
  return <details className="account-usage" onToggle={event => { if (event.currentTarget.open) refresh(); }}>
    <summary>账号与额度<ChevronDownIcon aria-hidden="true" /></summary>
    <div className="usage-heading"><strong>{usage?.plan?.toUpperCase() || 'Codex'}</strong>
      <button type="button" className="secondary-button" disabled={status === '正在读取额度…'} onClick={refresh}>刷新</button></div>
    {status && <p role="status">{status}</p>}
    {usage?.windows.map((w, i) => <div className="usage-window" key={i}>
      <span>{w.group} · {windowName(w.minutes)}</span><strong>剩余 {w.remainingPercent}%</strong>
      <progress value={w.remainingPercent} max={100} />
      {w.resetsAt && <small>{new Date(w.resetsAt).toLocaleString()} 重置</small>}
    </div>)}
    {usage && !usage.windows.length && <p>电脑未提供额度窗口。</p>}
    {usage && <small>上次读取于 {new Date(usage.checkedAt).toLocaleString()}</small>}
  </details>;
}
