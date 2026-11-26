import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { FileTransferError, type FileTransferManager } from "./file-transfer.js";

const LIMIT = 60;
type Source = "share" | "chat";
interface InboxEntry {
  id: string;
  fileName: string;
  path: string;
  size: number;
  receivedAt: number;
  source: Source;
}

export class FileInbox {
  private writes = Promise.resolve();

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
        const id = createHash("sha256").update(JSON.stringify([source, path, entry.size, entry.mtimeMs, entry.ino])).digest("hex");
        entries.push({ id, path, fileName: basename(path), size: entry.size, receivedAt: entry.mtimeMs, source });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    for (const path of shared) await append(path, "share");
    for (const path of uploaded) await append(path, "chat");
    return entries.sort((a, b) => b.receivedAt - a.receivedAt).slice(0, LIMIT);
  }

  async use(receiveFolder: string, id: unknown) {
    const entry = typeof id === "string" ? (await this.list(receiveFolder)).find(row => row.id === id) : undefined;
    if (!entry) throw new FileTransferError("FILE_NOT_FOUND", "文件已移动、修改或不在最近收件中，请刷新。", 410);
    return this.files.registerInboxFile(entry.path);
  }
}
