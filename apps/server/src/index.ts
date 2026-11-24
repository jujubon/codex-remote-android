import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { BlockList } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { ReaderStream } from "./reader-stream.js";
import { LocalReaderError, localReaderLauncher } from "./local-reader.js";
import { DeviceTools } from "./device-tools.js";
import { mkdir, readFile } from "node:fs/promises";
import { AppServerBridge } from "./app-server-bridge.js";
import { authenticateBearer } from "./auth.js";
import { buildCodexEnvironment, HOST_VERSION, loadConfig } from "./config.js";
import { DesktopIpcBridge } from "./desktop-ipc-bridge.js";
import { FileTransferError, FileTransferManager } from "./file-transfer.js";
import { MobileGateway } from "./gateway.js";
import { PromptQueueStore } from "./prompt-queue.js";

const config = loadConfig();
const bridge = new AppServerBridge({
  codexBin: config.codexBin,
  codexArgs: config.codexArgs,
  env: buildCodexEnvironment(config.codexHome),
  expectedCodexHome: config.codexHome,
});
const desktopIpc = new DesktopIpcBridge(
  config.desktopIpc,
  config.desktopIpcEndpoint,
);
const promptQueue = await PromptQueueStore.create(config.promptQueueFile);
if (config.fileRoots.includes(config.uploadDirectory)) await mkdir(config.uploadDirectory, { recursive: true, mode: 0o700 });
const files = await FileTransferManager.create({ allowedRoots: config.fileRoots, uploadDirectory: config.uploadDirectory });
await files.cleanupOrphanedUploads(promptQueue.protectedFilePaths());
const gateway = new MobileGateway(bridge, config, desktopIpc, files, promptQueue);
const heartbeat = gateway.startHeartbeat();
const device = new DeviceTools(
  join(dirname(config.promptQueueFile), "device-tools.json"),
  process.env.CMR_PHONE_DROP_DIR,
  threadId => gateway.currentTurnForPowerHold(threadId),
  (threadId, turnId) => gateway.turnFinishedForPowerHold(threadId, turnId),
);
const fileCleanup = setInterval(() => void Promise.all([files.cleanupExpired(), files.cleanupOrphanedUploads(promptQueue.protectedFilePaths())]).catch((error) => console.warn("[files] cleanup", error)), 60_000);
fileCleanup.unref();

const readerViewerPort = config.port === 65535 ? 8788 : config.port + 1;
const reader = new ReaderStream(readerViewerPort, Date.now,
  localReaderLauncher(process.env.CMR_PHONE_READER_SCRIPT, readerViewerPort),
  localReaderLauncher(process.env.CMR_PHONE_READER_SCRIPT, readerViewerPort, true));
const server = createServer((request, response) => void handleHttp(request, response));
let localServer: ReturnType<typeof createServer> | undefined;
let localHost = "";
let localListenerTimer: ReturnType<typeof setInterval> | undefined;

async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const proofRequest = /^\/api\/local-proof\?nonce=([a-f0-9]{32})$/.exec(request.url ?? "");
  if (request.method === "GET" && proofRequest && request.socket.localPort === 18788 && request.socket.localAddress === localHost) {
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.has(origin)) {
      json(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (origin) response.setHeader("access-control-allow-origin", origin);
    json(response, 200, {
      proof: createHmac("sha256", config.token).update(`codex-remote-local-v1:${proofRequest[1]}`).digest("hex"),
    });
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(bridge.ready ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      ok: bridge.ready,
      service: "codex-mobile-remote",
      version: HOST_VERSION,
      desktopIpc: desktopIpc.ready,
      desktopIpcSupported: desktopIpc.supported,
      desktopIpcReady: desktopIpc.ready,
    }));
    return;
  }

  if (request.url?.startsWith("/api/reader/")) {
    if ((request.headers.origin && !config.allowedOrigins.has(request.headers.origin)) ||
        !authenticateBearer(request.headers.authorization, config)) {
      request.resume();
      json(response, 401, { error: "unauthorized" });
      return;
    }
    try { await reader.ingest(request, response); }
    catch { if (!response.destroyed && !response.headersSent) json(response, 400, { error: "投屏请求未完成。" }); }
    return;
  }

  const isDevice = request.url?.startsWith("/api/device/");
  if (isDevice || request.url?.startsWith("/api/files/")) {
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.has(origin)) {
      json(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, X-CMR-Filename, X-CMR-Request-Id, ngrok-skip-browser-warning",
        "access-control-max-age": "600",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (!authenticateBearer(request.headers.authorization, config)) {
      response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    try {
      if (isDevice) {
        await handleDevice(request, response);
        return;
      }
      if (request.method === "POST" && request.url === "/api/files/upload") {
        const encodedName = String(request.headers["x-cmr-filename"] ?? "file");
        let fileName = "file";
        try { fileName = decodeURIComponent(encodedName); } catch { fileName = encodedName; }
        const contentLength = Number.parseInt(String(request.headers["content-length"] ?? ""), 10);
        const upload = await files.receiveUpload({
          stream: request,
          fileName,
          mimeType: request.headers["content-type"],
          contentLength: Number.isFinite(contentLength) ? contentLength : null,
        });
        json(response, 201, upload);
        return;
      }
      if (request.method === "POST" && request.url === "/api/files/ticket") {
        const body = await readJsonBody(request, 64 * 1024);
        const path = typeof body.path === "string" ? body.path : "";
        const ticket = await files.createDownloadTicket(path);
        json(response, 201, ticket);
        return;
      }
      const match = request.method === "GET" ? /^\/api\/files\/download\/([A-Za-z0-9_-]{22,128})$/.exec(request.url ?? "") : null;
      if (match) {
        const download = await files.claimDownload(match[1]!);
        response.writeHead(200, {
          "content-type": download.mimeType,
          "content-length": String(download.size),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.fileName)}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        download.stream.on("error", () => response.destroy());
        download.stream.pipe(response);
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error instanceof FileTransferError ? error.httpStatus : error instanceof LocalReaderError ? 409 : 500;
      json(response, status, { error: error instanceof Error ? error.message : "file transfer failed" });
    }
    return;
  }

  json(response, 404, { error: "not_found" });
}

async function handleDevice(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/api/device/status") {
    json(response, 200, { ...await device.status(), reader: reader.status() });
    return;
  }
  if (request.method === "GET" && request.url === "/api/device/usage") {
    json(response, 200, await gateway.readAccountUsage());
    return;
  }
  if (!device.supported || request.method !== "POST") {
    json(response, 404, { error: "此电脑未提供设备工具。" });
    return;
  }
  switch (request.url) {
    case "/api/device/reader/open-local":
      request.resume();
      json(response, 200, await reader.openLocal());
      return;
    case "/api/device/reader/open-remote":
      request.resume();
      json(response, 200, await reader.openRemote());
      return;
    case "/api/device/clipboard/read":
      json(response, 200, await device.clipboardRead());
      return;
    case "/api/device/clipboard/write":
      await device.clipboardWrite((await readJsonBody(request, 384 * 1024)).text);
      break;
    case "/api/device/power/lock":
      await device.lock();
      break;
    case "/api/device/power/hold": {
      const body = await readJsonBody(request, 2048);
      await device.startHold(body.minutes, body.threadId);
      json(response, 200, await device.status());
      return;
    }
    case "/api/device/power/release":
      device.cancelHold();
      json(response, 200, await device.status());
      return;
    case "/api/device/share/file":
      json(response, 201, await device.file(request, files));
      return;
    case "/api/device/share/link": {
      const body = await readJsonBody(request, 16 * 1024);
      json(response, 201, await device.link(body.requestId, body.url));
      return;
    }
    default:
      json(response, 404, { error: "not_found" });
      return;
  }
  json(response, 200, { ok: true });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new FileTransferError("FILE_TOO_LARGE", "request body is too large", 413);
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FileTransferError("INVALID_ARGUMENT", "JSON object required", 400);
  return value as Record<string, unknown>;
}

server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] received ${signal}; shutting down`);
  clearInterval(heartbeat);
  clearInterval(fileCleanup);
  clearInterval(localListenerTimer);
  device.stopHold();
  reader.close();
  gateway.close();
  await desktopIpc.stop();
  await bridge.stop();
  localServer?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("[server] uncaught exception", error);
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  console.error("[server] unhandled rejection", error);
});

console.log(`[server] Codex home ${config.codexHome}`);
await bridge.start();
await desktopIpc.start();
server.listen(config.port, config.host, () => {
  reader.listen();
  console.log(`[server] listening on http://${config.host}:${config.port}`);
  console.log(`[server] websocket endpoint ws://${config.host}:${config.port}/ws`);
  if (config.packagedNodeReplRuntime)
    console.log(`[server] packaged Node REPL runtime ${config.packagedNodeReplRuntime.nodeRepl}`);
});
localHost = await readFile(join(dirname(config.promptQueueFile), "lan-address.txt"), "utf8").then(value => value.trim(), () => "");
if (config.host === "127.0.0.1" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(localHost)) {
  const refreshLocalListener = () => {
    const adapter = Object.values(networkInterfaces()).flat().find(entry => entry?.family === "IPv4" && entry.address === localHost);
    const prefix = Number(adapter?.cidr?.split("/")[1]);
    if (!adapter || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) {
      localServer?.close();
      localServer = undefined;
      return;
    }
    if (localServer) return;
    const subnet = new BlockList();
    subnet.addSubnet(localHost, prefix);
    const listener = createServer((request, response) => void handleHttp(request, response));
    localServer = listener;
    listener.prependListener("connection", socket => {
      if (!socket.remoteAddress || !subnet.check(socket.remoteAddress)) socket.destroy();
    });
    listener.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
    listener.on("error", error => {
      if (localServer === listener) localServer = undefined;
      console.warn("[server] LAN listener unavailable:", error.message);
    });
    listener.listen(18788, localHost);
  };
  refreshLocalListener();
  localListenerTimer = setInterval(refreshLocalListener, 5000);
  localListenerTimer.unref();
}
