import type { AccountUsage } from '../types/protocol';
import type { RemoteConfig } from '../lib/configStore';
import { ChevronDownIcon } from './Icons';
import { UsageResetCards } from './UsageResetCards';

function windowName(minutes: number | null) {
  if (!minutes) return '额度窗口';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

export function AccountUsagePanel({ usage, status, refresh, expanded = false, assistantName = 'Codex', resetConfig, onReset }: {
  usage: AccountUsage | null; status: string; refresh: () => void; expanded?: boolean; assistantName?: string;
  resetConfig?: RemoteConfig; onReset?: () => void;
}) {
  const content = <>
    <div className="usage-heading"><strong>{usage?.plan?.toUpperCase() || assistantName}</strong>
      <button type="button" className="secondary-button" disabled={status === '正在读取额度…'} onClick={refresh}>刷新</button></div>
    {status && <p role="status">{status}</p>}
    {usage?.windows.map((w, i) => <div className="usage-window" key={i}>
      <span>{w.group} · {windowName(w.minutes)}</span><strong>剩余 {w.remainingPercent}%</strong>
      <progress aria-label={`${w.group} · ${windowName(w.minutes)}剩余额度`} value={w.remainingPercent} max={100} />
      {w.resetsAt && <small>{new Date(w.resetsAt).toLocaleString()} 重置</small>}
    </div>)}
    {usage && !usage.windows.length && <p>电脑未提供额度窗口。</p>}
    {resetConfig && (usage?.resetCredits
      ? <UsageResetCards resets={usage.resetCredits} config={resetConfig} refresh={onReset ?? refresh} />
      : usage && <p className="usage-reset-unavailable">当前额度接口未返回重置卡信息。</p>)}
    {usage && <small>上次读取于 {new Date(usage.checkedAt).toLocaleString()}</small>}
  </>;
  return expanded ? <section className="account-usage account-usage-expanded">{content}</section> :
    <details className="account-usage" onToggle={event => { if (event.currentTarget.open) refresh(); }}>
      <summary>账号与额度<ChevronDownIcon aria-hidden="true" /></summary>{content}
    </details>;
}
