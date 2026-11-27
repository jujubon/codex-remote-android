import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { createRequestId } from '../types/protocol';
import { toWebSocketUrl, type RemoteConfig } from './configStore';
import type { RemoteUploadResult } from './fileTransfer';

const nativeClipboard = registerPlugin<{
  read(): Promise<{ text: string }>;
  write(options: { text: string }): Promise<void>;
}>('DeviceClipboard');

export interface DeviceStatus {
  supported: boolean;
  computerControls?: boolean;
  displayControl?: boolean;
  shutdownPending?: boolean;
  shutdownError?: string;
  version?: string;
  receiveFolder: string | null;
  shareError?: string;
  autoOpen: boolean;
  awakeUntil: number | null;
  codexDesktop?: CodexDesktopState;
  antigravityDesktopInstalled?: boolean;
  antigravityDesktopOpen?: boolean;
  desktopCloseSupported?: boolean;
  hostUpdateSupported?: boolean;
  reader?: { localActive: boolean; remoteReady: boolean; canOpenLocal?: boolean };
}

export type CodexDesktopState = 'unavailable' | 'closed' | 'starting' | 'open';

export interface InboxFile {
  id: string;
  fileName: string;
  path: string;
  size: number;
  receivedAt: number;
  source: 'share' | 'chat';
}

export function registerInboxUpload(config: RemoteConfig, id: string) {
  return deviceRequest<RemoteUploadResult>(config, 'inbox/use', { id });
}

export async function loadInboxImage(config: RemoteConfig, id: string, thumbnail: boolean, signal: AbortSignal): Promise<Blob> {
  const url = new URL(toWebSocketUrl(config.serverUrl));
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = `/api/device/inbox/${thumbnail ? 'thumbnail' : 'preview'}/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + config.pairingToken, 'ngrok-skip-browser-warning': '1' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(thumbnail ? 8000 : 30_000)]),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    if (response.status === 404) throw new Error('图片预览需要更新电脑配套服务。');
    throw new Error(typeof body?.error === 'string' ? body.error : '暂时无法打开这张图片。');
  }
  if (!response.headers.get('Content-Type')?.startsWith('image/')) throw new Error('电脑未返回图片。');
  return response.blob();
}

export const QUICK_SHARE_KEY = 'codex.remote.quick-share';
export type HoldDuration = 30 | 60 | 120 | 'task';

export async function readPhoneClipboard() {
  if (Capacitor.isNativePlatform()) return (await nativeClipboard.read()).text;
  return navigator.clipboard.readText();
}

export async function writePhoneClipboard(text: string) {
  if (Capacitor.isNativePlatform()) await nativeClipboard.write({ text });
  else await navigator.clipboard.writeText(text);
}

export async function shareFileToComputer(config: RemoteConfig, file: File): Promise<{ fileName: string }> {
  if (file.size > 64 * 1024 * 1024) throw new Error('单个文件最多支持 64 MB。');
  const url = new URL(toWebSocketUrl(config.serverUrl));
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/device/share/file';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.pairingToken,
      'ngrok-skip-browser-warning': '1',
      'Content-Type': file.type || 'application/octet-stream',
      'X-CMR-Filename': encodeURIComponent(file.name),
      'X-CMR-Request-Id': createRequestId('share-file'),
    },
    body: file,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  const result = deviceResult<{ fileName: string }>(response.status, await response.json().catch(() => undefined));
  if (typeof result.fileName !== 'string') throw new Error('电脑未确认文件已接收。');
  return result;
}

export async function deviceRequest<T>(config: RemoteConfig, action: string, body?: object): Promise<T> {
  const url = new URL(toWebSocketUrl(config.serverUrl));
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/device/' + action;
  const method = ['status', 'usage', 'antigravity/usage', 'inbox', 'update/status', 'cockpit/accounts', 'cockpit/status'].includes(action)
    || (action === 'antigravity/models' && body === undefined)
    || (['audio/mute', 'display/power'].includes(action) && body === undefined) ? 'GET' : 'POST';
  const timeoutMs = action === 'inbox/clear' ? 60_000 : action === 'reader/open-remote' ? 25_000 : ['antigravity/usage', 'antigravity/models'].includes(action) ? 22_000
    : action.startsWith('usage/reset/') ? 25_000 : action === 'reader/open-local' ? 18_000 : action === 'usage' ? 6_000 : 12_000;
  const headers: Record<string, string> = { Authorization: 'Bearer ' + config.pairingToken, 'ngrok-skip-browser-warning': '1' };
  if (body) headers['Content-Type'] = 'application/json';
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: url.href, method, headers, data: body, disableRedirects: true,
      connectTimeout: Math.min(8_000, timeoutMs), readTimeout: timeoutMs,
      responseType: 'json',
    }).catch(() => { throw new Error('未收到电脑回执，请检查连接后重试。'); });
    return deviceResult<T>(response.status, response.data);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal, cache: 'no-store', redirect: 'error' });
    return deviceResult<T>(response.status, await response.json().catch(() => undefined));
  } finally {
    clearTimeout(timeout);
  }
}

function deviceResult<T>(status: number, result: unknown): T {
  if (status === 404) throw new Error('当前电脑端未提供这项功能，请检查电脑端版本。');
  if (status === 401) throw new Error('配对令牌失效，请检查连接设置。');
  if (status === 502 || status === 503 || status === 504) throw new Error('电脑暂时无法响应，请检查 Windows 服务和隧道。');
  if (status < 200 || status >= 300 || !result || typeof result !== 'object') {
    const error = result && typeof result === 'object' && 'error' in result ? result.error : undefined;
    throw new Error(typeof error === 'string' ? error : '电脑未确认操作。');
  }
  return result as T;
}
