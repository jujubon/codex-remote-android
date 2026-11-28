const quotaDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function formatQuotaTime(timestamp: number) {
  return quotaDate.format(timestamp);
}

export function usageWindowName(minutes: number | null, fallback = '额度窗口') {
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}
