const usageCode = /^(usagelimitexceeded|usagelimitreached|quotaexceeded|quotaexhausted|insufficientquota|planlimitexceeded)$/;
const usageMessage = /(?:hit|reach(?:ed)?|exceed(?:ed)?|used up)\s+(?:(?:the|your|its|current)\s+)?(?:\w+\s+){0,2}(?:usage limit|plan limit|quota)|(?:usage limit|plan limit|quota)\s+(?:has been\s+)?(?:exceeded|reached|exhausted)|usage_limit_reached|insufficient_quota|额度(?:已耗尽|用尽|已达到上限|达到上限)|已达到.{0,12}(?:额度|用量)上限/i;

export const USAGE_LIMIT_MESSAGE = "Codex 额度已达到上限。可以查看额度，恢复后再发送。";

export function isUsageLimitError(error: unknown): boolean {
  if (typeof error === "string") return usageCode.test(error.toLowerCase().replace(/[^a-z]/g, "")) || usageMessage.test(error);
  if (!error || typeof error !== "object") return false;
  const info = error as Record<string, unknown>;
  const code = info.codexErrorInfo ?? info.codex_error_info ?? info.code ?? info.type;
  if (typeof code === "string" && usageCode.test(code.toLowerCase().replace(/[^a-z]/g, ""))) return true;
  if (code && typeof code === "object" && Object.keys(code).some(key => usageCode.test(key.toLowerCase()))) return true;
  return [info.message, info.additionalDetails, info.additional_details, info.data].some(value =>
    typeof value === "string" ? isUsageLimitError(value) :
      value && typeof value === "object" && value === info.data ? isUsageLimitError(value) : false);
}
