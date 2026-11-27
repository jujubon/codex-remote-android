import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravitySessions, parseAntigravityModels } from "../src/antigravity.js";

const primary = "gemini-4-hydrogen-high";
const alternate = "gemini-3.8-flash-medium";
const fixture = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  listed: "",
  available: [] as { modelId: string }[],
  listCount: 0,
}));

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: (_executable: string, args: string[], _options: unknown,
    done: (error: null, output: { stdout: string }) => void) => {
    if (args[0] !== "models") throw new Error("Unexpected CLI command");
    fixture.listCount++;
    done(null, { stdout: fixture.listed });
  },
}));

vi.mock("../src/antigravity-acp.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/antigravity-acp.js")>(),
  AntigravityAcp: class {
    async request(method: string, params: Record<string, unknown>) {
      fixture.calls.push({ method, params });
      if (method === "initialize") return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } };
      if (method === "session/new" || method === "session/resume") return {
        sessionId: "fixture-session", models: { availableModels: fixture.available, currentModelId: primary },
      };
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    }

    close() {}
  },
}));

let tempFolder: string | undefined;
afterEach(async () => {
  if (tempFolder) await rm(tempFolder, { recursive: true, force: true });
  tempFolder = undefined;
  fixture.calls.length = 0;
  fixture.listCount = 0;
});

async function openStore() {
  const folder = await mkdtemp(join(tmpdir(), "cmr-models-"));
  tempFolder = folder;
  const filename = join(folder, "threads.json");
  fixture.listed = `Fetching available models...\n${primary}\tHydrogen (High)\n${alternate}\tFlash (Medium)\n`;
  fixture.available = [primary, alternate].map(modelId => ({ modelId }));
  return { folder, filename, store: await AntigravitySessions.open(filename, "mock-agy") };
}

function completion() {
  const { promise, resolve } = Promise.withResolvers<{ status: string; items: unknown[] }>();
  return { promise, callbacks: () => ({ delta() {}, approval() {}, approvalResolved() {}, completed: resolve }) };
}

describe("Antigravity model selection", () => {
  it("parses the tab-separated CLI catalog without treating its progress text as a model", () => {
    expect(parseAntigravityModels(`Fetching...\n${primary}\tHydrogen (High)\r\n${primary}\tDuplicate\nunknown\n`))
      .toMatchObject([{ model: primary, displayName: "Hydrogen (High)" }]);
  });

  it("applies the selected model before the first prompt and a saved change before resuming", async () => {
    const { folder, filename, store } = await openStore();
    expect((await store.listModels()).map(model => model.model)).toEqual([primary, alternate]);
    const first = completion();
    const { id } = await store.create(folder, true, "First", first.callbacks, [], alternate);
    expect((await first.promise).status).toBe("completed");
    expect(fixture.calls.map(call => call.method)).toEqual([
      "initialize", "session/new", "session/set_model", "session/prompt", "session/close",
    ]);
    expect(fixture.calls[2]?.params).toEqual({ sessionId: "fixture-session", modelId: alternate });
    expect(fixture.listCount).toBe(1);
    await expect(store.updateModel(id, "unavailable")).rejects.toThrow("不可用");
    await store.updateModel(id, primary);
    const reopened = await AntigravitySessions.open(filename, "mock-agy");
    expect(reopened.summary(id).model).toBe(primary);
    // The resumed CLI can report a different active model from the companion preference.
    await reopened.updateModel(id, alternate);
    fixture.calls.length = 0;
    const next = completion();
    await reopened.start(id, "Next", next.callbacks);
    expect((await next.promise).status).toBe("completed");
    expect(fixture.calls[1]).toMatchObject({ method: "session/resume", params: { sessionId: "fixture-session" } });
    expect(fixture.calls[2]).toMatchObject({ method: "session/set_model", params: { modelId: alternate } });
    expect(fixture.calls[3]?.method).toBe("session/prompt");
  });

  it("preserves the CLI default and refuses to send if a chosen model becomes unavailable", async () => {
    const { folder, store } = await openStore();
    const first = completion();
    const { id } = await store.create(folder, true, "Default", first.callbacks);
    await first.promise;
    expect(fixture.calls.some(call => call.method === "session/set_model")).toBe(false);
    await store.updateModel(id, alternate);
    fixture.calls.length = 0;
    fixture.available = [{ modelId: primary }];
    const next = completion();
    await store.start(id, "Unavailable", next.callbacks);
    expect((await next.promise).status).toBe("failed");
    expect(fixture.calls.some(call => call.method === "session/prompt")).toBe(false);
    expect(await store.updateModel(id, "")).toEqual({ model: null, effort: null });
    expect(store.summary(id).model).toBeNull();
  });
});
