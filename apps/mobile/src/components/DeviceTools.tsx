import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { RemoteConfig } from '../lib/configStore';
import type { ConnectionPhase } from '../types/protocol';
import { useDeviceStatus } from '../hooks/useDeviceStatus';
import { deviceRequest, QUICK_SHARE_KEY, readPhoneClipboard, shareFileToComputer, writePhoneClipboard, type DeviceStatus, type HoldDuration } from '../lib/deviceTools';
import { CloseIcon } from './Icons';

export function DeviceTools({ config, status, updateStatus, runningThreadId }: {
  config: RemoteConfig;
  status?: DeviceStatus;
  updateStatus: (status: DeviceStatus) => void;
  runningThreadId?: string;
}) {
  const [operating, setOperating] = useState(false);
  const [minutes, setMinutes] = useState<HoldDuration>(runningThreadId ? 'task' : 60);
  const [quickShare, setQuickShare] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const sharePicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (runningThreadId || !Capacitor.isNativePlatform()) return;
    void Preferences.get({ key: QUICK_SHARE_KEY }).then(({ value }) => setQuickShare(value === '1'))
      .catch(error => setFeedback({ text: message(error), error: true }));
  }, [runningThreadId]);

  const disabled = operating || status?.supported === false;

  async function run(operation: () => Promise<string>) {
    if (disabled) return;
    setOperating(true);
    setFeedback(undefined);
    try { setFeedback({ text: await operation() }); }
    catch (error) { setFeedback({ text: message(error), error: true }); }
    finally { setOperating(false); }
  }

  return <div className="device-tools" aria-busy={operating}>
      {feedback && <p className={feedback.error ? 'form-error' : 'device-feedback'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
      {operating && <p role="status">正在等待电脑响应…</p>}
      {status?.supported === false && <p role="status">此电脑未提供 Windows 设备工具。</p>}
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
          <label className="device-duration">保持唤醒
            <select value={minutes} onChange={event => setMinutes(event.target.value === 'task' ? 'task' : Number(event.target.value) as HoldDuration)}>
              <option value={30}>30 分钟</option>
              <option value={60}>1 小时</option>
              <option value={120}>2 小时</option>
              {runningThreadId && <option value="task">到当前任务结束（最多 2 小时）</option>}
            </select>
          </label>
          {!runningThreadId && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void run(async () => {
            await deviceRequest(config, 'power/lock');
            return 'Windows 已接收锁屏请求。';
          })}>锁定电脑</button>}
          <button type="button" className="primary-button" disabled={disabled} onClick={() => void run(async () => {
            updateStatus(await deviceRequest<DeviceStatus>(config, 'power/hold', { minutes, threadId: runningThreadId }));
            return 'Windows 已接收熄屏请求，保持唤醒已启用。';
          })}>熄屏挂机</button>
          {status?.awakeUntil && <button type="button" className="secondary-button device-release" disabled={disabled} onClick={() => void run(async () => {
            updateStatus(await deviceRequest<DeviceStatus>(config, 'power/release'));
            return '已取消保持唤醒，电脑恢复原休眠策略。';
          })}>停止挂机</button>}
        </div>
        {status?.awakeUntil && <p>最晚保持至 {new Date(status.awakeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
      </section>
      {!runningThreadId && <section>
        <h3>发送到电脑</h3>
        <input hidden ref={sharePicker} type="file" multiple onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (!files.length) return;
          void run(async () => {
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
  const { status, updateStatus } = useDeviceStatus(config, phase === 'connected');
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);

  return <dialog className="session-dialog" ref={dialog} onClose={onClose} aria-labelledby="device-power-title">
    <div className="session-sheet device-power-sheet">
      <header className="sheet-title-row">
        <h2 id="device-power-title">熄屏挂机</h2>
        <button className="icon-button nav-icon-button" type="button" aria-label="关闭" onClick={() => dialog.current?.close()}><CloseIcon /></button>
      </header>
      <DeviceTools config={config} status={status} updateStatus={updateStatus} runningThreadId={threadId} />
    </div>
  </dialog>;
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'AbortError' || error instanceof TypeError) return '未收到电脑回执，请检查连接后重试。';
  return error.message;
}
