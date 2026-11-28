import { useEffect, useRef, useState } from 'react';
import { afterDialogClose } from '../lib/dialogMotion';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { RemoteConfig } from '../lib/configStore';
import type { ConnectionPhase } from '../types/protocol';
import { useDeviceStatus } from '../hooks/useDeviceStatus';
import { deviceRequest, QUICK_SHARE_KEY, readPhoneClipboard, shareFileToComputer, writePhoneClipboard, type DeviceStatus, type HoldDuration } from '../lib/deviceTools';
import { ClipboardIcon, CloseIcon, MonitorIcon, PowerIcon, ShieldIcon, UploadIcon } from './Icons';
import { ComputerCardHeading } from './ComputerCardHeading';

type DeviceTool = 'clipboard' | 'screen' | 'share' | 'display' | 'mute';

export function DeviceTools({ config, status, updateStatus, runningThreadId, connected }: {
  config: RemoteConfig;
  status?: DeviceStatus;
  updateStatus: (status: DeviceStatus) => void;
  runningThreadId?: string;
  connected: boolean;
}) {
  const [activeTool, setActiveTool] = useState<DeviceTool>();
  const [minutes, setMinutes] = useState<HoldDuration>(runningThreadId ? 'task' : 60);
  const [quickShare, setQuickShare] = useState(false);
  const [savingQuickShare, setSavingQuickShare] = useState(false);
  const [feedback, setFeedback] = useState<{ tool: DeviceTool; text: string; error?: boolean }>();
  const [muted, setMuted] = useState<boolean>();
  const [displayOff, setDisplayOff] = useState<boolean>();
  const sharePicker = useRef<HTMLInputElement>(null);
  const shutdownDialog = useRef<HTMLDialogElement>(null);
  const computerControls = !runningThreadId && status?.computerControls === true;
  const displayControl = computerControls && status?.displayControl === true;

  useEffect(() => {
    if (runningThreadId || !Capacitor.isNativePlatform()) return;
    void Preferences.get({ key: QUICK_SHARE_KEY }).then(({ value }) => setQuickShare(value === '1'))
      .catch(error => setFeedback({ tool: 'share', text: message(error), error: true }));
  }, [runningThreadId]);

  useEffect(() => { setMuted(undefined); setDisplayOff(undefined); }, [config, connected]);
  useEffect(() => {
    if (!computerControls || !connected || activeTool === 'screen' || activeTool === 'display' || activeTool === 'mute') return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshControls() {
      if (!document.hidden) {
        await Promise.all([
          deviceRequest<{ muted: boolean }>(config, 'audio/mute').then(audio => {
            if (current) setMuted(audio.muted);
          }, () => { if (current) setMuted(undefined); }),
          displayControl && deviceRequest<{ displayOff: boolean }>(config, 'display/power').then(display => {
            if (current) setDisplayOff(display.displayOff);
          }, () => { if (current) setDisplayOff(undefined); }),
        ]);
      }
      if (current) timer = setTimeout(() => void refreshControls(), 5000);
    }
    void refreshControls();
    return () => { current = false; clearTimeout(timer); };
  }, [computerControls, displayControl, connected, config, activeTool]);

  const disabled = Boolean(activeTool) || status?.supported === false;

  async function run(tool: DeviceTool, operation: () => Promise<string | void>) {
    if (disabled) return;
    setActiveTool(tool);
    setFeedback(undefined);
    try {
      const text = await operation();
      if (text) setFeedback({ tool, text });
    }
    catch (error) { setFeedback({ tool, text: message(error), error: true }); }
    finally { setActiveTool(undefined); }
  }

  function feedbackFor(tool: DeviceTool) {
    return activeTool === tool ? <p className="computer-feedback computer-reveal" role="status">正在等待电脑响应…</p> :
      feedback?.tool === tool ? <p className="computer-feedback computer-reveal" data-tone={feedback.error ? 'error' : 'success'}
        role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p> : null;
  }

  const controlsDisabled = disabled || !connected;
  const lockButton = <button type="button" className="secondary-button computer-lock-button" disabled={controlsDisabled}
    onClick={() => void run('screen', async () => {
      await deviceRequest(config, 'power/lock');
      return 'Windows 已接收锁屏请求。';
    })}><ShieldIcon aria-hidden="true" />锁定电脑</button>;
  const muteSwitch = <ComputerControlSwitch label="电脑静音" checked={muted} disabled={controlsDisabled}
    pending={activeTool === 'mute'} error={feedback?.tool === 'mute' ? feedback.text : undefined}
    onToggle={() => void run('mute', async () => {
      const audio = await deviceRequest<{ muted: boolean }>(config, 'audio/mute', { muted: !muted });
      setMuted(audio.muted);
    })} />;
  const shutdownButton = <button type="button" className="secondary-button computer-shutdown-button"
    disabled={controlsDisabled || status?.shutdownPending} aria-haspopup="dialog"
    onClick={() => shutdownDialog.current?.showModal()}>
    <PowerIcon aria-hidden="true" />{status?.shutdownPending ? '已请求关机' : '关闭电脑'}
  </button>;
  const releaseHold = () => void run('screen', async () => {
    updateStatus(await deviceRequest<DeviceStatus>(config, 'power/release'));
    return '已取消保持唤醒，电脑恢复原休眠策略。';
  });

  return <div className="device-tools">
      {status?.supported === false && <p role="status">此电脑未提供 Windows 设备工具。</p>}
      {!runningThreadId && <section className="computer-utility" aria-busy={activeTool === 'clipboard'}>
        <ComputerCardHeading title="剪贴板" icon={<ClipboardIcon />} />
        <div className="device-actions">
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run('clipboard', async () => {
            const text = await readPhoneClipboard();
            if (!text) return '手机剪贴板没有可发送的文本。';
            await deviceRequest(config, 'clipboard/write', { text });
            return '已复制到电脑剪贴板。';
          })}>发送手机剪贴板</button>
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run('clipboard', async () => {
            const { text } = await deviceRequest<{ text: string }>(config, 'clipboard/read');
            if (!text) return '电脑剪贴板没有可拉取的文本。';
            await writePhoneClipboard(text);
            return '已复制到手机剪贴板。';
          })}>拉取电脑剪贴板</button>
        </div>
        {feedbackFor('clipboard')}
      </section>}
      <section className={runningThreadId ? undefined : 'computer-utility'} aria-busy={activeTool === 'screen'}>
        {!runningThreadId && <ComputerCardHeading title="电脑控制" icon={<MonitorIcon />}>
          {status?.awakeUntil && <span className="computer-status-pill" data-tone="success">挂机中</span>}
        </ComputerCardHeading>}
        {displayControl ? <div className="computer-control-grid">
          <div className="computer-control-row" role="group" aria-label="屏幕与声音">
            <ComputerControlSwitch label="熄屏挂机" checked={displayOff} disabled={controlsDisabled}
              pending={activeTool === 'display'} error={feedback?.tool === 'display' ? feedback.text : undefined}
              onToggle={() => void run('display', async () => {
                const display = await deviceRequest<{ displayOff: boolean }>(config, 'display/power', { displayOff: !displayOff });
                setDisplayOff(display.displayOff);
              })} />
            {muteSwitch}
          </div>
          <div className="computer-control-row" role="group" aria-label="电脑操作">
            {lockButton}
            {shutdownButton}
          </div>
        </div> : <div className="device-actions">
          <label className="device-duration computer-setting-row">保持唤醒
            <select value={minutes} onChange={event => setMinutes(event.target.value === 'task' ? 'task' : Number(event.target.value) as HoldDuration)}>
              <option value={30}>30 分钟</option>
              <option value={60}>1 小时</option>
              <option value={120}>2 小时</option>
              {runningThreadId && <option value="task">到当前任务结束（最多 2 小时）</option>}
            </select>
          </label>
          {!runningThreadId && lockButton}
          <button type="button" className="primary-button" disabled={controlsDisabled} onClick={() => void run('screen', async () => {
            updateStatus(await deviceRequest<DeviceStatus>(config, 'power/hold', { minutes, threadId: runningThreadId }));
            return 'Windows 已接收熄屏请求，保持唤醒已启用。';
          })}>熄屏挂机</button>
          {computerControls && <>{muteSwitch}{shutdownButton}</>}
          {status?.awakeUntil && <button type="button" className="secondary-button device-release" disabled={controlsDisabled} onClick={releaseHold}>停止挂机</button>}
        </div>}
        {status?.awakeUntil && <div className="computer-hold-status">
          <p className="computer-feedback" data-tone="success">最晚保持至 {new Date(status.awakeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          {displayControl && <button type="button" className="secondary-button" disabled={controlsDisabled} onClick={releaseHold}>停止保持唤醒</button>}
        </div>}
        {computerControls && status?.shutdownError
          ? <p className="computer-feedback" data-tone="error" role="alert">{status.shutdownError}</p>
          : feedbackFor('screen')}
        {computerControls && <dialog ref={shutdownDialog} className="session-dialog" aria-labelledby="computer-shutdown-title"
          onClick={event => { if (event.target === event.currentTarget) shutdownDialog.current?.close(); }}>
          <div className="session-sheet archive-sheet computer-shutdown-sheet">
            <header className="sheet-title-row"><h2 id="computer-shutdown-title">关闭电脑？</h2></header>
            <p>Windows 将正常关机，手机连接会断开。请先保存工作，下次使用时需要在电脑上开机并登录。</p>
            <div className="sheet-actions balanced-sheet-actions">
              <button type="button" className="secondary-button" autoFocus onClick={() => shutdownDialog.current?.close()}>取消</button>
              <button type="button" className="swipe-delete-confirm" disabled={disabled || !connected} onClick={() => {
                shutdownDialog.current?.close();
                void run('screen', async () => {
                  const result = await deviceRequest<{ requested: boolean }>(config, 'power/shutdown', { confirm: true });
                  if (!result.requested) throw new Error('电脑未确认关机请求。');
                  return '已请求 Windows 关机。';
                });
              }}>确认关机</button>
            </div>
          </div>
        </dialog>}
      </section>
      {!runningThreadId && <section className="computer-utility" aria-busy={activeTool === 'share'}>
        <ComputerCardHeading title="发送到电脑" icon={<UploadIcon />} />
        <input hidden ref={sharePicker} type="file" multiple onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (!files.length) return;
          void run('share', async () => {
            const saved: string[] = [];
            const failed: string[] = [];
            for (const file of files) {
              try { saved.push((await shareFileToComputer(config, file)).fileName); }
              catch (error) { failed.push(`${file.name}（${message(error)}）`); }
            }
            if (failed.length) throw new Error(`已保存 ${saved.length} 个文件。未确认接收：${failed.join('、')}`);
            return saved.length === 1 ? `已保存到电脑收件文件夹：${saved[0]}` : `已保存 ${saved.length} 个文件到电脑收件文件夹。`;
          });
        }} />
        <button type="button" className="secondary-button" disabled={disabled}
          onClick={() => sharePicker.current?.click()}>分享文件到电脑</button>
        {status?.shareError && <p className="computer-feedback" data-tone="error" role="alert">{status.shareError}</p>}
        {(status?.receiveFolder || Capacitor.isNativePlatform()) && <details className="computer-disclosure">
          <summary>接收设置</summary>
          <div className="computer-receive-settings">
        {status?.receiveFolder && <div className="computer-setting-row"><span><strong>保存位置</strong><small>{status.receiveFolder}{status.autoOpen ? ' · 接收后打开' : ''}</small></span></div>}
        {Capacitor.isNativePlatform() && <label className="computer-setting-row computer-switch">
          <span><strong>系统分享后直接发送</strong><small>在手机分享菜单中选择「发送到电脑」。</small></span>
          <input type="checkbox" role="switch" checked={quickShare} disabled={savingQuickShare} onChange={event => {
            const enabled = event.target.checked;
            setSavingQuickShare(true);
            setFeedback(undefined);
            void Preferences.set({ key: QUICK_SHARE_KEY, value: enabled ? '1' : '0' })
              .then(() => setQuickShare(enabled))
              .catch(error => setFeedback({ tool: 'share', text: message(error), error: true }))
              .finally(() => setSavingQuickShare(false));
          }} />
        </label>}
          </div>
        </details>}
        {feedbackFor('share')}
      </section>}
  </div>;
}

function ComputerControlSwitch({ label, checked, disabled, pending, error, onToggle }: {
  label: string;
  checked?: boolean;
  disabled: boolean;
  pending: boolean;
  error?: string;
  onToggle: () => void;
}) {
  const status = pending ? '等待电脑回执' : checked === undefined ? '状态未确认' : checked ? '已开启' : '已关闭';
  return <div className="computer-control-item">
    <button type="button" className="computer-control-switch" role="switch" aria-label={label}
      aria-checked={checked === true} aria-busy={pending} disabled={disabled || checked === undefined} onClick={onToggle}>
      <span className="computer-control-copy"><strong>{label}</strong><small>{status}</small></span>
      <span className="computer-control-track" aria-hidden="true" />
    </button>
    {error && <small className="computer-control-error" role="alert">{error}</small>}
  </div>;
}

export function DevicePowerDialog({ config, phase, threadId, onClose }: {
  config: RemoteConfig;
  phase: ConnectionPhase;
  threadId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { status, updateStatus } = useDeviceStatus(config, phase === 'connected');
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  return <dialog className="session-dialog" ref={dialog} onClose={event => afterDialogClose(event, onClose)} aria-labelledby="device-power-title">
    <div className="session-sheet device-power-sheet">
      <header className="sheet-title-row">
        <h2 id="device-power-title">熄屏挂机</h2>
        <button className="icon-button nav-icon-button" type="button" aria-label="关闭" onClick={() => dialog.current?.close()}><CloseIcon /></button>
      </header>
      <DeviceTools config={config} status={status} updateStatus={updateStatus} runningThreadId={threadId} connected={phase === 'connected'} />
    </div>
  </dialog>;
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'AbortError' || error instanceof TypeError) return '未收到电脑回执，请检查连接后重试。';
  return error.message;
}
