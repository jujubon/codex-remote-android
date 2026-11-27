import { describe, expect, it } from "vitest";
import { parseAntigravityUsage } from "../src/antigravity-usage.js";

describe("Antigravity model quota", () => {
  it("maps shared windows and keeps an exhausted bucket at zero", () => {
    const reset = "2026-11-27T12:30:00Z";
    expect(parseAntigravityUsage({ status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups: [
      { name: "Gemini Models", buckets: [
        { window: "5h", remaining_fraction: 0, reset_time: reset },
        { window: "weekly", remaining_fraction: 0.866, reset_time: "" },
        { window: "5h", remaining_fraction: -1 },
      ] },
    ] } } }, 123)).toEqual({ plan: null, checkedAt: 123, windows: [
      { group: "Gemini Models", minutes: 300, remainingPercent: 0, resetsAt: Date.parse(reset) },
      { group: "Gemini Models", minutes: 10080, remainingPercent: 87, resetsAt: null },
    ] });
  });

  it("rejects a model turn or a structured result without quota windows", () => {
    const command = { name: "usage", data: { groups: [] } };
    expect(() => parseAntigravityUsage({ status: "SUCCESS", num_turns: 1, command })).toThrow("未返回可用的额度数据");
    expect(() => parseAntigravityUsage({ status: "SUCCESS", num_turns: 0, command })).toThrow("未提供额度窗口");
  });
});
