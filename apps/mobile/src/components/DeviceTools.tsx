import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { RemoteConfig } from '../lib/configStore';
import type { ConnectionPhase } from '../types/protocol';
import { deviceRequest, QUICK_SHARE_KEY, readPhoneClipboard, writePhoneClipboard, type DeviceStatus, type HoldDuration } from '../lib/deviceTools';
import { CloseIcon } from './Icons';

export function DeviceTools({ config, phase, runningThreadId }: {
  config: RemoteConfig;
  phase: ConnectionPhase;
  runningThreadId?: string;
}) {
  const [status, setStatus] = useState<DeviceStatus>();
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [operating, setOperating] = useState(false);
  const [minutes, setMinutes] = useState<HoldDuration>(runningThreadId ? 'task' : 60);
  const [statusRefresh, setStatusRefresh] = useState(0);
  const [quickShare, setQuickShare] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();

  useEffect(() => {
    if (runningThreadId || !Capacitor.isNativePlatform()) return;
    void Preferences.get({ key: QUICK_SHARE_KEY }).then(({ value }) => setQuickShare(value === '1'))
      .catch(error => setFeedback({ text: message(error), error: true }));
  }, [runningThreadId]);

  const connected = phase === 'connected';
  useEffect(() => {
    let active = true;
    setLoadingStatus(true);
    void deviceRequest<DeviceStatus>(config, 'status').then(value => {
      if (active) {
        setStatus(value);
        setFeedback(current => current?.error ? undefined : current);
      }
    }).catch(error => {
      if (active) {
        setStatus(undefined);
        setFeedback({ text: message(error), error: true });
      }
    }).finally(() => { if (active) setLoadingStatus(false); });
    return () => { active = false; };
  }, [config, connected, statusRefresh]);

  const pending = loadingStatus || operating;
  useEffect(() => {
    if (pending || !status?.awakeUntil) return;
    let active = true;
    const timer = setInterval(() => {
      void deviceRequest<DeviceStatus>(config, 'status').then(next => {
        if (active) setStatus(next);
      }).catch(() => undefined);
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [config, pending, status?.awakeUntil]);

  async function run(operation: () => Promise<string>) {
    if (pending) return;
    setOperating(true);
    setFeedback(undefined);
    try { setFeedback({ text: await operation() }); }
    catch (error) { setFeedback({ text: message(error), error: true }); }
    finally { setOperating(false); }
  }

  const disabled = pending || !status?.supported;

  return <div className="device-tools" aria-busy={pending}>
      {feedback && <p className={feedback.error ? 'form-error' : 'device-feedback'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
      {pending && <p role="status">正在等待电脑响应…</p>}
      {!pending && !status && <button className="secondary-button" type="button" onClick={() => setStatusRefresh(value => value + 1)}>重试读取设备状态</button>}
      {!pending && status && !status.supported && <p role="status">此电脑未提供 Windows 设备工具。</p>}
      {!runningThreadId && <section>
        <h3>剪贴板</h3>
        <div className="device-actions">
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run(async () => {
            const text = await readPhoneClipboard();
            if (!text) return '手机剪贴板没有可发送的文本。';
            await deviceRequest(config, 'clipboard/write', { text });
            return '已复制到电脑剪贴板。';
          })}>发送手机剪贴板</button>
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run(async () => {
            const { text } = await deviceRequest<{ text: string }>(config, 'clipboard/read');
            if (!text) return '电脑剪贴板没有可拉取的文本。';
            await writePhoneClipboard(text);
            return '已复制到手机剪贴板。';
          })}>拉取电脑剪贴板</button>
        </div>
      </section>}
      <section>
        {!runningThreadId && <h3>电脑屏幕</h3>}
        <div className="device-actions">
          {!runningThreadId && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run(async () => {
            await deviceRequest(config, 'power/lock');
            return 'Windows 已接收锁屏请求。';
          })}>锁定电脑</button>}
          <label className="device-duration">保持唤醒
            <select value={minutes} onChange={event => setMinutes(event.target.value === 'task' ? 'task' : Number(event.target.value) as HoldDuration)}>
              <option value={30}>30 分钟</option>
              <option value={60}>1 小时</option>
              <option value={120}>2 小时</option>
              {runningThreadId && <option value="task">到当前任务结束（最多 2 小时）</option>}
            </select>
          </label>
          <button type="button" className="primary-button" disabled={disabled} onClick={() => void run(async () => {
            setStatus(await deviceRequest<DeviceStatus>(config, 'power/hold', { minutes, threadId: runningThreadId }));
            return 'Windows 已接收熄屏请求，保持唤醒已启用。';
          })}>熄屏挂机</button>
          {status?.awakeUntil && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run(async () => {
            setStatus(await deviceRequest<DeviceStatus>(config, 'power/release'));
            return '已取消保持唤醒，电脑恢复原休眠策略。';
          })}>停止挂机</button>}
        </div>
        {status?.awakeUntil && <p>最晚保持至 {new Date(status.awakeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
      </section>
      {!runningThreadId && <section>
        <h3>发送到电脑</h3>
        <p>在相册、文档或浏览器的分享菜单选择「发送到电脑」。</p>
        {status?.shareError && <p role="alert">{status.shareError}</p>}
        {status?.receiveFolder && <p className="device-folder">{status.receiveFolder}{status.autoOpen ? ' · 接收后打开' : ''}</p>}
        {Capacitor.isNativePlatform() && <label className="device-quick-share">
          <input type="checkbox" checked={quickShare} onChange={event => {
            const enabled = event.target.checked;
            void Preferences.set({ key: QUICK_SHARE_KEY, value: enabled ? '1' : '0' })
              .then(() => setQuickShare(enabled))
              .catch(error => setFeedback({ text: message(error), error: true }));
          }} /> 在系统分享菜单选择后直接发送
        </label>}
      </section>}
  </div>;
}

export function DevicePowerDialog({ config, phase, threadId, onClose }: {
  config: RemoteConfig;
  phase: ConnectionPhase;
  threadId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  return <dialog className="session-dialog" ref={dialog} onClose={onClose} aria-labelledby="device-power-title">
    <div className="session-sheet device-power-sheet">
      <header className="sheet-title-row">
        <h2 id="device-power-title">熄屏挂机</h2>
        <button className="icon-button nav-icon-button" type="button" aria-label="关闭" onClick={() => dialog.current?.close()}><CloseIcon /></button>
      </header>
      <DeviceTools config={config} phase={phase} runningThreadId={threadId} />
    </div>
  </dialog>;
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'AbortError' || error instanceof TypeError) return '未收到电脑回执，请检查连接后重试。';
  return error.message;
}
