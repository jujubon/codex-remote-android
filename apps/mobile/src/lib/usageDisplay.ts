import type { AccountUsage, Assistant } from '../types/protocol';

const quotaDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function homeQuotaPercent(usage: AccountUsage | null, assistant: Assistant) {
  const fiveHourWindows = usage?.windows.filter(window => window.minutes === 300 && Number.isFinite(window.remainingPercent));
  const window = assistant === 'antigravity'
    ? fiveHourWindows?.find(window => /^gemini\b/i.test(window.group.trim()))
    : fiveHourWindows?.find(window => /^codex$/i.test(window.group.trim())) ?? fiveHourWindows?.[0];
  return window ? Math.round(Math.min(100, Math.max(0, window.remainingPercent))) : undefined;
}

export function usageWindowsInDisplayOrder(windows: AccountUsage['windows']) {
  const groups = new Map<string, AccountUsage['windows']>();
  for (const window of windows) {
    const group = groups.get(window.group) ?? [];
    group.push(window);
    groups.set(window.group, group);
  }
  const rank = (minutes: number | null) => minutes === 300 ? 0 : minutes === 10080 ? 1 : 2;
  return [...groups.values()].flatMap(group => group.sort((a, b) => rank(a.minutes) - rank(b.minutes)));
}

export function formatQuotaTime(timestamp: number) {
  return quotaDate.format(timestamp);
}

export function usageWindowName(minutes: number | null, fallback = '额度窗口') {
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}
