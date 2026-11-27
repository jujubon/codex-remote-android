import { useMemo, type ReactNode } from 'react';
import { normalizeLocalUrl, type RemoteConfig } from '../lib/configStore';
import type { ConnectionPhase } from '../types/protocol';
import { useDeviceStatus } from '../hooks/useDeviceStatus';
import { ConnectionStatus } from './ConnectionStatus';
import { PhoneReader } from './CrossNetworkReader';
import { DeviceTools } from './DeviceTools';
import { GaugeIcon, MonitorIcon, SettingsIcon } from './Icons';
import type { InboxFile } from '../lib/deviceTools';
import { ConnectionDiagnostics, UpdatePanel } from './ComputerUtilities';
import { InboxPanel } from './InboxPanel';
import { ComputerCardHeading } from './ComputerCardHeading';
import { AntigravityDesktopCard } from './AntigravityDesktopCard';

export function ComputerScreen({ config, connectionUrl, phase, detail, hostVersion, checkSync, onUseInbox, deleteAttachmentsAfterTurn, onChangeAttachmentCleanup, onReconnect, onSettings, footer, notice, antigravityAvailable }: {
  config: RemoteConfig;
  connectionUrl?: string;
  phase: ConnectionPhase;
  detail: string;
  hostVersion: string;
  antigravityAvailable?: boolean;
  checkSync: () => Promise<void>;
  onUseInbox: (file: InboxFile) => void;
  onReconnect: () => void;
  onSettings: () => void;
  deleteAttachmentsAfterTurn?: boolean;
  onChangeAttachmentCleanup: (enabled: boolean) => Promise<void>;
  footer: ReactNode;
  notice: ReactNode;
}) {
  const active = connectionUrl || config.serverUrl;
  const endpoint = URL.canParse(active) ? new URL(active).host : '';
  const deviceConfig = useMemo(() => active === config.serverUrl ? config : { ...config, serverUrl: active }, [config, active]);
  const connected = phase === 'connected';
  const routeLabel = useMemo(() => {
    const address = active.replace(/^ws(s?):/i, 'http$1:');
    try { if (normalizeLocalUrl(address)) return '局域网直连'; } catch { /* Non-LAN address. */ }
    return /^(http|ws):\/\//i.test(active) ? '直连' : '固定域名';
  }, [active]);
  const { status, updateStatus } = useDeviceStatus(deviceConfig, connected, true);

  return <main className="app-screen computer-screen">
    <header className="top-bar computer-top-bar">
      <span className="project-symbol"><MonitorIcon /></span>
      <h1>电脑</h1>
      <button className="icon-button nav-icon-button" type="button" onClick={onSettings} aria-label="连接设置"><SettingsIcon /></button>
    </header>
    <div className="computer-scroll">
      <section className="computer-utility computer-connection" aria-label="连接状态">
        <ComputerCardHeading title="连接状态" icon={<GaugeIcon />}>
          <ConnectionStatus phase={phase} detail={detail} onReconnect={onReconnect} compact />
        </ComputerCardHeading>
        {endpoint && <div className="computer-setting-row connection-route"><span>{routeLabel}</span><strong>{endpoint}</strong></div>}
        {detail && !connected && <p className="computer-feedback" role="status">{detail}</p>}
        <ConnectionDiagnostics key={`${phase}:${active}`} config={deviceConfig} sync={checkSync} />
      </section>
      <PhoneReader config={config} deviceConfig={deviceConfig} desktop={status?.reader} supported={status?.supported} />
      <DeviceTools config={deviceConfig} status={status} updateStatus={updateStatus} />
      <InboxPanel key={active} config={deviceConfig} onUse={onUseInbox}
        deleteAfterTurn={deleteAttachmentsAfterTurn} onChangeAttachmentCleanup={onChangeAttachmentCleanup} />
      {(antigravityAvailable || status?.antigravityDesktopInstalled) && <AntigravityDesktopCard key={active}
        config={deviceConfig} connected={connected} installed={status?.antigravityDesktopInstalled} />}
      <UpdatePanel hostVersion={hostVersion} />
    </div>
    {notice && <div className="home-notice">{notice}</div>}
    {footer}
  </main>;
}
