import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { FileTransferError, inferMimeType, type FileTransferManager } from "./file-transfer.js";

const LIMIT = 60;
const THUMBNAIL_BYTES = 384 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
type Source = "share" | "chat";
interface InboxEntry {
  id: string;
  fileName: string;
  path: string;
  size: number;
  receivedAt: number;
  source: Source;
}

function receiptId(path: string, source: Source, entry: Stats): string {
  return createHash("sha256").update(JSON.stringify([source, path, entry.size, entry.mtimeMs, entry.ino])).digest("hex");
}

export class FileInbox {
  private writes = Promise.resolve();
  private lastListing?: { receiveFolder: string; entries: Map<string, InboxEntry> };

  constructor(private readonly indexPath: string, private readonly files: FileTransferManager) {}

  private async shares(): Promise<string[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.indexPath, "utf8"));
      return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string").slice(0, LIMIT) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  recordShare(path: string): Promise<void> {
    const operation = this.writes.then(async () => {
      const paths = await this.shares();
      const temp = `${this.indexPath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.indexPath), { recursive: true, mode: 0o700 });
        await writeFile(temp, JSON.stringify([path, ...paths.filter(previous => previous !== path)].slice(0, LIMIT)), { mode: 0o600 });
        await rename(temp, this.indexPath);
      } finally {
        await unlink(temp).catch(() => undefined);
      }
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  async list(receiveFolder: string): Promise<InboxEntry[]> {
    const shareRoot = await realpath(receiveFolder).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const [shared, uploaded] = await Promise.all([this.shares(), this.files.committedUploadPaths()]);
    const entries: InboxEntry[] = [];
    const append = async (path: string, source: Source) => {
      try {
        if (source === "share" && dirname(path) !== shareRoot) return;
        const entry = await lstat(path);
        if (!entry.isFile() || await realpath(path) !== path) return;
        const id = receiptId(path, source, entry);
        entries.push({ id, path, fileName: basename(path), size: entry.size, receivedAt: entry.mtimeMs, source });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    for (const path of shared) await append(path, "share");
    for (const path of uploaded) await append(path, "chat");
    const recent = entries.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, LIMIT);
    this.lastListing = { receiveFolder, entries: new Map(recent.map(entry => [entry.id, entry])) };
    return recent;
  }

  private async find(receiveFolder: string, id: unknown) {
    const entry = typeof id === "string" && /^[a-f0-9]{64}$/.test(id) ? (await this.list(receiveFolder)).find(row => row.id === id) : undefined;
    if (!entry) throw new FileTransferError("FILE_NOT_FOUND", "文件已移动、修改或不在最近收件中，请刷新。", 410);
    return entry;
  }

  async use(receiveFolder: string, id: unknown) {
    const entry = await this.find(receiveFolder, id);
    return this.files.registerInboxFile(entry.path);
  }

  async preview(receiveFolder: string, id: string, thumbnail: boolean) {
    const listing = this.lastListing;
    const cached = listing?.receiveFolder === receiveFolder ? listing.entries.get(id) : undefined;
    const entry = cached ?? await this.find(receiveFolder, id);
    const mime = inferMimeType(entry.fileName);
    if (!IMAGE_MIME_TYPES.has(mime)) throw new FileTransferError("INVALID_ARGUMENT", "此文件格式无法预览。", 415);
    if (entry.source === "share" && await realpath(receiveFolder).catch(() => undefined) !== dirname(entry.path))
      throw new FileTransferError("FILE_NOT_FOUND", "收件目录已变更，请刷新。", 410);
    const handle = await open(entry.path, "r").catch(() => {
      throw new FileTransferError("FILE_NOT_FOUND", "图片已移动，请刷新收件箱。", 410);
    });
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || await realpath(entry.path).catch(() => undefined) !== entry.path ||
          receiptId(entry.path, entry.source, actual) !== entry.id) {
        throw new FileTransferError("FILE_CHANGED", "图片已更改，请刷新收件箱。", 410);
      }
      if (actual.size > (thumbnail ? THUMBNAIL_BYTES : 64 * 1024 * 1024))
        throw new FileTransferError("FILE_TOO_LARGE", "图片超出预览大小限制。", 413);
      if (!actual.size) throw new FileTransferError("INVALID_ARGUMENT", "图片内容为空。", 400);
      return { mime, size: actual.size, stream: handle.createReadStream({ end: actual.size - 1 }) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
