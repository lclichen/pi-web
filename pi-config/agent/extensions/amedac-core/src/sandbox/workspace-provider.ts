import type { PlatformClient } from "./client.ts";
import { platformFind, platformGrep } from "./operations.ts";
import { toContainerPath } from "./paths.ts";
import {
  WorkspaceOperationError,
  type WorkspaceDirEntry,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceOperations,
  type WorkspaceStat,
} from "./workspace-api.ts";

export interface SandboxWorkspaceOptions {
  getClient: () => PlatformClient | undefined;
  getContainerId: () => Promise<number | null | undefined>;
  /** Server-side session cwd, used to un-mangle win32 tool paths. */
  sessionCwd?: string;
}

const ROOT = "/workspace";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Sandbox-mode workspace backed by the platform REST tools. */
export function createSandboxWorkspaceOperations(options: SandboxWorkspaceOptions): WorkspaceOperations {
  const current = async (): Promise<{ client: PlatformClient; containerId: number }> => {
    const client = options.getClient();
    if (!client) throw new WorkspaceOperationError("UNSUPPORTED", "Sandbox platform client is not connected");
    const containerId = await options.getContainerId();
    if (containerId === null || containerId === undefined) {
      throw new WorkspaceOperationError("UNSUPPORTED", "No sandbox container is connected");
    }
    return { client, containerId };
  };
  const canonicalize = async (path: string): Promise<string> => {
    const mapped = toContainerPath(path, options.sessionCwd);
    if (mapped !== ROOT && !mapped.startsWith(`${ROOT}/`)) {
      throw new WorkspaceOperationError("OUT_OF_SCOPE", `Path escapes the workspace: ${path}`);
    }
    return mapped;
  };

  return {
    version: 1,
    root: ROOT,
    capabilities: { read: true, write: true, exec: true, grep: true, find: true },

    canonicalize,
    async readFile(path) {
      const { client, containerId } = await current();
      return client.toolRead(containerId, await canonicalize(path));
    },
    async writeFile(path, content) {
      const { client, containerId } = await current();
      const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      await client.toolWrite(containerId, await canonicalize(path), buffer);
    },
    async mkdir(path) {
      const { client, containerId } = await current();
      const target = await canonicalize(path);
      await client.toolBash(containerId, `mkdir -p ${shellQuote(target)}`);
    },
    async stat(path): Promise<WorkspaceStat> {
      const { client, containerId } = await current();
      const info = await client.toolStat(containerId, await canonicalize(path));
      return {
        isFile: info.isFile,
        isDirectory: info.isDirectory,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    },
    async readdir(path): Promise<WorkspaceDirEntry[]> {
      const { client, containerId } = await current();
      const entries = await client.toolLs(containerId, await canonicalize(path));
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        size: entry.size,
      }));
    },
    async exec(command, execOptions: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
      const { client, containerId } = await current();
      const cwd = await canonicalize(execOptions.cwd ?? ".");
      let streamed = "";
      const onData = (chunk: Buffer) => {
        streamed += chunk.toString("utf8");
        execOptions.onData?.(chunk);
      };
      if (execOptions.signal?.aborted) {
        throw new WorkspaceOperationError("CANCELLED", "Command aborted");
      }
      try {
        const result = await client.toolBashStream(containerId, command, {
          cwd,
          ...(execOptions.timeout !== undefined ? { timeout: execOptions.timeout } : {}),
          ...(execOptions.signal ? { signal: execOptions.signal } : {}),
          onData,
        });
        return {
          exitCode: result.timedOut ? null : result.exitCode,
          stdout: streamed,
          stderr: "",
        };
      } catch (error) {
        // Platform predating the SSE endpoint: fall back to request/response.
        const status = (error as { status?: number }).status;
        if (status !== 404 && status !== 405) throw error;
        const result = await client.toolBash(containerId, command, {
          cwd,
          ...(execOptions.timeout !== undefined ? { timeout: execOptions.timeout } : {}),
        });
        if (result.stdout) execOptions.onData?.(Buffer.from(result.stdout));
        if (result.stderr) execOptions.onData?.(Buffer.from(result.stderr));
        return {
          exitCode: result.timedOut ? null : result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }
    },
    async grep(params) {
      const { client, containerId } = await current();
      return platformGrep(
        client,
        containerId,
        {
          pattern: params.pattern,
          ...(params.path ? { path: await canonicalize(params.path) } : {}),
          ...(params.glob ? { glob: params.glob } : {}),
          ...(params.literal !== undefined ? { literal: params.literal } : {}),
          ...(params.ignoreCase !== undefined ? { ignoreCase: params.ignoreCase } : {}),
          ...(params.context !== undefined ? { context: params.context } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        options.sessionCwd,
      );
    },
    async find(params) {
      const { client, containerId } = await current();
      return platformFind(
        client,
        containerId,
        {
          pattern: params.pattern,
          ...(params.path ? { path: await canonicalize(params.path) } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        options.sessionCwd,
      );
    },
  };
}
