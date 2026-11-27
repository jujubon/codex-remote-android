import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest, type DeviceStatus } from '../lib/deviceTools';
import { CompanionUpdate, checkLatestRelease, compareReleaseVersions, hostUpdateRunning, releasePage, type HostUpdate, type RemoteRelease, type StartupUpdate } from '../lib/updates';
import { ComputerCardHeading } from './ComputerCardHeading';
import { AlertIcon, CheckIcon, CloseIcon, GaugeIcon, UpdateIcon } from './Icons';

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

type UpdateTone = 'success' | 'info' | 'error';

function UpdateToast({ text, tone, transient, dismissible, children, onDismiss }: {
  text: string;
  tone: UpdateTone;
  transient: boolean;
  dismissible: boolean;
  children?: ReactNode;
  onDismiss: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!transient || leaving) return;
    const timer = setTimeout(() => setLeaving(true), 3600);
    return () => clearTimeout(timer);
  }, [transient, leaving, text]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => dismiss.current(), 160);
    return () => clearTimeout(timer);
  }, [leaving]);
  const Icon = tone === 'success' ? CheckIcon : tone === 'error' ? AlertIcon : UpdateIcon;
  return createPortal(
    <div className="update-toast" data-tone={tone} data-leaving={leaving || undefined}>
      <span className="update-toast-icon"><Icon aria-hidden="true" /></span>
      <p role="status">{text}</p>
      {dismissible && <button type="button" className="nav-icon-button update-toast-close"
        aria-label="关闭更新提示" onClick={() => setLeaving(true)}><CloseIcon /></button>}
      {children && <div className="update-toast-actions">{children}</div>}
    </div>,
    document.body,
  );
}

export function UpdatePanel({ hostVersion, config, connected, hostUpdateSupported, requestedUpdate, onUpdateStarted }: {
  hostVersion: string; config: RemoteConfig; connected: boolean; hostUpdateSupported?: boolean;
  requestedUpdate?: StartupUpdate; onUpdateStarted: () => void;
}) {
  const [mobileVersion, setMobileVersion] = useState('');
  const [release, setRelease] = useState<RemoteRelease>();
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<'phone' | 'host'>();
  const [hostUpdate, setHostUpdate] = useState<HostUpdate>();
  const [error, setError] = useState('');
  const [phoneStatus, setPhoneStatus] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const confirmation = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLElement>(null);
  const appliedRequest = useRef<StartupUpdate | undefined>(undefined);
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
      const update = result?.update;
      if (update) {
        // A historical receipt is only relevant while following that update.
        setHostUpdate(previous => hostUpdateRunning(update) || previous?.version === update.version ? update : previous);
      }
      if (hostUpdateRunning(result?.update) || (!result && watchingHost)) timer = setTimeout(() => void refresh(), 3500);
    }
    void refresh();
    return () => { valid = false; clearTimeout(timer); };
  }, [config, hostUpdateSupported, watchingHost, connected]);

  async function check() {
    setBusy(true);
    setRelease(undefined);
    setHostUpdate(undefined);
    setError('');
    setPhoneStatus('');
    setDismissed(false);
    try {
      setRelease(await checkLatestRelease());
    } catch {
      setError('检查更新失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function updatePhone(target = release) {
    if (!target?.androidSha256) return;
    setInstalling('phone');
    setError('');
    setPhoneStatus('');
    try {
      const result = await CompanionUpdate.install({ version: target.version, sha256: target.androidSha256 });
      setPhoneStatus(result.state === 'permission'
        ? '允许安装应用后，返回再点「更新手机」。'
        : '请在 Android 安装界面确认更新。');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '手机更新失败，请重试。');
    } finally {
      setInstalling(undefined);
    }
  }

  async function updateHost(target = release): Promise<boolean> {
    if (!target) return false;
    confirmation.current?.close();
    setInstalling('host');
    setError('');
    try {
      setHostUpdate(await deviceRequest<HostUpdate>(config, 'update/start', { version: target.version }));
      setPhoneStatus('');
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '电脑更新请求失败，请重试。');
      return false;
    } finally {
      setInstalling(undefined);
    }
  }

  useEffect(() => {
    if (!requestedUpdate || appliedRequest.current === requestedUpdate) return;
    appliedRequest.current = requestedUpdate;
    onUpdateStarted();
    card.current?.scrollIntoView({ block: 'end' });
    setRelease(requestedUpdate.release);
    setDismissed(false);
    async function apply(update: StartupUpdate) {
      if (update.host && connected) {
        const supported = hostUpdateSupported ?? (await deviceRequest<DeviceStatus>(config, 'status').catch(() => undefined))?.hostUpdateSupported;
        if (supported && !await updateHost(update.release)) return;
      }
      if (update.phone && native) await updatePhone(update.release);
    }
    void apply(requestedUpdate);
  }, [requestedUpdate, onUpdateStarted, config, connected, hostUpdateSupported, native]);

  const mobileComparison = release ? compareReleaseVersions(mobileVersion, release.version) : undefined;
  const hostComparison = release ? compareReleaseVersions(hostVersion, release.version) : undefined;
  const phoneUpdate = mobileComparison !== undefined && mobileComparison < 0;
  const computerUpdate = hostComparison !== undefined && hostComparison < 0
    && !(hostUpdate?.stage === 'completed' && hostUpdate.version === release?.version);
  const available = phoneUpdate || computerUpdate;
  const upToDate = mobileComparison !== undefined && hostComparison !== undefined ? '已是最新版本'
    : mobileComparison !== undefined ? '手机已是最新版本'
    : hostComparison !== undefined ? '电脑已是最新版本' : '暂时无法确认已安装版本';
  const updateProgress = installing === 'phone' ? '正在下载并校验手机更新…'
    : installing === 'host' ? '正在请求电脑更新…' : undefined;
  const message = error || updateProgress || (watchingHost && hostUpdate ? hostUpdateLabels[hostUpdate.stage] : undefined)
    || phoneStatus || (hostUpdate ? hostUpdateLabels[hostUpdate.stage] : undefined)
    || (release && (available ? `发现新版本 ${release.version}` : upToDate));
  const pending = Boolean(installing) || watchingHost;
  const tone: UpdateTone = pending ? 'info' : error || hostUpdate?.stage === 'failed' ? 'error'
    : !available && !phoneStatus && (hostUpdate?.stage === 'completed' ||
      mobileComparison !== undefined || hostComparison !== undefined) ? 'success' : 'info';
  const showActions = available && !pending;
  const transient = !pending && !showActions && !phoneStatus && tone !== 'error';
  const canCheck = !busy && !pending;
  return <section ref={card} className="computer-utility" aria-busy={busy || Boolean(installing) || watchingHost}>
    <ComputerCardHeading title="版本与更新" icon={<UpdateIcon />}>
      <button className="secondary-button update-check-button" type="button" disabled={!canCheck} onClick={() => void check()}>
        {busy && <span className="update-check-spinner" aria-hidden="true" />}{busy ? '正在检查…' : '检查更新'}
      </button>
    </ComputerCardHeading>
    <dl className="computer-versions">
      <div className="computer-setting-row"><dt>手机</dt><dd>{mobileVersion || (native ? '待读取' : '浏览器预览')}</dd></div>
      <div className="computer-setting-row"><dt>电脑</dt><dd>{hostVersion || '待连接'}</dd></div>
    </dl>
    {!dismissed && message && <UpdateToast text={message} tone={tone} transient={transient}
      dismissible={!pending && !transient} onDismiss={() => setDismissed(true)}>
      {(showActions || tone === 'error') && <>
        {showActions && phoneUpdate && (native && release?.androidSha256
          ? <button className="primary-button" type="button" onClick={() => void updatePhone()}>更新手机</button>
          : release?.android && <a className="primary-button" href={release.android} target="_blank" rel="noreferrer">下载 APK</a>)}
        {showActions && computerUpdate && (connected && hostUpdateSupported && release?.windows
          ? <button className="primary-button" type="button" onClick={() => confirmation.current?.showModal()}>更新电脑</button>
          : release?.windows && <a className="primary-button" href={release.windows} target="_blank" rel="noreferrer">下载 Windows ZIP</a>)}
        <a className="update-release-link" href={release?.url ?? releasePage} target="_blank" rel="noreferrer">发布说明</a>
      </>}
    </UpdateToast>}
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
