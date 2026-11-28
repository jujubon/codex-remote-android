import { describe, expect, it } from 'vitest';
import { homeQuotaPercent } from '../src/lib/usageDisplay';
import type { AccountUsage } from '../src/types/protocol';

function usage(...windows: [group: string, minutes: number, remainingPercent: number][]): AccountUsage {
  return { plan: null, checkedAt: 0, windows: windows.map(([group, minutes, remainingPercent]) => ({
    group, minutes, remainingPercent, resetsAt: null,
  })) };
}

describe('home quota ring', () => {
  it('shows the Codex five-hour window even when the weekly or separate model quota is lower', () => {
    expect(homeQuotaPercent(usage(['separate-model', 300, 5], ['Codex', 10080, 4], ['Codex', 300, 83]), 'codex')).toBe(83);
    expect(homeQuotaPercent(usage(['Codex', 10080, 4]), 'codex')).toBeUndefined();
  });

  it('shows the Gemini five-hour window and preserves an exhausted zero', () => {
    expect(homeQuotaPercent(usage(['Claude and GPT models', 300, 10], ['Gemini Models', 10080, 5], ['Gemini Models', 300, 64]), 'antigravity')).toBe(64);
    expect(homeQuotaPercent(usage(['Gemini Models', 300, 0]), 'antigravity')).toBe(0);
    expect(homeQuotaPercent(usage(['Claude and GPT models', 300, 80], ['Gemini Models', 10080, 90]), 'antigravity')).toBeUndefined();
  });
});
