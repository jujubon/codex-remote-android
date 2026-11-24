import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { AccountUsagePanel } from '../src/components/AccountUsagePanel';
import { PhoneReader } from '../src/components/CrossNetworkReader';
import { DeviceTools } from '../src/components/DeviceTools';
import { MessageBubble } from '../src/components/MessageBubble';
import { shareFileToComputer } from '../src/lib/deviceTools';

vi.mock('@capacitor/core', async (original) => ({
  ...await original<typeof import('@capacitor/core')>(),
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
}));

const config = { serverUrl: 'https://host.example', pairingToken: 'test' };

test('casting and clipboard actions stay available before the device status reply', () => {
  const reader = renderToStaticMarkup(<PhoneReader config={config} />);
  const tools = renderToStaticMarkup(<DeviceTools config={config} updateStatus={() => undefined} />);

  expect(reader).toContain('<h2>手机投屏</h2>');
  expect(reader).toContain('开始跨网投屏');
  expect(reader).toContain('role="switch"');
  expect(reader).not.toContain('先在电脑');
  expect(tools).toMatch(/<button type="button" class="secondary-button">发送手机剪贴板/);
  expect(tools).toMatch(/<button type="button" class="secondary-button">拉取电脑剪贴板/);
  expect(tools).toContain('分享文件到电脑');
  expect(tools).toMatch(/<input[^>]+type="file"[^>]+multiple/);
});

test('holds failed tool details closed until requested', () => {
  const view = renderToStaticMarkup(<MessageBubble message={{
    id: 'tool', threadId: 'chat', role: 'tool', status: 'failed', content: 'private output\nfull tool details', createdAt: 1,
  }} />);
  expect(view).not.toMatch(/<details[^>]*\sopen/);
  expect(view).not.toContain('full tool details');
});

test('sends selected files directly to the computer receive folder endpoint', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ fileName: '图片.jpg' }), { status: 201 }));
  vi.stubGlobal('fetch', request);
  try {
    const file = new File(['image bytes'], '图片.jpg', { type: 'image/jpeg' });
    await expect(shareFileToComputer(config, file)).resolves.toEqual({ fileName: '图片.jpg' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/api/device/share/file' }), expect.objectContaining({
      method: 'POST', body: file, headers: expect.objectContaining({ 'X-CMR-Filename': encodeURIComponent(file.name) }),
    }));
  } finally { vi.unstubAllGlobals(); }
});

test('quota can be retried after a request times out', () => {
  const view = renderToStaticMarkup(<AccountUsagePanel usage={null} status="读取额度超时" refresh={() => undefined} />);
  expect(view).toMatch(/<button type="button" class="secondary-button">刷新/);
});
