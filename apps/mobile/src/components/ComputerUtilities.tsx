import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, type DeviceStatus, type InboxFile } from '../lib/deviceTools';
import { checkLatestRelease, compareReleaseVersions, releasePage, type RemoteRelease } from '../lib/updates';

type CheckResult = { ms: number; error?: string };
const checks = ['电脑回执', 'Codex 额度请求', '对话列表同步'] as const;
const fileSize = (size: number) => size < 1024 ? `${size} B`
  : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;

export function ConnectionDiagnostics({ config, sync }: { config: RemoteConfig; sync: () => Promise<void> }) {
  const [results, setResults] = useState<Partial<Record<(typeof checks)[number], CheckResult>>>();
  const running = Boolean(results && Object.keys(results).length < checks.length);

  function run() {
    setResults({});
    const operations = [
      () => deviceRequest<DeviceStatus>(config, 'status'),
      () => deviceRequest(config, 'usage'),
      sync,
    ];
    checks.forEach((check, index) => {
      const started = performance.now();
      void operations[index]!().then(
        () => setResults(current => ({ ...current, [check]: { ms: performance.now() - started } })),
        error => setResults(current => ({ ...current, [check]: {
          ms: performance.now() - started,
          error: error instanceof Error && error.name !== 'AbortError' ? error.message : '请求超时。',
        } })),
      );
    });
  }

  return <div className="connection-diagnostics">
    <button className="secondary-button" type="button" disabled={running} onClick={run}>{running ? '正在自检…' : '连接自检'}</button>
    {results && <dl className="computer-check-results" aria-live="polite">{checks.map(check => {
      const result = results[check];
      return <div key={check}>
        <dt>{check}</dt>
        <dd>{result ? `${result.error ? '失败' : '通过'} · ${Math.round(result.ms)} ms` : '检测中…'}</dd>
        {result?.error && <small>{result.error}</small>}
      </div>;
    })}</dl>}
  </div>;
}

export function InboxPanel({ config, onUse }: { config: RemoteConfig; onUse: (file: InboxFile) => void }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<InboxFile[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const result = await deviceRequest<{ files: InboxFile[] }>(config, 'inbox');
      setFiles(result.files);
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取收件箱失败。');
    } finally {
      setLoading(false);
    }
  }
  return <section className="computer-utility">
    <div className="computer-utility-header">
      <h2>手机收件箱</h2>
      <button className="secondary-button" type="button" aria-expanded={open} onClick={() => {
        setOpen(!open);
        if (!open) void refresh();
      }}>{open ? '收起' : '打开'}</button>
    </div>
    {open && <>
      <div className="computer-utility-header">
        <span className="utility-muted">{loading ? '正在读取…' : files ? `最近 ${files.length} 项` : ''}</span>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void refresh()}>刷新</button>
      </div>
      {error && <p role="status">{error}</p>}
      {!loading && !error && files?.length === 0 && <p>暂无收件。</p>}
      {files && files.length > 0 && <ul className="computer-inbox-list">{files.map(file => <li key={file.id}>
        <div><strong>{file.fileName}</strong>
          <small>{file.source === 'share' ? '手机分享' : '对话附件'} · {fileSize(file.size)} · {new Date(file.receivedAt).toLocaleString('zh-CN')}</small>
          <small>{file.path}</small></div>
        <button className="secondary-button" type="button" onClick={() => onUse(file)}>用于对话</button>
      </li>)}</ul>}
    </>}
  </section>;
}

export function UpdatePanel({ hostVersion }: { hostVersion: string }) {
  const [mobileVersion, setMobileVersion] = useState('');
  const [release, setRelease] = useState<RemoteRelease>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const native = Capacitor.isNativePlatform();
  useEffect(() => {
    if (native) void CapacitorApp.getInfo().then(info => setMobileVersion(info.version)).catch(() => undefined);
  }, [native]);
  async function check() {
    setBusy(true);
    setError('');
    try {
      setRelease(await checkLatestRelease());
    } catch {
      setError('无法读取 GitHub 更新。可以重试或打开发布页。');
    } finally {
      setBusy(false);
    }
  }
  const mobileComparison = release ? compareReleaseVersions(mobileVersion, release.version) : undefined;
  const hostComparison = release ? compareReleaseVersions(hostVersion, release.version) : undefined;
  const requiredHostComparison = release?.minimumHost ? compareReleaseVersions(hostVersion, release.minimumHost) : undefined;
  return <section className="computer-utility">
    <div className="computer-utility-header">
      <h2>版本与更新</h2>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void check()}>{busy ? '正在检查…' : '检查更新'}</button>
    </div>
    <div className="utility-muted">手机 {mobileVersion || (native ? '待读取' : '浏览器预览')} · 电脑 {hostVersion || '待连接'}</div>
    {error && <p role="status">{error} <a href={releasePage} target="_blank" rel="noreferrer">查看发布页</a></p>}
    {release && <div className="computer-update-result" aria-live="polite">
      <strong>GitHub 最新版 {release.version}</strong>
      {mobileComparison !== undefined && <small>{mobileComparison < 0 ? '手机有新版本' : '手机已是最新版本'}</small>}
      <small>{requiredHostComparison !== undefined && requiredHostComparison < 0
        ? `电脑需要更新到 ${release.minimumHost} 或更高版本`
        : hostComparison === undefined ? '连接电脑后检查 Windows 版本'
          : hostComparison >= 0 ? '电脑已是最新版本'
            : requiredHostComparison !== undefined ? '电脑有可选更新，当前版本兼容' : '电脑有新版本，兼容性未确认'}</small>
      <div className="computer-update-links">
        {release.android && (mobileComparison === undefined || mobileComparison < 0) && <a href={release.android} target="_blank" rel="noreferrer">Android APK</a>}
        {release.windows && (hostComparison === undefined || hostComparison < 0) && <a href={release.windows} target="_blank" rel="noreferrer">Windows ZIP</a>}
        <a href={release.url} target="_blank" rel="noreferrer">发布说明</a>
      </div>
    </div>}
  </section>;
}
