import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { ReaderStream } from "../src/reader-stream.js";

describe("cross-network reader", () => {
    const frame = Uint8Array.of(255, 216, 33, 255, 217);
    const headers = { "x-cmr-reader-viewer": "1" };
    let now: number;
    let reader: ReaderStream;
    let sender: Server;
    let viewerUrl: string;
    let senderUrl: string;
    let launchLocal: () => Promise<void>;
    let launchRemote: () => Promise<void>;

    beforeEach(async () => {
        now = 30000;
        launchLocal = async () => {};
        launchRemote = async () => { await view(); };
        reader = new ReaderStream(0, () => now, () => launchLocal(), () => launchRemote());
        reader.listen();
        for (let i = 0; reader.localPort === undefined && i < 200; i++) await delay(10);
        if (reader.localPort === undefined) throw new Error("Reader failed to bind");
        viewerUrl = "http://127.0.0.1:" + reader.localPort;
        sender = createServer((request, response) => void reader.ingest(request, response));
        sender.listen(0, "127.0.0.1");
        await once(sender, "listening");
        const bound = sender.address();
        if (!bound || typeof bound === "string") throw new Error("Sender failed to bind");
        senderUrl = "http://127.0.0.1:" + bound.port + "/api/reader/";
    });

    afterEach(async () => {
        reader.close();
        if (sender?.listening) await new Promise<void>(resolve => sender.close(() => resolve()));
    });

    const view = () => fetch(viewerUrl + "/frame", { headers });
    const start = (control = false) => fetch(senderUrl + "start", {
        method: "POST",
        headers: control ? { "x-cmr-reader-controls": "1" } : undefined,
    });
    const turn = (session: string, action: string, extraHeaders = headers) => fetch(viewerUrl + "/control", {
        method: "POST",
        headers: { ...extraHeaders, "x-cmr-reader-session": session, "x-cmr-reader-action": action },
    });
    const poll = (session: string, command?: string, result = "done") => fetch(senderUrl + "control", {
        method: "POST",
        headers: {
            "x-cmr-reader-session": session,
            ...(command ? { "x-cmr-reader-command": command, "x-cmr-reader-result": result } : {}),
        },
    });
    const upload = (id: string, body = frame) => fetch(senderUrl + "frame", {
        method: "POST",
        body,
        headers: { "x-cmr-reader-session": id, "content-type": "image/jpeg" },
    });

    it("waits for the desktop to open once for concurrent Wi-Fi launch requests", async () => {
        let count = 0;
        let confirm!: () => void;
        launchLocal = () => new Promise<void>(resolve => { count++; confirm = resolve; });
        await view();
        const first = reader.openLocal();
        const second = reader.openLocal();
        expect(reader.status()).toMatchObject({ localActive: false, canOpenLocal: true });
        expect((await start()).status).toBe(409);
        confirm();
        expect(await first).toEqual({ alreadyOpen: false });
        expect(await second).toEqual({ alreadyOpen: false });
        expect(await reader.openLocal()).toEqual({ alreadyOpen: true });
        expect(count).toBe(1);
        expect(reader.status().localActive).toBe(true);
    });

    it("switches a reporting Wi-Fi viewer to cross-network and opens the receiver once", async () => {
        const report = (active: string) => fetch(viewerUrl + "/local", {
            method: "POST", headers: { ...headers, "x-cmr-reader-local": active },
        });
        let launches = 0;
        launchRemote = async () => { launches++; await view(); };
        await report("1");
        const first = reader.openRemote();
        const second = reader.openRemote();
        expect((await report("1")).headers.get("x-cmr-reader-switch")).toBe("remote");
        expect((await start()).status).toBe(409);
        await report("0");
        expect(await first).toEqual({ alreadyOpen: false });
        expect(await second).toEqual({ alreadyOpen: false });
        expect(await reader.openRemote()).toEqual({ alreadyOpen: true });
        expect(launches).toBe(1);
        expect((await start()).status).toBe(201);
    });

    it("keeps an active cross-network stream and allows retry after a launch error", async () => {
        await view();
        expect((await start()).status).toBe(201);
        await expect(reader.openLocal()).rejects.toThrow("先停止跨网投屏");
        expect((await fetch(viewerUrl + "/stop", { method: "POST", headers })).status).toBe(204);
        launchLocal = async () => { throw new Error("no-device"); };
        await expect(reader.openLocal()).rejects.toThrow("no-device");
        expect(reader.status().localActive).toBe(false);
        launchLocal = async () => {};
        await expect(reader.openLocal()).resolves.toEqual({ alreadyOpen: false });
    });

    it("requires a local viewer and an active session and clears the image after stop", async () => {
        expect((await start()).status).toBe(409);
        expect((await fetch(viewerUrl + "/frame")).status).toBe(403);
        expect((await fetch(viewerUrl + "/frame", { headers: { ...headers, Origin: "https://other.invalid" } })).status).toBe(403);
        expect((await view()).status).toBe(204);
        const opened = await start();
        expect(opened.status).toBe(201);
        const { id } = await opened.json();
        expect((await start()).status).toBe(409);
        expect((await upload("other")).status).toBe(410);
        expect((await upload(id, Uint8Array.of(0, 216, 33, 255, 217))).status).toBe(400);
        expect((await upload(id, new Uint8Array(161 * 1024))).status).toBe(400);
        expect((await upload(id)).status).toBe(204);
        const response = await view();
        expect(response.headers.has("x-cmr-reader-session")).toBe(false);
        expect((await turn(id, "next")).status).toBe(409);
        expect((await poll(id)).status).toBe(409);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
        const sequence = response.headers.get("x-cmr-frame");
        expect((await fetch(viewerUrl + "/frame?after=" + sequence, { headers })).status).toBe(304);
        expect((await fetch(viewerUrl + "/stop", { method: "POST", headers })).status).toBe(204);
        expect((await view()).status).toBe(204);
        expect((await upload(id)).status).toBe(410);
    });

    it("delivers only fixed gestures to the authorized sender and exposes its result to the viewer", async () => {
        await view();
        const session = await (await start(true)).json();
        expect(session.controls).toBe(true);
        expect((await turn(session.id, "next")).status).toBe(409);
        await upload(session.id);
        expect((await view()).headers.get("x-cmr-reader-session")).toBe(session.id);
        expect((await turn(session.id, "tap")).status).toBe(400);
        expect((await turn(session.id, "next", {})).status).toBe(403);
        expect((await turn("other", "next")).status).toBe(409);
        expect((await poll("other")).status).toBe(410);

        const listening = poll(session.id);
        const submitted = await turn(session.id, "next");
        const command = await submitted.json();
        expect(submitted.status).toBe(202);
        expect(await (await listening).json()).toEqual({ id: command.id, action: "next" });
        expect((await turn(session.id, "previous")).status).toBe(429);

        const acknowledged = poll(session.id, command.id, "wrong-app");
        for (let i = 0; i < 20; i++) {
            if ((await view()).headers.get("x-cmr-reader-command") === command.id) break;
            await delay(10);
        }
        const receipt = await view();
        expect(receipt.headers.get("x-cmr-reader-command")).toBe(command.id);
        expect(receipt.headers.get("x-cmr-reader-result")).toBe("wrong-app");
        const next = await turn(session.id, "scroll-up");
        expect(next.status).toBe(202);
        expect(await (await acknowledged).json()).toEqual({ ...(await next.json()), action: "scroll-up" });
    });

    it("expires a gesture before delivery and cancels polling when the viewer stops the stream", async () => {
        await view();
        const { id } = await (await start(true)).json();
        await upload(id);
        const command = await (await turn(id, "next")).json();
        now += 3100;
        const listening = poll(id);
        const receipt = await view();
        expect(receipt.headers.get("x-cmr-reader-command")).toBe(command.id);
        expect(receipt.headers.get("x-cmr-reader-result")).toBe("expired");
        expect((await fetch(viewerUrl + "/stop", { method: "POST", headers })).status).toBe(204);
        expect([204, 410]).toContain((await listening).status);
        expect((await poll(id)).status).toBe(410);
    });

    it("drops stale images and stops accepting frames after the local viewer has gone away", async () => {
        await view();
        const { id } = await (await start()).json();
        await upload(id);
        now += 5000;
        expect((await view()).status).toBe(204);
        expect((await upload(id)).status).toBe(204);
        now += 16000;
        expect((await upload(id)).status).toBe(410);
    });

    it("reports the desktop's selected route and waits for local mirroring to close", async () => {
        const local = (status: string, extraHeaders = headers) => fetch(viewerUrl + "/local", {
            method: "POST",
            headers: { ...extraHeaders, "x-cmr-reader-local": status },
        });
        expect(reader.status()).toEqual({ localActive: false, remoteReady: false, canOpenLocal: true });
        expect((await local("1", {})).status).toBe(403);
        expect((await local("1", { ...headers, Origin: "https://remote.invalid" })).status).toBe(403);
        expect((await local("1")).status).toBe(204);
        await view();
        expect(reader.status()).toEqual({ localActive: true, remoteReady: true, canOpenLocal: true });
        expect((await start()).status).toBe(409);
        expect((await local("0")).status).toBe(204);
        expect(reader.status().localActive).toBe(false);
        expect((await local("1")).status).toBe(204);
        now += 6500;
        expect(reader.status()).toEqual({ localActive: false, remoteReady: true, canOpenLocal: true });
        expect((await start()).status).toBe(201);
    });
});
