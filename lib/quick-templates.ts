/**
 * 快速会话模板 — admin-managed presets for the "quick" session mode.
 *
 * A template pins the model, the system prompt, and the MCP-server allowlist
 * a quick session starts with. One built-in template (id "default") is seeded
 * on first use: editable, never deletable — the one-click entry point.
 *
 * Storage: data/quick-templates.json (server-side, atomic writes).
 */
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { mkdirSync } from "fs";
import { atomicWriteFile } from "./atomic-write";

export interface QuickTemplate {
  id: string;
  name: string;
  description: string;
  /** Full system prompt for sessions started from this template. */
  systemPrompt: string;
  /** Optional provider/modelId override; absent = user's default model. */
  model?: { provider: string; modelId: string };
  /** MCP server-name allowlist. Empty/absent = every server configured in the
   *  USER scope (~/.pi/agent/mcp.json) is available. */
  mcpServers?: string[];
  /** Built-ins cannot be deleted (the default template). */
  builtin?: boolean;
}

interface TemplateStore {
  version: 1;
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

function storePath(): string {
  return join(process.cwd(), "data", "quick-templates.json");
}

function readStore(): TemplateStore {
  try {
    const raw = readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TemplateStore>;
    const templates = Array.isArray(parsed.templates) ? parsed.templates : [];
    if (!templates.some((t) => t.id === DEFAULT_TEMPLATE_ID)) {
      templates.unshift(defaultTemplate());
    }
    return { version: 1, templates: templates.filter((t) => t && typeof t.id === "string" && typeof t.name === "string") };
  } catch {
    return { version: 1, templates: [defaultTemplate()] };
  }
}

function writeStore(store: TemplateStore): void {
  const target = storePath();
  mkdirSync(dirname(target), { recursive: true });
  writePrivateFileAtomicSync(target, JSON.stringify(store, null, 2));
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
  if (template.model !== undefined) {
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
  return errors;
}

/** Admin: create a new template. Returns the stored record. */
export function createQuickTemplate(input: Partial<QuickTemplate>): { template?: QuickTemplate; errors?: TemplateValidationError[] } {
  const errors = validate(input);
  if (errors.length > 0) return { errors };
  const template: QuickTemplate = {
    id: randomUUID(),
    name: input.name!.trim(),
    description: typeof input.description === "string" ? input.description.trim().slice(0, 300) : "",
    systemPrompt: input.systemPrompt!,
    ...(input.model ? { model: input.model } : {}),
    ...(Array.isArray(input.mcpServers) ? { mcpServers: input.mcpServers.map((s) => s.trim()).filter(Boolean) } : {}),
  };
  const store = readStore();
  store.templates.push(template);
  writeStore(store);
  return { template };
}

/** Admin: update (including the built-in default). */
export function updateQuickTemplate(id: string, input: Partial<QuickTemplate>): { template?: QuickTemplate; errors?: TemplateValidationError[] } {
  const store = readStore();
  const existing = store.templates.find((t) => t.id === id);
  if (!existing) return { errors: [{ field: "id", reason: "模板不存在" }] };
  const merged: Partial<QuickTemplate> = {
    ...existing,
    ...input,
    id: existing.id, // id is immutable
    builtin: existing.builtin,
  };
  const errors = validate(merged);
  if (errors.length > 0) return { errors };
  Object.assign(existing, {
    name: merged.name!.trim(),
    description: typeof merged.description === "string" ? merged.description.trim().slice(0, 300) : "",
    systemPrompt: merged.systemPrompt!,
    ...(merged.model ? { model: merged.model } : { model: undefined }),
    ...(Array.isArray(merged.mcpServers) ? { mcpServers: merged.mcpServers.map((s) => s.trim()).filter(Boolean) } : { mcpServers: undefined }),
  });
  writeStore(store);
  return { template: { ...existing } };
}

/** Admin: delete — the built-in default is refused. */
export function deleteQuickTemplate(id: string): { ok: boolean; error?: string } {
  if (id === DEFAULT_TEMPLATE_ID) {
    return { ok: false, error: "默认模板不可删除（可编辑）" };
  }
  const store = readStore();
  const next = store.templates.filter((t) => t.id !== id);
  if (next.length === store.templates.length) return { ok: false, error: "模板不存在" };
  store.templates = next;
  writeStore(store);
  return { ok: true };
}
