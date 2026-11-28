import { describe, expect, it, vi } from "vitest";
import { classifyMailRow, mailAlerts, taskFromSummary } from "../src/campus-mail.js";
import { createAntigravityMailRouter, MailQuotaError, translationChunks, validateSummary } from "../src/mail-analysis.js";

const now = Date.UTC(2026, 10, 28, 10);
const mail = {
  uid: 1, id: "a".repeat(64), subject: "Lab report", body: "Please send the lab report by Friday at 18:00.",
  sender: "Advisor", address: "advisor@example.test", receivedAt: now, noticedAt: now, priority: true, truncated: false,
};
const result = {
  overview: "周五前提交实验报告。", importance: "important", task: "explicit", action: "提交实验报告",
  quote: "Please send the lab report by Friday at 18:00.", deadline: "周五 18:00", deadlineQuote: "Friday at 18:00", needsTranslation: true,
};

describe("Antigravity mail model routing", () => {
  const gemini = "gemini-4-hydrogen-high";
  const claude = "claude-opus-4-6-thinking";
  const signal = new AbortController().signal;

  it("starts on Gemini, reuses Claude while Gemini is limited and prefers Gemini again after its retry time", async () => {
    vi.useFakeTimers();
    try {
      const route = createAntigravityMailRouter();
      const generate = vi.fn(async model => model);
      await expect(route(generate, signal)).resolves.toBe(gemini);
      generate.mockRejectedValueOnce(new MailQuotaError());
      await expect(route(generate, signal)).resolves.toBe(claude);
      await expect(route(generate, signal)).resolves.toBe(claude);
      vi.advanceTimersByTime(15 * 60_000);
      await expect(route(generate, signal)).resolves.toBe(gemini);
      expect(generate.mock.calls.flat()).toEqual([gemini, gemini, claude, claude, gemini]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps both models on cooldown and retries the one whose cooldown ends first", async () => {
    vi.useFakeTimers();
    try {
      const route = createAntigravityMailRouter();
      const retryAt = Date.now() + 30_000;
      const generate = vi.fn(async model => model)
        .mockRejectedValueOnce(new MailQuotaError(retryAt))
        .mockRejectedValueOnce(new MailQuotaError(retryAt + 30_000));
      await expect(route(generate, signal)).rejects.toMatchObject({ retryAt });
      await expect(route(generate, signal)).rejects.toMatchObject({ retryAt });
      expect(generate.mock.calls.flat()).toEqual([gemini, claude]);
      vi.advanceTimersByTime(30_000);
      await expect(route(generate, signal)).resolves.toBe(gemini);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not switch models after an authentication failure or an aborted analysis", async () => {
    const route = createAntigravityMailRouter();
    const controller = new AbortController();
    const stopped = new Error("stopped");
    const generate = vi.fn().mockRejectedValueOnce(new Error("login")).mockImplementationOnce(async () => {
      controller.abort(stopped);
      throw new MailQuotaError();
    });
    await expect(route(generate, signal)).rejects.toThrow("login");
    await expect(route(generate, controller.signal)).rejects.toBe(stopped);
    expect(generate.mock.calls.flat()).toEqual([gemini, gemini]);
  });
});

describe("campus mail analysis", () => {
  it("promotes a grounded action to a pending task and alerts with its deadline", () => {
    const summary = validateSummary(result, mail);
    expect(taskFromSummary(summary)).toEqual({ state: "pending" });
    expect(summary.needsTranslation).toBe(true);
    expect(mailAlerts([{ ...mail, summary }], now, "antigravity", false)).toEqual([
      { id: mail.id, at: now, priority: true, subject: mail.subject, preview: "提交实验报告 · 周五 18:00" },
    ]);
  });

  it("keeps advertisements quiet even when an important sender or a countdown is present", () => {
    const summary = validateSummary({ ...result, importance: "promotion" }, mail);
    expect(taskFromSummary(summary)).toBeUndefined();
    expect(mailAlerts([{ ...mail, summary }], now + 100_000, "antigravity", false)).toEqual([]);
  });

  it("reclassifies cached voluntary petitions and clears old AI suggestions without deleting a manual to-do", () => {
    const petition = { ...mail, subject: "Request to sign the chapter petition",
      body: "If you support the formation, please review and sign the petition.", address: "onlinepetitions@from.ieee.org" };
    const legacy = { ...validateSummary(result, mail), importance: "normal" as const, task: "review" as const };
    const restored = classifyMailRow({ ...petition, summary: legacy, task: { state: "review" } });
    expect(restored.summary).toMatchObject({ importance: "promotion", task: "none", action: "", deadline: "" });
    expect(restored.task).toBeUndefined();
    expect(mailAlerts([restored], now, "antigravity", false)).toEqual([]);
    const known = validateSummary({ ...result, quote: petition.body }, petition);
    expect(known).toMatchObject({ importance: "promotion", task: "none" });
    expect(classifyMailRow({ ...petition, summary: legacy, task: { state: "pending", manual: true } }).task)
      .toEqual({ state: "pending", manual: true });
    const assignment = classifyMailRow({ ...mail, subject: "Draft the petition for legal review" });
    expect(assignment.voluntaryPetition).toBe(false);
  });

  it("puts ungrounded actions into review and drops unsupported deadlines", () => {
    const summary = validateSummary({ ...result, quote: "Invented evidence", deadlineQuote: "Invented date" }, mail);
    expect(summary).toMatchObject({ importance: "normal", task: "review", deadline: "", quote: "" });
    expect(taskFromSummary(summary)).toEqual({ state: "review" });
    expect(mailAlerts([{ ...mail, summary }], now, "antigravity", true)).toEqual([]);
  });

  it("keeps routine replies quiet and updates a provisional alert using the same notification ID", () => {
    expect(mailAlerts([mail], now, "antigravity", false)).toEqual([]);
    const provisional = mailAlerts([mail], now, "antigravity", true);
    expect(provisional[0]?.id).toBe(mail.id);
    const normal = validateSummary({ ...result, importance: "normal", task: "none" }, mail);
    expect(mailAlerts([{ ...mail, summary: normal }], now, "antigravity", true)).toEqual([]);
    const important = validateSummary(result, mail);
    expect(mailAlerts([{ ...mail, summary: important }], now, "antigravity", false)[0]?.id).toBe(provisional[0]?.id);
  });

  it("uses a stable reminder ID that opens the original email and skips completed tasks", () => {
    const row = { ...mail, noticedAt: undefined, task: { state: "pending" as const, remindAt: now } };
    const first = mailAlerts([row], now, "off", false);
    expect(first[0]).toMatchObject({ mailId: mail.id, priority: true });
    expect(first[0]?.id).not.toBe(mail.id);
    expect(mailAlerts([row], now + 1000, "off", false)).toEqual(first);
    expect(mailAlerts([{ ...row, task: { ...row.task, state: "done" } }], now, "off", false)).toEqual([]);
  });

  it("segments long mail without losing text or splitting Unicode characters", () => {
    const body = ("A multilingual email with Chinese 文本 and an emoji 🧪.\n").repeat(250);
    const chunks = translationChunks(body);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(body);
    expect(chunks.every(chunk => [...chunk].length <= 2800 && !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
});
