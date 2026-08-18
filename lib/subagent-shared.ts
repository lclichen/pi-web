/**
 * Client-safe subagent types and helpers. Kept separate from
 * lib/subagent-records.ts (which pulls in the server-only session reader /
 * pi SDK) so client components can import them without bundling Node APIs.
 */

export interface SubagentRecord {
  id: string;
  type: string;
  description: string;
  status: string;
  /** Absolute epoch ms from the plugin's record; undefined for live entries. */
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

/** "刚刚 / 3 分钟前 / 2 小时前 / 3 天前" relative-time label. */
export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  const diff = Math.max(0, now - epochMs);
  if (diff < 30_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  return `${months} 个月前`;
}
