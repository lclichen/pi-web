/**
 * Server-side directory browsing on a user's paired machine (local-machine
 * mode). Backs the wizard's path picker and project-workdir validation.
 *
 * The requested directory becomes the request's workspace (`base` on agent
 * >= 0.2.0; a root-relative prefix on older agents), so the picker can climb
 * anywhere the agent can reach instead of being stuck under its shared root.
 */
import { AgentUnavailableError, relayRpc } from "./forward";
import { requireCompatibleAgent } from "./agent-gate";
import type { FsEntry, FsStatResult } from "./protocol";
import { resolveRelayWorkspaceScope, toRelayPath } from "./workspace-base";

export interface AgentDirectoryEntry {
  name: string;
  path: string;
}

export interface AgentDirectoryListing {
  path: string;
  parentPath: string | null;
  directories: AgentDirectoryEntry[];
}

/** Trim trailing separators and use forward slashes; keep roots absolute
 *  ("/", "C:/"). The agent accepts "/" on Windows, and one style keeps the
 *  picker's path arithmetic unambiguous. */
export function normalizeDisplayPath(path: string): string {
  const raw = path.trim();
  const trimmed = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`;
  if (trimmed === "") return /^[\\/]/.test(raw) ? "/" : "";
  return trimmed;
}

/** Parent directory in the same path style, or null at a filesystem root. */
export function parentPathOf(path: string): string | null {
  const trimmed = normalizeDisplayPath(path);
  if (!trimmed) return null;
  if (trimmed === "/") return null;
  if (/^[A-Za-z]:\/$/.test(trimmed)) return null; // "C:/"
  if (/^[A-Za-z]:$/.test(trimmed)) return null; // "C:" (defensive)
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return null;
  if (idx === 0) return "/";
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

/** Join a directory with one direct child name (no separators in `name`). */
export function joinDisplayPath(parent: string, name: string): string {
  let base = normalizeDisplayPath(parent);
  if (!base) return name;
  if (base === "/") return `/${name}`;
  base = base.replace(/\/+$/, "");
  return `${base}/${name}`;
}

function isAbsoluteDisplayPath(path: string): boolean {
  return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

/** Resolve the requested directory: absolute as-is, relative against the
 *  agent's shared root, empty to the root itself. */
function resolveRequestedDirectory(requested: string | undefined, workspaceRoot: string): string {
  const raw = requested?.trim() ?? "";
  const root = normalizeDisplayPath(workspaceRoot || "/");
  if (!raw) return root;
  if (isAbsoluteDisplayPath(raw)) return normalizeDisplayPath(raw);
  return joinDisplayPath(root, raw);
}

function agentFor(userId: number, machineId?: string) {
  const gate = requireCompatibleAgent(userId, machineId);
  if (!gate.ok) {
    if (gate.status === 503) throw new AgentUnavailableError(machineId ?? "");
    throw new Error(gate.error);
  }
  return gate.info;
}

/**
 * List the sub-directories of `requested` (absolute path on the agent's
 * machine). An empty path starts at the agent's shared root.
 */
export async function browseAgentDirectory(
  userId: number,
  machineId: string | undefined,
  requested?: string,
): Promise<AgentDirectoryListing> {
  const info = agentFor(userId, machineId);
  const start = resolveRequestedDirectory(requested, info.workspaceRoot || "/");
  if (!start) throw new Error("无法确定要浏览的目录");
  const scope = resolveRelayWorkspaceScope(start, info);
  if (scope.error) throw new Error(scope.error);

  // Listing "." against `start` as the workspace: the agent reports the
  // direct children, and we rebuild absolute paths client-side.
  const entries = (await relayRpc(
    "fs.list",
    { path: toRelayPath(".", scope, start), ...(scope.base ? { base: scope.base } : {}) },
    { userId, machineId },
  )) as FsEntry[];

  const directories = (entries ?? [])
    .filter((entry) => entry.isDir)
    .map((entry) => ({ name: entry.name, path: joinDisplayPath(start, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { path: start, parentPath: parentPathOf(start), directories };
}

const INVALID_DIR_NAME = /[\\/:*?"<>|]/;

/** Create one direct child directory; returns its absolute path. */
export async function createAgentDirectory(
  userId: number,
  machineId: string | undefined,
  parent: string,
  name: string,
): Promise<string> {
  const info = agentFor(userId, machineId);
  const dirName = name.trim();
  if (!dirName) throw new Error("文件夹名不能为空");
  if (dirName === "." || dirName === ".." || INVALID_DIR_NAME.test(dirName)) {
    throw new Error("文件夹名包含非法字符");
  }
  const parentPath = resolveRequestedDirectory(parent, info.workspaceRoot || "/");
  if (!parentPath) throw new Error("缺少父目录");
  const scope = resolveRelayWorkspaceScope(parentPath, info);
  if (scope.error) throw new Error(scope.error);

  await relayRpc(
    "fs.mkdir",
    {
      path: toRelayPath(dirName, scope, parentPath),
      ...(scope.base ? { base: scope.base } : {}),
    },
    { userId, machineId },
  );
  return joinDisplayPath(parentPath, dirName);
}

/**
 * Validate a project workdir: it must exist, be a directory, and be reachable
 * by the agent. Returns the normalized absolute path.
 */
export async function validateAgentDirectory(
  userId: number,
  machineId: string | undefined,
  workdir: string,
): Promise<string> {
  const info = agentFor(userId, machineId);
  const dir = resolveRequestedDirectory(workdir, info.workspaceRoot || "/");
  if (!dir) throw new Error("工作目录不能为空");
  // Stat the leaf through its parent so the agent never needs to enumerate a
  // large project directory just to create the project record.
  const parent = parentPathOf(dir) ?? dir;
  const scope = resolveRelayWorkspaceScope(parent, info);
  if (scope.error) throw new Error(scope.error);
  const leaf = dir === parent ? "." : dir.slice(parent.replace(/\/+$/, "").length + 1);
  const stat = (await relayRpc(
    "fs.stat",
    { path: toRelayPath(leaf, scope, parent), ...(scope.base ? { base: scope.base } : {}) },
    { userId, machineId },
  )) as FsStatResult;
  if (!stat?.exists) throw new Error(`目录不存在：${dir}`);
  if (!stat.isDir) throw new Error(`不是目录：${dir}`);
  return dir;
}
