import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile } from "@/lib/atomic-write";
import type { AgentInfo, AgentDetail, ConfigScope } from "@/lib/api-types";

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function validateAgentName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required";
  if (trimmed === "." || trimmed === "..") return "Invalid name";
  if (!NAME_RE.test(trimmed)) {
    return "Name may only contain letters, digits, dot, underscore and hyphen";
  }
  return null;
}

export function agentsDirFor(cwd: string, scope: ConfigScope): string {
  return scope === "project" ? join(cwd, ".pi", "agents") : join(getAgentDir(), "agents");
}

function csvToList(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    const arr = v.map(String).map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  if (typeof v === "string") {
    const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  return undefined;
}

function parseAgentFile(name: string, raw: string, scope: ConfigScope, filePath: string): AgentInfo {
  const base: AgentInfo = { name, scope, filePath };
  try {
    const { frontmatter: fm } = parseFrontmatter<Record<string, unknown>>(raw);
    return {
      ...base,
      description: typeof fm.description === "string" ? fm.description : undefined,
      tools: csvToList(fm.tools),
      disallowedTools: csvToList(fm.disallowed_tools),
      model: typeof fm.model === "string" ? fm.model : undefined,
      thinking: typeof fm.thinking === "string" ? fm.thinking : undefined,
      maxTurns:
        typeof fm.max_turns === "number" && Number.isFinite(fm.max_turns)
          ? fm.max_turns
          : undefined,
    };
  } catch (e) {
    return { ...base, parseError: e instanceof Error ? e.message : String(e) };
  }
}

export function listAgents(cwd: string, scope: ConfigScope): AgentInfo[] {
  const dir = agentsDirFor(cwd, scope);
  if (!existsSync(dir)) return [];
  const out: AgentInfo[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    const filePath = join(dir, entry.name);
    let raw = "";
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    out.push(parseAgentFile(name, raw, scope, filePath));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listAllAgents(cwd: string): AgentInfo[] {
  return [...listAgents(cwd, "project"), ...listAgents(cwd, "global")];
}

export function getAgentDetail(
  cwd: string,
  scope: ConfigScope,
  name: string,
): AgentDetail | null {
  const filePath = join(agentsDirFor(cwd, scope), `${name}.md`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8");
  const info = parseAgentFile(name, raw, scope, filePath);
  let systemPrompt = "";
  let rawFrontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(raw);
    systemPrompt = parsed.body.trim();
    rawFrontmatter = parsed.frontmatter;
  } catch {
    // keep defaults; parseError already on info
  }
  return { ...info, systemPrompt, rawFrontmatter };
}

export interface AgentFields {
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  thinking?: string;
  maxTurns?: number;
}

function listToCsv(list?: string[]): string | undefined {
  if (!list || list.length === 0) return undefined;
  return list.join(", ");
}

function yamlScalar(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value);
  if (s === "") return undefined;
  if (/[:#&*!|>'"%@`{}\[\],\n]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Apply scalar updates to a frontmatter text block, preserving every other
 * line (unknown keys, comments, formatting). Keys mapped to undefined are
 * removed; keys not present are appended.
 */
function rewriteFrontmatterBlock(
  block: string,
  updates: Record<string, string | undefined>,
): string {
  const lines = block.split(/\r?\n/);
  const keyIndex = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+)\s*:/);
    if (m) keyIndex.set(m[1], i);
  }
  for (const [key, value] of Object.entries(updates)) {
    const idx = keyIndex.get(key);
    if (idx !== undefined) {
      if (value === undefined) lines.splice(idx, 1);
      else lines[idx] = `${key}: ${value}`;
    } else if (value !== undefined) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

function fieldsToUpdate(fields: AgentFields): Record<string, string | undefined> {
  return {
    description: yamlScalar(fields.description),
    tools: yamlScalar(listToCsv(fields.tools)),
    disallowed_tools: yamlScalar(listToCsv(fields.disallowedTools)),
    model: yamlScalar(fields.model),
    thinking: yamlScalar(fields.thinking),
    max_turns:
      fields.maxTurns === undefined || Number.isNaN(fields.maxTurns)
        ? undefined
        : String(fields.maxTurns),
  };
}

export function buildAgentContent(
  raw: string | null,
  fields: AgentFields,
  systemPrompt: string,
): string {
  const body = systemPrompt.replace(/\s+$/, "");
  const updates = fieldsToUpdate(fields);
  if (raw) {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (m) {
      const rewritten = rewriteFrontmatterBlock(m[1], updates);
      return body ? `---\n${rewritten}\n---\n\n${body}` : `---\n${rewritten}\n---\n`;
    }
  }
  const fmLines = Object.entries(updates)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return fmLines.length
    ? `---\n${fmLines.join("\n")}\n---\n\n${body}`
    : body;
}

export function createAgent(
  cwd: string,
  scope: ConfigScope,
  name: string,
  fields: AgentFields,
  systemPrompt: string,
): string {
  const filePath = join(agentsDirFor(cwd, scope), `${name}.md`);
  if (existsSync(filePath)) {
    throw new Error(`Agent "${name}" already exists in ${scope} scope`);
  }
  atomicWriteFile(filePath, buildAgentContent(null, fields, systemPrompt));
  return filePath;
}

export function updateAgent(
  cwd: string,
  scope: ConfigScope,
  name: string,
  fields: AgentFields,
  systemPrompt: string,
): string {
  const filePath = join(agentsDirFor(cwd, scope), `${name}.md`);
  if (!existsSync(filePath)) {
    throw new Error(`Agent "${name}" not found in ${scope} scope`);
  }
  const raw = readFileSync(filePath, "utf8");
  atomicWriteFile(filePath, buildAgentContent(raw, fields, systemPrompt));
  return filePath;
}

export function deleteAgent(cwd: string, scope: ConfigScope, name: string): boolean {
  const filePath = join(agentsDirFor(cwd, scope), `${name}.md`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}
