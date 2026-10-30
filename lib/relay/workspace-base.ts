/**
 * Local-agent workspace mapping.
 *
 * A local-machine project binds `project.workdir` — an absolute directory on
 * the USER'S machine. The relay agent historically had one global workspace
 * root, so every fs/exec/pty call was rooted there and project workdirs were
 * ignored (the "project runs in the agent's startup directory" bug).
 *
 * Two wire strategies keep old and new agents working:
 *   · base   — agent >= 0.2.0 ("workspace-base" feature): pass the absolute
 *              workdir as `base` on each RPC; the agent resolves relative
 *              paths against it and fences ".." inside it.
 *   · prefix — older agents: only directories INSIDE the agent's shared root
 *              are reachable. Convert the workdir to a root-relative prefix
 *              and prepend it to workspace paths.
 *   · error  — workdir outside the shared root on an old agent: surfaced to
 *              the caller/user instead of silently running somewhere else.
 *
 * Paths may arrive as absolute paths under the workspace (the session prompt
 * names workspaceDir) or workspace-relative paths (tool docs). `toRelayPath`
 * normalizes both forms for the selected strategy.
 */
import type { AgentInfo } from "./protocol";

export const RELAY_WORKSPACE_BASE_FEATURE = "workspace-base";
/** fs.read accepts encoding:"base64" (binary-safe previews). Agent >= 0.2.x. */
export const RELAY_BINARY_READ_FEATURE = "binary-read";

export interface RelayWorkspaceScope {
  /** Absolute base directory for agents with per-request roots. */
  base?: string;
  /** Root-relative prefix for legacy agents ("" = the agent root itself). */
  prefix?: string;
  /** Why this workspace cannot be reached on the connected agent. */
  error?: string;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function looksWindows(path: string): boolean {
  return /^[A-Za-z]:(\/|$)/.test(normalize(path)) || normalize(path).startsWith("//");
}

function samePath(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return looksWindows(na) || looksWindows(nb) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Is `child` equal to or nested under `parent`? Case-insensitive on Windows. */
export function isPathWithin(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  if (samePath(c, p)) return true;
  if (c.length <= p.length) return false;
  if (c[p.length] !== "/") return false;
  return samePath(c.slice(0, p.length), p);
}

/**
 * Lexical relative path from `root` to `dir` (slash-separated). Returns ""
 * when equal and null when `dir` escapes `root` (or lives on another drive).
 */
export function relativeToRoot(root: string, dir: string): string | null {
  const r = normalize(root);
  const d = normalize(dir);
  if (samePath(r, d)) return "";
  if (!isPathWithin(d, r)) return null;
  // Use the normalized (slash) strings so Windows/POSIX separators agree.
  return d.slice(r.length).replace(/^\/+/, "");
}

export function agentSupportsWorkspaceBase(info: AgentInfo | null | undefined): boolean {
  return Boolean(info?.features?.includes(RELAY_WORKSPACE_BASE_FEATURE));
}

export function agentSupportsBinaryRead(info: AgentInfo | null | undefined): boolean {
  return Boolean(info?.features?.includes(RELAY_BINARY_READ_FEATURE));
}

/**
 * Pick the wire strategy for a project workspace on the connected agent.
 * `info` may be null (agent offline): returns an error the caller can show.
 */
export function resolveRelayWorkspaceScope(
  workspaceDir: string | undefined | null,
  info: AgentInfo | null | undefined,
): RelayWorkspaceScope {
  const wd = workspaceDir?.trim();
  if (!wd) return {};
  if (!info) {
    return { error: "本机 Agent 未连接，无法定位项目工作区" };
  }
  if (agentSupportsWorkspaceBase(info)) return { base: wd };

  const root = info.workspaceRoot?.trim();
  if (!root) {
    return { error: "本机 Agent 未上报共享根目录，无法定位项目工作区" };
  }
  const rel = relativeToRoot(root, wd);
  if (rel !== null) return rel ? { prefix: rel } : {};
  return {
    error:
      `项目工作区 ${wd} 不在本机 Agent 的共享根 ${root} 内。` +
      "请把 Agent 升级到 0.2.0+（支持任意工作区目录），或在「本机」面板将共享根改为该目录。",
  };
}

function absolutenessOf(path: string): "windows" | "posix" | "relative" {
  if (looksWindows(path)) return "windows";
  return path.startsWith("/") || path.startsWith("\\") ? "posix" : "relative";
}

/**
 * Map a tool/UI path to the path sent over the relay.
 *
 * - workspace-relative "src/a.ts" stays relative (prefixed for legacy agents)
 * - an absolute path under `workspaceDir` becomes workspace-relative
 * - any other absolute path passes through VERBATIM in both modes: the
 *   agent's resolver treats absolute paths absolutely (fenced at its root).
 *   The historical "strip leading /" fallback made /a/b/c become root+/a/b/c
 *   — the doubled-path bug when clicking turn-written files in the file panel.
 */
export function toRelayPath(path: string, scope: RelayWorkspaceScope, workspaceDir?: string | null): string {
  const raw = path.trim();
  if (!raw) return scope.prefix || ".";
  const kind = absolutenessOf(raw);
  if (kind !== "relative") {
    const wd = workspaceDir?.trim();
    if (wd && isPathWithin(raw, wd)) {
      const rel = relativeToRoot(wd, raw) || ".";
      if (!scope.prefix) return rel;
      return rel === "." ? scope.prefix : `${scope.prefix}/${rel}`;
    }
    return raw;
  }
  if (!scope.prefix) return raw;
  return raw === "." ? scope.prefix : `${scope.prefix}/${raw}`;
}

/**
 * Inverse of `toRelayPath` for display: turn an absolute path under the
 * workspace (or a workspace-relative path) into a workspace-relative path.
 * Returns null when the path is outside the workspace.
 */
export function toWorkspaceRelative(path: string, workspaceDir?: string | null): string | null {
  const raw = path.trim();
  if (!raw) return "";
  const kind = absolutenessOf(raw);
  if (kind === "relative") return raw.replace(/^\.\/+/, "");
  const wd = workspaceDir?.trim();
  if (!wd || !isPathWithin(raw, wd)) return null;
  return relativeToRoot(wd, raw) ?? null;
}
