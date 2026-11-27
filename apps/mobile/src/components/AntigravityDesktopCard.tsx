import { useState } from 'react';
import { openAntigravityPortal } from '../lib/antigravityPortal';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest } from '../lib/deviceTools';
import { ComputerCardHeading } from './ComputerCardHeading';
import { MonitorIcon } from './Icons';

export function AntigravityDesktopCard({ config, connected, installed }: {
  config: RemoteConfig;
  connected: boolean;
  installed?: boolean;
}) {
  const [busy, setBusy] = useState<'desktop' | 'remote'>();
  const [feedback, setFeedback] = useState<{ text: string; tone: 'success' | 'error' }>();

  async function startDesktop() {
    setBusy('desktop');
    setFeedback(undefined);
    try {
      const result = await deviceRequest<{ ok?: boolean }>(config, 'antigravity/open');
      if (result.ok !== true) throw new Error('电脑未确认启动请求。');
      setFeedback({ text: '已请求电脑打开 Antigravity。设备上线后即可进入远程控制。', tone: 'success' });
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : '暂时无法启动桌面版，请重试。', tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  }

  async function openRemote() {
    setBusy('remote');
    setFeedback(undefined);
    try {
      await openAntigravityPortal();
    } catch (error) {
      setFeedback({ text: (error as Error).message, tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  }

  return <section className="computer-utility" aria-label="Antigravity 桌面对话">
    <ComputerCardHeading title="Antigravity 桌面对话" icon={<MonitorIcon />} />
    <div className="device-actions">
      <button type="button" className="secondary-button" disabled={!connected || installed === false || Boolean(busy)}
        onClick={() => void startDesktop()}>{busy === 'desktop' ? '正在启动…' : '启动电脑桌面版'}</button>
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void openRemote()}>打开远程控制</button>
    </div>
    <p className="computer-feedback" data-tone={feedback?.tone} role="status">{feedback?.text ?? (
      installed === false ? '电脑上未找到 Antigravity 桌面版。' : '用同一 Google 账号查看电脑上的 Antigravity 项目和对话。'
    )}</p>
  </section>;
}
