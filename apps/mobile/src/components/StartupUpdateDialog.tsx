import { useEffect, useRef } from 'react';
import type { StartupUpdate } from '../lib/updates';
import { UpdateIcon } from './Icons';

export function StartupUpdateDialog({ update, onUpdate, onLater }: {
  update: StartupUpdate;
  onUpdate: (update: StartupUpdate) => void;
  onLater: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function present() {
      if (!dialog.current || dialog.current.open) return;
      if (document.hidden || document.querySelector('dialog[open]')) {
        timer = setTimeout(present, 600);
        return;
      }
      dialog.current.showModal();
    }
    present();
    return () => clearTimeout(timer);
  }, []);

  return <dialog ref={dialog} className="session-dialog startup-update-dialog"
    aria-labelledby="startup-update-title" aria-describedby="startup-update-detail" onClose={onLater}>
    <div className="startup-update-sheet">
      <span className="startup-update-icon"><UpdateIcon aria-hidden="true" /></span>
      <h2 id="startup-update-title">发现新版本 {update.release.version}</h2>
      <p id="startup-update-detail">
        {update.phone && update.host ? '手机和电脑配套服务均可更新。'
          : update.phone ? '手机 App 可以更新。' : '电脑配套服务可以更新。'}
        {update.host && ' 更新时电脑连接可能短暂中断。'}
        {update.phone && ' 手机安装由 Android 确认。'}
      </p>
      <div className="startup-update-buttons">
        <button type="button" className="secondary-button" onClick={() => dialog.current?.close()}>稍后再说</button>
        <button type="button" className="primary-button" onClick={() => onUpdate(update)}>立即更新</button>
      </div>
    </div>
  </dialog>;
}
