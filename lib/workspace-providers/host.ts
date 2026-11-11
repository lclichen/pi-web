import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  WorkspaceOperationError,
  type WorkspaceDirEntry,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceOperations,
  type WorkspaceStat,
} from "../workspace-operations";

function within(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Minimal shell environment; never pass the platform's secrets to workspace commands. */
const HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "SYSTEMDRIVE",
  "ComSpec",
  "COMSPEC",
  "windir",
  "WINDIR",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
] as const;

function hostEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...(extra ?? {}) } as NodeJS.ProcessEnv;
}

/** Resolve the real path of `target`, walking up through missing ancestors. */
async function realTarget(target: string): Promise<string> {
  let current = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

/** Host-mode workspace: the session cwd on the pi-web server. */
export function createHostWorkspaceOperations(root: string): WorkspaceOperations {
  const absoluteRoot = resolve(root);
  let realRoot: Promise<string> | undefined;
  const rootReal = () => (realRoot ??= realpath(absoluteRoot).catch(() => absoluteRoot));

  const canonicalize = async (path: string): Promise<string> => {
    const target = resolve(absoluteRoot, path);
    const real = await realTarget(target);
    if (!within(real, await rootReal())) {
      throw new WorkspaceOperationError("OUT_OF_SCOPE", `Path escapes the workspace: ${path}`);
    }
    return real;
  };

  return {
    version: 1,
    root: absoluteRoot,
    capabilities: { read: true, write: true, exec: true, grep: false, find: false },

    canonicalize,
    async readFile(path) {
      return readFile(await canonicalize(path));
    },
    async writeFile(path, content) {
      await writeFile(await canonicalize(path), content);
    },
    async mkdir(path) {
      await mkdir(await canonicalize(path), { recursive: true });
    },
    async stat(path): Promise<WorkspaceStat> {
      const info = await stat(await canonicalize(path));
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    },
    async readdir(path): Promise<WorkspaceDirEntry[]> {
      const dir = await canonicalize(path);
      const entries = await readdir(dir, { withFileTypes: true });
      return Promise.all(
        entries.map(async (entry) => {
          const info = await stat(join(dir, entry.name)).catch(() => null);
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: info?.size ?? 0,
          };
        }),
      );
    },
    async exec(command: string, options: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
      const cwd = await canonicalize(options.cwd ?? ".");
      return new Promise((resolvePromise) => {
        const child = spawn(command, [], {
          cwd,
          shell: true,
          windowsHide: true,
          env: hostEnv(options.env),
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const finish = (exitCode: number | null) => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolvePromise({ exitCode: timedOut || options.signal?.aborted ? null : exitCode, stdout, stderr });
        };
        const onAbort = () => child.kill("SIGKILL");
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timer =
          options.timeout && options.timeout > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
              }, options.timeout * 1000)
            : undefined;
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          options.onData?.(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
          options.onData?.(chunk);
        });
        child.on("error", (error) => {
          stderr += error.message;
          finish(null);
        });
        child.on("close", (code) => finish(code));
      });
    },
  };
}
