import type { AccountUsage } from '../types/protocol';
import type { RemoteConfig } from '../lib/configStore';
import { formatQuotaTime, usageWindowName } from '../lib/usageDisplay';
import { GaugeIcon, UpdateIcon } from './Icons';
import { UsageResetCards } from './UsageResetCards';
import { CockpitAccountSwitch } from './CockpitAccountSwitch';

export function AccountUsagePanel({ usage, status, refresh, resetConfig, onReset }: {
  usage: AccountUsage | null; status: string; refresh: () => void;
  resetConfig?: RemoteConfig; onReset?: () => void;
}) {
  return <section className="account-usage" aria-label="账号与额度">
    <div className="usage-card">
      <div className="usage-heading">
        <div className="usage-title">
          <GaugeIcon aria-hidden="true" />
          <h3>账号与额度</h3>
          {usage?.plan && <span className="usage-plan">{usage.plan.toUpperCase()}</span>}
        </div>
        <button type="button" className="nav-icon-button usage-icon-button" aria-label="刷新额度"
          disabled={status.startsWith('正在')} onClick={refresh}><UpdateIcon aria-hidden="true" /></button>
      </div>
      {status && <p role="status" className="usage-note">{status}</p>}
      {!!usage?.windows.length && <ul className="usage-windows">{usage.windows.map((window, index) => {
        const name = `${window.group} · ${usageWindowName(window.minutes)}`;
        return <li className="usage-window" key={index}>
          <div className="usage-heading"><span>{name}</span><strong>{window.remainingPercent}%</strong></div>
          <progress aria-label={`${name}剩余额度`} aria-valuetext={`剩余 ${window.remainingPercent}%`} value={window.remainingPercent} max={100} />
          {window.resetsAt && <small>{formatQuotaTime(window.resetsAt)} 重置</small>}
        </li>;
      })}</ul>}
      {usage && !usage.windows.length && <p className="usage-note">电脑未提供额度窗口。</p>}
      {usage && <small className="usage-note">更新于 {formatQuotaTime(usage.checkedAt)}</small>}
    </div>
    {resetConfig && usage?.resetCredits && <UsageResetCards resets={usage.resetCredits} config={resetConfig} refresh={onReset ?? refresh} />}
    {resetConfig && usage && !usage.resetCredits && <p className="usage-note">当前额度接口未返回重置卡信息。</p>}
    {resetConfig && <CockpitAccountSwitch key={resetConfig.serverUrl} config={resetConfig} onVerified={onReset ?? refresh} />}
  </section>;
}
