import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CampusMail, mailAccountId, mailKind, parseMailConfig, type MailAlert } from "./campus-mail.js";
import { createAntigravityMailRouter } from "./mail-analysis.js";

const legacyFiles = ["campus-mail.json", "campus-mail-csu.json", "campus-mail-qq.json"];
const accountFile = /^([a-f0-9]{64})\.json$/;
type Descriptor = { id: string; address: string; kind: "csu" | "qq" };
type Account = Descriptor & { mail: CampusMail };
type Settings = Parameters<CampusMail["configure"]>[0];

export class Mailboxes {
  private readonly folder: string;
  private readonly accounts = new Map<string, Account>();
  private readonly routeAntigravity = createAntigravityMailRouter();
  private analysisTail = Promise.resolve();
  private refresh?: Promise<void>;
  private interval?: NodeJS.Timeout;
  private stopped = false;
  private migrated = false;
  private status = "";

  constructor(private readonly stateDir: string, private readonly publish: (alerts: MailAlert[]) => void) {
    this.folder = join(stateDir, "mail-accounts");
  }

  start() {
    void this.discover();
    this.interval = setInterval(() => void this.discover(), 4_000).unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.interval);
    for (const { mail } of this.accounts.values()) mail.stop();
  }

  private update = () => {
    if (!this.stopped) this.publish(this.alerts());
  };

  private scheduleAnalysis = <T>(task: () => Promise<T>): Promise<T> => {
    const result = this.analysisTail.then(task);
    this.analysisTail = result.then(() => undefined, () => undefined);
    return result;
  };

  discover(): Promise<void> {
    if (this.stopped || this.refresh) return this.refresh ?? Promise.resolve();
    this.refresh = this.refreshAccounts().catch(() => {
      this.status = "暂时无法读取邮箱账号设置。";
      this.update();
    }).finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  private async refreshAccounts() {
    if (!this.migrated) await this.importLegacyAccounts();
    const files = await readdir(this.folder);
    const entries = new Map<string, Descriptor>();
    for (const file of files) {
      const id = accountFile.exec(file)?.[1];
      if (!id) continue;
      const raw = await readFile(join(this.folder, file), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const config = raw && parseMailConfig(raw);
      if (config && mailAccountId(config.address) === id) entries.set(id, { id, address: config.address, kind: mailKind(config.address) });
    }
    if (this.stopped) return;
    let changed = !!this.status;
    this.status = "";
    for (const [id, entry] of this.accounts) {
      if (entries.has(id)) continue;
      entry.mail.stop();
      this.accounts.delete(id);
      changed = true;
    }
    for (const account of entries.values()) {
      if (this.accounts.has(account.id)) continue;
      const mail = new CampusMail(join(this.folder, `${account.id}.json`), this.update, this.scheduleAnalysis, account.id, this.routeAntigravity);
      this.accounts.set(account.id, { ...account, mail });
      mail.start();
      changed = true;
    }
    if (changed) this.update();
  }

  private async importLegacyAccounts() {
    await mkdir(this.folder, { recursive: true });
    const marker = join(this.folder, ".legacy-imported");
    if (!existsSync(marker)) {
      for (const file of legacyFiles) {
        const raw = await readFile(join(this.stateDir, file), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!raw) continue;
        const config = parseMailConfig(raw);
        if (!config) continue;
        const path = join(this.folder, `${mailAccountId(config.address)}.json`);
        await writeFile(path, JSON.stringify(config), { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      }
      await writeFile(marker, "", { flag: "a" });
    }
    this.migrated = true;
  }

  alerts(): MailAlert[] {
    return [...this.accounts.values()].flatMap(entry => entry.mail.alerts())
      .sort((a, b) => b.at - a.at).slice(0, 30).reverse();
  }

  private defaultAccount() {
    return [...this.accounts.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.address.localeCompare(b.address))[0];
  }

  list(id?: string) {
    const entry = (id ? this.accounts.get(id) : undefined) ?? this.defaultAccount();
    const snapshot = entry?.mail.list();
    const mailboxes = [...this.accounts.values()].map(({ id, kind, address, mail }) => {
      const snapshot = mail.list();
      return { id, kind, address, pending: snapshot.rows.filter(row => row.task?.state === "pending").length };
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.address.localeCompare(b.address));
    return { ...(snapshot ?? { smartMail: true, lastSyncAt: null, rows: [] }), configured: !!entry, mailbox: entry?.kind,
      mailboxId: entry?.id, syncing: snapshot?.syncing ?? !!entry, status: this.status || snapshot?.status || "", mailboxes };
  }

  async sync(id?: string) {
    await this.discover();
    const entry = id ? this.accounts.get(id) : this.defaultAccount();
    if (entry) void entry.mail.sync(true);
    return this.list(id);
  }

  async configure(id: string | undefined, input: Settings) {
    const entry = id ? this.accounts.get(id) : this.defaultAccount();
    if (!entry) throw new Error("请先在电脑添加这个邮箱。");
    await entry.mail.configure(input);
    return this.list(entry.id);
  }

  read(id: string) {
    for (const entry of this.accounts.values()) {
      const detail = entry.mail.read(id);
      if (detail) return { ...detail, mailboxId: entry.id };
    }
  }

  async change(id: string, operation: unknown) {
    const selected = this.read(id);
    const entry = selected && this.accounts.get(selected.mailboxId);
    if (!entry) throw new Error("这封邮件已离开近期收件箱。");
    const result = await entry.mail.change(id, operation);
    return result ? { ...result, mailboxId: entry.id } : undefined;
  }
}
