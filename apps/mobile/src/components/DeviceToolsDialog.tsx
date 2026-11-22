import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, QUICK_SHARE_KEY, readPhoneClipboard, writePhoneClipboard, type DeviceStatus, type HoldDuration } from '../lib/deviceTools';
import { CloseIcon } from './Icons';

export function DeviceToolsDialog({ config, runningThreadId, onClose }: {
  config: RemoteConfig;
  runningThreadId?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<DeviceStatus>();
  const [pending, setPending] = useState(true);
  const [minutes, setMinutes] = useState<HoldDuration>(60);
  const [quickShare, setQuickShare] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    void Preferences.get({ key: QUICK_SHARE_KEY }).then(({ value }) => setQuickShare(value === '1'));
  }, []);

  useEffect(() => {
    let active = true;
    void deviceRequest<DeviceStatus>(config, 'status').then(value => {
      if (active) setStatus(value);
    }).catch(error => {
      if (active) setFeedback({ text: message(error), error: true });
    }).finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, [config]);

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
    setPending(true);
    setFeedback(undefined);
    try { setFeedback({ text: await operation() }); }
    catch (error) { setFeedback({ text: message(error), error: true }); }
    finally { setPending(false); }
  }

  const disabled = pending || !status?.supported;
  const selectedDuration = minutes === "task" && !runningThreadId ? 60 : minutes;

  return <dialog className="session-dialog" ref={dialog} onClose={onClose} aria-labelledby="device-tools-title">
    <div className="session-sheet device-tools">
      <header className="sheet-title-row">
        <h2 id="device-tools-title">设备工具</h2>
        <button className="icon-button" type="button" aria-label="关闭" onClick={() => dialog.current?.close()}><CloseIcon /></button>
      </header>
      <section>
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
      </section>
      <section>
        <h3>电脑屏幕</h3>
        <div className="device-actions">
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run(async () => {
            await deviceRequest(config, 'power/lock');
            return 'Windows 已接收锁屏请求。';
          })}>锁定电脑</button>
          <label className="device-duration">保持唤醒
            <select value={selectedDuration} onChange={event => setMinutes(event.target.value === 'task' ? 'task' : Number(event.target.value) as HoldDuration)}>
              <option value={30}>30 分钟</option>
              <option value={60}>1 小时</option>
              <option value={120}>2 小时</option>
              {runningThreadId && <option value="task">到当前任务结束（最多 2 小时）</option>}
            </select>
          </label>
          <button type="button" className="primary-button" disabled={disabled} onClick={() => void run(async () => {
            setStatus(await deviceRequest<DeviceStatus>(config, 'power/hold', { minutes: selectedDuration, threadId: runningThreadId }));
            return 'Windows 已接收熄屏请求，保持唤醒已启用。';
          })}>熄屏挂机</button>
          {status?.awakeUntil && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run(async () => {
            setStatus(await deviceRequest<DeviceStatus>(config, 'power/release'));
            return '已取消保持唤醒，电脑恢复原休眠策略。';
          })}>停止挂机</button>}
        </div>
        {status?.awakeUntil && <p>最晚保持至 {new Date(status.awakeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
      </section>
      {Capacitor.isNativePlatform() && <section>
        <h3>发送到电脑</h3>
        <p>在相册、文档或浏览器的分享菜单选择「发送到电脑」。</p>
        {status?.shareError && <p role="alert">{status.shareError}</p>}
        {status?.receiveFolder && <p className="device-folder">{status.receiveFolder}{status.autoOpen ? ' · 接收后打开' : ''}</p>}
        <label className="device-quick-share">
          <input type="checkbox" checked={quickShare} onChange={event => {
            const enabled = event.target.checked;
            void Preferences.set({ key: QUICK_SHARE_KEY, value: enabled ? '1' : '0' })
              .then(() => setQuickShare(enabled))
              .catch(error => setFeedback({ text: message(error), error: true }));
          }} /> 在系统分享菜单选择后直接发送
        </label>
      </section>}
      {pending && <p role="status">正在等待电脑响应…</p>}
      {feedback && <p className={feedback.error ? 'form-error' : 'device-feedback'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
      {!pending && status && !status.supported && <p role="status">此电脑未提供 Windows 设备工具。</p>}
    </div>
  </dialog>;
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'AbortError' || error instanceof TypeError) return '未收到电脑回执，请检查连接后重试。';
  return error.message;
}
