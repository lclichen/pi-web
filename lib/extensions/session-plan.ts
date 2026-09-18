/**
 * Session plan storage (lab-training state pattern).
 *
 * Plans live in the project's fixed folder, one file per session:
 *   <cwd>/.pi/plans/plan-sess_<sessionId>.md
 * Written session-side via node fs (the extension runs where the session
 * process runs, so the file lands beside the project's other .pi state),
 * read by the WebUI through the ordinary /api/files route (the project home
 * is an allowed root for the session owner). Legacy workspace plans
 * (.pi/plan.md / PLAN.md) remain read-only fallbacks on the client.
 *
 * Three write paths:
 *   1. plan_save tool — the main model saves/updates its implementation plan
 *   2. Auto-capture — the subagents extension saves @plan results here
 *      (lib/subagent-extension.ts calls saveSessionPlan on plan-profile runs)
 *   3. Anything else (user, scripts) may simply write the file
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { defineTool, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export const PLAN_DIR_NAME = ".pi/plans";

export function sessionPlanPath(cwd: string, sessionId: string): string {
  return join(cwd, PLAN_DIR_NAME, `plan-sess_${sessionId}.md`);
}

/** Best-effort save; failures are reported to the caller, never thrown. */
export function saveSessionPlan(cwd: string, sessionId: string, markdown: string): { ok: boolean; error?: string } {
  try {
    const dir = join(cwd, PLAN_DIR_NAME);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = sessionPlanPath(cwd, sessionId);
    writeFileSync(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Profile names whose subagent results are treated as plans. */
export function isPlanProfile(profile: string | undefined): boolean {
  if (!profile) return false;
  return /^(plan|planner|planning|architect)/i.test(profile.trim());
}

export function makeSessionPlanExtension(): InlineExtension {
  return (pi: ExtensionAPI): void => {
    pi.registerTool(defineTool({
      name: "plan_save",
      label: "Plan",
      description:
        "Save (or update) this session's implementation plan as markdown. It is stored at " +
        ".pi/plans/plan-sess_<sessionId>.md in the project and shown in the WebUI 计划 panel " +
        "and status capsule. Call it whenever a plan is created or meaningfully revised.",
      promptSnippet: "plan_save — persist the session implementation plan (markdown)",
      // 中文版备查：产出或实质性修订实施计划后，用 plan_save 保存完整 markdown 计划
      // （含步骤清单，未完成步骤用 `- [ ]` 复选框表达）；不要把计划只留在对话里。
      promptGuidelines: [
        "After producing or materially revising an implementation plan, save the full markdown with plan_save (steps expressed as `- [ ]` checkboxes); never leave the plan only in the conversation.",
      ],
      parameters: Type.Object({
        content: Type.String({ description: "Full markdown plan. Use `- [ ]` / `- [x]` checkboxes for steps." }),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const result = saveSessionPlan(ctx.cwd, sessionId, params.content);
        return result.ok
          ? {
              content: [{ type: "text", text: `Plan saved (${params.content.length} chars) to ${PLAN_DIR_NAME}/plan-sess_${sessionId.slice(0, 8)}….md` }],
              details: { saved: true, path: sessionPlanPath(ctx.cwd, sessionId) },
            }
          : {
              content: [{ type: "text", text: `Failed to save plan: ${result.error}` }],
              details: { saved: false },
              isError: true,
            };
      },
    }));
  };
}
