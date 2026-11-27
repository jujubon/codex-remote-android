import { useEffect, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, type CodexDesktopState } from '../lib/deviceTools';
import { ComputerCardHeading } from './ComputerCardHeading';
import { MonitorIcon } from './Icons';

const stateLabels: Record<CodexDesktopState, string> = {
  unavailable: '未安装',
  closed: '未打开',
  starting: '正在启动…',
  open: '已打开',
};

export function CodexDesktopCard({ config, connected, state, onState }: {
  config: RemoteConfig;
  connected: boolean;
  state?: CodexDesktopState;
  onState: (state: CodexDesktopState) => void;
}) {
  const [sending, setSending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState('');
  const displayState = !connected ? '电脑未连接' : sending ? stateLabels.starting : state ? stateLabels[state] : '待确认';

  useEffect(() => {
    if (state === 'open') setAttempted(false);
  }, [state]);

  async function start() {
    setSending(true);
    setAttempted(false);
    setError('');
    try {
      const result = await deviceRequest<{ codexDesktop?: CodexDesktopState }>(config, 'codex/open');
      if (result.codexDesktop !== 'starting' && result.codexDesktop !== 'open') throw new Error('电脑未确认启动请求。');
      onState(result.codexDesktop);
      setAttempted(result.codexDesktop === 'starting');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '暂时无法启动 Codex Desktop。');
    } finally {
      setSending(false);
    }
  }

  const feedback = error || (connected && attempted && state === 'closed' ? '暂未检测到 Codex 窗口，可再次启动。' : '');
  return <section className="computer-utility" aria-label="Codex Desktop">
    <ComputerCardHeading title="Codex Desktop" icon={<MonitorIcon />}>
      <span className="computer-status-pill" data-tone={connected && state === 'open' ? 'success' : undefined} role="status">{displayState}</span>
    </ComputerCardHeading>
    {connected && state !== 'unavailable' && state !== 'open' && <div className="device-actions">
      <button type="button" className="secondary-button" disabled={sending || state === 'starting'} onClick={() => void start()}>
        {sending || state === 'starting' ? '正在启动…' : '启动电脑 Codex'}
      </button>
    </div>}
    {feedback && <p className="computer-feedback" data-tone="error" role="status">{feedback}</p>}
  </section>;
}
