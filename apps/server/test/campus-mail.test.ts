import { describe, expect, it } from "vitest";
import { mailAlerts, taskFromSummary } from "../src/campus-mail.js";
import { translationChunks, validateSummary } from "../src/mail-analysis.js";

const now = Date.UTC(2026, 10, 28, 10);
const mail = {
  uid: 1, id: "a".repeat(64), subject: "Lab report", body: "Please send the lab report by Friday at 18:00.",
  sender: "Advisor", address: "advisor@example.test", receivedAt: now, noticedAt: now, priority: true, truncated: false,
};
const result = {
  overview: "周五前提交实验报告。", importance: "important", task: "explicit", action: "提交实验报告",
  quote: "Please send the lab report by Friday at 18:00.", deadline: "周五 18:00", deadlineQuote: "Friday at 18:00", needsTranslation: true,
};

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
