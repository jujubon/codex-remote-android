import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CockpitAccounts } from "../src/cockpit-accounts.js";

describe.skipIf(process.platform !== "win32")("Cockpit Tools account automation", () => {
  const source = { id: "source-id", email: "source@example.test", plan: "plus" };
  const target = { id: "target-id", email: "target@example.test", plan: "pro" };
  const token = randomBytes(32).toString("base64url");
  let home: string;
  let server: WebSocketServer;
  let port: number;
  let activeEmail: string;
  let reloadEmail: string;
  let sentSwitches: string[];
  let receiptId: string;
  let accounts: typeof source[];
  let acquireIdle: ReturnType<typeof vi.fn<() => boolean>>;
  let releaseIdle: ReturnType<typeof vi.fn<() => void>>;
  let restart: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let cockpit: CockpitAccounts;

  async function writeStatus(version?: number) {
    await writeFile(join(home, ".cockpit_tools", "server.json"), JSON.stringify({
      ws_port: port, auth_token: token, automation_version: version,
    }));
  }

  beforeEach(async () => {
    vi.stubEnv("COCKPIT_TOOLS_DATA_DIR", undefined);
    home = await mkdtemp(join(tmpdir(), "cmr-cockpit-test-"));
    await mkdir(join(home, ".cockpit_tools"));
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    port = (server.address() as { port: number }).port;
    await writeStatus(1);
    activeEmail = source.email;
    reloadEmail = target.email;
    sentSwitches = [];
    receiptId = target.id;
    accounts = [source, target];
    server.on("connection", socket => socket.on("message", message => {
      const request = JSON.parse(message.toString());
      const { authToken, requestId, command, version } = request.payload;
      const reply = { type: "response.automation", payload:
        authToken === token && request.type === "request.automation" && version === 1 && command.platform === "codex"
          ? { version, requestId, status: "ok", data: command.operation === "list" ? accounts
            : { platform: "codex", accountId: receiptId, effect: "credentials_written", warnings: [] } }
          : { version, requestId, status: "error", code: "unauthorized", message: "Fixture rejected the request" },
      };
      if (reply.payload.status === "ok" && command.operation === "switch") sentSwitches.push(command.accountId);
      socket.send(JSON.stringify(reply));
    }));
    acquireIdle = vi.fn(() => true);
    releaseIdle = vi.fn();
    restart = vi.fn(async () => { activeEmail = reloadEmail; });
    cockpit = new CockpitAccounts({
      request: async () => ({ account: { type: "chatgpt", email: activeEmail } }),
      restart,
    }, acquireIdle, releaseIdle, join(home, ".codex"), home);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("returns masked labels, sends only the selected account, and verifies it after reconnecting", async () => {
    const before = (await cockpit.list()).accounts;
    expect(before).toMatchObject([{ current: true, plan: "plus" }, { current: false, plan: "pro" }]);
    expect(before[1]?.label).toMatch(/^tar•••@example\.test/);
    expect(JSON.stringify(before)).not.toMatch(/source@example|target@example|source-id|target-id|auth_token/);
    const requested = await cockpit.start(before[1]?.key);
    expect(requested.stage).toBe("switching");
    await vi.waitFor(() => expect(cockpit.status().operation).toMatchObject({ id: requested.id, stage: "verified" }));
    expect(sentSwitches).toEqual([target.id]);
    expect(restart).toHaveBeenCalledOnce();
    expect(releaseIdle).toHaveBeenCalledOnce();
    expect((await cockpit.list()).accounts[1]?.current).toBe(true);
  });

  it("prevents duplicate requests and refuses to send a switch while work is active", async () => {
    const key = (await cockpit.list()).accounts[1]?.key;
    acquireIdle.mockReturnValue(false);
    const trying = cockpit.start(key);
    await expect(cockpit.start(key)).rejects.toThrow("已有账号切换正在处理");
    await expect(trying).rejects.toThrow("电脑仍在处理任务");
    expect(sentSwitches).toEqual([]);
    expect(restart).not.toHaveBeenCalled();
  });

  it("distinguishes a successful receipt from a confirmed account change", async () => {
    reloadEmail = source.email;
    await cockpit.start((await cockpit.list()).accounts[1]?.key);
    await vi.waitFor(() => expect(cockpit.status().operation?.stage).toBe("unverified"));
    expect(sentSwitches).toEqual([target.id]);
  });

  it("rejects a mismatched receipt and a legacy server", async () => {
    receiptId = "different-account";
    await cockpit.start((await cockpit.list()).accounts[1]?.key);
    await vi.waitFor(() => expect(cockpit.status().operation?.stage).toBe("failed"));
    expect(restart).not.toHaveBeenCalled();
    await writeStatus();
    await expect(cockpit.list()).rejects.toThrow("1.5.3");
  });
});
