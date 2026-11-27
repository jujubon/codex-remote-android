import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, type DeviceStatus } from '../lib/deviceTools';
import { CompanionUpdate, checkLatestRelease, compareReleaseVersions, hostUpdateRunning, releasePage, type HostUpdate, type RemoteRelease } from '../lib/updates';
import { ComputerCardHeading } from './ComputerCardHeading';
import { GaugeIcon, UpdateIcon } from './Icons';

type CheckResult = { ms: number; error?: string };
const checks = ['电脑回执', 'Codex 额度请求', '对话列表同步'] as const;

export function ConnectionDiagnostics({ config, sync, endpoint, routeLabel }: {
  config: RemoteConfig; sync: () => Promise<void>; endpoint: string; routeLabel: string;
}) {
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
      void Promise.resolve().then(operations[index]!).then(
        () => setResults(current => ({ ...current, [check]: { ms: performance.now() - started } })),
        error => setResults(current => ({ ...current, [check]: {
          ms: performance.now() - started,
          error: error instanceof Error && error.name !== 'AbortError' ? error.message : '请求超时。',
        } })),
      );
    });
  }

  return <div className="connection-diagnostics" aria-busy={running}>
    <div className="computer-setting-row connection-route">
      <span><small>{routeLabel}</small><strong title={endpoint}>{endpoint || '等待连接'}</strong></span>
      <button className="connection-check-button" type="button" disabled={running} onClick={run}>
        <GaugeIcon aria-hidden="true" /><span>{running ? '正在自检…' : results ? '重新自检' : '连接自检'}</span>
      </button>
    </div>
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

const hostUpdateLabels: Record<HostUpdate['stage'], string> = {
  pending: '电脑已收到更新请求。',
  downloading: '电脑正在下载并校验更新…',
  switching: '配套服务正在切换版本，手机会自动重连。',
  completed: '电脑配套服务更新完成。',
  failed: '电脑更新未完成，可重试或手动安装。',
};

let cachedRelease: { data: RemoteRelease; checkedAt: number } | undefined;

export function UpdatePanel({ hostVersion, config, connected, hostUpdateSupported }: {
  hostVersion: string; config: RemoteConfig; connected: boolean; hostUpdateSupported?: boolean;
}) {
  const [mobileVersion, setMobileVersion] = useState('');
  const [release, setRelease] = useState(cachedRelease?.data);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<'phone' | 'host'>();
  const [hostUpdate, setHostUpdate] = useState<HostUpdate>();
  const [error, setError] = useState('');
  const [phoneStatus, setPhoneStatus] = useState('');
  const confirmation = useRef<HTMLDialogElement>(null);
  const native = Capacitor.getPlatform() === 'android';
  useEffect(() => {
    if (native) void CapacitorApp.getInfo().then(info => setMobileVersion(info.version)).catch(() => undefined);
  }, [native]);
  const watchingHost = hostUpdateRunning(hostUpdate);
  useEffect(() => {
    if (!hostUpdateSupported && !watchingHost) return;
    let valid = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const result = await deviceRequest<{ update?: HostUpdate }>(config, 'update/status').catch(() => undefined);
      if (!valid) return;
      if (result?.update) setHostUpdate(result.update);
      if (hostUpdateRunning(result?.update) || (!result && watchingHost)) timer = setTimeout(() => void refresh(), 3500);
    }
    void refresh();
    return () => { valid = false; clearTimeout(timer); };
  }, [config, hostUpdateSupported, watchingHost, connected]);

  async function check() {
    setBusy(true);
    setError('');
    try {
      const data = await checkLatestRelease();
      cachedRelease = { data, checkedAt: Date.now() };
      setRelease(data);
    } catch {
      setError('无法读取 GitHub 更新。可以重试或打开发布页。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!cachedRelease || Date.now() - cachedRelease.checkedAt > 120_000) void check();
  }, []);

  async function updatePhone() {
    if (!release?.androidSha256) return;
    setInstalling('phone');
    setError('');
    setPhoneStatus('');
    try {
      const result = await CompanionUpdate.install({ version: release.version, sha256: release.androidSha256 });
      setPhoneStatus(result.state === 'permission'
        ? '请允许本 App 安装应用，返回后再点一次「更新手机」。'
        : '请在 Android 安装界面确认更新。');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '手机更新失败，请重试。');
    } finally {
      setInstalling(undefined);
    }
  }

  async function updateHost() {
    if (!release) return;
    confirmation.current?.close();
    setInstalling('host');
    setError('');
    try {
      setHostUpdate(await deviceRequest<HostUpdate>(config, 'update/start', { version: release.version }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '电脑更新请求失败，请重试。');
    } finally {
      setInstalling(undefined);
    }
  }

  const mobileComparison = release ? compareReleaseVersions(mobileVersion, release.version) : undefined;
  const hostComparison = release ? compareReleaseVersions(hostVersion, release.version) : undefined;
  const requiredHostComparison = release?.minimumHost ? compareReleaseVersions(hostVersion, release.minimumHost) : undefined;
  return <section className="computer-utility" aria-busy={busy || Boolean(installing) || watchingHost}>
    <ComputerCardHeading title="版本与更新" icon={<UpdateIcon />}>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void check()}>{busy ? '正在检查…' : '检查更新'}</button>
    </ComputerCardHeading>
    <dl className="computer-versions">
      <div className="computer-setting-row"><dt>手机</dt><dd>{mobileVersion || (native ? '待读取' : '浏览器预览')}</dd></div>
      <div className="computer-setting-row"><dt>电脑</dt><dd>{hostVersion || '待连接'}</dd></div>
    </dl>
    {error && <p className="computer-feedback" data-tone="error" role="status">{error} <a href={releasePage} target="_blank" rel="noreferrer">查看发布页</a></p>}
    {phoneStatus && <p className="computer-feedback" role="status">{phoneStatus}</p>}
    {hostUpdate && <p className="computer-feedback" data-tone={hostUpdate.stage === 'failed' ? 'error' : undefined} role="status">
      {hostUpdateLabels[hostUpdate.stage]}</p>}
    {release && <div className="computer-update-result computer-reveal" aria-live="polite">
      <strong>GitHub 最新版 {release.version}</strong>
      {mobileComparison !== undefined && <small>{mobileComparison < 0 ? '手机有新版本' : '手机已是最新版本'}</small>}
      <small>{requiredHostComparison !== undefined && requiredHostComparison < 0
        ? `电脑需要更新到 ${release.minimumHost} 或更高版本`
        : hostComparison === undefined ? '连接电脑后检查 Windows 版本'
          : hostComparison >= 0 ? '电脑已是最新版本'
            : requiredHostComparison !== undefined ? '电脑有可选更新，当前版本兼容' : '电脑有新版本，兼容性未确认'}</small>
      <div className="computer-update-links">
        {native && release.androidSha256 && mobileComparison !== undefined && mobileComparison < 0
          && <button className="primary-button" type="button" disabled={Boolean(installing) || watchingHost}
            onClick={() => void updatePhone()}>{installing === 'phone' ? '正在下载并校验…' : '更新手机'}</button>}
        {connected && hostUpdateSupported && release.windows && hostComparison !== undefined && hostComparison < 0
          && <button className="primary-button" type="button" disabled={Boolean(installing) || watchingHost}
            onClick={() => confirmation.current?.showModal()}>更新电脑</button>}
        {release.android && (mobileComparison === undefined || mobileComparison < 0) && <a href={release.android} target="_blank" rel="noreferrer">下载 APK</a>}
        {release.windows && (hostComparison === undefined || hostComparison < 0) && <a href={release.windows} target="_blank" rel="noreferrer">下载 Windows ZIP</a>}
        <a href={release.url} target="_blank" rel="noreferrer">发布说明</a>
      </div>
    </div>}
    <dialog className="session-dialog" ref={confirmation} aria-labelledby="computer-update-title"
      onClick={event => { if (event.target === event.currentTarget) confirmation.current?.close(); }}>
      <div className="session-sheet">
        <header className="sheet-title-row"><h2 id="computer-update-title">更新电脑配套服务</h2></header>
        <p>安装 {release?.version} 时，配套服务会短暂重启，完成后手机会自动重连。</p>
        <div className="device-actions">
          <button className="secondary-button" type="button" onClick={() => confirmation.current?.close()}>取消</button>
          <button className="primary-button" type="button" onClick={() => void updateHost()}>确认更新</button>
        </div>
      </div>
    </dialog>
  </section>;
}
