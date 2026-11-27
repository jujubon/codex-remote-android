import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState } from 'react';
import { checkLatestRelease, compareReleaseVersions, type RemoteRelease, type StartupUpdate } from '../lib/updates';

type Probe = { release: RemoteRelease; mobileVersion: string };

export function useStartupUpdate(enabled: boolean, hostVersion: string): StartupUpdate | undefined {
  const once = useRef<Promise<Probe> | undefined>(undefined);
  const [probe, setProbe] = useState<Probe>();
  const [waitedForHost, setWaitedForHost] = useState(false);

  useEffect(() => {
    if (!enabled || Capacitor.getPlatform() !== 'android') return;
    let mounted = true;
    once.current ??= Promise.all([
      checkLatestRelease(),
      CapacitorApp.getInfo().then(info => info.version).catch(() => ''),
    ]).then(([release, mobileVersion]) => ({ release, mobileVersion }));
    void once.current.then(result => { if (mounted) setProbe(result); }).catch(() => undefined);
    const timer = setTimeout(() => setWaitedForHost(true), 4000);
    return () => { mounted = false; clearTimeout(timer); };
  }, [enabled]);

  if (!probe || (!hostVersion && !waitedForHost)) return;
  const { release, mobileVersion } = probe;
  const phone = Boolean(release.android) && (compareReleaseVersions(mobileVersion, release.version) ?? 0) < 0;
  const host = Boolean(release.windows) && (compareReleaseVersions(hostVersion, release.version) ?? 0) < 0;
  return phone || host ? { release, phone, host } : undefined;
}
