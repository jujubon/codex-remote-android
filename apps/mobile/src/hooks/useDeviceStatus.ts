import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, type DeviceStatus } from '../lib/deviceTools';

export function useDeviceStatus(config: RemoteConfig, connected: boolean, watchReader = false) {
  const [status, setStatus] = useState<DeviceStatus>();
  const revision = useRef(0);
  const updateStatus = useCallback((next: DeviceStatus) => {
    revision.current++;
    setStatus(previous => ({ ...next, reader: next.reader ?? previous?.reader }));
  }, []);
  const poll = watchReader || Boolean(status?.awakeUntil);

  useEffect(() => { setStatus(undefined); }, [config]);
  useEffect(() => {
    if (!connected) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!document.hidden) {
        const before = revision.current;
        const next = await deviceRequest<DeviceStatus>(config, 'status').catch(() => undefined);
        if (active && next && before === revision.current) setStatus(next);
      }
      if (active && poll) timer = setTimeout(() => void refresh(), 5000);
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [config, connected, poll]);

  return { status, updateStatus };
}
