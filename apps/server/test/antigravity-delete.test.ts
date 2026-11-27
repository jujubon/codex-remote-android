import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravitySessions } from "../src/antigravity.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const folder of temporary.splice(0)) await rm(folder, { force: true, recursive: true });
});

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "cmr-antigravity-delete-"));
  temporary.push(folder);
  const filename = join(folder, "threads.json");
  const threads = ["First", "Second", "Third"].map(title => ({
    id: `antigravity:${randomUUID()}`, cwd: folder, title, sessionId: randomUUID(), projectless: false,
    turns: [{ id: randomUUID(), text: title, response: "Done", status: "completed", startedAt: 1000, completedAt: 2000 }],
  }));
  await writeFile(filename, JSON.stringify(threads));
  return { folder, filename, ids: threads.map(row => row.id) };
}

it("persists an Antigravity title without replacing the conversation or its history", async () => {
  const { filename, ids: [id] } = await fixture();
  const sessions = await AntigravitySessions.open(filename);
  const history = sessions.page(id!, 20);
  expect(await sessions.renameConversation(id!, "持久化标题 📝")).toMatchObject({ id, name: "持久化标题 📝" });
  const reopened = await AntigravitySessions.open(filename);
  expect(reopened.summary(id!).name).toBe("持久化标题 📝");
  expect(reopened.page(id!, 20)).toEqual(history);
});

describe("Antigravity app conversation removal", () => {
  it("serializes concurrent deletions and preserves unrelated conversations after restart", async () => {
    const { filename, ids } = await fixture();
    const sessions = await AntigravitySessions.open(filename);
    await Promise.all([sessions.deleteConversation(ids[0]!), sessions.deleteConversation(ids[1]!), sessions.deleteConversation(ids[0]!)]);
    expect(sessions.list().map(thread => thread.id)).toEqual([ids[2]]);
    await sessions.deleteConversation(ids[0]!);
    const reopened = await AntigravitySessions.open(filename);
    expect(reopened.list().map(thread => thread.id)).toEqual([ids[2]]);
  });

  it("keeps the conversation visible if persistence fails", async () => {
    const { folder, filename, ids } = await fixture();
    const sessions = await AntigravitySessions.open(filename);
    await rename(filename, join(folder, "original.json"));
    await mkdir(filename);
    await expect(sessions.deleteConversation(ids[0]!)).rejects.toThrow();
    expect(sessions.list().map(thread => thread.id)).toEqual(ids);
  });

  it("refuses to delete a running conversation", async () => {
    const { folder, filename, ids } = await fixture();
    const sessions = await AntigravitySessions.open(filename, join(folder, "missing-agy.exe"));
    let done: () => void = () => undefined;
    const completed = new Promise<void>(resolve => { done = resolve; });
    const running = sessions.start(ids[0]!, "fixture task", () => ({
      delta() {}, approval() {}, approvalResolved() {}, completed: done,
    }));
    await expect(sessions.deleteConversation(ids[0]!)).rejects.toThrow("结束或停止");
    await running;
    await completed;
    expect(sessions.list()).toHaveLength(3);
  });
});
