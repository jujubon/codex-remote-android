import { Capacitor, registerPlugin } from '@capacitor/core';
import { toWebSocketUrl, type RemoteConfig } from './configStore';

const nativeClipboard = registerPlugin<{
  read(): Promise<{ text: string }>;
  write(options: { text: string }): Promise<void>;
}>('DeviceClipboard');

export interface DeviceStatus {
  supported: boolean;
  receiveFolder: string | null;
  shareError?: string;
  autoOpen: boolean;
  awakeUntil: number | null;
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

export async function deviceRequest<T>(config: RemoteConfig, action: string, body?: object): Promise<T> {
  const url = new URL(toWebSocketUrl(config.serverUrl));
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/device/' + action;
  const method = action === 'status' ? 'GET' : 'POST';
  const headers: Record<string, string> = { Authorization: 'Bearer ' + config.pairingToken, 'ngrok-skip-browser-warning': '1' };
  if (body) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal, cache: 'no-store', redirect: 'error' });
    if (response.status === 404) throw new Error('请将电脑端配套服务更新到 0.9.1。');
    if (response.status === 401) throw new Error('配对令牌失效，请检查连接设置。');
    if (response.status === 502 || response.status === 503) throw new Error('电脑暂时离线，请检查 Windows 服务和隧道。');
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error || '电脑未确认操作。');
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
