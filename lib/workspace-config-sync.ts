/**
 * 远程工作区 .pi/ → 项目区配置同步。
 *
 * Remote sessions execute tools in a workspace (sandbox / user machine / SSH),
 * while the SDK reads agent config from the project home on the pi-web server
 * (<home>/.pi). Editing config in the workspace without a sync step therefore
 * has no runtime effect. This module reads .pi/ through the session's
 * WorkspaceOperations provider (same path containment as the coding tools) and
 * applies it to the project home through the same validation gate as config
 * bundle imports.
 *
 * Security posture:
 *  - only relative .pi/ paths; absolute paths / traversal are rejected;
 *  - credential and runtime files are skipped, never overwritten
 *    (auth.json, ssh.json, sandbox-platform.json, bundle locks, …);
 *  - mcp.json / models.json must pass the shared schema validation;
 *  - normal users cannot sync project-level stdio MCP (server-side execution);
 *  - remote-mode MCP servers that the tool policy excludes are rejected before
 *    any write, so a synced config is actually usable in this project's mode.
 *
 * Remote transports follow symlinks inside the workspace; that is already
 * within the project owner's read capability (same tools/terminal), and the
 * destination stays confined to <project-home>/.pi/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertAllowedConfigPath,
  isDeniedConfigPath,
  validateConfigWrites,
  type ConfigWrite,
} from "./project-config-bundle.ts";
import { stripJsonc } from "./jsonc.ts";
import { detectTransport } from "./mcp-config.ts";
import { mcpServerModePolicy } from "./tool-policy.ts";
import type { ServerEntry } from "./api-types.ts";
import type { SessionMode } from "./session-modes.ts";
import { WorkspaceOperationError, type WorkspaceOperations } from "./workspace-operations.ts";

export const WORKSPACE_CONFIG_MAX_FILES = 5_000;
export const WORKSPACE_CONFIG_MAX_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_CONFIG_MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 32;

/** Runtime state that lives under .pi/ but must never become project config. */
const SYNC_EXTRA_DENIED_BASENAMES = new Set(["sandbox-sync.json"]);

export interface WorkspaceConfigFile {
  /** POSIX path relative to the workspace root, always under `.pi/`. */
  rel: string;
  content: Buffer;
}

export interface WorkspaceConfigCollectResult {
  files: WorkspaceConfigFile[];
  /** Denied / oversized / non-regular entries that were deliberately skipped. */
  skipped: string[];
  bytes: number;
}

export interface WorkspaceConfigSyncStats {
  /** Collected files considered for sync (excluding skipped entries). */
  files: number;
  bytes: number;
  added: number;
  overwritten: number;
  unchanged: number;
  skipped: number;
  skippedPaths: string[];
}

export interface WorkspaceConfigSyncPlan {
  writes: ConfigWrite[];
  stats: WorkspaceConfigSyncStats;
}

export interface WorkspaceConfigSyncOptions {
  /** Target project mode (sandbox / local-machine / ssh). */
  mode: SessionMode;
  /** Admins may sync project-level stdio MCP; normal users may not. */
  allowStdioMcp: boolean;
}

function safeEntryName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

function isSyncDenied(rel: string): boolean {
  if (isDeniedConfigPath(rel)) return true;
  const lower = rel.toLowerCase();
  // Retired standalone sandbox extension: project homes already remove this
  // link at creation; syncing it back would double-register container tools.
  if (lower === ".pi/extensions/pi-sandbox-extension" || lower.startsWith(".pi/extensions/pi-sandbox-extension/")) {
    return true;
  }
  const base = rel.split("/").pop()?.toLowerCase() ?? "";
  return SYNC_EXTRA_DENIED_BASENAMES.has(base);
}

function isMissingError(error: unknown): boolean {
  if (error instanceof WorkspaceOperationError) return error.code === "NOT_FOUND";
  const code = (error as { code?: unknown })?.code;
  if (code === 2 || code === "ENOENT" || code === "NOT_FOUND") return true;
  if ((error as { status?: unknown })?.status === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /no such file|not found|enoent/i.test(message);
}

/**
 * Walk the workspace's .pi/ through a WorkspaceOperations provider.
 * Provider errors (offline relay, missing container, …) propagate: a silent
 * empty sync would look like success while changing nothing.
 */
export async function collectWorkspaceConfig(ws: WorkspaceOperations): Promise<WorkspaceConfigCollectResult> {
  let rootStat: { isDirectory: boolean };
  try {
    rootStat = await ws.stat(".pi");
  } catch (error) {
    if (isMissingError(error)) {
      throw new Error("工作区中没有 .pi 目录（请先在远程工作区创建 Agent 配置）");
    }
    throw error;
  }
  if (!rootStat.isDirectory) throw new Error("工作区的 .pi 不是目录");

  const files: WorkspaceConfigFile[] = [];
  const skipped: string[] = [];
  const visitedDirs = new Set<string>();
  let bytes = 0;

  const walk = async (relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      skipped.push(`${relDir}/ (depth)`);
      return;
    }
    let canonical: string;
    try {
      canonical = await ws.canonicalize(relDir);
    } catch {
      skipped.push(`${relDir}/ (out of scope)`);
      return;
    }
    if (visitedDirs.has(canonical)) return; // symlink cycle / duplicate
    visitedDirs.add(canonical);

    const entries = await ws.readdir(relDir);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!safeEntryName(entry.name)) {
        skipped.push(`${relDir}/${entry.name} (invalid name)`);
        continue;
      }
      const rel = `${relDir}/${entry.name}`;
      if (isSyncDenied(rel)) {
        skipped.push(rel);
        continue;
      }
      let isDirectory = entry.isDirectory;
      if (!isDirectory) {
        // A symlink-to-directory is reported as a file by some transports.
        const info = await ws.stat(rel).catch(() => null);
        if (!info) {
          skipped.push(`${rel} (missing)`);
          continue;
        }
        isDirectory = info.isDirectory;
        if (!isDirectory && info.size > WORKSPACE_CONFIG_MAX_FILE_BYTES) {
          skipped.push(`${rel} (>${WORKSPACE_CONFIG_MAX_FILE_BYTES} bytes)`);
          continue;
        }
      }
      if (isDirectory) {
        await walk(rel, depth + 1);
        continue;
      }
      const content = await ws.readFile(rel);
      if (content.length > WORKSPACE_CONFIG_MAX_FILE_BYTES) {
        skipped.push(`${rel} (>${WORKSPACE_CONFIG_MAX_FILE_BYTES} bytes)`);
        continue;
      }
      bytes += content.length;
      if (bytes > WORKSPACE_CONFIG_MAX_BYTES) {
        throw new Error(`同步内容过大（>${Math.round(WORKSPACE_CONFIG_MAX_BYTES / 1024 / 1024)}MB）`);
      }
      if (files.length >= WORKSPACE_CONFIG_MAX_FILES) {
        throw new Error(`工作区配置文件过多（>${WORKSPACE_CONFIG_MAX_FILES}）`);
      }
      files.push({ rel, content });
    }
  };

  await walk(".pi", 0);
  if (files.length === 0) {
    throw new Error("工作区 .pi/ 中没有可同步的配置文件（凭证与运行态文件会被跳过）");
  }
  return { files, skipped, bytes };
}

interface McpServerLike {
  name: string;
  entry: ServerEntry;
  disabled: boolean;
}

function mcpServersFromText(text: string): McpServerLike[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return []; // schema validation reports the syntax error separately
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  const out: McpServerLike[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as ServerEntry;
    out.push({ name, entry, disabled: entry.disabled === true });
  }
  return out;
}

/** Reject enabled MCP servers the current project mode would exclude anyway. */
export function validateMcpForMode(files: WorkspaceConfigFile[], mode: SessionMode): void {
  const problems: string[] = [];
  for (const file of files) {
    if (!/(^|\/)mcp\.json$/i.test(file.rel)) continue;
    for (const server of mcpServersFromText(file.content.toString("utf8"))) {
      if (server.disabled) continue;
      const transport = detectTransport(server.entry);
      const policy = mcpServerModePolicy(server.entry, transport, mode);
      if (policy.excluded) {
        problems.push(`${file.rel}: MCP 服务器「${server.name}」在 ${mode} 模式不可用 —— ${policy.reason}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`同步中止：工具模式检查未通过（未写入任何文件）—— ${problems.join("；")}`);
  }
}

async function readExisting(home: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(join(home, rel));
  } catch {
    return null;
  }
}

/**
 * Validate all collected files and compare with the project home.
 * Nothing is written here; the returned writes contain only changed files.
 */
export async function planWorkspaceConfigSync(
  home: string,
  collected: WorkspaceConfigCollectResult,
  options: WorkspaceConfigSyncOptions,
): Promise<WorkspaceConfigSyncPlan> {
  // Validate every candidate, not only the changed ones: an unchanged file is
  // still part of the config that will run after a later edit.
  validateConfigWrites(
    collected.files.map((f) => ({ rel: f.rel, content: f.content })),
    { allowStdioMcp: options.allowStdioMcp, action: "同步" },
  );
  validateMcpForMode(collected.files, options.mode);

  const writes: ConfigWrite[] = [];
  let added = 0;
  let overwritten = 0;
  let unchanged = 0;
  for (const file of collected.files) {
    assertAllowedConfigPath(file.rel);
    const existing = await readExisting(home, file.rel);
    if (existing?.equals(file.content)) {
      unchanged += 1;
      continue;
    }
    if (existing) overwritten += 1;
    else added += 1;
    writes.push({ rel: file.rel, content: file.content, existed: Boolean(existing) });
  }
  return {
    writes,
    stats: {
      files: collected.files.length,
      bytes: collected.bytes,
      added,
      overwritten,
      unchanged,
      skipped: collected.skipped.length,
      skippedPaths: collected.skipped,
    },
  };
}

/** Write a planned sync (unchanged files were already filtered out). */
export async function applyWorkspaceConfigSync(home: string, plan: WorkspaceConfigSyncPlan): Promise<void> {
  for (const write of plan.writes) {
    const target = join(home, write.rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, write.content);
  }
}
