import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [request, setRequest] = useState<'open' | 'close'>();
  const [pending, setPending] = useState<'open' | 'close'>();
  const [confirmClose, setConfirmClose] = useState(false);
  const [error, setError] = useState('');
  const deviceConfig = useMemo(() => connectionUrl && connectionUrl !== config.serverUrl
    ? { ...config, serverUrl: connectionUrl } : config, [config, connectionUrl]);
  const { status, updateCodexDesktop } = useDeviceStatus(deviceConfig, connected, true);
  const codex = assistant === 'codex';
  const windowOpen = codex
    ? status?.codexDesktop === 'open' ? true : status?.codexDesktop === 'closed' ? false : undefined
    : status?.antigravityDesktopOpen;
  const opened = connected && windowOpen === true;
  const available = connected && (codex ? status?.codexDesktop !== 'unavailable' : status?.antigravityDesktopInstalled !== false);
  const motion = request ?? pending ?? (connected && codex && status?.codexDesktop === 'starting' ? 'open' : undefined);
  const title = codex ? 'Codex 桌面' : 'Antigravity 桌面';
  const desktopState = !connected ? 'offline' : motion ? 'pending' : opened ? 'open' : available && windowOpen === false ? 'closed' : 'offline';
  const statusText = !connected ? '配套服务未连接。'
    : !available ? '电脑上未找到桌面应用。'
    : motion === 'close' ? '正在关闭桌面…'
    : motion === 'open' ? '正在启动桌面…'
    : opened ? '桌面已打开。'
    : windowOpen === false ? '桌面未打开。' : '正在确认桌面状态…';

  useEffect(() => {
    if (!pending) return;
    if (connected && windowOpen === (pending === 'open')) {
      setPending(undefined);
      return;
    }
    const timer = setTimeout(() => {
      setPending(undefined);
      setError(pending === 'open' ? '暂未检测到桌面窗口，可再次启动。'
        : '桌面窗口仍未确认关闭，请检查电脑上是否有确认提示。');
    }, 22_000);
    return () => clearTimeout(timer);
  }, [pending, connected, windowOpen]);

  async function openPortal() {
    setError('');
    try {
      await openAntigravityPortal();
      dialog.current?.close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法打开桌面对话，请重试。');
    }
  }

  async function start() {
    setRequest('open');
    setError('');
    try {
      if (codex) {
        const result = await deviceRequest<{ codexDesktop: CodexDesktopState }>(deviceConfig, 'codex/open');
        updateCodexDesktop(result.codexDesktop);
        if (result.codexDesktop === 'starting') setPending('open');
      } else {
        await deviceRequest(deviceConfig, 'antigravity/open');
        setPending('open');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '暂时无法启动桌面，请重试。');
    } finally {
      setRequest(undefined);
    }
  }

  async function closeDesktop() {
    setConfirmClose(false);
    setRequest('close');
    setError('');
    try {
      const result = await deviceRequest<{ closing: boolean }>(deviceConfig, `${assistant}/close`);
      if (result.closing || windowOpen === true) setPending('close');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '暂时无法关闭桌面，请重试。');
    } finally {
      setRequest(undefined);
    }
  }

  return <>
    <button className="manage-button assistant-desktop-link" type="button" aria-describedby="assistant-desktop-state"
      aria-haspopup="dialog"
      onClick={() => {
        setConfirmClose(false);
        dialog.current?.showModal();
      }}>
      <MonitorIcon aria-hidden="true" /><span>启动</span><i data-state={desktopState} aria-hidden="true" />
    </button>
    <span id="assistant-desktop-state" hidden>{statusText}</span>
    <dialog className="session-dialog" ref={dialog} aria-labelledby="assistant-desktop-title"
      onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="session-sheet assistant-desktop-sheet">
        <header className="sheet-title-row">
          <h2 id="assistant-desktop-title">{title}</h2>
          <button type="button" className="nav-icon-button" aria-label="关闭桌面操作" onClick={() => dialog.current?.close()}><CloseIcon /></button>
        </header>
        <p className="computer-feedback" data-tone={desktopState === 'open' ? 'success' : undefined} role="status">{statusText}</p>
        {error && <p className="computer-feedback" data-tone="error" role="alert">{error}</p>}
        {confirmClose && opened ? <>
          <p className="assistant-close-warning">关闭窗口可能中断桌面正在运行的任务。</p>
          <div className="device-actions">
            <button className="secondary-button" type="button" onClick={() => setConfirmClose(false)}>取消</button>
            <button className="secondary-button assistant-desktop-close" type="button" onClick={() => void closeDesktop()}>确认关闭</button>
          </div>
        </> : <div className="device-actions">
          {available && !opened && <button className="primary-button" type="button"
            disabled={Boolean(motion)} onClick={() => void start()}>启动</button>}
          {!codex && <button className={opened ? 'primary-button' : 'secondary-button'} type="button"
            disabled={motion === 'close'} onClick={() => void openPortal()}>进入桌面对话</button>}
          {opened && status?.desktopCloseSupported && <button className="secondary-button assistant-desktop-close" type="button"
            disabled={Boolean(motion)} onClick={() => setConfirmClose(true)}>关闭桌面</button>}
        </div>}
      </div>
    </dialog>
  </>;
}
