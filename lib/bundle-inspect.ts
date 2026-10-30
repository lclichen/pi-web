/**
 * Bundle content inspection — parse a (decrypted) config-bundle zip WITHOUT
 * applying it, for the "Agents 管理 · Agent 定义" page: version metadata,
 * content inventory (extensions/skills/agents/models/MCP/labs), declared
 * dependencies and bounded file previews feed list + detail views there.
 *
 * Works on plain zip bytes; encrypted .apkg is decrypted by the caller
 * (route mirrors the import flow via openApkgViaTool). Read-only: nothing is
 * written, licenses are NOT consumed (that only happens on apply).
 */
import JSZip from "jszip";
import type { BundlePackageMeta } from "./project-config-bundle.ts";

export interface InspectEntry {
  path: string;
  size: number;
}

export interface InspectModels {
  file: string;
  models: string[];
}

export interface InspectMcp {
  file: string;
  servers: string[];
}

export interface BundleInspection {
  package: BundlePackageMeta | null;
  /** Archive format fields (manifest.format). */
  format: { version: number | null; exportedAt: string | null };
  /** Declared environment dependencies (manifest.package.dependencies). */
  dependencies: string[];
  hasReadme: boolean;
  agentsMdBytes: number | null;
  counts: {
    extensions: number;
    skills: number;
    agents: number;
    models: number;
    mcp: number;
    labs: number;
    other: number;
  };
  extensions: InspectEntry[];
  skills: InspectEntry[];
  agents: InspectEntry[];
  models: InspectModels[];
  mcp: InspectMcp[];
  labs: InspectEntry[];
  otherFiles: InspectEntry[];
  /** Raw manifest.json (the 代码/manifest view). */
  manifest: unknown;
}

export const PREVIEW_MAX_BYTES = 512 * 1024;
const OTHER_FILES_CAP = 100;
const MAX_PREVIEW_ENTRIES = 20_000;

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

/** Preview whitelist: everything a bundle may legally carry. */
export function isPreviewablePath(path: string): boolean {
  const rel = normalizePath(path);
  if (rel.startsWith("..") || rel.includes("/../") || rel.includes("\\")) return false;
  return /^\.pi\//i.test(rel) || /^labs\//i.test(rel) || /^(agents\.md|readme\.md)$/i.test(rel);
}

function entry(path: string, size: number): InspectEntry {
  return { path: normalizePath(path), size };
}

/** models.json shapes: { modelList: [...] } | { models: [...] } | bare array. */
function collectModelIds(data: unknown): string[] {
  let arr: unknown[] | null = null;
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.modelList)) arr = obj.modelList;
    else if (Array.isArray(obj.models)) arr = obj.models;
  }
  if (!arr) return [];
  const ids: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") ids.push(item);
    else if (item && typeof item === "object") {
      const m = item as Record<string, unknown>;
      if (typeof m.id === "string") ids.push(m.id);
      else if (typeof m.name === "string") ids.push(m.name);
    }
  }
  return [...new Set(ids)];
}

/** mcp.json shapes: { mcpServers: { name: cfg } } | { servers: {...} }. */
function collectMcpServers(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  const servers = obj.mcpServers ?? obj.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.keys(servers as Record<string, unknown>);
}

export async function inspectBundleZip(zipData: Buffer): Promise<BundleInspection> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(zipData);
  } catch {
    throw new Error("无法解析压缩包（需要 zip 格式，或 .apkg 解密后的内容）");
  }

  const inspection: BundleInspection = {
    package: null,
    format: { version: null, exportedAt: null },
    dependencies: [],
    hasReadme: false,
    agentsMdBytes: null,
    counts: { extensions: 0, skills: 0, agents: 0, models: 0, mcp: 0, labs: 0, other: 0 },
    extensions: [],
    skills: [],
    agents: [],
    models: [],
    mcp: [],
    labs: [],
    otherFiles: [],
    manifest: null,
  };

  const entries = Object.values(archive.files)
    .filter((e) => !e.dir)
    .slice(0, MAX_PREVIEW_ENTRIES);
  const jsonReads: Array<{ path: string; text: string }> = [];

  for (const e of entries) {
    const rel = normalizePath(e.name);
    const lower = rel.toLowerCase();
    if (lower === "manifest.json" || lower === "readme.md") {
      const text = await e.async("string");
      jsonReads.push({ path: lower, text });
      if (lower === "readme.md") inspection.hasReadme = true;
      continue;
    }
    if (lower === "agents.md") {
      inspection.agentsMdBytes = (await e.async("nodebuffer")).length;
      continue;
    }
    // Metadata reads for models / MCP inventories (bounded by entry count);
    // these belong to their own sections, not "other files".
    const isModelsJson = /^\.pi\/.*models\.json$/i.test(rel);
    const isMcpJson = /^\.pi\/.*mcp\.json$/i.test(rel);
    if (isModelsJson || isMcpJson) {
      const text = await e.async("string");
      jsonReads.push({ path: rel, text });
      continue;
    }
    const size = ((await e.async("nodebuffer")) as Buffer).length;

    if (lower.startsWith(".pi/extensions/")) {
      inspection.extensions.push(entry(rel, size));
    } else if (lower.startsWith(".pi/skills/")) {
      inspection.skills.push(entry(rel, size));
    } else if (lower.startsWith(".pi/agents/") || lower === ".pi/subagents.json") {
      inspection.agents.push(entry(rel, size));
    } else if (lower.startsWith("labs/")) {
      // labs/ 已废弃（历史包兼容展示）；新 Agent 定义只应携带 .pi/。
      inspection.labs.push(entry(rel, size));
    } else if (lower.startsWith(".pi/")) {
      if (inspection.otherFiles.length < OTHER_FILES_CAP) inspection.otherFiles.push(entry(rel, size));
      inspection.counts.other += 1;
    }
    // Anything else (unexpected root files) is ignored — the apply path is
    // the authority on what lands in a project.
  }

  for (const read of jsonReads) {
    if (read.path === "readme.md") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      continue;
    }
    if (read.path === "manifest.json") {
      inspection.manifest = parsed;
      const m = parsed as {
        format?: { version?: unknown; exportedAt?: unknown };
        package?: Partial<BundlePackageMeta> & { dependencies?: unknown };
      };
      if (typeof m.format?.version === "number") inspection.format.version = m.format.version;
      if (typeof m.format?.exportedAt === "string") inspection.format.exportedAt = m.format.exportedAt;
      if (m.package && typeof m.package.name === "string") {
        inspection.package = {
          name: m.package.name,
          title: m.package.title ?? m.package.name,
          description: m.package.description ?? "",
          version: m.package.version ?? "1.0.0",
          channel: m.package.channel ?? "stable",
        };
      }
      if (Array.isArray(m.package?.dependencies)) {
        inspection.dependencies = (m.package!.dependencies as unknown[])
          .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
          .map((d) => d.trim())
          .slice(0, 50);
      }
    } else if (/models\.json$/i.test(read.path)) {
      const models = collectModelIds(parsed);
      if (models.length > 0) inspection.models.push({ file: read.path, models });
    } else if (/mcp\.json$/i.test(read.path)) {
      const servers = collectMcpServers(parsed);
      if (servers.length > 0) inspection.mcp.push({ file: read.path, servers });
    }
  }

  inspection.counts.extensions = inspection.extensions.length;
  // 技能以“目录”计数，不是文件：.pi/skills/<name>/SKILL.md + references/* 属于
  // 同一个技能（此前把每个文件都算成一个技能，内容清单里的数字虚高）。
  // 扁平文件（.pi/skills/<name>.md，历史包）各算一个；缺 SKILL.md 的目录不计。
  const skillDirs = new Set<string>();
  let flatSkillFiles = 0;
  for (const s of inspection.skills) {
    const rel = s.path.replace(/^\.pi\/skills\//i, "");
    const slash = rel.indexOf("/");
    if (slash === -1) {
      flatSkillFiles += 1;
      continue;
    }
    // Only directories that actually carry SKILL.md count as skills.
    if (/^[^/]+\/SKILL\.md$/i.test(rel)) skillDirs.add(rel.slice(0, slash));
  }
  inspection.counts.skills = skillDirs.size + flatSkillFiles;
  inspection.counts.agents = inspection.agents.length;
  inspection.counts.models = inspection.models.reduce((sum, m) => sum + m.models.length, 0);
  inspection.counts.mcp = inspection.mcp.reduce((sum, m) => sum + m.servers.length, 0);
  inspection.counts.labs = inspection.labs.length;
  return inspection;
}

/** Read one previewable file (bounded). Binary detection is up to the caller. */
export async function readBundleFileFromZip(
  zipData: Buffer,
  path: string,
): Promise<{ bytes: Buffer; truncated: boolean; size: number }> {
  if (!isPreviewablePath(path)) throw new Error("此路径不可预览");
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(zipData);
  } catch {
    throw new Error("无法解析压缩包");
  }
  const file = archive.file(normalizePath(path));
  if (!file) throw new Error("文件不存在");
  const full = (await file.async("nodebuffer")) as Buffer;
  return {
    bytes: full.length > PREVIEW_MAX_BYTES ? full.subarray(0, PREVIEW_MAX_BYTES) : full,
    truncated: full.length > PREVIEW_MAX_BYTES,
    size: full.length,
  };
}

/** Heuristic: NUL byte or heavy control chars → treat as binary in the UI. */
export function looksBinary(bytes: Buffer): boolean {
  const probe = bytes.subarray(0, 4096);
  let control = 0;
  for (const byte of probe) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return probe.length > 0 && control / probe.length > 0.1;
}
