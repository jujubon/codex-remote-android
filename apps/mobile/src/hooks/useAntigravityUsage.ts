import { useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest } from '../lib/deviceTools';
import type { AccountUsage } from '../types/protocol';

export function useAntigravityUsage(config: RemoteConfig | null | undefined, connectionUrl: string | undefined, connected: boolean) {
  const [snapshot, setSnapshot] = useState<{ owner: RemoteConfig; usage: AccountUsage | null; status: string }>();
  const inFlight = useRef<RemoteConfig | null>(null);
  const current = snapshot?.owner === config ? snapshot : undefined;

  async function refresh() {
    if (!config || inFlight.current === config) return;
    const usage = current?.usage ?? null;
    if (!connected) {
      setSnapshot({ owner: config, usage, status: '连接电脑后可刷新额度。' });
      return;
    }
    inFlight.current = config;
    setSnapshot({ owner: config, usage, status: '正在读取额度…' });
    try {
      const next = await deviceRequest<AccountUsage>({ ...config, serverUrl: connectionUrl || config.serverUrl }, 'antigravity/usage');
      if (!Array.isArray(next.windows) || !next.windows.length) throw new Error('电脑未返回 Antigravity 额度。');
      if (inFlight.current === config) setSnapshot({ owner: config, usage: next, status: '' });
    } catch (error) {
      if (inFlight.current === config) setSnapshot({ owner: config, usage, status: error instanceof Error ? error.message : '暂时无法读取额度。' });
    } finally {
      if (inFlight.current === config) inFlight.current = null;
    }
  }

  return { usage: current?.usage ?? null, status: current?.status ?? '', refresh };
}
