/**
 * Workspace operations provider contract (draft v1).
 *
 * Remote modes (sandbox / local-machine / SSH) and the host mode all operate
 * on a workspace, but the pi SDK's built-in tools can only route through the
 * `*Operations` objects passed to `create*Tool(cwd, { operations })`. This
 * module defines the stable, mode-neutral provider those adapters can be
 * built from. The host/sandbox/relay/ssh adapters implement it; the event
 * bridge in ./extensions/workspace-service.ts exposes it to extensions.
 *
 * Path rules:
 *   - `root` is informational (for display/logging); never use it to access
 *     the host filesystem directly.
 *   - Every method accepts either a workspace-relative POSIX path or an
 *     absolute path inside the provider's namespace. `canonicalize` resolves
 *     both and MUST reject paths that escape the workspace with
 *     `WorkspaceOperationError("OUT_OF_SCOPE")`.
 */

import type {
  BashOperations,
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";

export const WORKSPACE_OPERATIONS_VERSION = 1 as const;

/** Event bus channel exposed by the host for workspace requests. */
export const WORKSPACE_REQUEST_EVENT = "pi-web:workspace:request";
export function workspaceReplyEvent(requestId: string): string {
  return `pi-web:workspace:reply:${requestId}`;
}

export interface WorkspaceBridgeRequest {
  v: typeof WORKSPACE_OPERATIONS_VERSION;
  id: string;
  method: string;
  params?: unknown;
}

export type WorkspaceBridgeResponse =
  | { v: typeof WORKSPACE_OPERATIONS_VERSION; id: string; ok: true; result: unknown }
  | {
      v: typeof WORKSPACE_OPERATIONS_VERSION;
      id: string;
      ok: false;
      error: { code: WorkspaceErrorCode; message: string };
    };

export type WorkspaceCapability = "read" | "write" | "exec";

export type WorkspaceErrorCode =
  "OUT_OF_SCOPE" | "NOT_FOUND" | "READ_ONLY" | "UNSUPPORTED" | "CANCELLED" | "EXEC_FAILED";

export class WorkspaceOperationError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly cause?: unknown;

  constructor(code: WorkspaceErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "WorkspaceOperationError";
    this.code = code;
    this.cause = cause;
  }
}

export interface WorkspaceStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface WorkspaceDirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

export interface WorkspaceExecOptions {
  /** Working directory, same path rules as the other methods. Default: root. */
  cwd?: string;
  /** Timeout in seconds, matching the SDK bash tool. */
  timeout?: number;
  signal?: AbortSignal;
  /** Extra environment for remote executors; hosts may narrow this allowlist. */
  env?: Record<string, string>;
  /** Stream stdout+stderr chunks as they arrive. */
  onData?: (chunk: Buffer) => void;
}

export interface WorkspaceExecResult {
  exitCode: number | null;
  /** Full captured output (also delivered incrementally through onData). */
  stdout: string;
  stderr: string;
}

export interface WorkspaceGrepOptions {
  pattern: string;
  path?: string;
  glob?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
  limit?: number;
}

export interface WorkspaceFindOptions {
  pattern: string;
  path?: string;
  limit?: number;
}

export interface WorkspaceCapabilities {
  read: boolean;
  write: boolean;
  exec: boolean;
  grep?: boolean;
  find?: boolean;
}

export interface WorkspaceOperations {
  readonly version: typeof WORKSPACE_OPERATIONS_VERSION;
  readonly root: string;
  readonly capabilities: WorkspaceCapabilities;

  canonicalize(path: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Remove a file (idempotent). Optional: older providers may not implement it. */
  remove?(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<WorkspaceStat>;
  readdir(path: string): Promise<WorkspaceDirEntry[]>;
  exec(command: string, options?: WorkspaceExecOptions): Promise<WorkspaceExecResult>;

  /** Optional search capabilities; hosts without them set capabilities=false. */
  grep?(options: WorkspaceGrepOptions): Promise<string>;
  find?(options: WorkspaceFindOptions): Promise<string[]>;
}

function assertCapability(ws: WorkspaceOperations, capability: WorkspaceCapability): void {
  if (!ws.capabilities[capability]) {
    throw new WorkspaceOperationError("READ_ONLY", `Workspace does not support ${capability}`);
  }
}

/** SDK ReadOperations backed by a workspace provider. */
export function toReadOperations(ws: WorkspaceOperations): ReadOperations {
  assertCapability(ws, "read");
  return {
    readFile: (absolutePath) => ws.readFile(absolutePath),
    access: async (absolutePath) => {
      await ws.stat(absolutePath);
    },
  };
}

/** SDK WriteOperations backed by a workspace provider. */
export function toWriteOperations(ws: WorkspaceOperations): WriteOperations {
  assertCapability(ws, "write");
  return {
    writeFile: (absolutePath, content) => ws.writeFile(absolutePath, content),
    mkdir: (dir) => ws.mkdir(dir),
  };
}

/** SDK EditOperations backed by a workspace provider. */
export function toEditOperations(ws: WorkspaceOperations): EditOperations {
  assertCapability(ws, "write");
  return {
    readFile: (absolutePath) => ws.readFile(absolutePath),
    writeFile: (absolutePath, content) => ws.writeFile(absolutePath, content),
    access: async (absolutePath) => {
      await ws.stat(absolutePath);
    },
  };
}

/** SDK LsOperations backed by a workspace provider. */
export function toLsOperations(ws: WorkspaceOperations): LsOperations {
  assertCapability(ws, "read");
  return {
    exists: async (absolutePath) => {
      try {
        await ws.stat(absolutePath);
        return true;
      } catch (error) {
        if (error instanceof WorkspaceOperationError && error.code === "NOT_FOUND") return false;
        throw error;
      }
    },
    stat: async (absolutePath) => {
      const stat = await ws.stat(absolutePath);
      return { isDirectory: () => stat.isDirectory };
    },
    readdir: async (absolutePath) => (await ws.readdir(absolutePath)).map((entry) => entry.name),
  };
}

/** SDK BashOperations backed by a workspace provider. */
export function toBashOperations(ws: WorkspaceOperations): BashOperations {
  assertCapability(ws, "exec");
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) {
        throw new WorkspaceOperationError("CANCELLED", "Command aborted");
      }
      const result = await ws.exec(command, {
        cwd,
        ...(timeout !== undefined ? { timeout } : {}),
        ...(signal ? { signal } : {}),
        ...(env
          ? {
              env: Object.fromEntries(
                Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
              ),
            }
          : {}),
        onData,
      });
      return { exitCode: result.exitCode };
    },
  };
}
