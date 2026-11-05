/**
 * 护栏审计（P2c）：每次路径/命令护栏判定追加一行 JSONL 到
 * `<cwd>/.pi/guardrail-audit.jsonl`。
 *
 * - 追加写，无读放大；单文件超过 2MB 轮转为 `.1`（只保留上一代，避免
 *   无限增长）。
 * - 写失败静默：审计不得阻断工具调用（只读介质/权限问题按无审计处理）。
 * - 文件在自保护清单内（Agent 工具路径不可读不可写），项目随包分发时
 *   属于运行态数据，由导出侧忽略。
 *
 * 纯 Node 实现（同 process，同步 append 成本可忽略）。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const GUARDRAIL_AUDIT_FILE = ".pi/guardrail-audit.jsonl";
export const GUARDRAIL_AUDIT_MAX_BYTES = 2 * 1024 * 1024;

export interface GuardrailAuditEntry {
  /** 判定时间（epoch ms）。 */
  ts: number;
  /** 工具名。 */
  tool: string;
  /** 判定目标（路径或合成 target，如 !catastrophic）。 */
  path: string;
  /** allow / ask / deny。 */
  action: string;
  /** rule / ask / headless-deny。 */
  via: string;
}

/** 追加一条审计；超限先轮转。任何 IO 失败静默。 */
export function appendGuardrailAudit(cwd: string, entry: GuardrailAuditEntry): void {
  const target = join(cwd, GUARDRAIL_AUDIT_FILE);
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    if (existsSync(target) && statSync(target).size > GUARDRAIL_AUDIT_MAX_BYTES) {
      renameSync(target, `${target}.1`);
    }
    appendFileSync(target, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // 审计失败不阻断工具调用。
  }
}
