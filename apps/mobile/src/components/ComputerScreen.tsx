import type { ReactNode } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import type { ConnectionPhase } from '../types/protocol';
import { ConnectionStatus } from './ConnectionStatus';
import { CrossNetworkReader } from './CrossNetworkReader';
import { DeviceTools } from './DeviceTools';
import { MonitorIcon, SettingsIcon } from './Icons';

export function ComputerScreen({ config, phase, detail, onReconnect, onSettings, footer, notice }: {
  config: RemoteConfig;
  phase: ConnectionPhase;
  detail: string;
  onReconnect: () => void;
  onSettings: () => void;
  footer: ReactNode;
  notice: ReactNode;
}) {
  const endpoint = URL.canParse(config.serverUrl) ? new URL(config.serverUrl).host : '';
  return <main className="app-screen computer-screen">
    <header className="top-bar computer-top-bar">
      <span className="project-symbol"><MonitorIcon /></span>
      <h1>电脑</h1>
      <button className="icon-button nav-icon-button" type="button" onClick={onSettings} aria-label="连接设置"><SettingsIcon /></button>
    </header>
    <div className="computer-scroll">
      <section className="computer-connection" aria-label="连接状态">
        <ConnectionStatus phase={phase} detail={detail} onReconnect={onReconnect} />
        {endpoint && <span>{endpoint}</span>}
      </section>
      <CrossNetworkReader config={config} />
      <DeviceTools config={config} phase={phase} />
    </div>
    {notice && <div className="home-notice">{notice}</div>}
    {footer}
  </main>;
}
