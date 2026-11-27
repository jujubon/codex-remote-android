import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceTools, findAntigravityDesktop, readChatAttachmentFolder, storeDrop } from "../src/device-tools.js";

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

describe("Antigravity desktop discovery", () => {
  it("prefers the per-user desktop app over the system-wide installation", async () => {
    const { path } = await fixture();
    const local = join(path, "Local");
    const programs = join(path, "Program Files");
    const userExe = join(local, "Programs", "Antigravity", "Antigravity.exe");
    const systemExe = join(programs, "Antigravity", "Antigravity.exe");
    for (const executable of [userExe, systemExe]) {
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(executable, "fixture");
    }
    const env = { LOCALAPPDATA: local, ProgramFiles: programs };
    await expect(findAntigravityDesktop(env)).resolves.toBe(userExe);
    await rm(userExe);
    await expect(findAntigravityDesktop(env)).resolves.toBe(systemExe);
  });

  it("accepts a host-configured Antigravity executable and rejects other targets", async () => {
    const { path } = await fixture();
    await mkdir(path);
    const executable = join(path, "Antigravity.exe");
    const other = join(path, "agy.exe");
    await writeFile(executable, "fixture");
    await writeFile(other, "fixture");
    await expect(findAntigravityDesktop({ CMR_ANTIGRAVITY_DESKTOP_BIN: executable })).resolves.toBe(executable);
    for (const target of [other, "Antigravity.exe", join(path, "missing", "Antigravity.exe")]) {
      await expect(findAntigravityDesktop({ CMR_ANTIGRAVITY_DESKTOP_BIN: target })).resolves.toBeUndefined();
    }
  });
});

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

  it("supports distinct folders for phone shares and Codex attachments", async () => {
    const { config, path, tools } = await fixture();
    const receiveFolder = join(path, "手机分享");
    const chatAttachmentFolder = join(path, "Codex 对话附件");
    await expect(readChatAttachmentFolder(config)).resolves.toBeUndefined();
    await writeFile(config, "\uFEFF" + JSON.stringify({ receiveFolder, chatAttachmentFolder }));
    await expect(tools.settings()).resolves.toEqual({ folder: receiveFolder, autoOpen: false });
    await expect(readChatAttachmentFolder(config)).resolves.toBe(chatAttachmentFolder);
    await writeFile(config, JSON.stringify({ receiveFolder, chatAttachmentFolder: "relative" }));
    await expect(readChatAttachmentFolder(config)).rejects.toThrow("绝对路径");
    await expect(tools.settings()).resolves.toMatchObject({ folder: receiveFolder });
  });

  it("rejects a task-bound wake request before invoking Windows if the turn is unknown", async () => {
    const { tools } = await fixture();
    await expect(tools.startHold("task", "missing")).rejects.toThrow("没有确认");
    expect((await tools.status()).awakeUntil).toBeNull();
  });
});
