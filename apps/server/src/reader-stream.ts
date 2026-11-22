import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MAX_FRAME_BYTES = 160 * 1024;
const VIEWER_IDLE_MS = 15_000;
const SENDER_IDLE_MS = 25_000;
const FRAME_FRESH_MS = 4_000;

export class ReaderStream {
    private viewerSeen = -Infinity;
    private stream?: { id: string; lastSeen: number; frame?: Buffer; receiving?: boolean };
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

    listen(): void {
        this.viewer.listen(this.viewerPort, "127.0.0.1");
        this.expiry = setInterval(() => this.prune(), 1000);
        this.expiry.unref();
    }

    close(): void {
        clearInterval(this.expiry);
        this.stream = undefined;
        this.viewer.close();
    }

    private prune(): void {
        if (!this.stream) return;
        const age = this.now() - this.stream.lastSeen;
        if (age > SENDER_IDLE_MS || this.now() - this.viewerSeen > VIEWER_IDLE_MS) this.stream = undefined;
        else if (age > FRAME_FRESH_MS) this.stream.frame = undefined;
    }

    async ingest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        this.prune();
        if (!this.viewer.listening) return this.json(response, 503, { error: "电脑投屏窗口服务未启动。" });
        if (request.method !== "POST") return this.json(response, 404, { error: "not_found" });
        if (request.url === "/api/reader/start") {
            if (this.now() - this.viewerSeen > VIEWER_IDLE_MS)
                return this.json(response, 409, { error: "请先在电脑打开「跨网阅读窗」。" });
            if (this.stream) return this.json(response, 409, { error: "已有屏幕共享，请先停止后再打开。" });
            const id = randomUUID();
            this.stream = { id, lastSeen: this.now() };
            return this.json(response, 201, { id });
        }

        const id = request.headers["x-cmr-reader-session"];
        const stream = this.stream;
        if (!stream || !id || stream.id !== id) return this.json(response, 410, { error: "投屏已结束，请重新打开电脑窗口后再试。" });
        if (request.url === "/api/reader/stop") {
            this.stream = undefined;
            return this.json(response, 200, { ok: true });
        }
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

        if (request.method === "POST" && request.url === "/stop") {
            this.stream = undefined;
            return void response.writeHead(204).end();
        }
        const url = new URL(request.url ?? "/", "http://" + host);
        if (request.method === "GET" && url.pathname === "/frame") {
            this.prune();
            this.viewerSeen = this.now();
            const frame = this.stream?.frame;
            if (!frame) return void response.writeHead(204).end();
            const headers = { "x-cmr-frame": String(this.sequence) };
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

const page = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>跨网阅读窗 · Codex Remote</title><style>body{margin:0;background:#16141c;color:#eee9fa;font:14px system-ui;display:grid;height:100dvh;grid-template-rows:auto 1fr}header{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#262033;gap:12px}button{padding:6px 12px;color:inherit;background:#513ab2;border:0;border-radius:7px;cursor:pointer}button:disabled{opacity:.45;cursor:default}main{display:grid;place-items:center;min-height:0;position:relative;padding:10px}img{width:100%;height:100%;min-height:0;object-fit:contain}p{position:absolute;text-align:center;color:#c2b8d4;margin:20px;line-height:1.65}[hidden]{display:none}</style></head><body><header><strong>跨网阅读窗</strong><button disabled>结束投屏</button></header><main><p role="status">等待手机共享屏幕。<br>在 Codex Remote 的「电脑」页点「开始跨网投屏」。</p><img alt="手机共享的画面" hidden></main><script src="/viewer.js"></script></body></html>';

const script = [
    "const image = document.querySelector('img'), status = document.querySelector('p'), stop = document.querySelector('button');",
    "const headers = { 'x-cmr-reader-viewer': '1' }; let after = '', picture = '';",
    "function clear(text) { if (picture) URL.revokeObjectURL(picture); picture = ''; after = ''; image.removeAttribute('src'); image.hidden = true; status.hidden = false; status.textContent = text; stop.disabled = true; }",
    "stop.onclick = async () => { try { const result = await fetch('/stop', {method: 'POST', headers}); if (!result.ok) throw new Error(); clear('已结束投屏。'); } catch { clear('无法联系配套服务。'); } };",
    "async function refresh() { try {",
    "  const response = await fetch('/frame?after=' + after, {headers, cache: 'no-store', signal: AbortSignal.timeout(3000)});",
    "  if (response.status === 204) { if (picture) clear('投屏已结束或已断开。'); } else if (response.status !== 304) {",
    "    if (!response.ok) throw new Error(); const next = URL.createObjectURL(await response.blob());",
    "    if (picture) URL.revokeObjectURL(picture); picture = next; after = response.headers.get('x-cmr-frame') || '';",
    "    image.src = picture; image.hidden = false; status.hidden = true; stop.disabled = false;",
    "  }",
    "} catch { clear('无法联系配套服务。'); } finally { setTimeout(refresh, 300); } }",
    "refresh();",
].join("\n");
