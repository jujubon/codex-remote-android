import { Capacitor, registerPlugin } from '@capacitor/core';
import { useEffect, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, type DeviceStatus } from '../lib/deviceTools';

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

export function PhoneReader({ config, connected }: { config: RemoteConfig; connected: boolean }) {
  const [status, setStatus] = useState<ReaderState>({ state: 'idle' });
  const [desktop, setDesktop] = useState<DeviceStatus['reader']>();
  const [configureRemote, setConfigureRemote] = useState(false);
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
  const localActive = connected && desktop?.localActive;
  const remoteReady = connected && desktop?.remoteReady;
  const showRemote = active || ((configureRemote || remoteReady) && !localActive);

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

  useEffect(() => {
    setDesktop(undefined);
    if (!native || !connected) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (!document.hidden) {
        const next = await deviceRequest<DeviceStatus>(config, 'status').catch(() => undefined);
        if (mounted) setDesktop(next?.reader);
      }
      if (mounted) timer = setTimeout(() => void refresh(), 4000);
    }
    void refresh();
    return () => { mounted = false; clearTimeout(timer); };
  }, [config, native, connected]);

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
        await reader.start({ address: endpoint.origin, target: allowControls ? target : undefined });
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

  return <section className="computer-reader">
    <h2>手机阅读窗</h2>
    {active ? <p>跨网投屏</p> : localActive
      ? <p role="status">本地 Wi-Fi 投屏中。在电脑关闭小窗可结束。</p>
      : <p>同一 Wi-Fi 时，在 Windows 打开「手机阅读窗」。已配对的手机可直接连接。</p>}
    {native && !active && !localActive && !showRemote && <div>
      <button type="button" className="secondary-button" onClick={() => setConfigureRemote(true)}>跨网投屏</button>
    </div>}
    {native && showRemote && !active && <>
      <p>{remoteReady
        ? '电脑已打开跨网窗口。可以在手机上确认共享。'
        : '先在电脑的「手机阅读窗」点「改用跨网」。'}</p>
      {!canShare && <p>请先在连接设置填入 HTTPS 隧道地址。</p>}
    </>}
    {native && showRemote && canShare && !active && <div className="computer-reader-controls">
      <label className="computer-reader-toggle">
        <input type="checkbox" checked={allowControls} disabled={pending}
          onChange={event => enableControls(event.target.checked)} />
        允许电脑翻页
      </label>
      {allowControls && <>
        <p>电脑可在所选 App 内滑动翻页。确认投屏后，保持手机解锁并打开该 App。</p>
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
      </>}
    </div>}
    {native && showRemote && <div>
      <button className={active ? 'secondary-button' : 'primary-button'} type="button"
        disabled={pending || (!active && (!canShare || (allowControls && !canControl)))} onClick={() => void toggle()}>
        {active ? '停止投屏' : '开始跨网投屏'}
      </button>
    </div>}
    {(feedback || status.detail || active) && <p role="status">
      {feedback || status.detail || (status.state === 'sharing' ? '正在共享屏幕。' : '正在连接电脑阅读窗…')}
    </p>}
  </section>;
}
