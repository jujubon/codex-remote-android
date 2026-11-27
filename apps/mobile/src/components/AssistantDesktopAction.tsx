import { useMemo, useRef, useState } from 'react';
import { useDeviceStatus } from '../hooks/useDeviceStatus';
import { openAntigravityPortal } from '../lib/antigravityPortal';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, type CodexDesktopState } from '../lib/deviceTools';
import type { Assistant } from '../types/protocol';
import { CloseIcon, MonitorIcon } from './Icons';

export function AssistantDesktopAction({ assistant, config, connectionUrl, connected }: {
  assistant: Assistant; config: RemoteConfig; connectionUrl?: string; connected: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');
  const deviceConfig = useMemo(() => connectionUrl && connectionUrl !== config.serverUrl
    ? { ...config, serverUrl: connectionUrl } : config, [config, connectionUrl]);
  const { status, updateCodexDesktop } = useDeviceStatus(deviceConfig, connected, true);
  const codex = assistant === 'codex';
  const opened = connected && (codex ? status?.codexDesktop === 'open' : status?.antigravityDesktopOpen === true);
  const available = connected && (codex ? status?.codexDesktop !== 'unavailable' : status?.antigravityDesktopInstalled !== false);
  const starting = busy || (codex ? status?.codexDesktop === 'starting' : launching && !opened);
  const title = codex ? 'Codex 桌面' : 'Antigravity 桌面对话';
  const label = codex ? '桌面' : '桌面对话';

  async function openPortal() {
    setError('');
    try {
      await openAntigravityPortal();
      dialog.current?.close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法打开桌面对话，请重试。');
      dialog.current?.showModal();
    }
  }

  async function start() {
    setBusy(true);
    setError('');
    try {
      if (codex) {
        const result = await deviceRequest<{ codexDesktop: CodexDesktopState }>(deviceConfig, 'codex/open');
        updateCodexDesktop(result.codexDesktop);
      } else {
        await deviceRequest(deviceConfig, 'antigravity/open');
        setLaunching(true);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '暂时无法启动桌面，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button className="manage-button assistant-desktop-link" type="button" aria-label={title}
      onClick={() => {
        setError('');
        if (!codex && opened) void openPortal();
        else dialog.current?.showModal();
      }}>
      <MonitorIcon /><span>{label}</span>{opened && <i aria-label="已打开" />}
    </button>
    <dialog className="session-dialog" ref={dialog} aria-labelledby="assistant-desktop-title"
      onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="session-sheet assistant-desktop-sheet">
        <header className="sheet-title-row">
          <h2 id="assistant-desktop-title">{title}</h2>
          <button type="button" className="nav-icon-button" aria-label="关闭桌面操作" onClick={() => dialog.current?.close()}><CloseIcon /></button>
        </header>
        <p className="computer-feedback" role="status">{!connected ? '配套服务未连接。'
          : !available ? '电脑上未找到桌面应用。'
          : opened ? '桌面已打开。'
          : starting ? (codex ? '正在启动…' : '已请求启动。Google 显示设备在线后，即可进入桌面对话。')
          : '可以从这里启动电脑上的桌面应用。'}</p>
        {error && <p className="computer-feedback" data-tone="error" role="alert">{error}</p>}
        <div className="device-actions">
          {available && !opened && <button className={codex || !launching ? 'primary-button' : 'secondary-button'} type="button"
            disabled={busy || (codex && starting)} onClick={() => void start()}>
            {busy || (codex && starting) ? '正在启动…' : launching ? '重新启动请求' : '启动桌面'}
          </button>}
          {!codex && (opened || launching || !available) && <button className="primary-button" type="button"
            onClick={() => void openPortal()}>进入桌面对话</button>}
        </div>
      </div>
    </dialog>
  </>;
}
