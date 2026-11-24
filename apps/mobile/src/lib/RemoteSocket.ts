import type { ClientMessage, ConnectionPhase, ServerMessage } from '../types/protocol';
import { isServerMessage, WIRE_PROTOCOL } from '../types/protocol';
import { toWebSocketUrl } from './configStore';
import { verifyLocalRoute } from './localRoute';

interface RemoteSocketOptions {
  serverUrl: string;
  localUrl?: string;
  onRoute?: (url: string) => void;
  onResume?: () => void;
  token: string;
  onMessage: (message: ServerMessage) => void;
  onPhase: (phase: ConnectionPhase, detail?: string) => void;
}

const MAX_RECONNECT_DELAY = 20_000;
const HEARTBEAT_INTERVAL = 20_000;
const PROBE_TIMEOUT = 5_000;

function base64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export class RemoteSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectAttempts = 0;
  private manuallyClosed = false;
  private welcomed = false;
  private networkListenersInstalled = false;
  private routeTimer: number | null = null;
  private routeGeneration = 0;
  private localRetryAfter = 0;
  private checkingRoute = false;
  private activeServerUrl = '';
  private handshakeTimer: number | null = null;
  private probe: { id: string; timer: number; resuming: boolean } | null = null;
  private probeSequence = 0;
  private suspended = false;

  constructor(private readonly options: RemoteSocketOptions) {}

  get serverUrl(): string {
    return this.welcomed ? this.activeServerUrl : this.options.serverUrl;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.installNetworkListeners();
    if (navigator.onLine === false) {
      this.options.onPhase('offline', '手机当前没有网络连接；访问局域网主机时请连接同一 Wi-Fi');
      return;
    }
    this.open(false);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.routeGeneration++;
    this.welcomed = false;
    this.clearTimers();
    this.removeNetworkListeners();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'client disconnect');
    this.options.onPhase('offline');
  }

  reconnectNow(reconnecting = false): void {
    this.routeGeneration++;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    socket?.close();
    this.reconnectAttempts = 0;
    this.manuallyClosed = false;
    void this.open(reconnecting);
  }

  suspend(): void {
    this.suspended = true;
    this.clearProbe();
  }

  resume(): void {
    this.suspended = false;
    if (this.manuallyClosed || navigator.onLine === false) return;
    if (this.socket?.readyState === WebSocket.OPEN && this.welcomed) {
      if (!this.probe?.resuming) this.checkConnection(true);
    } else if (this.socket?.readyState !== WebSocket.CONNECTING && this.socket?.readyState !== WebSocket.OPEN) {
      this.reconnectNow(true);
    }
  }

  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.welcomed) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private async open(reconnecting: boolean, route?: string): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    if (navigator.onLine === false) {
      this.options.onPhase('offline', '手机当前没有网络连接；访问局域网主机时请连接同一 Wi-Fi');
      return;
    }

    const generation = ++this.routeGeneration;
    this.options.onPhase(reconnecting ? 'reconnecting' : 'connecting');
    const serverUrl = route ?? (this.options.localUrl && Date.now() >= this.localRetryAfter &&
      await verifyLocalRoute(this.options.localUrl, this.options.token) ? this.options.localUrl : this.options.serverUrl);
    if (this.manuallyClosed || generation !== this.routeGeneration) return;
    let wsUrl: string;
    try {
      wsUrl = toWebSocketUrl(serverUrl);
    } catch (error) {
      this.options.onPhase('error', error instanceof Error ? error.message : '服务器地址无效');
      return;
    }

    this.activeServerUrl = serverUrl;
    const tokenProtocol = `token.${base64UrlUtf8(this.options.token)}`;
    const socket = new WebSocket(wsUrl, [WIRE_PROTOCOL, tokenProtocol]);
    this.socket = socket;
    const isLocal = serverUrl === this.options.localUrl;
    this.handshakeTimer = window.setTimeout(() => {
      if (socket !== this.socket || this.welcomed) return;
      this.clearTimers();
      this.socket = null;
      socket.close();
      if (isLocal) {
        this.localRetryAfter = Date.now() + 30_000;
        void this.open(true, this.options.serverUrl);
      } else {
        this.scheduleReconnect('等待电脑连接超时');
      }
    }, isLocal ? 2600 : 12_000);

    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.welcomed = false;
    };

    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      try {
        const payload: unknown = JSON.parse(String(event.data));
        const messages = Array.isArray(payload) ? payload : [payload];
        for (const message of messages) {
          if (!isServerMessage(message)) continue;
          if (message.type === 'welcome') {
            if (this.handshakeTimer !== null) window.clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
            this.welcomed = true;
            this.options.onRoute?.(serverUrl);
            this.reconnectAttempts = 0;
            this.options.onPhase('connected', message.codexReady ? undefined : 'Bridge 已连接，但 Codex app-server 尚未就绪');
            this.startHeartbeat();
          }
          if (message.type === 'pong' && this.probe && message.id === this.probe.id) {
            const { resuming } = this.probe;
            this.clearProbe();
            if (resuming) {
              this.options.onResume?.();
              void this.refreshRoute();
            }
          }
          this.options.onMessage(message);
        }
      } catch {
        this.options.onPhase('error', '收到无法解析的服务器消息');
      }
    };

    socket.onerror = () => {
      if (socket === this.socket && !this.welcomed) {
        this.options.onPhase('error', '连接失败，请检查地址和配对令牌');
      }
    };

    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      if (!this.welcomed && serverUrl === this.options.localUrl) this.localRetryAfter = Date.now() + 30_000;
      this.socket = null;
      this.welcomed = false;
      this.clearTimers();
      if (!this.manuallyClosed) {
        const detail = event.reason
          || (event.code === 1006
            ? '无法连接主机，请检查手机 Wi-Fi、服务器地址和配对令牌'
            : `连接已关闭（代码 ${event.code}）`);
        this.scheduleReconnect(detail);
      }
    };
  }


  private readonly handleNetworkOffline = (): void => {
    if (this.manuallyClosed) return;
    this.routeGeneration++;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    socket?.close(1000, 'device offline');
    this.options.onPhase('offline', '手机当前没有网络连接；访问局域网主机时请连接同一 Wi-Fi');
  };

  private readonly handleNetworkOnline = (): void => {
    if (this.manuallyClosed) return;
    if (!this.suspended) this.resume();
    else if (!this.socket) this.reconnectNow(true);
  };

  private installNetworkListeners(): void {
    if (this.networkListenersInstalled) return;
    window.addEventListener('offline', this.handleNetworkOffline);
    window.addEventListener('online', this.handleNetworkOnline);
    if (this.options.localUrl) this.routeTimer = window.setInterval(() => void this.refreshRoute(), 10_000);
    this.networkListenersInstalled = true;
  }

  private removeNetworkListeners(): void {
    if (!this.networkListenersInstalled) return;
    window.removeEventListener('offline', this.handleNetworkOffline);
    window.removeEventListener('online', this.handleNetworkOnline);
    if (this.routeTimer !== null) window.clearInterval(this.routeTimer);
    this.routeTimer = null;
    this.networkListenersInstalled = false;
  }

  private async refreshRoute(): Promise<void> {
    const local = this.options.localUrl;
    if (!local || this.checkingRoute || !this.welcomed || this.manuallyClosed || this.suspended || document.hidden) return;
    const generation = this.routeGeneration;
    this.checkingRoute = true;
    try {
      const next = Date.now() >= this.localRetryAfter && await verifyLocalRoute(local, this.options.token) ? local : this.options.serverUrl;
      if (generation !== this.routeGeneration || !this.welcomed || this.suspended || next === this.activeServerUrl) return;
      this.clearTimers();
      const old = this.socket;
      this.socket = null;
      this.welcomed = false;
      old?.close(1000, 'network route changed');
      void this.open(true, next);
    } finally { this.checkingRoute = false; }
  }

  private scheduleReconnect(reason?: string): void {
    this.reconnectAttempts += 1;
    const exponential = Math.min(MAX_RECONNECT_DELAY, 800 * 2 ** (this.reconnectAttempts - 1));
    const jitter = Math.floor(Math.random() * 400);
    const delay = exponential + jitter;
    const timing = `${Math.ceil(delay / 1000)} 秒后重试`;
    this.options.onPhase('reconnecting', reason ? `${reason}，${timing}` : timing);
    this.reconnectTimer = window.setTimeout(() => this.open(true), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.suspended && !document.hidden && !this.probe) this.checkConnection(false);
    }, HEARTBEAT_INTERVAL);
  }

  private checkConnection(resuming: boolean): void {
    this.clearProbe();
    const id = `ping_${++this.probeSequence}`;
    if (!this.send({ type: 'ping', id })) {
      this.reconnectNow(true);
      return;
    }
    const timer = window.setTimeout(() => {
      this.probe = null;
      if (!this.suspended && !document.hidden) this.reconnectNow(true);
    }, PROBE_TIMEOUT);
    this.probe = { id, timer, resuming };
  }

  private clearProbe(): void {
    if (this.probe) window.clearTimeout(this.probe.timer);
    this.probe = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    if (this.handshakeTimer !== null) window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearProbe();
    this.stopHeartbeat();
  }
}
