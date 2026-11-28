import type { AccountUsage } from '../types/protocol';
import type { RemoteConfig } from '../lib/configStore';
import { formatQuotaTime, usageWindowGroups, usageWindowName } from '../lib/usageDisplay';
import { GaugeIcon, UpdateIcon } from './Icons';
import { UsageResetCards } from './UsageResetCards';
import { CockpitAccountSwitch } from './CockpitAccountSwitch';

const groupLabels: Record<string, string> = { 'Gemini Models': 'Gemini', 'Claude and GPT models': 'Claude / GPT' };

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
      {!!usage?.windows.length && <div className="usage-groups">{usageWindowGroups(usage.windows).map(group => {
        const title = Object.hasOwn(groupLabels, group.name) ? groupLabels[group.name] : group.name;
        return <section className="usage-group" key={group.name} aria-label={title}>
          <h4>{title}</h4>
          <ul className="usage-windows">{group.windows.map((window, index) => {
            const duration = usageWindowName(window.minutes);
            return <li className="usage-window" key={`${window.minutes}-${index}`}>
              <div className="usage-heading"><span>{duration}</span><strong>{window.remainingPercent}%</strong></div>
              <progress aria-label={`${title} ${duration}剩余额度`} aria-valuetext={`剩余 ${window.remainingPercent}%`} value={window.remainingPercent} max={100} />
              {window.resetsAt && <small>{formatQuotaTime(window.resetsAt)} 重置</small>}
            </li>;
          })}</ul>
        </section>;
      })}</div>}
      {usage && !usage.windows.length && <p className="usage-note">电脑未提供额度窗口。</p>}
      {usage && <small className="usage-note">更新于 {formatQuotaTime(usage.checkedAt)}</small>}
    </div>
    {resetConfig && usage?.resetCredits && <UsageResetCards resets={usage.resetCredits} config={resetConfig} refresh={onReset ?? refresh} />}
    {resetConfig && usage && !usage.resetCredits && <p className="usage-note">当前额度接口未返回重置卡信息。</p>}
    {resetConfig && <CockpitAccountSwitch key={resetConfig.serverUrl} config={resetConfig} onVerified={onReset ?? refresh} />}
  </section>;
}
