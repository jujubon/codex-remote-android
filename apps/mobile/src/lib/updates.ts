import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';

const repository = 'jujubon/codex-remote-android';
export const releasePage = `https://github.com/${repository}/releases/latest`;
const versionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

export interface RemoteRelease {
  version: string;
  minimumHost?: string;
  android?: string;
  androidSha256?: string;
  windows?: string;
  url: string;
}

export interface StartupUpdate {
  release: RemoteRelease;
  phone: boolean;
  host: boolean;
}

export const CompanionUpdate = registerPlugin<{
  install(options: { version: string; sha256: string }): Promise<{ state: 'permission' | 'installer' }>;
}>('CompanionUpdate');

export interface HostUpdate {
  version: string;
  stage: 'pending' | 'downloading' | 'switching' | 'completed' | 'failed';
}

export function hostUpdateRunning(update?: HostUpdate): boolean {
  return Boolean(update && ['pending', 'downloading', 'switching'].includes(update.stage));
}

export function compareReleaseVersions(current: string, expected: string): number | undefined {
  if (!versionPattern.test(current) || !versionPattern.test(expected)) return;
  const left = current.split('.').map(Number);
  const right = expected.split('.').map(Number);
  return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
}

export async function checkLatestRelease(): Promise<RemoteRelease> {
  const url = `https://api.github.com/repos/${repository}/releases/latest`;
  let status: number;
  let data: unknown;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({ url, connectTimeout: 8000, readTimeout: 8000, responseType: 'json', disableRedirects: true });
    ({ status, data } = response);
  } else {
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    status = response.status;
    data = await response.json();
  }
  const release = data as { tag_name?: unknown; body?: unknown; assets?: { name?: string; state?: string; digest?: unknown }[] } | null;
  const tag = release?.tag_name;
  if (status !== 200 || typeof tag !== 'string' || !tag.startsWith('v') || !versionPattern.test(tag.slice(1))) {
    throw new Error('暂时无法读取 GitHub 发布版本。');
  }
  const version = tag.slice(1);
  const android = `Codex-Remote-${version}.apk`;
  const windows = `Codex-Remote-Windows-${version}.zip`;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = (name: string) => assets.find(asset => asset?.name === name && asset.state === 'uploaded');
  const download = (name: string) => asset(name)
    ? `https://github.com/${repository}/releases/download/${tag}/${name}` : undefined;
  const digest = asset(android)?.digest;
  const androidSha256 = typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(digest) ? digest.slice(7).toLowerCase() : undefined;
  const minimumHost = typeof release?.body === 'string'
    ? release.body.match(/<!-- codex-remote:min-host=(\d{1,5}\.\d{1,5}\.\d{1,5}) -->/)?.[1] : undefined;
  return { version, minimumHost, android: download(android), androidSha256, windows: download(windows), url: `https://github.com/${repository}/releases/tag/${tag}` };
}
