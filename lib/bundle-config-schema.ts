/**
 * 配置包里两个"格式很严格"的文件：`.pi/mcp.json` 与 `.pi/models.json`。
 *
 * 它们不是可有可无的备注文档——pi 与 pi-mcp-adapter 启动时按固定结构解析：
 *   · mcp.json   `{ mcpServers: { <name>: {command|url|socket, args, env, …} } }`
 *   · models.json `{ providers: { <id>: { api, baseUrl, apiKey, models: [{id,…}] } } }`
 * 历史 Demo 曾带 `{ modelList: [...] }`（旧格式），导入后会让项目会话的模型
 * 列表直接变空。导出/导入/上传三个入口在落盘前都跑这里的校验，宁可明确失败
 * 也不要发出一个装得下但跑不起来的包。
 *
 * 规则保持"结构必填 + 类型检查"，未知字段放行（adapter 仍在演进）。
 */
import { stripJsonc } from "./jsonc.ts";

export interface ConfigFileProblem {
  path: string;
  problem: string;
}

const MCP_TRANSPORTS = new Set(["stdio", "http", "sse"]);
const MCP_AUTH = new Set(["none", "bearer", "oauth"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

/** Problems in one mcp.json document (empty array = valid). */
export function validateMcpConfigText(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (e) {
    return [`不是合法 JSON：${e instanceof Error ? e.message : String(e)}`];
  }
  if (!isRecord(parsed)) return ["根节点必须是对象 { mcpServers: { … } }"];
  if (!("mcpServers" in parsed)) return ["缺少 mcpServers 字段（即使没有服务器也应写 {}）"];
  if (!isRecord(parsed.mcpServers)) return ["mcpServers 必须是对象（名称 → 服务器定义）"];

  const problems: string[] = [];
  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    const at = `mcpServers.${name}`;
    if (!isRecord(raw)) {
      problems.push(`${at} 必须是对象`);
      continue;
    }
    const hasCommand = typeof raw.command === "string" && raw.command.trim().length > 0;
    const hasUrl = typeof raw.url === "string" && raw.url.trim().length > 0;
    const hasSocket = typeof raw.socket === "string" && raw.socket.trim().length > 0;
    if (!hasCommand && !hasUrl && !hasSocket) {
      problems.push(`${at} 缺少 command（stdio）或 url（http）`);
    }
    if ("args" in raw && !isStringArray(raw.args)) problems.push(`${at}.args 必须是字符串数组`);
    if ("env" in raw && !isStringMap(raw.env)) problems.push(`${at}.env 必须是 KEY→字符串 的对象`);
    if ("headers" in raw && !isStringMap(raw.headers)) problems.push(`${at}.headers 必须是 KEY→字符串 的对象`);
    if ("disabled" in raw && typeof raw.disabled !== "boolean") problems.push(`${at}.disabled 必须是布尔值`);
    if ("directTools" in raw && typeof raw.directTools !== "boolean" && !isStringArray(raw.directTools)) {
      problems.push(`${at}.directTools 必须是布尔值或字符串数组`);
    }
    for (const key of ["includeTools", "excludeTools"] as const) {
      if (key in raw && !isStringArray(raw[key])) problems.push(`${at}.${key} 必须是字符串数组`);
    }
    if ("auth" in raw && (typeof raw.auth !== "string" || !MCP_AUTH.has(raw.auth))) {
      problems.push(`${at}.auth 只能是 none / bearer / oauth`);
    }
    if ("transport" in raw && (typeof raw.transport !== "string" || !MCP_TRANSPORTS.has(raw.transport))) {
      problems.push(`${at}.transport 只能是 stdio / http / sse`);
    }
    for (const key of ["idleTimeout", "toolTimeoutMs", "requestTimeoutMs"] as const) {
      if (key in raw && typeof raw[key] !== "number") problems.push(`${at}.${key} 必须是数字`);
    }
  }
  return problems;
}

/** Problems in one models.json document (empty array = valid). */
export function validateModelsConfigText(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch (e) {
    return [`不是合法 JSON：${e instanceof Error ? e.message : String(e)}`];
  }
  if (!isRecord(parsed)) return ["根节点必须是对象 { providers: { … } }"];
  if ("modelList" in parsed && !("providers" in parsed)) {
    return ["检测到旧格式 modelList[]：pi 需要 { providers: { <id>: { models: [...] } } }，请迁移后再打包"];
  }
  if (!("providers" in parsed)) return ["缺少 providers 字段（pi 的 models.json 格式为 { providers: { … } }）"];
  if (!isRecord(parsed.providers)) return ["providers 必须是对象（provider id → 定义）"];

  const problems: string[] = [];
  for (const [id, raw] of Object.entries(parsed.providers)) {
    const at = `providers.${id}`;
    if (!isRecord(raw)) {
      problems.push(`${at} 必须是对象`);
      continue;
    }
    if (!Array.isArray(raw.models)) {
      problems.push(`${at}.models 必须是数组`);
      continue;
    }
    raw.models.forEach((model, index) => {
      const modelAt = `${at}.models[${index}]`;
      if (!isRecord(model)) {
        problems.push(`${modelAt} 必须是对象`);
        return;
      }
      if (typeof model.id !== "string" || model.id.trim().length === 0) problems.push(`${modelAt}.id 必须是非空字符串`);
      for (const key of ["contextWindow", "maxOutputTokens"] as const) {
        if (key in model && typeof model[key] !== "number") problems.push(`${modelAt}.${key} 必须是数字`);
      }
      if ("cost" in model && !isRecord(model.cost)) problems.push(`${modelAt}.cost 必须是对象`);
    });
    for (const key of ["api", "baseUrl", "apiKey"] as const) {
      if (key in raw && typeof raw[key] !== "string") problems.push(`${at}.${key} 必须是字符串`);
    }
  }
  return problems;
}

/** Validate one bundle member by its relative path (others = no opinion). */
export function validateBundleConfigText(rel: string, text: string): string[] {
  const lower = rel.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)mcp(-quick)?\.json$/.test(lower)) return validateMcpConfigText(text);
  if (/(^|\/)models\.json$/.test(lower)) return validateModelsConfigText(text);
  return [];
}

/** Turn per-file problems into one actionable error message. */
export function formatConfigProblems(problems: ConfigFileProblem[]): string {
  const lines = problems.slice(0, 8).map((p) => `${p.path}：${p.problem}`);
  if (problems.length > 8) lines.push(`…另有 ${problems.length - 8} 处问题`);
  return lines.join("；");
}
