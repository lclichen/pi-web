import { getAgentForUser } from "../relay/registry";
import { relayRpc } from "../relay/forward";
import { clientCompatibility } from "../client-compat";
import {
  agentSupportsBinaryRead,
  agentSupportsBinaryWrite,
  isPathWithin,
  resolveRelayWorkspaceScope,
  toRelayPath,
  type RelayWorkspaceScope,
} from "../relay/workspace-base";
import type { ExecResult, FsEntry, FsReadResult, FsStatResult, GrepMatch } from "../relay/protocol";
import {
  WorkspaceOperationError,
  type WorkspaceDirEntry,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceOperations,
  type WorkspaceStat,
} from "../workspace-operations";

export interface RelayWorkspaceOptions {
  userId: number;
  /** Project workspace on the user's machine. */
  workspaceDir?: string;
  machineId?: string;
}

/** Local-machine workspace backed by the paired Go relay agent. */
export function createRelayWorkspaceOperations(options: RelayWorkspaceOptions): WorkspaceOperations {
  const { userId, workspaceDir, machineId } = options;
  const currentScope = (): RelayWorkspaceScope => {
    const info = getAgentForUser(userId, machineId)?.info;
    if (info) {
      const compat = clientCompatibility(info.agentVersion);
      if (!compat.compatible) return { error: compat.message };
    }
    return resolveRelayWorkspaceScope(workspaceDir, info);
  };
  const scopeOrThrow = (): RelayWorkspaceScope => {
    const scope = currentScope();
    if (scope.error) throw new WorkspaceOperationError("UNSUPPORTED", scope.error);
    return scope;
  };
  const call = <T>(
    method: Parameters<typeof relayRpc>[0],
    params: Record<string, unknown> | undefined,
    scope: RelayWorkspaceScope,
  ) =>
    relayRpc(
      method,
      { ...(params ?? {}), ...(scope.base ? { base: scope.base } : {}) },
      { userId, ...(machineId ? { machineId } : {}) },
    ) as Promise<T>;

  const wirePath = (path: string, scope: RelayWorkspaceScope): string => {
    const raw = path.trim();
    if (raw && !raw.startsWith(".") && !raw.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(raw)) {
      const segments = raw.replace(/\\/g, "/").split("/");
      if (segments.includes(".."))
        throw new WorkspaceOperationError("OUT_OF_SCOPE", `Path escapes the workspace: ${path}`);
    }
    if (workspaceDir && (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) && !isPathWithin(raw, workspaceDir)) {
      throw new WorkspaceOperationError("OUT_OF_SCOPE", `Path escapes the workspace: ${path}`);
    }
    return toRelayPath(path, scope, workspaceDir);
  };

  return {
    version: 1,
    root: workspaceDir ?? "",
    capabilities: { read: true, write: true, exec: true, grep: true, find: true },

    async canonicalize(path) {
      return wirePath(path, scopeOrThrow());
    },
    async readFile(path) {
      const scope = scopeOrThrow();
      const info = getAgentForUser(userId, machineId)?.info;
      const result = await call<FsReadResult>(
        "fs.read",
        { path: wirePath(path, scope), ...(agentSupportsBinaryRead(info) ? { encoding: "base64" } : {}) },
        scope,
      );
      return result.contentBase64
        ? Buffer.from(result.contentBase64, "base64")
        : Buffer.from(result.content ?? "", "utf8");
    },
    async writeFile(path, content) {
      const scope = scopeOrThrow();
      if (typeof content === "string") {
        await call("fs.write", { path: wirePath(path, scope), content }, scope);
        return;
      }
      const info = getAgentForUser(userId, machineId)?.info;
      if (!agentSupportsBinaryWrite(info)) {
        throw new WorkspaceOperationError("UNSUPPORTED", "本机 Agent 版本过旧，无法写入二进制文件（需要 ≥ 0.6.0）");
      }
      await call(
        "fs.write",
        { path: wirePath(path, scope), contentBase64: Buffer.from(content).toString("base64") },
        scope,
      );
    },
    async remove(path) {
      const scope = scopeOrThrow();
      await call("fs.delete", { path: wirePath(path, scope) }, scope);
    },
    async mkdir(path) {
      const scope = scopeOrThrow();
      await call("fs.mkdir", { path: wirePath(path, scope) }, scope);
    },
    async stat(path): Promise<WorkspaceStat> {
      const scope = scopeOrThrow();
      const result = await call<FsStatResult>("fs.stat", { path: wirePath(path, scope) }, scope);
      if (!result.exists) throw new WorkspaceOperationError("NOT_FOUND", path);
      return {
        isFile: !result.isDir,
        isDirectory: result.isDir,
        size: result.size,
        mtimeMs: result.mtime,
      };
    },
    async readdir(path): Promise<WorkspaceDirEntry[]> {
      const scope = scopeOrThrow();
      const entries = await call<FsEntry[]>("fs.list", { path: wirePath(path, scope) }, scope);
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDir, size: entry.size }));
    },
    async exec(command, options: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
      const scope = scopeOrThrow();
      const result = await call<ExecResult>(
        "exec.run",
        {
          argv: ["bash", "-c", command],
          cwd: wirePath(options.cwd ?? ".", scope),
          ...(options.timeout ? { timeout: options.timeout * 1000 } : {}),
        },
        scope,
      );
      if (result.stdout) options.onData?.(Buffer.from(result.stdout, "utf8"));
      if (result.stderr) options.onData?.(Buffer.from(result.stderr, "utf8"));
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    async grep(params) {
      const scope = scopeOrThrow();
      const matches = await call<GrepMatch[]>(
        "search.grep",
        {
          pattern: params.pattern,
          ...(params.path ? { path: wirePath(params.path, scope) } : {}),
          ...(params.glob ? { glob: params.glob } : {}),
        },
        scope,
      );
      return matches.length ? matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n") : "(no matches)";
    },
    async find(params) {
      const scope = scopeOrThrow();
      return call<string[]>(
        "search.fd",
        {
          pattern: params.pattern,
          ...(params.path ? { path: wirePath(params.path, scope) } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        },
        scope,
      );
    },
  };
}
