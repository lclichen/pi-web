/**
 * Benchmark report rendering (P0-2).
 *
 * Two artifacts per run directory (bench-results/<timestamp>/):
 *   report.md   — human summary: per-model pass rate, per-task/per-check
 *                 detail, behavioral metrics (todo discipline).
 *   runs.jsonl  — one record per task×model, append-friendly for trend
 *                 tracking across runs (compare like pi-smart-compact's
 *                 telemetry-report convention).
 */
import type { CheckResult } from "./checks.ts";

export interface TaskRecord {
  taskId: string;
  area: string;
  provider: string;
  model: string;
  pass: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; toolCalls: number };
  durationMs: number;
  error?: string;
  todo?: { calls: number; errorCalls: number; noChangeCalls: number };
}

export interface RunMeta {
  startedAt: string;
  provider: string;
  model: string;
  taskCount: number;
}

export function toTaskRecord(
  taskId: string,
  area: string,
  selection: { provider: string; id: string },
  pass: boolean,
  checks: CheckResult[],
  usage: TaskRecord["usage"],
  durationMs: number,
  error?: string,
  todo?: TaskRecord["todo"],
): TaskRecord {
  return {
    taskId,
    area,
    provider: selection.provider,
    model: selection.id,
    pass,
    checks: checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
    usage,
    durationMs,
    error,
    ...(todo ? { todo } : {}),
  };
}

export function renderMarkdownReport(meta: RunMeta, records: TaskRecord[]): string {
  const passCount = records.filter((r) => r.pass).length;
  const lines: string[] = [];
  lines.push(`# pi-web harness bench`);
  lines.push("");
  lines.push(`- 模型：\`${meta.provider}/${meta.model}\``);
  lines.push(`- 开始时间：${meta.startedAt}`);
  lines.push(`- 任务数：${meta.taskCount}（通过 **${passCount}/${records.length}**）`);
  const totalIn = records.reduce((s, r) => s + r.usage.inputTokens, 0);
  const totalOut = records.reduce((s, r) => s + r.usage.outputTokens, 0);
  const totalCalls = records.reduce((s, r) => s + r.usage.toolCalls, 0);
  const totalMs = records.reduce((s, r) => s + r.durationMs, 0);
  lines.push(`- 汇总 tokens：in ${totalIn.toLocaleString()} / out ${totalOut.toLocaleString()}，工具调用 ${totalCalls} 次，总耗时 ${(totalMs / 1000).toFixed(1)}s`);
  lines.push("");

  // Per-area pass rates localize a failure to a framework module.
  const areas = [...new Set(records.map((r) => r.area))];
  lines.push(`## 分域能力（定位缺陷用）`);
  lines.push("");
  lines.push(`| Area | Pass | Tasks |`);
  lines.push(`|---|---|---|`);
  for (const area of areas) {
    const inArea = records.filter((r) => r.area === area);
    lines.push(`| ${area} | ${inArea.filter((r) => r.pass).length}/${inArea.length} | ${inArea.map((r) => r.taskId).join(", ")} |`);
  }
  lines.push("");

  lines.push(`## 任务明细`);
  lines.push("");
  lines.push(`| Task | Area | Result | Checks | Tokens (in/out) | Calls | Duration |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of records) {
    const checks = `${r.checks.filter((c) => c.pass).length}/${r.checks.length}`;
    lines.push(
      `| ${r.taskId} | ${r.area} | ${r.pass ? "✅" : "❌"} | ${checks} | ${r.usage.inputTokens}/${r.usage.outputTokens} | ${r.usage.toolCalls} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push("");

  const todoRecords = records.filter((r) => r.todo);
  if (todoRecords.length > 0) {
    lines.push(`## todo 工具行为指标（P0-1 易用性观测）`);
    lines.push("");
    lines.push(`| Task | calls | error calls | no-op calls |`);
    lines.push(`|---|---|---|---|`);
    for (const r of todoRecords) {
      lines.push(`| ${r.taskId} | ${r.todo!.calls} | ${r.todo!.errorCalls} | ${r.todo!.noChangeCalls} |`);
    }
    lines.push("");
    lines.push(`error calls ≈ 0 且 no-op calls 低 → 模型理解全量写入契约；error calls 高 → 工具 schema 或提示引导需要调整。`);
    lines.push("");
  }

  const failed = records.filter((r) => !r.pass);
  if (failed.length > 0) {
    lines.push(`## 失败详情`);
    lines.push("");
    for (const r of failed) {
      lines.push(`### ${r.taskId}${r.error ? ` — ${r.error}` : ""}`);
      lines.push("");
      for (const c of r.checks.filter((c) => !c.pass)) {
        lines.push(`- ❌ \`${c.name}\`: ${c.detail}`);
      }
      lines.push("");
    }
  } else {
    lines.push(`全部通过 🎉`);
    lines.push("");
  }
  return lines.join("\n");
}
