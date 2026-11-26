import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, type DeviceStatus } from '../lib/deviceTools';
import { checkLatestRelease, compareReleaseVersions, releasePage, type RemoteRelease } from '../lib/updates';
import { ComputerCardHeading } from './ComputerCardHeading';
import { UpdateIcon } from './Icons';

type CheckResult = { ms: number; error?: string };
const checks = ['电脑回执', 'Codex 额度请求', '对话列表同步'] as const;

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

  return <div className="connection-diagnostics" aria-busy={running}>
    <button className="secondary-button" type="button" disabled={running} onClick={run}>{running ? '正在自检…' : '连接自检'}</button>
    {results && <dl className="computer-check-results computer-reveal" aria-live="polite">{checks.map(check => {
      const result = results[check];
      return <div key={check}>
        <dt>{check}</dt>
        <dd className="computer-status-pill" data-tone={!result ? undefined : result.error ? 'error' : 'success'}>
          {result ? `${result.error ? '失败' : '通过'} · ${Math.round(result.ms)} ms` : '检测中…'}</dd>
        {result?.error && <small>{result.error}</small>}
      </div>;
    })}</dl>}
  </div>;
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
  return <section className="computer-utility" aria-busy={busy}>
    <ComputerCardHeading title="版本与更新" icon={<UpdateIcon />}>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void check()}>{busy ? '正在检查…' : '检查更新'}</button>
    </ComputerCardHeading>
    <dl className="computer-versions">
      <div className="computer-setting-row"><dt>手机</dt><dd>{mobileVersion || (native ? '待读取' : '浏览器预览')}</dd></div>
      <div className="computer-setting-row"><dt>电脑</dt><dd>{hostVersion || '待连接'}</dd></div>
    </dl>
    {error && <p className="computer-feedback" data-tone="error" role="status">{error} <a href={releasePage} target="_blank" rel="noreferrer">查看发布页</a></p>}
    {release && <div className="computer-update-result computer-reveal" aria-live="polite">
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
