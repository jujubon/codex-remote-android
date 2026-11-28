import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampusMail, mailAccountId } from "../src/campus-mail.js";
import { Mailboxes } from "../src/mailboxes.js";

const school = "fixture@csu.edu.cn";
const qq = "123456789@qq.com";
const secondQQ = "567891234@qq.com";
const ids = [school, qq, secondQQ].map(mailAccountId);

afterEach(() => vi.restoreAllMocks());

describe("mailbox registry", () => {
  it("imports both old profiles, starts every account independently, and never resurrects a removed profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmr-mailboxes-"));
    const account = (address: string) => ({ address, secret: "fixture-protected-secret", dataDir: root });
    const put = (file: string, address: string) => writeFile(join(root, file), JSON.stringify(account(address)));
    const start = vi.spyOn(CampusMail.prototype, "start").mockImplementation(() => undefined);
    const boxes = new Mailboxes(root, () => undefined);
    try {
      await put("campus-mail.json", school);
      await put("campus-mail-qq.json", qq);
      await boxes.discover();
      expect(start).toHaveBeenCalledTimes(2);
      expect(boxes.list().mailboxes.map(x => x.id)).toEqual(ids.slice(0, 2));
      expect(boxes.list(ids[1]).mailbox).toBe("qq");
      expect(JSON.parse(await readFile(join(root, "mail-accounts", `${ids[0]}.json`), "utf8"))).toEqual(account(school));
      expect(await readdir(join(root, "mail-accounts"))).toHaveLength(3);

      await put(`mail-accounts/${ids[2]}.json`, secondQQ);
      await boxes.discover();
      expect(start).toHaveBeenCalledTimes(3);
      expect(boxes.list(ids[2]).mailboxId).toBe(ids[2]);
      await unlink(join(root, "mail-accounts", `${ids[1]}.json`));
      await boxes.discover();
      expect(boxes.list(ids[1]).mailboxId).toBe(ids[0]);
      expect(boxes.list().mailboxes.map(x => x.id)).toEqual([ids[0], ids[2]]);
      await expect(boxes.configure(ids[1], { provider: "off" })).rejects.toThrow("添加这个邮箱");
      const restarted = new Mailboxes(root, () => undefined);
      try {
        await restarted.discover();
        expect(restarted.list().mailboxes.map(x => x.id)).toEqual([ids[0], ids[2]]);
      } finally { restarted.stop(); }
    } finally {
      boxes.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
