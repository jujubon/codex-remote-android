import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest } from '../lib/deviceTools';
import { ChevronDownIcon, UpdateIcon } from './Icons';

type Account = { key: string; label: string; plan?: string; current: boolean };
type Operation = { id: string; stage: 'switching' | 'verified' | 'unverified' | 'failed'; message?: string };

export function CockpitAccountSwitch({ config: { serverUrl, pairingToken }, onVerified }: { config: RemoteConfig; onVerified: () => void }) {
  const config = useMemo(() => ({ serverUrl, pairingToken }), [serverUrl, pairingToken]);
  const [expanded, setExpanded] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>();
  const [selected, setSelected] = useState<Account>();
  const [job, setJob] = useState<Operation>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const latestOnVerified = useRef(onVerified);
  latestOnVerified.current = onVerified;
  const switching = job?.stage === 'switching';

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const list = await deviceRequest<{ accounts: Account[]; operation?: Operation }>(config, 'cockpit/accounts');
      setAccounts(list.accounts);
      setJob(list.operation);
    } catch (failure) {
      setAccounts(undefined);
      setAccountError(failure);
    } finally { setBusy(false); }
  }, [config]);

  useEffect(() => { void refresh(); }, [refresh]);

  function setAccountError(failure: unknown) {
    setError(failure instanceof Error ? failure.message : '暂时无法连接 Cockpit Tools。');
  }

  async function switchAccount(account: Account) {
    if (busy || switching) return;
    setBusy(true);
    setError('');
    try {
      const result = await deviceRequest<Operation>(config, 'cockpit/switch', { key: account.key, confirm: true });
      setJob(result);
      setSelected(undefined);
    } catch (failure) { setAccountError(failure); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!switching) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 200_000;
    async function poll() {
      const result = await deviceRequest<{ operation?: Operation }>(config, 'cockpit/status').catch(() => undefined);
      if (!active) return;
      const next = result?.operation;
      if (next?.id === job?.id && next && next.stage !== 'switching') {
        setJob(next);
        if (next.stage === 'verified' || next.stage === 'unverified') {
          if (next.stage === 'verified') latestOnVerified.current();
          void refresh();
        }
        return;
      }
      if ((result && next?.id !== job?.id) || Date.now() >= deadline) {
        setJob(undefined);
        setError('暂未确认切换结果，请刷新列表或在电脑上核对。');
        return;
      }
      timer = setTimeout(() => void poll(), 1500);
    }
    timer = setTimeout(() => void poll(), 1200);
    return () => { active = false; clearTimeout(timer); };
  }, [config, job?.id, refresh, switching]);

  const status = switching ? '正在切换并重新连接 Codex…'
    : job?.stage === 'verified' ? '手机端已验证新账号。若电脑桌面仍显示旧账号，关闭并重新打开 Codex Desktop。'
    : job?.stage === 'unverified' ? 'Cockpit 已应用切换。当前账号暂未验证，请重新打开 Codex Desktop 并核对。'
    : job?.message;

  return <section className="cockpit-accounts" aria-busy={busy || switching}>
    <div className="usage-heading">
      <div className="cockpit-heading"><h3>Codex 账号</h3><small>Cockpit Tools</small></div>
      <div className="cockpit-actions">
        {expanded && !selected && <button className="nav-icon-button usage-icon-button" type="button" aria-label="刷新账号列表"
          disabled={busy || switching} onClick={() => void refresh()}><UpdateIcon aria-hidden="true" /></button>}
        <button className="nav-icon-button usage-icon-button cockpit-toggle" type="button" aria-expanded={expanded}
          aria-label={expanded ? '收起 Codex 账号' : '展开 Codex 账号'} onClick={() => setExpanded(value => !value)}>
          <ChevronDownIcon aria-hidden="true" />
        </button>
      </div>
    </div>
    {expanded && <div className="cockpit-accounts-body">
      {(error || status) && <p className="computer-feedback" data-tone={error || job?.stage === 'failed' ? 'error' : undefined} role="status">{error || status}</p>}
      {selected ? <div className="cockpit-confirm">
        <p>切换到 <strong>{selected.label}</strong>？请先结束电脑上正在运行的 Codex 任务。</p>
        <div className="startup-update-buttons">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setSelected(undefined)}>取消</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void switchAccount(selected)}>确认切换</button>
        </div>
      </div> : <>
        {accounts?.length ? <ul className="cockpit-account-list">{accounts.map(account => <li key={account.key}>
          <span><strong>{account.label}</strong>{account.plan && <small>{account.plan.toUpperCase()}</small>}</span>
          {account.current ? <small className="computer-status-pill" data-tone="success">当前</small>
            : <button className="secondary-button" type="button" disabled={busy || switching} onClick={() => {
              setError('');
              setSelected(account);
            }}>选用</button>}
        </li>)}</ul> : !error && <p className="usage-note" role="status">{busy ? '正在读取账号…' : 'Cockpit Tools 中没有已保存的 Codex 账号。'}</p>}
      </>}
    </div>}
  </section>;
}
