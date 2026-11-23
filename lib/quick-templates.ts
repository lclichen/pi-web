/**
 * 快速会话模板 — admin-managed presets for the "quick" session mode.
 *
 * A template pins the model, the system prompt, and the MCP-server allowlist
 * a quick session starts with. One built-in template (id "default") is seeded
 * on first use: editable, never deletable — the one-click entry point.
 *
 * Storage: <dataDir>/state/global/quick-templates.json (server-side, atomic writes)——跟随
 * 部署数据目录（PI_WEB_DATA_DIR / AMEDAC 布局，lib/mode-homes.ts）。
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { JsonStore } from "./state/json-store";
import { legacyDataPath } from "./state/paths";

export interface QuickTemplate {
  id: string;
  name: string;
  description: string;
  /** Full system prompt for sessions started from this template. */
  systemPrompt: string;
  /** Optional provider/modelId override; absent = user's default model. */
  model?: { provider: string; modelId: string };
  /** Whole-server MCP grants (legacy). Every `<server>_<tool>` tool from the
   *  named servers is available. Union with mcpTools; empty/absent contributes
   *  nothing (quick is a closed world — no MCP tools by default). */
  mcpServers?: string[];
  /** Tool-level MCP allowlist: exact adapter tool names `<server>_<tool>`
   *  (same identifiers as a subagent's `ext:pi-mcp-adapter/<server>_<tool>`).
   *  Union with mcpServers; empty/absent contributes nothing. */
  mcpTools?: string[];
  /** Built-ins cannot be deleted (the default template). */
  builtin?: boolean;
}

interface TemplateData {
  templates: QuickTemplate[];
}

export const DEFAULT_TEMPLATE_ID = "default";

const DEFAULT_QUICK_PROMPT = [
  "你是一个运行在「快速会话」模式下的助手。",
  "该模式没有工作区：你不能读写文件、不能执行命令（read/write/edit/bash/grep/find/ls 均不可用）。",
  "你可以使用提供的外部 MCP 工具（如果有的话）来获取信息或执行受限操作。",
  "请直接回答用户的问题；当请求需要你没有的工具时，明确说明并给出替代建议。",
].join("\n");

function defaultTemplate(): QuickTemplate {
  return {
    id: DEFAULT_TEMPLATE_ID,
    name: "快速会话",
    description: "默认模板：无工作区的轻量问答，可用的 MCP 工具取决于用户配置。",
    systemPrompt: DEFAULT_QUICK_PROMPT,
    builtin: true,
  };
}

function parseTemplates(value: unknown): TemplateData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as { templates?: unknown }).templates;
  const templates = Array.isArray(raw) ? (raw as QuickTemplate[]) : [];
  if (!templates.some((template) => template.id === DEFAULT_TEMPLATE_ID)) {
    templates.unshift(defaultTemplate());
  }
  return {
    templates: templates.filter(
      (template) => template && typeof template.id === "string" && typeof template.name === "string",
    ),
  };
}

const quickTemplatesStore = new JsonStore<TemplateData>({
  name: "quick-templates",
  scope: { kind: "global" },
  legacyPaths: () => [
    legacyDataPath("quick-templates.json"),
    // Packaged deployments used to write into the (possibly read-only) app
    // directory; keep the one-time migration path.
    join(process.cwd(), "data", "quick-templates.json"),
  ],
  defaults: () => ({ templates: [defaultTemplate()] }),
  parse: parseTemplates,
});

function readStore(): TemplateData {
  return quickTemplatesStore.read();
}

export function listQuickTemplates(): QuickTemplate[] {
  return readStore().templates.map((t) => ({ ...t }));
}

export function getQuickTemplate(id: string): QuickTemplate | null {
  return readStore().templates.find((t) => t.id === id) ?? null;
}

export interface TemplateValidationError {
  field: string;
  reason: string;
}

function validate(template: Partial<QuickTemplate>): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];
  if (typeof template.name !== "string" || !template.name.trim()) {
    errors.push({ field: "name", reason: "模板名称不能为空" });
  } else if (template.name.length > 60) {
    errors.push({ field: "name", reason: "模板名称过长（≤60 字符）" });
  }
  if (typeof template.systemPrompt !== "string") {
    errors.push({ field: "systemPrompt", reason: "缺少系统提示词" });
  } else if (template.systemPrompt.length > 20_000) {
    errors.push({ field: "systemPrompt", reason: "系统提示词过长（≤20000 字符）" });
  }
  if (template.model !== undefined && template.model !== null) {
    const m = template.model;
    if (!m || typeof m.provider !== "string" || typeof m.modelId !== "string" || !m.provider || !m.modelId) {
      errors.push({ field: "model", reason: "模型需要同时提供 provider 与 modelId" });
    }
  }
  if (template.mcpServers !== undefined) {
    if (!Array.isArray(template.mcpServers) || template.mcpServers.some((s) => typeof s !== "string")) {
      errors.push({ field: "mcpServers", reason: "MCP 服务器允许列表必须是字符串数组" });
    }
  }
  if (template.mcpTools !== undefined) {
    if (!Array.isArray(template.mcpTools) || template.mcpTools.some((s) => typeof s !== "string")) {
      errors.push({ field: "mcpTools", reason: "MCP 工具允许列表必须是字符串数组" });
    }
  }
  return errors;
}

function normalizeList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean))];
}

/** Admin: create a new template. Returns the stored record. */
export function createQuickTemplate(input: Partial<QuickTemplate>): {
  template?: QuickTemplate;
  errors?: TemplateValidationError[];
} {
  const errors = validate(input);
  if (errors.length > 0) return { errors };
  const mcpServers = normalizeList(input.mcpServers);
  const mcpTools = normalizeList(input.mcpTools);
  const template: QuickTemplate = {
    id: randomUUID(),
    name: input.name!.trim(),
    description: typeof input.description === "string" ? input.description.trim().slice(0, 300) : "",
    systemPrompt: input.systemPrompt!,
    ...(input.model ? { model: input.model } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(mcpTools ? { mcpTools } : {}),
  };
  quickTemplatesStore.update((data) => {
    data.templates.push(template);
  });
  return { template };
}

/** Admin: update (including the built-in default). */
export function updateQuickTemplate(
  id: string,
  input: Partial<QuickTemplate>,
): { template?: QuickTemplate; errors?: TemplateValidationError[] } {
  let result: QuickTemplate | undefined;
  let errors: TemplateValidationError[] | undefined;
  quickTemplatesStore.update((data) => {
    const existing = data.templates.find((t) => t.id === id);
    if (!existing) {
      errors = [{ field: "id", reason: "模板不存在" }];
      return;
    }
    const merged: Partial<QuickTemplate> = {
      ...existing,
      ...input,
      id: existing.id, // id is immutable
      builtin: existing.builtin,
    };
    const validation = validate(merged);
    if (validation.length > 0) {
      errors = validation;
      return;
    }
    Object.assign(existing, {
      name: merged.name!.trim(),
      description: typeof merged.description === "string" ? merged.description.trim().slice(0, 300) : "",
      systemPrompt: merged.systemPrompt!,
      ...(merged.model ? { model: merged.model } : { model: undefined }),
      ...(Array.isArray(merged.mcpServers)
        ? { mcpServers: normalizeList(merged.mcpServers) }
        : { mcpServers: undefined }),
      ...(Array.isArray(merged.mcpTools)
        ? { mcpTools: normalizeList(merged.mcpTools) }
        : { mcpTools: undefined }),
    });
    result = { ...existing };
  });
  if (errors) return { errors };
  if (!result) return { errors: [{ field: "id", reason: "模板不存在" }] };
  return { template: result };
}

/** Admin: delete — the built-in default is refused. */
export function deleteQuickTemplate(id: string): { ok: boolean; error?: string } {
  if (id === DEFAULT_TEMPLATE_ID) {
    return { ok: false, error: "默认模板不可删除（可编辑）" };
  }
  let ok = false;
  quickTemplatesStore.update((data) => {
    const next = data.templates.filter((t) => t.id !== id);
    if (next.length === data.templates.length) return;
    data.templates = next;
    ok = true;
  });
  return ok ? { ok: true } : { ok: false, error: "模板不存在" };
}
