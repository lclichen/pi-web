/**
 * Plan Mode extension — PLAN/执行双模式（harness-research/01 方案落地）。
 *
 * 机制对齐 codex Collaboration Mode + Claude Code Plan Mode 的收敛结论：
 * - 模式是会话状态（execute | plan），经 appendEntry("plan-mode") 持久化、
 *   分支回放重建（同 todo 的快照回放模式）；
 * - 进入方式：模型自动（enter_plan_mode 工具 + promptGuidelines 教时机）
 *   或用户手动（/plan、/plan-exit 斜杠命令）；
 * - plan 模式下 before_agent_start 追加 <collaboration_mode> 指令块（多
 *   扩展链式替换的尾部），tool_call 钩子硬门禁写类工具（write/edit、
 *   变异 bash/powershell、todo——计划文件才是规划期的清单，防双清单
 *   混淆，codex 同款策略）；plan_save 是唯一允许的"写"；
 * - 退出经 exit_plan_mode 工具：要求先 plan_save 存了计划，再经
 *   ctx.ui.confirm 弹用户确认（pi-web RPC 通道渲染阻塞确认框）；确认后
 *   切回 execute 并注入官方交接语（先把计划步骤写入 todo 再实施）。
 *   确认超时/中止/无 UI 宿主一律按"未确认"处理并给出手动路径——永不
 *   抛错失败；
 * - 当前模式经 widget key "plan-mode" 发布 {mode}，ChatStatusWidget 显示
 *   模式徽标。
 */
import { existsSync } from "node:fs";
import { defineTool, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { sessionPlanPath } from "./session-plan.ts";

export const PLAN_MODE_WIDGET_KEY = "plan-mode";
export const PLAN_MODE_ENTRY_TYPE = "plan-mode";

export type PlanMode = "execute" | "plan";

/** Mutation heuristic for bash/powershell gating in plan mode. Deliberately
 *  conservative (false positives are retried read-only; false negatives are
 *  still caught by the system-prompt instruction and human review). */
const MUTATING_COMMAND_RE =
  /\b(rm|rmdir|mv|cp|mkdir|touch|tee|chmod|chown|ln|dd|shred|truncate|kill|pkill|mkfs|mount|umount)\b|(^|[^2s])>>?|\bsed\b[^|]*\s-i\b|\bgit\b[^|]*\b(commit|push|merge|rebase|reset|checkout|restore|apply|revert|clean|stash|tag)\b|\bnpm\b[^|]*\b(install|uninstall|update|link|publish|ci)\b|\bpnpm\b|\byarn\b[^|]*\b(add|remove)\b|\bpip3?\b[^|]*\b(install|uninstall)\b|\bcargo\b[^|]*\b(add|install)\b|\bgo\b[^|]*\b(install|get)\b|\bapt(-get)?\b|\byum\b|\bdnf\b|\bmake\b|\bdocker\b[^|]*\b(run|build|rm|exec|create)\b|\bapptainer\b.*\b(run|exec|instance\s+start)\b|\bcurl\b[^|]*\s(-X|-d|-T|--request|--data|--upload)\b|\bwget\b[^|]*\b(--post|--put)\b|\bnode\b[^|]*\s-e\b|\bpython3?\b[^|]*\s-c\b|\b(remove|move|copy|rename|new|set)-item\b|\bout-file\b|\b(set|add)-content\b|\b(start|stop)-process\b|\bremove-itemproperty\b/i;

/** Tools blocked outright while planning (todo blocked: the plan file is the
 *  checklist in plan mode — same separation codex enforces for update_plan). */
const PLAN_BLOCKED_TOOLS = new Set(["write", "edit", "todo"]);

const PLAN_MODE_INSTRUCTIONS = `<collaboration_mode>
You are now in PLAN mode. Your job is to explore and produce an implementation plan — not to make changes.

Read-only exploration is allowed: read / ls / find / grep and non-mutating shell commands. Mutating tools (write, edit, mutating bash/powershell, todo) are BLOCKED while planning; plan_save is the only write target — the plan file is the checklist during planning.

Workflow:
1. Explore the relevant code and context first. When delegating, keep subagent work read-only.
2. If a decision genuinely blocks the plan (ambiguous goal, mutually exclusive approaches), use the ask_user_question tool when available (options + recommended default); otherwise state the options with your recommendation and ask in your reply.
3. Save the plan with plan_save: brief context, the recommended approach with rationale, a step checklist as \`- [ ]\` items (3-7 steps), and a verification section (how to prove it works).
4. Call exit_plan_mode to request user approval. Do NOT call it before the plan is saved.

Your active mode changes only when the user approves exit_plan_mode or switches it manually; user requests or your own reasoning do not change it by themselves.
</collaboration_mode>`;

const APPROVED_HANDOFF =
  "User approved the plan. Switched to EXECUTE mode. Start by writing the plan steps into the todo list " +
  "(mark exactly one step in_progress), then implement step by step, updating todo as you go. " +
  "Follow the saved plan; if reality diverges from it materially, say so instead of silently deviating.";

/** Codex's "clear context and implement" variant: the plan file becomes the
 *  source of user intent for a context that is about to be compacted. */
const FRESH_CONTEXT_HANDOFF =
  (path: string) =>
  `User approved the plan and chose to implement in a FRESH context. Switched to EXECUTE mode and a context ` +
  `compaction is running. Treat the saved plan as the source of user intent: first read ${path}, write its steps ` +
  `into the todo list (mark exactly one in_progress), then implement step by step. Do not rely on details of the ` +
  `pre-approval exploration that are not in the plan file — re-read the specific files you need as you go.`;

const APPROVAL_CHOICE_IMPLEMENT = "直接实施";
const APPROVAL_CHOICE_FRESH = "清上下文实施";
const APPROVAL_CHOICE_STAY = "继续规划";

const textBlock = (s: string) => ({ type: "text" as const, text: s });

interface PlanModeEntryData {
  mode: PlanMode;
}

/** Rebuild the mode from the branch's plan-mode entries (last wins). */
export function reconstructPlanMode(entries: Iterable<{ type: string; customType?: string; data?: unknown }>): PlanMode {
  let mode: PlanMode = "execute";
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PLAN_MODE_ENTRY_TYPE) continue;
    const data = entry.data as Partial<PlanModeEntryData> | undefined;
    if (data?.mode === "plan" || data?.mode === "execute") mode = data.mode;
  }
  return mode;
}

function isMutatingShellCommand(input: unknown): boolean {
  const command = (input as { command?: unknown } | undefined)?.command;
  return typeof command === "string" && MUTATING_COMMAND_RE.test(command);
}

export function makePlanModeExtension(): InlineExtension {
  let mode: PlanMode = "execute";

  const setMode = (next: PlanMode, pi: ExtensionAPI, ctx: ExtensionContext): void => {
    if (mode === next) return;
    mode = next;
    pi.appendEntry(PLAN_MODE_ENTRY_TYPE, { mode } satisfies PlanModeEntryData);
    publishWidget(ctx);
    try {
      ctx.ui?.notify?.(next === "plan" ? "已进入 PLAN 模式（只读规划）" : "已切回 EXECUTE 模式");
    } catch {
      // notify is best-effort
    }
  };

  const publishWidget = (ctx: ExtensionContext) => {
    try {
      ctx.ui?.setWidget?.(PLAN_MODE_WIDGET_KEY, [JSON.stringify({ mode })]);
    } catch {
      // best-effort
    }
  };

  const savedPlanPath = (ctx: ExtensionContext): string | null => {
    try {
      const sid = ctx.sessionManager.getSessionId();
      const path = sessionPlanPath(ctx.cwd, sid);
      return existsSync(path) ? path : null;
    } catch {
      return null;
    }
  };

  return (pi: ExtensionAPI): void => {
    pi.on("session_start", async (_event, ctx) => {
      mode = reconstructPlanMode(ctx.sessionManager.getBranch() as never);
      publishWidget(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
      mode = reconstructPlanMode(ctx.sessionManager.getBranch() as never);
      publishWidget(ctx);
    });

    // Mode instructions ride the (chained) system-prompt replacement; zero
    // overhead in execute mode.
    pi.on("before_agent_start", async (event) => {
      if (mode !== "plan") return undefined;
      return { systemPrompt: `${event.systemPrompt}\n${PLAN_MODE_INSTRUCTIONS}` };
    });

    // Hard gating while planning (belt to the prompt's suspenders).
    pi.on("tool_call", async (event) => {
      if (mode !== "plan") return undefined;
      const name = event.toolName;
      if (PLAN_BLOCKED_TOOLS.has(name)) {
        return {
          block: true,
          reason:
            name === "todo"
              ? "PLAN mode: the plan file is the checklist while planning. Save/update the plan with plan_save, then call exit_plan_mode; after approval, write the plan steps into the todo list."
              : "PLAN mode is read-only — no file modifications. Save the plan with plan_save and call exit_plan_mode to switch to execution.",
        };
      }
      if ((name === "bash" || name === "powershell") && isMutatingShellCommand(event.input)) {
        return {
          block: true,
          reason:
            "PLAN mode allows read-only shell commands only — this one looks mutating. If the classification is wrong, rephrase the command read-only (e.g. drop redirections); real changes happen after exit_plan_mode approval.",
        };
      }
      return undefined;
    });

    pi.registerTool(defineTool({
      name: "enter_plan_mode",
      label: "Enter Plan Mode",
      description:
        "Switch this session to PLAN mode before starting work on a task that needs planning. While planning you " +
        "explore read-only, save an implementation plan with plan_save, then request approval with exit_plan_mode. " +
        "Mutating tools are blocked in PLAN mode. Do NOT enter for small single-file edits, quick lookups, or simple questions.",
      promptSnippet: "enter_plan_mode — switch to read-only planning for multi-step/architectural tasks",
      promptGuidelines: [
        "调用 enter_plan_mode 的时机：任务涉及多个文件或模块、需要 3 步以上的有序实施、存在架构/接口/方案取舍、或是高风险变更（重构、迁移、删除）时，在动手探索之前先进入；用户明确要求先出计划时同样进入。",
        "不要为单文件小改动、查询/解释类请求、两步以内的琐事进入计划模式——那只会拖慢响应。",
      ],
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        if (mode === "plan") {
          return { content: [textBlock("Already in PLAN mode. Explore, save the plan with plan_save, then call exit_plan_mode.")], details: { mode: "plan", changed: false } };
        }
        setMode("plan", pi, ctx);
        return {
          content: [
            textBlock(
              "Entered PLAN mode. Explore the task read-only (mutating tools are blocked), save the implementation " +
                "plan with plan_save (context / recommended approach / `- [ ]` step checklist / verification), then " +
                "call exit_plan_mode for user approval.",
            ),
          ],
          details: { mode: "plan", changed: true },
        };
      },
    }));

    pi.registerTool(defineTool({
      name: "exit_plan_mode",
      label: "Exit Plan Mode",
      description:
        "Request user approval for the saved plan and switch back to EXECUTE mode. Only valid in PLAN mode and " +
        "after the plan has been saved with plan_save. The user picks: implement now / implement in a fresh " +
        "context (compaction runs; the saved plan becomes the source of intent) / keep planning. On approval the " +
        "agent starts implementing, first writing the plan steps into the todo list.",
      promptSnippet: "exit_plan_mode — request plan approval and return to execution",
      promptGuidelines: [
        "计划保存（plan_save）之后调用 exit_plan_mode 请求用户批准；未经批准不要开始实施。被拒或未响应时根据对话反馈修订计划后再次请求。",
      ],
      parameters: Type.Object({
        summary: Type.Optional(
          Type.String({ description: "One-line summary of the plan being submitted for approval (shown in the confirmation dialog)." }),
        ),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        if (mode !== "plan") {
          return { content: [textBlock("Not in PLAN mode — nothing to exit. Use enter_plan_mode first if the task needs planning.")], details: { mode: "execute" }, isError: true };
        }
        const planPath = savedPlanPath(ctx);
        if (!planPath) {
          return {
            content: [
              textBlock(
                "No plan saved yet for this session. Save the implementation plan with plan_save " +
                  "(context / approach / `- [ ]` steps / verification) before calling exit_plan_mode.",
              ),
            ],
            details: { mode: "plan", approved: false, reason: "no-plan" },
            isError: true,
          };
        }
        // Three-way approval over the blocking RPC UI channel (#8): implement
        // now / implement in a fresh context (compact; the plan file becomes
        // the source of intent — codex's clear-context handoff) / keep
        // planning. Timeout / abort / exceptions resolve to "keep planning".
        // A headless host (bench, print mode) has no human to ask — detect it
        // via ctx.hasUI === false (the SDK's no-op UI still exposes callable
        // select/confirm that silently decline, so checking for the method
        // alone is not enough) and auto-approve as "implement now" there so
        // the workflow can never dead-lock.
        let choice: string | undefined;
        let note = "";
        if (ctx.hasUI === false || typeof ctx.ui?.select !== "function") {
          choice = APPROVAL_CHOICE_IMPLEMENT;
          note = "（当前宿主无交互确认 UI，自动批准）";
        } else {
          try {
            choice = await ctx.ui.select(
              "实施此计划？",
              [APPROVAL_CHOICE_IMPLEMENT, APPROVAL_CHOICE_FRESH, APPROVAL_CHOICE_STAY],
              { timeout: 300_000, signal },
            );
          } catch {
            choice = undefined;
            note = "（确认框异常）";
          }
        }
        if (choice !== APPROVAL_CHOICE_IMPLEMENT && choice !== APPROVAL_CHOICE_FRESH) {
          return {
            content: [
              textBlock(
                `用户未批准计划${note}。仍在 PLAN 模式：根据对话中的反馈修订计划（plan_save 更新后可再次调用 ` +
                  `exit_plan_mode）；用户也可随时用 /plan-exit 手动切换到执行模式。计划文件：${planPath}`,
              ),
            ],
            details: { mode: "plan", approved: false, reason: "declined" },
          };
        }
        setMode("execute", pi, ctx);
        if (choice === APPROVAL_CHOICE_FRESH) {
          // Fire-and-forget: pi queues the compaction safely relative to the
          // running tool batch; the handoff tells the model not to lean on
          // pre-approval context either way.
          try {
            ctx.compact();
          } catch {
            // compaction is an optimization of the fresh-context choice, not
            // a requirement — the plan-driven handoff works without it.
          }
          return {
            content: [textBlock(FRESH_CONTEXT_HANDOFF(planPath))],
            details: { mode: "execute", approved: true, freshContext: true, planPath },
          };
        }
        return {
          content: [textBlock(note ? `${APPROVED_HANDOFF}${note}` : APPROVED_HANDOFF)],
          details: { mode: "execute", approved: true, planPath, ...(note ? { autoApproved: true } : {}) },
        };
      },
    }));

    pi.registerCommand("plan", {
      description: "进入 PLAN 模式（只读规划）",
      handler: async (_args, ctx) => {
        setMode("plan", pi, ctx);
      },
    });
    pi.registerCommand("plan-exit", {
      description: "切回 EXECUTE 模式（手动，不经确认框）",
      handler: async (_args, ctx) => {
        setMode("execute", pi, ctx);
      },
    });
  };
}
