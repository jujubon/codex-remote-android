import { Capacitor, registerPlugin } from '@capacitor/core';
import { useEffect, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, type DeviceStatus } from '../lib/deviceTools';
import { MonitorIcon } from './Icons';
import { ComputerCardHeading } from './ComputerCardHeading';

type ReaderState = { state: 'idle' | 'connecting' | 'sharing'; detail?: string; controlAvailable?: boolean };
type ReadingApp = { id: string; name: string };

const reader = registerPlugin<{
  start(options: { address: string; target?: string }): Promise<void>;
  state(): Promise<ReaderState>;
  stop(): Promise<void>;
  readingTargets(): Promise<{ apps: ReadingApp[] }>;
  openControlSettings(): Promise<void>;
}>('CrossNetworkReader');

export async function stopCrossNetworkReader() {
  if (Capacitor.getPlatform() === 'android') await reader.stop().catch(() => undefined);
}

export function PhoneReader({ config, deviceConfig = config, desktop, supported }: {
  config: RemoteConfig;
  deviceConfig?: RemoteConfig;
  desktop?: DeviceStatus['reader'];
  supported?: boolean;
}) {
  const [status, setStatus] = useState<ReaderState>({ state: 'idle' });
  const [localOpened, setLocalOpened] = useState(false);
  const [preferredMode, setPreferredMode] = useState<'wifi' | 'remote'>();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [allowControls, setAllowControls] = useState(false);
  const [apps, setApps] = useState<ReadingApp[]>([]);
  const [target, setTarget] = useState('');
  const native = Capacitor.getPlatform() === 'android';
  const endpoint = URL.canParse(config.serverUrl) ? new URL(config.serverUrl) : null;
  const canShare = endpoint?.protocol === 'https:' || endpoint?.protocol === 'wss:';
  const active = status.state !== 'idle';
  const canControl = status.controlAvailable && target;
  const localActive = localOpened || desktop?.localActive;
  const mode = active ? 'remote' : preferredMode ?? (canShare && deviceConfig.serverUrl === config.serverUrl ? 'remote' : 'wifi');

  useEffect(() => {
    if (!native || pending) return;
    let mounted = true;
    const refresh = () => reader.state().then(next => {
      if (mounted) setStatus(next);
    }).catch(() => undefined);
    void refresh();
    const timer = setInterval(() => void refresh(), 800);
    return () => { mounted = false; clearInterval(timer); };
  }, [native, pending]);

  useEffect(() => { setLocalOpened(false); }, [desktop, config]);

  async function openLocal() {
    if (pending || localActive || active || supported === false) return;
    setPending(true);
    setFeedback('正在打开 Wi-Fi 投屏…');
    try {
      await deviceRequest<{ alreadyOpen: boolean }>(deviceConfig, 'reader/open-local');
      setLocalOpened(true);
      setFeedback('');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '未确认电脑投屏窗口已打开。');
    } finally {
      setPending(false);
    }
  }

  function enableControls(checked: boolean) {
    setAllowControls(checked);
    setFeedback('');
    if (checked) void reader.readingTargets().then(({ apps }) => setApps(apps))
      .catch(() => setFeedback('无法读取手机上的 App 列表。'));
  }

  async function toggle() {
    if (!endpoint || pending) return;
    setPending(true);
    setFeedback('');
    try {
      if (active) {
        await reader.stop();
        setStatus({ state: 'idle' });
      } else {
        if (endpoint.protocol === 'wss:') endpoint.protocol = 'https:';
        setFeedback('正在电脑上打开接收窗口…');
        await deviceRequest(config, 'reader/open-remote');
        setLocalOpened(false);
        setFeedback('请在手机上确认屏幕共享。');
        await reader.start({ address: endpoint.origin, target: allowControls ? target : undefined });
        setFeedback('');
        setStatus({ state: 'connecting' });
        setAllowControls(false);
        setTarget('');
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '无法启动屏幕共享。');
    } finally {
      setPending(false);
    }
  }

  return <section className="computer-utility computer-reader">
    <ComputerCardHeading title="手机投屏" icon={<MonitorIcon />}>
      {(active || localActive) && <span className="computer-status-pill" data-tone="success">
        {active ? status.state === 'sharing' ? '跨网共享中' : '连接中' : 'Wi-Fi 投屏中'}
      </span>}
    </ComputerCardHeading>
    {!native && <p className="utility-muted">打开 Android App 即可投屏。</p>}
    {native && !active && <div className="reader-mode segmented-controls" data-selected={mode} role="group" aria-label="投屏方式">
      <button type="button" aria-pressed={mode === 'wifi'} disabled={pending} onClick={() => { setPreferredMode('wifi'); setFeedback(''); }}>同一 Wi‑Fi</button>
      <button type="button" aria-pressed={mode === 'remote'} disabled={pending} onClick={() => { setPreferredMode('remote'); setFeedback(''); }}>跨网投屏</button>
    </div>}
    {native && !active && <p className="utility-muted computer-reveal" key={mode}>{mode === 'wifi'
      ? '首次使用需在 Windows 完成无线调试配对。'
      : canShare ? '支持 5G 和不同 Wi‑Fi，手机确认后开始共享。' : '请在连接设置中填写固定 HTTPS 地址。'}</p>}
    {native && mode === 'remote' && canShare && !active && <div className="computer-reader-controls">
      <label className="computer-setting-row computer-switch">
        <span><strong>允许电脑翻页</strong></span>
        <input type="checkbox" role="switch" checked={allowControls} disabled={pending}
          onChange={event => enableControls(event.target.checked)} />
      </label>
      {allowControls && <div className="computer-reader-controls computer-reveal">
        <p className="utility-muted">共享期间请保持手机解锁，并打开所选阅读 App。</p>
        {!status.controlAvailable && <button className="secondary-button" type="button"
          onClick={() => void reader.openControlSettings().catch((error: Error) => setFeedback(error.message))}>
          开启「阅读窗翻页」无障碍权限
        </button>}
        <label className="computer-reader-target">
          阅读 App
          <select value={target} disabled={pending} onChange={event => setTarget(event.target.value)}>
            <option value="">选择阅读 App</option>
            {apps.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
          </select>
        </label>
      </div>}
    </div>}
    {native && <button className={active ? 'secondary-button reader-action' : 'primary-button reader-action'} type="button"
      disabled={pending || supported === false || (mode === 'wifi' ? !!localActive : !active && (!canShare || (allowControls && !canControl)))}
      onClick={() => void (mode === 'wifi' ? openLocal() : toggle())}>
      {active ? '停止投屏' : pending ? '正在连接电脑…' : mode === 'wifi' ? '在电脑打开 Wi-Fi 投屏' : '开始跨网投屏'}
    </button>}
    {(feedback || status.detail) && <p className="computer-feedback computer-reveal" role="status">
      {feedback || status.detail}
    </p>}
  </section>;
}
