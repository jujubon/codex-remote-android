import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSocket } from '../src/lib/RemoteSocket';
import { discoverLanUrl, supportsLanDiscovery, verifyLocalRoute } from '../src/lib/localRoute';
import type { ClientMessage, ServerMessage } from '../src/types/protocol';

vi.mock('../src/lib/localRoute', () => ({
  discoverLanUrl: vi.fn(),
  supportsLanDiscovery: vi.fn(),
  verifyLocalRoute: vi.fn(),
}));

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly instances: TestWebSocket[] = [];

  readyState = TestWebSocket.CONNECTING;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: ClientMessage[] = [];
  close = vi.fn(() => { this.readyState = 3; });

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  welcome() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
    this.receive({ type: 'welcome', serverId: 'test', codexReady: true, version: '0.9.12' });
  }
}

function connectedSocket() {
  const onResume = vi.fn();
  const onPhase = vi.fn();
  const client = new RemoteSocket({
    serverUrl: 'https://remote.example', token: 'test-token',
    onResume, onPhase, onMessage: vi.fn(),
  });
  client.connect();
  const socket = TestWebSocket.instances[0];
  socket.welcome();
  return { client, socket, onResume, onPhase };
}

describe('RemoteSocket foreground recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    TestWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', TestWebSocket);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('document', { hidden: false });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the current connection and catches up once after the matching pong', () => {
    const { client, socket, onResume, onPhase } = connectedSocket();
    client.suspend();
    client.resume();
    client.resume();
    expect(socket.sent).toHaveLength(1);
    const ping = socket.sent[0];
    if (ping.type !== 'ping') throw new Error('expected a foreground ping');
    socket.receive({ type: 'pong', id: 'stale' });
    expect(onResume).not.toHaveBeenCalled();
    socket.receive({ type: 'pong', id: ping.id });
    socket.receive({ type: 'pong', id: ping.id });
    vi.advanceTimersByTime(6_000);

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(onPhase.mock.calls.map(([phase]) => phase)).toEqual(['connecting', 'connected']);
  });

  it('reconnects once when the old connection stops returning pongs', () => {
    const { client, socket, onResume, onPhase } = connectedSocket();
    client.resume();
    vi.advanceTimersByTime(5_000);
    expect(TestWebSocket.instances).toHaveLength(2);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(onResume).not.toHaveBeenCalled();
    expect(onPhase).toHaveBeenLastCalledWith('reconnecting');

    client.resume();
    expect(TestWebSocket.instances).toHaveLength(2);
    TestWebSocket.instances[1].welcome();
    expect(onPhase).toHaveBeenLastCalledWith('connected', undefined);
  });

  it('cancels a pending foreground probe while suspended and ignores its late pong', () => {
    const { client, socket, onResume } = connectedSocket();
    client.resume();
    const oldPing = socket.sent[0];
    if (oldPing.type !== 'ping') throw new Error('expected a foreground ping');
    client.suspend();
    vi.advanceTimersByTime(25_000);
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(1);

    client.resume();
    const newPing = socket.sent[1];
    if (newPing.type !== 'ping') throw new Error('expected a new foreground ping');
    socket.receive({ type: 'pong', id: oldPing.id });
    expect(onResume).not.toHaveBeenCalled();
    socket.receive({ type: 'pong', id: newPing.id });
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('retries a cross-network socket that never receives its welcome', () => {
    const client = new RemoteSocket({
      serverUrl: 'https://remote.example', token: 'test-token', onPhase: vi.fn(), onMessage: vi.fn(),
    });
    client.connect();
    vi.advanceTimersByTime(14_000);
    expect(TestWebSocket.instances).toHaveLength(2);
    expect(TestWebSocket.instances[0].close).toHaveBeenCalledOnce();
  });

  it('discovers LAN without a public connection, follows DHCP changes, and returns to the fixed domain', async () => {
    vi.mocked(supportsLanDiscovery).mockReturnValue(true);
    const first = 'http://192.168.20.25:18788';
    const second = 'http://192.168.20.26:18788';
    let reachable: string | undefined = first;
    vi.mocked(discoverLanUrl).mockImplementation(async () => reachable);
    vi.mocked(verifyLocalRoute).mockImplementation(async candidate => candidate === reachable);
    const client = new RemoteSocket({
      serverUrl: 'https://remote.example', token: 'test-token', onPhase: vi.fn(), onMessage: vi.fn(),
    });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(TestWebSocket.instances.map(socket => socket.url)).toEqual(['ws://192.168.20.25:18788/ws']);
    TestWebSocket.instances[0].welcome();
    expect(client.serverUrl).toBe(first);

    reachable = second;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(TestWebSocket.instances[1].url).toBe('ws://192.168.20.26:18788/ws');
    TestWebSocket.instances[1].welcome();
    expect(client.serverUrl).toBe(second);

    reachable = undefined;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(TestWebSocket.instances[2].url).toBe('wss://remote.example/ws');
  });
});
