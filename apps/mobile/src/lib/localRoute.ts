import { Capacitor, CapacitorHttp } from '@capacitor/core';

export async function verifyLocalRoute(localUrl: string, token: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
    const url = new URL('/api/local-proof', localUrl);
    url.searchParams.set('nonce', nonce);
    const response = Capacitor.isNativePlatform()
      ? await CapacitorHttp.request({ url: url.href, method: 'GET', connectTimeout: 1000, readTimeout: 1000, disableRedirects: true })
      : await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1200) }).then(async result => ({ status: result.status, data: await result.json() }));
    const proof = response.data?.proof;
    if (response.status !== 200 || typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false;
    const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signature = Uint8Array.from(proof.match(/../g)!, value => Number.parseInt(value, 16));
    return await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`codex-remote-local-v1:${nonce}`));
  } catch { return false; }
}
