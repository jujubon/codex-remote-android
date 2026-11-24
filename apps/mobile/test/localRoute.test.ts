import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { normalizeLocalUrl } from '../src/lib/configStore';
import { verifyLocalRoute } from '../src/lib/localRoute';

it('accepts only an explicit private LAN endpoint for auto switching', () => {
  expect(normalizeLocalUrl('192.168.0.103:18788')).toBe('http://192.168.0.103:18788');
  expect(() => normalizeLocalUrl('https://remote.example')).toThrow();
  expect(() => normalizeLocalUrl('http://127.0.0.1:18788')).toThrow();
});

it('verifies the paired host without sending the token to the LAN probe', async () => {
  const token = 'test pairing secret';
  const request = vi.fn(async (url: URL) => {
    const challenge = url.searchParams.get('nonce');
    const proof = createHmac('sha256', token).update(`codex-remote-local-v1:${challenge}`).digest('hex');
    return new Response(JSON.stringify({ proof }));
  });
  vi.stubGlobal('fetch', request);
  try {
    expect(await verifyLocalRoute('http://192.168.0.103:18788', token)).toBe(true);
    expect(await verifyLocalRoute('http://192.168.0.103:18788', 'another token')).toBe(false);
    expect(request).toHaveBeenCalledWith(expect.any(URL), expect.not.objectContaining({ headers: expect.anything() }));
  } finally { vi.unstubAllGlobals(); }
});
