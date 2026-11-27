import { randomUUID } from "node:crypto";
import type { AccountUsage, UsageResetOutcome } from "@codex-mobile/protocol";
import type { AppServerBridge } from "./app-server-bridge.js";
import { FileTransferError } from "./file-transfer.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function availableUsageResets(raw: unknown, now = Date.now()): AccountUsage["resetCredits"] {
  const summary = record(record(raw)?.rateLimitResetCredits);
  const availableCount = summary?.availableCount;
  if (typeof availableCount !== "number" || !Number.isSafeInteger(availableCount) || availableCount < 0) return undefined;
  if (availableCount === 0) return { availableCount, cards: [] };
  const cards = Array.isArray(summary?.credits) ? summary.credits.flatMap(value => {
    const row = record(value);
    if (row?.status !== "available" || row.resetType !== "codexRateLimits" || typeof row.id !== "string" || !row.id) return [];
    if (row.expiresAt !== null && (typeof row.expiresAt !== "number" || !Number.isFinite(row.expiresAt) || row.expiresAt * 1000 <= now)) return [];
    return [{ id: row.id, title: typeof row.title === "string" ? row.title : null,
      expiresAt: typeof row.expiresAt === "number" ? row.expiresAt * 1000 : null }];
  }) : [];
  return { availableCount, cards };
}

type Confirmation = {
  accountId: string;
  creditId: string;
  expiresAt: number;
  dispatched?: boolean;
  operation?: Promise<UsageResetOutcome>;
};

export class UsageResets {
  private readonly confirmations = new Map<string, Confirmation>();

  constructor(private readonly bridge: Pick<AppServerBridge, "request">, private readonly now = Date.now) {}

  async prepare(creditId: unknown) {
    if (typeof creditId !== "string" || !creditId || creditId.length > 256) throw new FileTransferError("INVALID_ARGUMENT", "重置卡编号无效。", 400);
    const latest = await this.bridge.request("account/rateLimits/read", {});
    const accountId = record(latest)?.accountId;
    const card = availableUsageResets(latest, this.now())?.cards.find(row => row.id === creditId);
    if (!card || typeof accountId !== "string" || !accountId) throw new FileTransferError("INVALID_ARGUMENT", "这张重置卡当前不可用，请刷新额度后重试。", 409);

    const now = this.now();
    for (const [token, entry] of this.confirmations) if (entry.expiresAt <= now) this.confirmations.delete(token);
    if (this.confirmations.size >= 64) throw new FileTransferError("INVALID_ARGUMENT", "重置卡确认请求过多，请稍后再试。", 429);
    const token = randomUUID();
    this.confirmations.set(token, { accountId, creditId, expiresAt: Math.min(now + 120_000, card.expiresAt ?? Infinity) });
    return { token, card };
  }

  async confirm(token: unknown): Promise<UsageResetOutcome> {
    const entry = typeof token === "string" ? this.confirmations.get(token) : undefined;
    if (!entry || entry.expiresAt <= this.now() || typeof token !== "string") {
      throw new FileTransferError("INVALID_ARGUMENT", "确认已失效，请刷新额度后重新选择重置卡。", 409);
    }
    return entry.operation ??= this.redeem(entry, token).catch(error => { entry.operation = undefined; throw error; });
  }

  private async redeem(entry: Confirmation, token: string): Promise<UsageResetOutcome> {
    const latest = await this.bridge.request("account/rateLimits/read", {});
    if (record(latest)?.accountId !== entry.accountId) {
      throw new FileTransferError("INVALID_ARGUMENT", "Codex 账号已变化，请刷新额度后重新确认。", 409);
    }
    if (entry.expiresAt <= this.now()) throw new FileTransferError("INVALID_ARGUMENT", "确认已失效，请重新选择重置卡。", 409);
    if (!entry.dispatched && !availableUsageResets(latest, this.now())?.cards.some(card => card.id === entry.creditId)) return "noCredit";
    entry.dispatched = true;
    let reply: unknown;
    try {
      reply = await this.bridge.request("account/rateLimitResetCredit/consume", { creditId: entry.creditId, idempotencyKey: token });
    } catch (error) {
      if (error instanceof Error && /method not found|unknown method/i.test(error.message)) {
        throw new FileTransferError("INVALID_ARGUMENT", "请更新电脑上的 Codex Desktop 后重试。", 409);
      }
    }
    const outcome = record(reply)?.outcome;
    if (outcome === "reset" || outcome === "alreadyRedeemed" || outcome === "nothingToReset" || outcome === "noCredit") return outcome;
    throw new FileTransferError("INVALID_ARGUMENT", "暂未确认重置结果。可以重试本次确认，或刷新额度查看这张卡的状态。", 409);
  }
}
