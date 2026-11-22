import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceTools, storeDrop } from "../src/device-tools.js";

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codex-phone-drop-"));
  temporary.push(directory);
  const path = join(directory, "PhoneDrop");
  const config = join(directory, "device-tools.json");
  return { path, config, tools: new DeviceTools(config, path) };
}

describe("PhoneDrop persistence", () => {
  it("preserves both complete files under concurrent same-name writes", async () => {
    const { path } = await fixture();
    const files = await Promise.all([
      storeDrop(path, "实验记录.pdf", Buffer.from("first")),
      storeDrop(path, "实验记录.pdf", Buffer.from("second")),
    ]);
    expect((await readdir(path)).sort()).toEqual(["实验记录 (1).pdf", "实验记录.pdf"]);
    expect(await Promise.all(files.map(file => readFile(file, "utf8")))).toEqual(["first", "second"]);
  });

  it("protects Windows reserved filenames and removes path syntax", async () => {
    const { path } = await fixture();
    await storeDrop(path, "CON.txt", Buffer.from("one"));
    await storeDrop(path, "../report.txt:alternate", Buffer.from("two"));
    expect((await readdir(path)).sort()).toEqual(["_CON.txt", "_report.txt_alternate"]);
  });

  it("reuses the original receipt when a client retries the same link", async () => {
    const { path, tools } = await fixture();
    const id = "91cb3cd3-6166-413c-9e7e-6cc2921b11da_0";
    const result = await Promise.all([tools.link(id, "https://example.com/"), tools.link(id, "https://example.com/")]);
    expect(result[0]).toEqual(result[1]);
    expect(result[0]?.opened).toBe(false);
    expect(await readdir(path)).toHaveLength(1);
    expect(await readFile(join(path, result[0]!.fileName), "utf8")).toBe("https://example.com/\r\n");
    expect(() => tools.link(id, "file:///C:/Windows/")).toThrow("HTTP");
  });

  it("accepts Windows UTF-8 BOM settings and requires an absolute local folder", async () => {
    const { path, config, tools } = await fixture();
    await writeFile(config, "\uFEFF" + JSON.stringify({ receiveFolder: path, autoOpen: true }));
    await expect(tools.settings()).resolves.toEqual({ folder: path, autoOpen: true });
    await writeFile(config, JSON.stringify({ receiveFolder: "../other" }));
    await expect(tools.settings()).rejects.toThrow("绝对路径");
  });

  it("rejects a task-bound wake request before invoking Windows if the turn is unknown", async () => {
    const { tools } = await fixture();
    await expect(tools.startHold("task", "missing")).rejects.toThrow("没有确认");
    expect((await tools.status()).awakeUntil).toBeNull();
  });
});
