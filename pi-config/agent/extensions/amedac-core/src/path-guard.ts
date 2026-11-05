/**
 * 路径护栏扩展（amedac-core，CLI / WebUI 双端）。
 *
 * 威胁模型 A：拦截 workspace 类工具的误操作访问——工作区外或敏感路径按
 * 策略拒绝/询问。评估模型与文件布局见 ./path-guard-policy.ts，工具清单见
 * ./tool-manifest.ts。
 *
 * 覆盖由 manifest 驱动（不再硬编码工具名单）：
 *   · 声明了 pathParams 的工具 → 该参数按路径策略评估（读恒判；risk=write
 *     的工具再判写）；
 *   · 声明了 commandParams 的工具 → 参数走 evaluateBashCommand（写入目标
 *     提取 + 内联执行兜底）——bash/powershell 与 bg_run 共用同一管线；
 *   · 未声明参数的工具（host 状态类、MCP、第三方扩展）保持 passthrough。
 *
 * 模式：Host / quick 的工具路径就是服务器路径；sandbox / ssh /
 * local-machine 的工具路径是远端工作区路径，经 `.pi/path-policy.scope.json`
 * （pi-web 在会话启动时写入，运行态、不随包分发）映射回项目 home 后再套策略。
 * 这样"锁定工作区内某个文件"的 deny 规则在各模式下语义一致。
 *
 * 交互：ctx.ui.select 四选（允许一次 / 本项目始终允许 / 拒绝 / 拒绝且
 * 不再询问）。无人值守宿主（ctx.hasUI === false：批量 API、bench）一律
 * 按拒绝处理并说明原因——不会静默放行。持久决策写入
 * .pi/path-policy.decisions.json，随配置包导出分发（分发后同样不再询问）。
 *
 * 局限（有意为之）：bash 解析 best-effort（不执行变量展开、不解析解释器
 * 代码）；未在 manifest 声明的工具（MCP 等运行时工具）不在拦截范围；这是
 * 行为护栏不是安全边界。强隔离由容器 / relay 工作区围栏提供。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PATH_DECISIONS_FILE,
  PATH_POLICY_FILE,
  PATH_SCOPE_FILE,
  evaluateBashCommand,
  evaluatePathAgainstPolicy,
  normalizePolicyPath,
  parsePathPolicy,
  parsePathScope,
  parsePolicyDecisions,
  type GuardAction,
  type PathPolicy,
  type PathScope,
  type PolicyDecisions,
} from "./path-guard-policy.ts";
import { commandParamsFor, manifestFor, pathParamsFor } from "./tool-manifest.ts";

const ASK_ALLOW_ONCE = "允许一次";
const ASK_ALLOW_ALWAYS = "本项目始终允许（写入决策文件）";
const ASK_DENY = "拒绝";
const ASK_DENY_ALWAYS = "拒绝且不再询问（写入决策文件）";

interface LoadedPolicy {
  policy: PathPolicy;
  decisions: PolicyDecisions;
  scope: PathScope | null;
}

function loadPolicy(cwd: string): LoadedPolicy {
  return {
    policy: parsePathPolicy(safeRead(join(cwd, PATH_POLICY_FILE))),
    decisions: parsePolicyDecisions(safeRead(join(cwd, PATH_DECISIONS_FILE))),
    scope: parsePathScope(safeRead(join(cwd, PATH_SCOPE_FILE))),
  };
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

function recordDecision(cwd: string, loaded: LoadedPolicy, absPath: string, decision: "allow" | "deny"): void {
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
  /** 测试/观测/审计钩子：每次护栏判定（含最终动作）都会上报（cwd = 会话工作区）。 */
  onVerdict?: (info: {
    tool: string;
    cwd: string;
    path: string;
    action: string;
    via: "rule" | "ask" | "headless-deny";
  }) => void;
}

export function makePathGuardExtension(events: PathGuardEvents = {}) {
  return (pi: ExtensionAPI): void => {
    // 会话内决策缓存：文件每次工具调用都读（小文件），但“允许一次”只存内存。
    const sessionOnceAllows = new Set<string>();
    let sessionAsked = 0;

    pi.on("tool_call", async (event, ctx) => {
      const pathParams = pathParamsFor(event.toolName);
      const commandParams = commandParamsFor(event.toolName);
      if (pathParams.length === 0 && commandParams.length === 0) return;
      const cwd = ctx.cwd;
      const input = event.input as Record<string, unknown>;
      const loaded = loadPolicy(cwd);
      const risk = manifestFor(event.toolName)?.risk;

      /**
       * 判定收敛点：rule-deny → 直接 block；ask → 四选/无人值守拒绝；
       * 允许一次只记会话内存。返回 block 结果或 undefined（放行）。
       */
      const decide = async (verdict: GuardAction, target: string): Promise<{ block: true; reason: string } | undefined> => {
        if (verdict.action === "allow" || !target) return undefined;
        if (sessionOnceAllows.has(target)) return undefined;
        if (verdict.action === "deny") {
          events.onVerdict?.({ tool: event.toolName, cwd, path: target, action: "deny", via: "rule" });
          return { block: true, reason: verdict.reason };
        }
        // ask：无人值守 → 拒绝（不静默放行）
        if (ctx.hasUI === false || typeof ctx.ui?.select !== "function") {
          events.onVerdict?.({ tool: event.toolName, cwd, path: target, action: "deny", via: "headless-deny" });
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
          events.onVerdict?.({ tool: event.toolName, cwd, path: target, action: "allow", via: "ask" });
          return undefined;
        }
        if (choice === ASK_ALLOW_ALWAYS) {
          recordDecision(cwd, loaded, target, "allow");
          events.onVerdict?.({ tool: event.toolName, cwd, path: target, action: "allow", via: "ask" });
          return undefined;
        }
        if (choice === ASK_DENY_ALWAYS) recordDecision(cwd, loaded, target, "deny");
        events.onVerdict?.({ tool: event.toolName, cwd, path: target, action: "deny", via: "ask" });
        return {
          block: true,
          reason: `用户${choice === ASK_DENY_ALWAYS ? "已选择“拒绝且不再询问”（已记录，之后不再询问）" : "拒绝了本次操作"}：${verdict.reason} 请改在工作区允许的路径内完成，或请用户调整 .pi/path-policy.json。不要重复尝试同一路径。`,
        };
      };

      // ---- 命令参数：写入目标提取 + 内联执行兜底（bash/powershell/bg_run）----
      for (const param of commandParams) {
        const command = input[param];
        if (typeof command !== "string") continue;
        const { verdict, target } = evaluateBashCommand(command, cwd, loaded.policy, loaded.decisions, loaded.scope);
        if (verdict.action === "allow" || !target) continue;
        const blocked = await decide(verdict, target);
        if (blocked) return blocked;
      }

      // ---- 路径参数：读规则先判（write/edit 也读取内容），risk=write 再判写 ----
      for (const param of pathParams) {
        const value = input[param];
        if (typeof value !== "string" || value.trim().length === 0) continue;
        const target = resolveToolPath(value, cwd);
        if (sessionOnceAllows.has(target)) continue;
        const readVerdict = evaluatePathAgainstPolicy(target, "read", cwd, loaded.policy, loaded.decisions, loaded.scope);
        const readBlocked = await decide(readVerdict, target);
        if (readBlocked) return readBlocked;
        if (risk !== "write") continue;
        const writeVerdict = evaluatePathAgainstPolicy(target, "write", cwd, loaded.policy, loaded.decisions, loaded.scope);
        const writeBlocked = await decide(writeVerdict, target);
        if (writeBlocked) return writeBlocked;
      }
      return undefined;
    });
  };
}
