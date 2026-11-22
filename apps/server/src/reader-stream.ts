import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MAX_FRAME_BYTES = 160 * 1024;
const VIEWER_IDLE_MS = 15_000;
const LOCAL_IDLE_MS = 6_000;
const SENDER_IDLE_MS = 25_000;
const FRAME_FRESH_MS = 4_000;
const CONTROL_TTL_MS = 3_000;
const CONTROL_POLL_MS = 8_000;
const gestures = ["next", "previous", "scroll-down", "scroll-up"] as const;
const results = ["done", "wrong-app", "unavailable", "interrupted"] as const;
type Gesture = typeof gestures[number];
type ControlResult = typeof results[number] | "expired";
type Command = { id: string; action: Gesture; expires: number; delivered: boolean };
type Controls = {
    pending?: Command;
    result?: { id: string; status: ControlResult };
    reply?: (command?: Command) => void;
};
type Stream = { id: string; lastSeen: number; frame?: Buffer; receiving?: boolean; controls?: Controls };

function isOneOf<T extends string>(values: readonly T[], input: unknown): input is T {
    return typeof input === "string" && values.some(value => value === input);
}

export class ReaderStream {
    private viewerSeen = -Infinity;
    private localSeen = -Infinity;
    private stream?: Stream;
    private sequence = 0;
    private readonly viewer;
    private expiry?: NodeJS.Timeout;

    constructor(private readonly viewerPort: number, private readonly now = Date.now) {
        this.viewer = createServer((request, response) => this.serveViewer(request, response));
        this.viewer.on("error", error => console.warn("[phone-reader]", error.message));
    }

    get localPort(): number | undefined {
        const bound = this.viewer.address();
        return typeof bound === "object" && bound !== null ? bound.port : undefined;
    }

    status(): { localActive: boolean; remoteReady: boolean } {
        const now = this.now();
        return {
            localActive: now - this.localSeen <= LOCAL_IDLE_MS,
            remoteReady: now - this.viewerSeen <= VIEWER_IDLE_MS,
        };
    }

    listen(): void {
        this.viewer.listen(this.viewerPort, "127.0.0.1");
        this.expiry = setInterval(() => this.prune(), 1000);
        this.expiry.unref();
    }

    close(): void {
        clearInterval(this.expiry);
        this.endStream();
        this.localSeen = -Infinity;
        this.viewerSeen = -Infinity;
        this.viewer.close();
    }

    private endStream(): void {
        this.stream?.controls?.reply?.();
        this.stream = undefined;
    }

    private prune(): void {
        if (!this.stream) return;
        const now = this.now();
        const age = now - this.stream.lastSeen;
        if (age > SENDER_IDLE_MS || now - this.viewerSeen > VIEWER_IDLE_MS) return this.endStream();
        else if (age > FRAME_FRESH_MS) this.stream.frame = undefined;
        const controls = this.stream.controls;
        if (controls?.pending && controls.pending.expires <= now) {
            controls.result = { id: controls.pending.id, status: "expired" };
            controls.pending = undefined;
        }
    }

    async ingest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        this.prune();
        if (!this.viewer.listening) return this.json(response, 503, { error: "电脑投屏窗口服务未启动。" });
        if (request.method !== "POST") return this.json(response, 404, { error: "not_found" });
        if (request.url === "/api/reader/start") {
            const { localActive, remoteReady } = this.status();
            if (localActive) return this.json(response, 409, { error: "请先关闭电脑上的本地投屏小窗。" });
            if (!remoteReady)
                return this.json(response, 409, { error: "请先在电脑的「手机阅读窗」选择「改用跨网」。" });
            if (this.stream) return this.json(response, 409, { error: "已有屏幕共享，请先停止后再打开。" });
            const id = randomUUID();
            const controls = request.headers["x-cmr-reader-controls"] === "1" ? {} : undefined;
            this.stream = { id, lastSeen: this.now(), controls };
            return this.json(response, 201, { id, controls: controls !== undefined });
        }

        const id = request.headers["x-cmr-reader-session"];
        const stream = this.stream;
        if (!stream || !id || stream.id !== id) return this.json(response, 410, { error: "投屏已结束，请重新打开电脑窗口后再试。" });
        if (request.url === "/api/reader/stop") {
            this.endStream();
            return this.json(response, 200, { ok: true });
        }
        if (request.url === "/api/reader/control") return this.pollControls(request, response, stream);
        if (request.url !== "/api/reader/frame") return this.json(response, 404, { error: "not_found" });

        const size = Number(request.headers["content-length"]);
        if (!Number.isInteger(size) || size < 4 || size > MAX_FRAME_BYTES || request.headers["content-type"] !== "image/jpeg") {
            request.resume();
            return this.json(response, 400, { error: "图片超出投屏大小限制。" });
        }
        if (stream.receiving) {
            request.resume();
            return this.json(response, 429, { error: "上一帧仍在接收。" });
        }
        stream.receiving = true;
        try {
            const chunks: Buffer[] = [];
            let received = 0;
            for await (const chunk of request) {
                const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                received += data.length;
                if (received > size) return this.json(response, 400, { error: "图片长度不一致。" });
                chunks.push(data);
            }
            if (this.stream !== stream || this.now() - this.viewerSeen > VIEWER_IDLE_MS)
                return this.json(response, 410, { error: "电脑投屏窗口已断开。" });
            const frame = Buffer.concat(chunks);
            if (received !== size || frame[0] !== 0xff || frame[1] !== 0xd8 ||
                frame.at(-2) !== 0xff || frame.at(-1) !== 0xd9)
                return this.json(response, 400, { error: "无效的 JPEG 帧。" });
            stream.frame = frame;
            stream.lastSeen = this.now();
            this.sequence++;
            response.writeHead(204, { "cache-control": "no-store" }).end();
        } finally {
            stream.receiving = false;
        }
    }

    private pollControls(request: IncomingMessage, response: ServerResponse, stream: Stream): void {
        const controls = stream.controls;
        if (!controls) return this.json(response, 409, { error: "未授权电脑翻页。" });
        const result = request.headers["x-cmr-reader-result"];
        const pending = controls.pending;
        if (pending?.delivered && request.headers["x-cmr-reader-command"] === pending.id && isOneOf(results, result)) {
            controls.result = { id: pending.id, status: result };
            controls.pending = undefined;
        }
        if (controls.reply) return this.json(response, 429, { error: "已有翻页连接。" });
        const release = () => {
            clearTimeout(timer);
            response.off("close", release);
            controls.reply = undefined;
        };
        const reply = (command?: Command) => {
            release();
            if (!command) return void response.writeHead(204, { "cache-control": "no-store" }).end();
            command.delivered = true;
            this.json(response, 200, { id: command.id, action: command.action });
        };
        const timer = setTimeout(() => reply(), CONTROL_POLL_MS);
        controls.reply = reply;
        response.once("close", release);
        if (controls.pending && !controls.pending.delivered) reply(controls.pending);
    }

    private serveViewer(request: IncomingMessage, response: ServerResponse): void {
        const port = this.localPort;
        const host = "127.0.0.1:" + port;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; img-src blob:; style-src 'unsafe-inline'; frame-ancestors 'none'");
        if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== "http://" + host))
            return void response.writeHead(403).end();
        if (request.method === "GET" && request.url === "/")
            return void response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        if (request.method === "GET" && request.url === "/viewer.js")
            return void response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(script);
        if (request.headers["x-cmr-reader-viewer"] !== "1") return void response.writeHead(403).end();

        if (request.method === "GET" && request.url === "/ready") return void response.writeHead(204).end();
        if (request.method === "POST" && request.url === "/local") {
            const active = request.headers["x-cmr-reader-local"];
            if (active !== "0" && active !== "1") return void response.writeHead(400).end();
            this.localSeen = active === "1" ? this.now() : -Infinity;
            return void response.writeHead(204).end();
        }
        if (request.method === "POST" && request.url === "/stop") {
            this.endStream();
            return void response.writeHead(204).end();
        }
        const url = new URL(request.url ?? "/", "http://" + host);
        if (request.method === "POST" && url.pathname === "/control") {
            this.prune();
            const stream = this.stream;
            const action = request.headers["x-cmr-reader-action"];
            if (!isOneOf(gestures, action)) return void response.writeHead(400).end();
            if (!stream?.frame || !stream.controls || request.headers["x-cmr-reader-session"] !== stream.id)
                return void response.writeHead(409).end();
            if (stream.controls.pending) return void response.writeHead(429).end();
            const command = { id: randomUUID(), action, expires: this.now() + CONTROL_TTL_MS, delivered: false };
            stream.controls.pending = command;
            stream.controls.reply?.(command);
            return this.json(response, 202, { id: command.id });
        }
        if (request.method === "GET" && url.pathname === "/frame") {
            this.prune();
            this.viewerSeen = this.now();
            const stream = this.stream;
            const frame = stream?.frame;
            if (!frame) return void response.writeHead(204).end();
            const headers: Record<string, string> = { "x-cmr-frame": String(this.sequence) };
            if (stream.controls) {
                headers["x-cmr-reader-session"] = stream.id;
                if (stream.controls.result) {
                    headers["x-cmr-reader-command"] = stream.controls.result.id;
                    headers["x-cmr-reader-result"] = stream.controls.result.status;
                }
            }
            if (url.searchParams.get("after") === String(this.sequence))
                return void response.writeHead(304, headers).end();
            return void response.writeHead(200, { ...headers, "content-type": "image/jpeg", "content-length": frame.length }).end(frame);
        }
        response.writeHead(404).end();
    }

    private json(response: ServerResponse, status: number, value: object): void {
        response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(value));
    }
}

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>手机阅读窗 · 跨网</title>
<style>
body{margin:0;background:#16141c;color:#eee9fa;font:14px system-ui;display:grid;height:100dvh;grid-template-rows:auto 1fr auto}
header,footer{padding:8px 14px;background:#262033}
header,nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
button{padding:6px 12px;color:inherit;background:#513ab2;border:0;border-radius:7px;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
main{display:grid;place-items:center;min-height:0;position:relative;padding:10px}
img{width:100%;height:100%;min-height:0;object-fit:contain}
main p{position:absolute;text-align:center;margin:20px;line-height:1.65}
p,footer{color:#c2b8d4}
[hidden]{display:none}
</style></head><body>
<header><strong>手机阅读窗 · 跨网</strong><nav aria-label="阅读控制">
<button data-action="previous" disabled>上一页</button><button data-action="next" disabled>下一页</button>
<button id="stop" disabled>结束投屏</button></nav></header>
<main><p role="status">等待手机共享屏幕。<br>在 Codex Remote 的「电脑 → 手机阅读窗」点「开始跨网投屏」。</p><img alt="手机共享的画面" hidden></main>
<footer role="status" hidden></footer>
<script src="/viewer.js"></script></body></html>`;

const script = `
const image = document.querySelector('img');
const status = document.querySelector('main p');
const stop = document.querySelector('#stop');
const feedback = document.querySelector('footer');
const controls = document.querySelectorAll('[data-action]');
const headers = { 'x-cmr-reader-viewer': '1' };
const keys = { ArrowLeft: 'previous', ArrowRight: 'next', ArrowUp: 'scroll-up', ArrowDown: 'scroll-down' };
const failures = {
  'wrong-app': '请解锁手机并回到已选的阅读 App。',
  unavailable: '手机翻页服务不可用，请检查无障碍设置。',
  interrupted: '手机没有完成这个手势，请重试。',
  expired: '手机未及时确认，可查看画面后再试。'
};
let after = '', picture = '', session = '', pending = false, command = '';
let lastGesture = -Infinity, stopped = false;

function updateButtons() {
  for (const button of controls) button.disabled = !session || pending;
}
function clear(text) {
  if (picture) URL.revokeObjectURL(picture);
  picture = ''; after = ''; session = ''; pending = false; command = '';
  image.removeAttribute('src'); image.hidden = true; status.hidden = false;
  status.textContent = text; stop.disabled = true; feedback.hidden = true; updateButtons();
}
stop.onclick = async () => {
  stopped = true;
  try {
    const result = await fetch('/stop', {method: 'POST', headers});
    if (!result.ok) throw new Error();
    clear('已结束投屏。');
  } catch { clear('无法联系配套服务。'); }
  finally { stopped = false; }
};
async function turn(action) {
  if (!session || pending || performance.now() - lastGesture < 450) return;
  lastGesture = performance.now();
  const current = session;
  pending = true; updateButtons(); feedback.textContent = '正在等手机确认…';
  try {
    const response = await fetch('/control', {
      method: 'POST',
      headers: { ...headers, 'x-cmr-reader-session': current, 'x-cmr-reader-action': action },
      signal: AbortSignal.timeout(3500)
    });
    if (session !== current) return;
    if (response.ok) {
      const result = await response.json();
      if (session === current) command = result.id;
      return;
    }
    feedback.textContent = response.status === 429 ? '上一条手势尚未确认。' : '请在手机上授权电脑翻页。';
  } catch { if (session === current) feedback.textContent = '连接中断，请查看当前画面。'; }
  if (session === current) { pending = false; updateButtons(); }
}
for (const button of controls) button.onclick = () => turn(button.dataset.action);
document.addEventListener('keydown', event => {
  const action = keys[event.key];
  if (!action || !session || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  if (!event.repeat) void turn(action);
});
image.addEventListener('wheel', event => {
  if (!session || event.ctrlKey || !event.deltaY) return;
  event.preventDefault();
  void turn(event.deltaY > 0 ? 'scroll-down' : 'scroll-up');
}, {passive: false});
async function refresh() {
  try {
    const response = await fetch('/frame?after=' + after, {headers, cache: 'no-store', signal: AbortSignal.timeout(3000)});
    if (stopped) return;
    if (response.status === 204) { if (picture) clear('画面已断开或投屏已结束。'); return; }
    if (response.status !== 304) {
      if (!response.ok) throw new Error();
      const next = URL.createObjectURL(await response.blob());
      if (stopped) { URL.revokeObjectURL(next); return; }
      if (picture) URL.revokeObjectURL(picture);
      picture = next; after = response.headers.get('x-cmr-frame') || '';
      image.src = picture; image.hidden = false; status.hidden = true; stop.disabled = false;
    }
    const nextSession = response.headers.get('x-cmr-reader-session') || '';
    if (nextSession !== session || feedback.hidden) {
      session = nextSession; pending = false; command = '';
      feedback.textContent = session ? '左右键翻页 · 滚轮或上下键滚动' : '手机未开启电脑翻页';
      feedback.hidden = false; updateButtons();
    }
    if (command && response.headers.get('x-cmr-reader-command') === command) {
      const result = response.headers.get('x-cmr-reader-result');
      feedback.textContent = result === 'done' ? '手机已执行手势' : failures[result] || '手势未确认。';
      pending = false; command = ''; updateButtons();
    }
  } catch { clear('无法联系配套服务。'); }
  finally { setTimeout(refresh, 300); }
}
refresh();
`;
