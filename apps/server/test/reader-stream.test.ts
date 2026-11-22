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

    beforeEach(async () => {
        now = 30000;
        reader = new ReaderStream(0, () => now);
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
    const start = () => fetch(senderUrl + "start", { method: "POST" });
    const upload = (id: string, body = frame) => fetch(senderUrl + "frame", {
        method: "POST",
        body,
        headers: { "x-cmr-reader-session": id, "content-type": "image/jpeg" },
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
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(frame);
        const sequence = response.headers.get("x-cmr-frame");
        expect((await fetch(viewerUrl + "/frame?after=" + sequence, { headers })).status).toBe(304);
        expect((await fetch(viewerUrl + "/stop", { method: "POST", headers })).status).toBe(204);
        expect((await view()).status).toBe(204);
        expect((await upload(id)).status).toBe(410);
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
});
