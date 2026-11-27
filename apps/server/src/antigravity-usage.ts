import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { AccountUsage } from "@codex-mobile/protocol";
import { acpObject } from "./antigravity-acp.js";

const run = promisify(execFile);
const minutesByWindow = new Map([["5h", 300], ["weekly", 10080]]);

export function parseAntigravityUsage(value: unknown, checkedAt = Date.now()): AccountUsage {
  const result = acpObject(value);
  const command = acpObject(result?.command);
  const groups = acpObject(command?.data)?.groups;
  if (result?.status !== "SUCCESS" || result.num_turns !== 0 || command?.name !== "usage" || !Array.isArray(groups)) {
    throw new Error("Antigravity 未返回可用的额度数据，请检查 CLI 登录和版本。");
  }

  const windows: AccountUsage["windows"] = [];
  for (const row of groups) {
    const group = acpObject(row);
    if (typeof group?.name !== "string" || !group.name.trim() || !Array.isArray(group.buckets)) continue;
    for (const entry of group.buckets) {
      const bucket = acpObject(entry);
      const fraction = bucket?.remaining_fraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const reset = typeof bucket?.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
      const minutes = typeof bucket?.window === "string" ? minutesByWindow.get(bucket.window) ?? null : null;
      windows.push({ group: group.name, minutes, remainingPercent: Math.round(fraction * 100), resetsAt: Number.isFinite(reset) ? reset : null });
    }
  }
  if (!windows.length) throw new Error("Antigravity 未提供额度窗口，请检查电脑上的 CLI 登录。");
  return { plan: null, checkedAt, windows };
}

export function antigravityUsageReader(executable: string | undefined) {
  let last: AccountUsage | undefined;
  let pending: Promise<AccountUsage> | undefined;
  let versionChecked = false;
  async function refresh(): Promise<AccountUsage> {
    if (!executable) throw new Error("请先在电脑上安装并登录 Antigravity CLI。");
    const env = { ...process.env };
    delete env.CMR_TOKEN;
    const options = { cwd: tmpdir(), env, windowsHide: true, maxBuffer: 256 * 1024, timeout: 16_000 };
    if (!versionChecked) {
      const { stdout } = await run(executable, ["--version"], { ...options, timeout: 3000 });
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stdout.trim());
      const [, major = 0, minor = 0, patch = 0] = match?.map(Number) ?? [];
      // Earlier versions could send an unsupported slash command as a model prompt.
      if (major === 0 || (major === 1 && (minor < 1 || (minor === 1 && patch < 11)))) {
        throw new Error("请将电脑上的 Antigravity CLI 更新到 1.1.11 或更新版本。");
      }
      versionChecked = true;
    }
    let data: unknown;
    try {
      const { stdout } = await run(executable, ["--print-timeout", "12s", "--output-format", "json", "--print=/usage"], options);
      data = JSON.parse(stdout) as unknown;
    } catch {
      throw new Error("暂时无法读取 Antigravity 额度，请确认电脑上的 CLI 已登录后重试。");
    }
    const usage = parseAntigravityUsage(data);
    last = usage;
    return usage;
  }
  return () => {
    if (last && Date.now() - last.checkedAt < 8000) return Promise.resolve(last);
    pending ??= refresh().finally(() => { pending = undefined; });
    return pending;
  };
}
