import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { FileInbox } from "../src/file-inbox.js";
import {
  FileTransferError,
  FileTransferManager,
  inferMimeType,
  normalizeMimeType,
  sanitizeFileName,
} from "../src/file-transfer.js";

const temporaryDirectories: string[] = [];

async function fixture(options: { now?: () => number; maxUploadBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cmr-file-transfer-"));
  temporaryDirectories.push(root);
  const uploads = join(root, ".uploads");
  const manager = await FileTransferManager.create({
    allowedRoots: [root],
    uploadDirectory: uploads,
    downloadTtlMs: 1_000,
    uploadTtlMs: 2_000,
    maxUploadBytes: options.maxUploadBytes ?? 1024,
    now: options.now,
  });
  return { root, uploads, manager };
}

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("file transfer primitives", () => {
  it("deletes only confirmed inbox receipts and keeps queued, pinned and changed files", async () => {
    const { manager, root } = await fixture();
    const inbox = new FileInbox(join(root, "inbox.json"), manager);
    const received = join(root, "received");
    await mkdir(received);
    const share = join(received, "share.png");
    await writeFile(share, "original");
    await inbox.recordShare(share);
    const upload = await manager.receiveUpload({ stream: Readable.from([Buffer.from("chat")]), fileName: "chat.txt" });
    await manager.commitUpload(upload.uploadId);
    const receipts = await inbox.list(received);
    const chat = receipts.find(file => file.source === "chat")!;
    const photo = receipts.find(file => file.source === "share")!;

    await expect(inbox.remove(received, upload.path, async () => false)).rejects.toMatchObject({ httpStatus: 410 });
    await expect(inbox.remove(received, chat.id, async () => true)).rejects.toMatchObject({ code: "FILE_IN_USE" });
    manager.pinUpload(upload.uploadId);
    await expect(inbox.remove(received, chat.id, async () => false)).rejects.toMatchObject({ code: "FILE_IN_USE" });
    manager.releaseUpload(upload.uploadId);
    await expect(inbox.remove(received, photo.id, async () => {
      await writeFile(share, "replaced image bytes");
      return false;
    })).rejects.toMatchObject({ code: "FILE_CHANGED" });
    expect(await readFile(share, "utf8")).toBe("replaced image bytes");
    expect(await inbox.remove(received, chat.id, async () => false)).toEqual({ id: chat.id, deleted: true });
    await expect(stat(upload.path)).rejects.toMatchObject({ code: "ENOENT" });
    const [updated] = await inbox.list(received);
    await inbox.remove(received, updated!.id, async () => false);
    await writeFile(share, "untracked replacement");
    expect(await inbox.list(received)).toEqual([]);
  });

  it("clears the inbox beyond its recent listing while preserving active, replaced, and newly received files", async () => {
    const { manager, root } = await fixture();
    const inbox = new FileInbox(join(root, "inbox.json"), manager);
    const received = join(root, "received");
    await mkdir(received);
    const changed = join(received, "changed.txt");
    const shared = join(received, "shared.txt");
    const unrelated = join(received, "unrelated.txt");
    const newShare = join(received, "new.txt");
    for (const path of [changed, shared, unrelated]) await writeFile(path, "original");
    await inbox.recordShare(changed);
    await inbox.recordShare(shared);

    const uploads = [];
    for (let index = 0; index < 61; index++) {
      const upload = await manager.receiveUpload({ fileName: `chat-${index}.txt`, stream: Readable.from(["file"]) });
      await manager.commitUpload(upload.uploadId);
      uploads.push(upload);
    }
    const [active, pinned] = uploads;
    manager.pinUpload(pinned!.uploadId);
    expect(await inbox.list(received)).toHaveLength(60);

    const result = await inbox.clear(received, async path => {
      if (path === changed) {
        await writeFile(changed, "replacement bytes");
        await writeFile(newShare, "new file");
        await inbox.recordShare(newShare);
      }
      return path === active!.path;
    });

    expect(result).toEqual({ deleted: 60, inUse: 2, failed: 1 });
    expect((await inbox.list(received)).map(file => file.path)).toEqual(expect.arrayContaining([active!.path, pinned!.path, changed, newShare]));
    expect(await inbox.list(received)).toHaveLength(4);
    expect(await readFile(unrelated, "utf8")).toBe("original");
    expect(await readFile(changed, "utf8")).toBe("replacement bytes");
  });

  it("recovers opted-in attachments after restart and keeps queued, reused and permanent files safe", async () => {
    const { manager, root, uploads } = await fixture();
    const upload = (fileName: string, deleteAfterTurn: boolean) =>
      manager.receiveUpload({ fileName, deleteAfterTurn, stream: Readable.from([Buffer.from(fileName)]) });
    const temporary = await upload("temporary.png", true);
    const permanent = await upload("permanent.png", false);
    await upload("unsubmitted.png", true);
    await manager.commitUpload(temporary.uploadId, "chat-a", "turn-a");
    await manager.commitUpload(permanent.uploadId, "chat-a", "turn-a");

    const restarted = await FileTransferManager.create({ allowedRoots: [root], uploadDirectory: uploads });
    const [candidate, ...others] = await restarted.pendingAttachmentCleanup();
    expect(candidate).toMatchObject({ path: temporary.path, threadId: "chat-a", turnId: "turn-a" });
    expect(others).toEqual([]);
    expect(await restarted.deleteCompletedAttachment(candidate!, new Set([temporary.path]))).toBe(false);
    const reused = await restarted.registerInboxFile(temporary.path);
    expect(reused.path).not.toBe(temporary.path);
    expect(await restarted.deleteCompletedAttachment(candidate!, new Set())).toBe(true);
    await expect(stat(temporary.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(permanent.path, "utf8")).toBe("permanent.png");
    expect(await readFile(reused.path, "utf8")).toBe("temporary.png");
    expect(await restarted.committedUploadPaths()).toEqual([permanent.path]);
  });

  it("streams small inbox images by receipt id and rejects changed or non-image entries", async () => {
    const { manager, root } = await fixture();
    const inbox = new FileInbox(join(root, "index.json"), manager);
    const image = join(root, "picture.png");
    const text = join(root, "private.txt");
    await writeFile(image, "picture bytes");
    await writeFile(text, "private contents");
    await inbox.recordShare(image);
    await inbox.recordShare(text);
    const files = await inbox.list(root);
    const photo = files.find(file => file.fileName === "picture.png")!;
    const other = files.find(file => file.fileName === "private.txt")!;
    const preview = await inbox.preview(root, photo.id, true);
    expect(preview.mime).toBe("image/png");
    expect(await streamText(preview.stream)).toBe("picture bytes");
    await expect(inbox.preview(root, other.id, false)).rejects.toMatchObject({ httpStatus: 415 });
    await writeFile(image, "different picture bytes");
    await expect(inbox.preview(root, photo.id, false)).rejects.toMatchObject({ httpStatus: 410 });
  });

  it("lists confirmed phone receipts and reuses the same bytes without taking ownership", async () => {
    let now = 0;
    const { manager, root, uploads } = await fixture({ now: () => now });
    const received = join(root, "received");
    await mkdir(received);
    const indexPath = join(root, "state", "inbox.json");
    const inbox = new FileInbox(indexPath, manager);
    const share = join(received, "phone.txt");
    await writeFile(share, "phone");
    await writeFile(join(received, "untracked.txt"), "not a receipt");
    await inbox.recordShare(share);
    const chat = await manager.receiveUpload({ stream: Readable.from([Buffer.from("chat")]), fileName: "chat.txt" });
    await manager.commitUpload(chat.uploadId);
    await manager.receiveUpload({ stream: Readable.from([Buffer.from("draft")]), fileName: "draft.txt" });

    const reloaded = new FileInbox(indexPath, manager);
    const entries = await reloaded.list(received);
    expect(entries.map(entry => [entry.fileName, entry.source])).toEqual(expect.arrayContaining([["phone.txt", "share"], ["chat.txt", "chat"]]));
    expect(entries).toHaveLength(2);
    const entry = entries.find(candidate => candidate.source === "share")!;
    const registered = await reloaded.use(received, entry.id);
    expect(registered.path).toBe(entry.path);
    expect(await readdir(uploads)).toHaveLength(2);
    expect(await manager.getUpload(registered.uploadId)).toEqual(registered);
    await manager.commitUpload(registered.uploadId);
    now += 3_000;
    await manager.cleanupExpired();
    expect(await readFile(share, "utf8")).toBe("phone");
    expect(await readFile(chat.path, "utf8")).toBe("chat");
    await expect(reloaded.use(root, entry.id)).rejects.toMatchObject({ httpStatus: 410 });
    await writeFile(share, "replacement with other contents");
    await expect(reloaded.use(received, entry.id)).rejects.toMatchObject({ httpStatus: 410 });
  });

  it("sanitizes traversal, separators, controls, and excessively long names", () => {
    expect(sanitizeFileName(" ../../secret\\name\u0000.txt ")).toBe("_.._secret_name.txt");
    expect(Buffer.byteLength(sanitizeFileName(`${"你".repeat(100)}.png`))).toBeLessThanOrEqual(180);
    expect(sanitizeFileName("... ")).toBe("file");
    expect(normalizeMimeType("Image/PNG; charset=binary")).toBe("image/png");
    expect(normalizeMimeType("text/plain\r\nX-Evil: yes")).toBe("application/octet-stream");
    expect(inferMimeType("PHOTO.PNG")).toBe("image/png");
  });

  it("streams uploads to a private random directory without trusting the original path", async () => {
    const { manager } = await fixture();
    const result = await manager.receiveUpload({
      stream: Readable.from([Buffer.from("hello "), Buffer.from("world")]),
      fileName: "../../report.md",
      mimeType: "text/markdown; charset=utf-8",
      contentLength: 11,
    });

    expect(result.uploadId).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(result.fileName).toBe("_.._report.md");
    expect(result.mimeType).toBe("text/markdown");
    expect(result.size).toBe(11);
    expect(await readFile(result.path, "utf8")).toBe("hello world");
    if (process.platform !== "win32")
      expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  });

  it("rejects oversized streams and removes their partial files", async () => {
    const { manager, uploads } = await fixture({ maxUploadBytes: 5 });
    await expect(manager.receiveUpload({
      stream: Readable.from([Buffer.from("123"), Buffer.from("456")]),
      fileName: "large.bin",
    })).rejects.toMatchObject({ code: "FILE_TOO_LARGE", httpStatus: 413 });
    expect(await readdir(uploads)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("only registers canonical regular files inside allowed roots, including symlink resolution", async () => {
    const { root, manager } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "cmr-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

    await expect(manager.createDownloadTicket(join(root, "escape.txt"))).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
      httpStatus: 403,
    });
    await expect(manager.createDownloadTicket(root)).rejects.toMatchObject({ code: "NOT_A_FILE" });
  });

  it("allows only an exact Desktop canonical attachment outside configured roots", async () => {
    const { manager } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "cmr-desktop-attachment-"));
    temporaryDirectories.push(outside);
    const image = join(outside, "screen.png");
    const sibling = join(outside, "other.png");
    await writeFile(image, "image");
    await writeFile(sibling, "other");

    await expect(manager.createDownloadTicket(image)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await manager.trustDesktopAttachment(image);
    const ticket = await manager.createDownloadTicket(image);
    expect(ticket.fileName).toBe("screen.png");
    await expect(manager.createDownloadTicket(sibling)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("serves a one-time ticket once and detects replacement after registration", async () => {
    const { root, manager } = await fixture();
    const path = join(root, "result.txt");
    await writeFile(path, "first");
    const ticket = await manager.createDownloadTicket(path, { mimeType: "text/plain", oneTime: true });
    const claimed = await manager.claimDownload(ticket.id);
    expect(await streamText(claimed.stream)).toBe("first");
    await expect(manager.claimDownload(ticket.id)).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND" });

    const changedTicket = await manager.createDownloadTicket(path, { oneTime: true });
    await rm(path);
    await writeFile(path, "other");
    await expect(manager.claimDownload(changedTicket.id)).rejects.toSatisfy((error: unknown) =>
      error instanceof FileTransferError && ["FILE_CHANGED", "FILE_NOT_FOUND"].includes(error.code));
  });

  it("expires tickets and removes expired uploads during cleanup", async () => {
    let now = 10_000;
    const { root, manager } = await fixture({ now: () => now });
    const path = join(root, "download.bin");
    await writeFile(path, "download");
    const ticket = await manager.createDownloadTicket(path);
    const upload = await manager.receiveUpload({ stream: Readable.from("upload"), fileName: "upload.bin" });

    now += 2_001;
    await expect(manager.claimDownload(ticket.id)).rejects.toMatchObject({ code: "TRANSFER_EXPIRED" });
    expect(await manager.cleanupExpired()).toEqual({ downloads: 0, uploads: 1 });
    await expect(readFile(upload.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps committed message attachments across expiry and process restart cleanup", async () => {
    let now = 10_000;
    const { root, uploads, manager } = await fixture({ now: () => now });
    const upload = await manager.receiveUpload({ stream: Readable.from("persistent image"), fileName: "image.png", mimeType: "image/png" });
    await expect(manager.commitUpload(upload.uploadId)).resolves.toBe(true);

    now += 10_000;
    expect(await manager.cleanupExpired()).toEqual({ downloads: 0, uploads: 0 });
    expect(await readFile(upload.path, "utf8")).toBe("persistent image");

    const restarted = await FileTransferManager.create({
      allowedRoots: [root],
      uploadDirectory: uploads,
      downloadTtlMs: 1_000,
      uploadTtlMs: 2_000,
      now: () => now,
    });
    await expect(restarted.cleanupOrphanedUploads()).resolves.toBe(0);
    expect(await readFile(upload.path, "utf8")).toBe("persistent image");
  });

  it.skipIf(process.platform === "win32")("requires upload storage to remain inside an allowed root after symlink resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmr-root-"));
    const outside = await mkdtemp(join(tmpdir(), "cmr-storage-outside-"));
    temporaryDirectories.push(root, outside);
    await chmod(root, 0o700);
    await mkdir(join(outside, "uploads"));
    await symlink(join(outside, "uploads"), join(root, "linked-uploads"));

    await expect(FileTransferManager.create({
      allowedRoots: [root],
      uploadDirectory: join(root, "linked-uploads"),
    })).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
});
