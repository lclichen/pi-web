/**
 * 路径护栏扩展（amedac-core，CLI / WebUI 双端）。
 *
 * 威胁模型 A：拦截 write / edit / bash 的误操作写入——工作区外或敏感
 * 路径按策略拒绝/询问。评估模型与文件布局见 ./path-guard-policy.ts。
 *
 * 交互：ctx.ui.select 四选（允许一次 / 本项目始终允许 / 拒绝 / 拒绝且
 * 不再询问）。无人值守宿主（ctx.hasUI === false：批量 API、bench）一律
 * 按拒绝处理并说明原因——不会静默放行。持久决策写入
 * .pi/path-policy.decisions.json，随配置包导出分发（分发后同样不再询问）。
 *
 * 局限（有意为之）：bash 解析 best-effort（不追踪 cd / 不解 $()），
 * 这是行为护栏不是安全边界；强隔离由容器/relay 工作区围栏提供。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PATH_DECISIONS_FILE,
  PATH_POLICY_FILE,
  evaluatePathAgainstPolicy,
  extractBashWriteTargets,
  normalizePolicyPath,
  parsePathPolicy,
  parsePolicyDecisions,
  type PathPolicy,
  type PolicyDecisions,
} from "./path-guard-policy.ts";

const ASK_ALLOW_ONCE = "允许一次";
const ASK_ALLOW_ALWAYS = "本项目始终允许（写入决策文件）";
const ASK_DENY = "拒绝";
const ASK_DENY_ALWAYS = "拒绝且不再询问（写入决策文件）";

interface LoadedPolicy {
  policy: PathPolicy;
  decisions: PolicyDecisions;
}

function loadPolicy(cwd: string): LoadedPolicy {
  const policyRaw = safeRead(join(cwd, PATH_POLICY_FILE));
  const decisionsRaw = safeRead(join(cwd, PATH_DECISIONS_FILE));
  return { policy: parsePathPolicy(policyRaw), decisions: parsePolicyDecisions(decisionsRaw) };
}

function safeRead(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function persistDecisions(cwd: string, decisions: PolicyDecisions): void {
  const target = join(cwd, PATH_DECISIONS_FILE);
  try {
    // 决策文件在自保护清单里：护栏进程自身可写，Agent 工具路径不可触。
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(decisions, null, 2) + "\n", "utf8");
  } catch {
    // 写不进（只读介质等）：会话内决策仍生效，只是不持久化。
  }
}

function recordDecision(
  cwd: string,
  loaded: LoadedPolicy,
  absPath: string,
  decision: "allow" | "deny",
): void {
  const norm = normalizePolicyPath(absPath);
  loaded.decisions.entries = loaded.decisions.entries.filter((e) => e.path !== norm);
  loaded.decisions.entries.push({ path: norm, decision, at: Date.now() });
  if (loaded.decisions.entries.length > 500) {
    loaded.decisions.entries = loaded.decisions.entries.slice(-500);
  }
  persistDecisions(cwd, loaded.decisions);
}

/** resolve a tool-supplied path against the session cwd (POSIX-first). */
function resolveToolPath(raw: string, cwd: string): string {
  const norm = normalizePolicyPath(raw);
  if (norm.startsWith("/") || /^[A-Za-z]:\//.test(norm)) return norm; // POSIX 绝对 + Windows 盘符（开发机测试用）
  const base = normalizePolicyPath(cwd);
  if (norm.startsWith("~")) return norm; // 主目录字面量：按工作区外评估
  return normalizePolicyPath(`${base}/${norm}`);
}

export interface PathGuardEvents {
  /** 测试/观测钩子：每次护栏判定（含最终动作）都会上报。 */
  onVerdict?: (info: { tool: string; path: string; action: string; via: "rule" | "ask" | "headless-deny" }) => void;
}

export function makePathGuardExtension(events: PathGuardEvents = {}) {
  return (pi: ExtensionAPI): void => {
    // 会话内决策缓存：文件每次工具调用都读（小文件），但“允许一次”只存内存。
    const sessionOnceAllows = new Set<string>();
    let sessionAsked = 0;

    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return;
      const cwd = ctx.cwd;
      const input = event.input as { path?: unknown; command?: unknown };

      let writeTargets: string[] = [];
      let readTarget: string | null = null;
      if (event.toolName === "bash") {
        if (typeof input.command !== "string") return;
        writeTargets = extractBashWriteTargets(input.command, cwd);
      } else {
        if (typeof input.path !== "string") return;
        readTarget = resolveToolPath(input.path, cwd);
        writeTargets = [readTarget]; // write/edit 同时是读取+写入，两者都评估
      }

      const loaded = loadPolicy(cwd);
      for (const target of writeTargets) {
        if (sessionOnceAllows.has(target)) continue;
        const verdict = evaluatePathAgainstPolicy(target, "write", cwd, loaded.policy, loaded.decisions);
        if (readTarget && event.toolName !== "bash") {
          const readVerdict = evaluatePathAgainstPolicy(readTarget, "read", cwd, loaded.policy, loaded.decisions);
          if (readVerdict.action === "deny") {
            events.onVerdict?.({ tool: event.toolName, path: target, action: "deny", via: "rule" });
            return { block: true, reason: readVerdict.reason };
          }
        }
        if (verdict.action === "allow") continue;
        if (verdict.action === "deny") {
          events.onVerdict?.({ tool: event.toolName, path: target, action: "deny", via: "rule" });
          return { block: true, reason: verdict.reason };
        }
        // ask：无人值守 → 拒绝（不静默放行）
        if (ctx.hasUI === false || typeof ctx.ui?.select !== "function") {
          events.onVerdict?.({ tool: event.toolName, path: target, action: "deny", via: "headless-deny" });
          return {
            block: true,
            reason: `${verdict.reason} 当前为无人值守会话，默认拒绝。如需放行，请用户在交互会话中确认一次（会写入 ${PATH_DECISIONS_FILE}），或调整 ${PATH_POLICY_FILE}。`,
          };
        }
        sessionAsked += 1;
        let choice: string | undefined;
        try {
          choice = await ctx.ui.select(
            `路径护栏：${verdict.reason}`,
            [ASK_ALLOW_ONCE, ASK_ALLOW_ALWAYS, ASK_DENY, ASK_DENY_ALWAYS],
            undefined,
          );
        } catch {
          choice = undefined;
        }
        if (choice === ASK_ALLOW_ONCE) {
          sessionOnceAllows.add(target);
          events.onVerdict?.({ tool: event.toolName, path: target, action: "allow", via: "ask" });
          continue; // 放行本次调用
        }
        if (choice === ASK_ALLOW_ALWAYS) {
          recordDecision(cwd, loaded, target, "allow");
          events.onVerdict?.({ tool: event.toolName, path: target, action: "allow", via: "ask" });
          continue;
        }
        if (choice === ASK_DENY_ALWAYS) {
          recordDecision(cwd, loaded, target, "deny");
        }
        events.onVerdict?.({ tool: event.toolName, path: target, action: "deny", via: "ask" });
        return {
          block: true,
          reason: `用户${choice === ASK_DENY_ALWAYS ? "已选择“拒绝且不再询问”（已记录，之后不再询问）" : "拒绝了本次操作"}：${verdict.reason} 请改在工作区允许的路径内完成，或请用户调整 .pi/path-policy.json。`,
        };
      }
      return undefined;
    });
  };
}
