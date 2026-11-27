import { useRef, useState, type FormEvent } from 'react';
import { DEFAULT_SERVER_URL, normalizeServerUrl, saveRemoteConfig, storageDescription, type RemoteConfig } from '../lib/configStore';
import { CloseIcon, EyeIcon, ShieldIcon, UpdateIcon } from './Icons';

interface SetupScreenProps {
  initialConfig?: RemoteConfig | null;
  onSaved: (config: RemoteConfig) => void;
  onCancel?: () => void;
  onForget?: () => void;
  onFullRefresh?: () => Promise<void>;
}

export function SetupScreen({ initialConfig, onSaved, onCancel, onForget, onFullRefresh }: SetupScreenProps) {
  const [serverUrl, setServerUrl] = useState(initialConfig?.serverUrl ?? DEFAULT_SERVER_URL);
  const [localUrl, setLocalUrl] = useState(initialConfig?.localUrl ?? '');
  const [pairingToken, setPairingToken] = useState(initialConfig?.pairingToken ?? '');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const refreshDialog = useRef<HTMLDialogElement>(null);

  async function refreshCache() {
    if (!onFullRefresh || refreshing) return;
    refreshDialog.current?.close();
    setRefreshing(true);
    setError('');
    try {
      await onFullRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '全量刷新失败');
      setRefreshing(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const saved = await saveRemoteConfig({
        serverUrl: normalizeServerUrl(serverUrl),
        localUrl,
        pairingToken,
      });
      onSaved(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '配置保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="setup-screen">
      <section className="setup-card">
        <header className="setup-brand">
          <img src="/logo.svg?v=3" alt="" className="product-logo" />
          <div>
            <strong>Codex Remote</strong>
            <span>Android 客户端</span>
          </div>
        </header>

        <div className="setup-heading">
          <p className="eyebrow">连接设置</p>
          <h1>连接电脑</h1>
          <p className="setup-intro">填写 Windows 配套服务的地址和令牌，连接 Codex、Antigravity 和电脑工具。</p>
        </div>

        <form onSubmit={handleSubmit} className="setup-form">
          <label>
            <span>服务器地址</span>
            <input
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="https://codex.example.com"
              autoCapitalize="none"
              autoCorrect="off"
              inputMode="url"
              required
            />
            <small>同网可使用可信局域网地址。跨网请输入 HTTPS/WSS 地址。</small>
          </label>

          <label>
            <span>手动局域网地址（可选）</span>
            <input value={localUrl} onChange={event => setLocalUrl(event.target.value)}
              placeholder="http://192.168.0.103:18788" inputMode="url" autoCapitalize="none" autoCorrect="off" />
            <small>电脑启用可信局域网后，手机会自动发现已配对的电脑。也可在这里填写手动地址。</small>
          </label>

          <label>
            <span>配对令牌</span>
            <div className="secret-input">
              <input
                value={pairingToken}
                onChange={(event) => setPairingToken(event.target.value)}
                placeholder="粘贴主机端生成的令牌"
                type={showToken ? 'text' : 'password'}
                autoCapitalize="none"
                autoCorrect="off"
                required
              />
              <button type="button" onClick={() => setShowToken((value) => !value)} aria-label={showToken ? '隐藏令牌' : '显示令牌'}>
                <EyeIcon off={showToken} />
              </button>
            </div>
          </label>

          {error && <div className="form-error">{error}</div>}

          <div className="setup-actions">
            {onCancel && <button className="secondary-button" type="button" onClick={onCancel}>取消</button>}
            <button className="primary-button setup-submit" type="submit" disabled={saving}>
              {saving ? '正在保存…' : '保存并连接'}
            </button>
          </div>
          {onFullRefresh && (
            <div className="cache-refresh-action">
              <button
                className="secondary-button"
                type="button"
                disabled={refreshing}
                aria-haspopup="dialog"
                onClick={() => refreshDialog.current?.showModal()}
              >
                {refreshing ? '正在全量刷新…' : '清空缓存并全量刷新'}
              </button>
              <small>删除所有版本的本地任务缓存，保留连接信息，并重新下载任务索引和当前会话。</small>
            </div>
          )}
          {onForget && (
            <button className="danger-text-button" type="button" onClick={onForget}>清除本机连接信息</button>
          )}
        </form>

        <div className="security-note">
          <ShieldIcon />
          <p>{storageDescription()}</p>
        </div>
      </section>
      {onFullRefresh && <dialog className="session-dialog cache-confirm-dialog" ref={refreshDialog} aria-labelledby="cache-confirm-title"
        onClick={event => { if (event.target === event.currentTarget) refreshDialog.current?.close(); }}>
        <div className="session-sheet">
          <header className="sheet-title-row">
            <div className="archive-title">
              <span className="management-icon" aria-hidden="true"><UpdateIcon /></span>
              <h2 id="cache-confirm-title">清空缓存并刷新</h2>
            </div>
            <button className="nav-icon-button" type="button" aria-label="关闭" onClick={() => refreshDialog.current?.close()}><CloseIcon /></button>
          </header>
          <p className="cache-confirm-note">清空这部手机的任务缓存，再从电脑同步最新列表。连接地址和配对令牌会保留。</p>
          <div className="sheet-actions balanced-sheet-actions">
            <button className="secondary-button" type="button" onClick={() => refreshDialog.current?.close()}>取消</button>
            <button className="primary-button" type="button" onClick={() => void refreshCache()}>清空并刷新</button>
          </div>
        </div>
      </dialog>}
    </main>
  );
}
