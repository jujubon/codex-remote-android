import { useMemo, type ReactNode } from 'react';
import { normalizeLocalUrl, type RemoteConfig } from '../lib/configStore';
import type { ConnectionPhase } from '../types/protocol';
import { useDeviceStatus } from '../hooks/useDeviceStatus';
import { ConnectionStatus } from './ConnectionStatus';
import { PhoneReader } from './CrossNetworkReader';
import { DeviceTools } from './DeviceTools';
import { MonitorIcon, SettingsIcon } from './Icons';
import type { InboxFile } from '../lib/deviceTools';
import { ConnectionDiagnostics, UpdatePanel } from './ComputerUtilities';
import { InboxPanel } from './InboxPanel';

export function ComputerScreen({ config, connectionUrl, phase, detail, hostVersion, checkSync, onUseInbox, onReconnect, onSettings, footer, notice }: {
  config: RemoteConfig;
  connectionUrl?: string;
  phase: ConnectionPhase;
  detail: string;
  hostVersion: string;
  checkSync: () => Promise<void>;
  onUseInbox: (file: InboxFile) => void;
  onReconnect: () => void;
  onSettings: () => void;
  footer: ReactNode;
  notice: ReactNode;
}) {
  const active = connectionUrl || config.serverUrl;
  const endpoint = URL.canParse(active) ? new URL(active).host : '';
  const deviceConfig = useMemo(() => active === config.serverUrl ? config : { ...config, serverUrl: active }, [config, active]);
  const connected = phase === 'connected';
  const routeLabel = useMemo(() => {
    if (!connected) return '尝试连接 · ';
    const address = active.replace(/^ws(s?):/i, 'http$1:');
    try { if (normalizeLocalUrl(address)) return '局域网直连 · '; } catch { /* Non-LAN address. */ }
    return /^(http|ws):\/\//i.test(active) ? '直连 · ' : '固定域名 · ';
  }, [active, connected]);
  const { status, updateStatus } = useDeviceStatus(deviceConfig, connected, true);
  return <main className="app-screen computer-screen">
    <header className="top-bar computer-top-bar">
      <span className="project-symbol"><MonitorIcon /></span>
      <h1>电脑</h1>
      <button className="icon-button nav-icon-button" type="button" onClick={onSettings} aria-label="连接设置"><SettingsIcon /></button>
    </header>
    <div className="computer-scroll">
      <section className="computer-connection" aria-label="连接状态">
        <ConnectionStatus phase={phase} detail={detail} onReconnect={onReconnect} />
        {endpoint && <span>{routeLabel}{endpoint}</span>}
        <ConnectionDiagnostics key={`${phase}:${active}`} config={deviceConfig} sync={checkSync} />
      </section>
      <PhoneReader config={config} deviceConfig={deviceConfig} desktop={status?.reader} supported={status?.supported} />
      <DeviceTools config={deviceConfig} status={status} updateStatus={updateStatus} />
      <InboxPanel key={active} config={deviceConfig} onUse={onUseInbox} />
      <UpdatePanel hostVersion={hostVersion} />
    </div>
    {notice && <div className="home-notice">{notice}</div>}
    {footer}
  </main>;
}
