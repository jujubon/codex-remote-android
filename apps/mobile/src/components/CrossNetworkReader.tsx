import { Capacitor, registerPlugin } from '@capacitor/core';
import { useEffect, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';

type ReaderState = { state: 'idle' | 'connecting' | 'sharing'; detail?: string };

const reader = registerPlugin<{
  start(options: { address: string }): Promise<void>;
  state(): Promise<ReaderState>;
  stop(): Promise<void>;
}>('CrossNetworkReader');

export async function stopCrossNetworkReader() {
  if (Capacitor.getPlatform() === 'android') await reader.stop().catch(() => undefined);
}

export function CrossNetworkReader({ config }: { config: RemoteConfig }) {
  const [status, setStatus] = useState<ReaderState>({ state: 'idle' });
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const native = Capacitor.getPlatform() === 'android';
  const endpoint = URL.canParse(config.serverUrl) ? new URL(config.serverUrl) : null;
  const canShare = endpoint?.protocol === 'https:' || endpoint?.protocol === 'wss:';
  const active = status.state !== 'idle';

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
        await reader.start({ address: endpoint.origin });
        setStatus({ state: 'connecting' });
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : '无法启动屏幕共享。');
    } finally {
      setPending(false);
    }
  }

  return <section className="computer-reader">
    <h2>跨网阅读窗</h2>
    <p>电脑先打开「跨网阅读窗」，再在手机上确认共享屏幕。使用 5G 时也能传送画面。</p>
    {native && !canShare && <p>请先在连接设置填入 HTTPS 隧道地址。</p>}
    {native && <div>
      <button className={active ? 'secondary-button' : 'primary-button'} type="button"
        disabled={pending || (!active && !canShare)} onClick={() => void toggle()}>
        {active ? '停止投屏' : '开始跨网投屏'}
      </button>
    </div>}
    {(feedback || status.detail || active) && <p role="status">
      {feedback || status.detail || (status.state === 'sharing' ? '正在共享屏幕。' : '正在连接电脑阅读窗…')}
    </p>}
  </section>;
}
