import { describe, expect, it, vi } from "vitest";
import { availableUsageResets, UsageResets } from "../src/usage-resets.js";

const credit = { id: "chosen-card", resetType: "codexRateLimits", status: "available", title: "Full reset", expiresAt: 200 };
const snapshot = (accountId = "account") => ({ accountId, rateLimitResetCredits: { availableCount: 1, credits: [credit] } });

describe("Codex reset credits", () => {
  it("keeps the reported count separate from available card details", () => {
    expect(availableUsageResets({ rateLimitResetCredits: { availableCount: 2, credits: null } })).toEqual({ availableCount: 2, cards: [] });
    expect(availableUsageResets(snapshot(), 100_000)?.cards).toEqual([{ id: "chosen-card", title: "Full reset", expiresAt: 200_000 }]);
    expect(availableUsageResets(snapshot(), 200_000)?.cards).toEqual([]);
    expect(availableUsageResets({})).toBeUndefined();
  });

  it("reads only when opening a confirmation and consumes the selected card once", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => method === "account/rateLimits/read" ? snapshot() : { outcome: "reset" });
    const resets = new UsageResets({ request }, () => 100_000);
    await expect(resets.confirm("unissued")).rejects.toThrow("确认已失效");
    await expect(resets.prepare("unknown")).rejects.toThrow("当前不可用");
    const { token } = await resets.prepare(credit.id);
    expect(request.mock.calls.every(([method]) => method === "account/rateLimits/read")).toBe(true);
    await expect(Promise.all([resets.confirm(token), resets.confirm(token)])).resolves.toEqual(["reset", "reset"]);
    expect(request.mock.calls.filter(([method]) => method.endsWith("/consume"))).toEqual([
      ["account/rateLimitResetCredit/consume", { creditId: credit.id, idempotencyKey: token }],
    ]);
  });

  it("rejects a changed account and an expired confirmation", async () => {
    let now = 100_000;
    let account = "account-1";
    const request = vi.fn(async (_method: string) => snapshot(account));
    const resets = new UsageResets({ request }, () => now);
    const { token } = await resets.prepare(credit.id);
    account = "account-2";
    await expect(resets.confirm(token)).rejects.toThrow("账号已变化");
    now = 200_000;
    await expect(resets.confirm(token)).rejects.toThrow("确认已失效");
    expect(request.mock.calls.every(([method]) => method === "account/rateLimits/read")).toBe(true);
  });

  it("reuses the same idempotency key after an uncertain result", async () => {
    let first = true;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "account/rateLimits/read") return snapshot();
      if (first) { first = false; throw new Error("timeout"); }
      return { outcome: "alreadyRedeemed" };
    });
    const resets = new UsageResets({ request }, () => 100_000);
    const { token } = await resets.prepare(credit.id);
    await expect(resets.confirm(token)).rejects.toThrow("暂未确认");
    await expect(resets.confirm(token)).resolves.toBe("alreadyRedeemed");
    const consumes = request.mock.calls.filter(([method]) => method.endsWith("/consume"));
    expect(consumes).toHaveLength(2);
    expect(consumes[0]).toEqual(consumes[1]);
  });
});
