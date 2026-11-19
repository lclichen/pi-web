import type { Client, SFTPWrapper } from "ssh2";
import { sshExec } from "../ssh";
import {
  WorkspaceOperationError,
  type WorkspaceDirEntry,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceManifest,
  type WorkspaceOperations,
  type WorkspaceStat,
} from "../workspace-operations";

interface SftpEntry {
  filename: string;
  attrs: { isDirectory(): boolean; size: number; mtime: number };
}

function sftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((err, value) => (err ? reject(err) : resolve(value))));
}

/** Run SFTP work on a fresh channel and always close it (server MaxSessions). */
async function withSftp<T>(getClient: () => Promise<Client>, fn: (s: SFTPWrapper) => Promise<T>): Promise<T> {
  const s = await sftp(await getClient());
  try {
    return await fn(s);
  } finally {
    try {
      s.end();
    } catch {
      // channel already closed
    }
  }
}
function sftpRead(s: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => s.readFile(path, (err, data) => (err ? reject(err) : resolve(data))));
}
function sftpWrite(s: SFTPWrapper, path: string, content: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => s.writeFile(path, content, (err) => (err ? reject(err) : resolve())));
}
function sftpUnlink(s: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => s.unlink(path, (err) => (err ? reject(err) : resolve())));
}
function sftpStat(s: SFTPWrapper, path: string): Promise<{ isDirectory(): boolean; size: number; mtime: number }> {
  return new Promise((resolve, reject) => s.stat(path, (err, attrs) => (err ? reject(err) : resolve(attrs))));
}
function sftpReadDir(s: SFTPWrapper, path: string): Promise<SftpEntry[]> {
  return new Promise((resolve, reject) =>
    s.readdir(path, (err, list) => (err ? reject(err) : resolve(list as SftpEntry[]))),
  );
}

/** Recursive mkdir; an existing directory is success, other errors stay errors.
 *  Shared with the SSH agent tools (lib/extensions/ssh-tools.ts) — ssh2's mkdir
 *  is single-level, so every parent segment must be walked. */
export function sftpMkdir(s: SFTPWrapper, path: string): Promise<void> {
  // ssh2's mkdir takes SFTP attrs, not fs-style options, so `recursive` was
  // silently ignored and nested `.pi/skills/<name>` writes failed with
  // "No such file". Walk the segments and tolerate existing directories.
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter((part) => part && part !== ".");
  return (async () => {
    let current = absolute ? "" : ".";
    for (const part of parts) {
      current = `${current}/${part}`;
      await new Promise<void>((resolve, reject) => {
        s.mkdir(current, (err) => {
          if (!err) return resolve();
          s.stat(current, (statErr, attrs) => {
            if (!statErr && attrs.isDirectory()) return resolve();
            reject(err);
          });
        });
      });
    }
  })();
}

function normalizeRemote(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new WorkspaceOperationError("OUT_OF_SCOPE", `Path escapes the workspace: ${path}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

function withinRemote(child: string, root: string): boolean {
  if (root === "/") return true;
  return child === root || child.startsWith(`${root.replace(/\/+$/, "")}/`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SshWorkspaceOptions {
  getClient: () => Promise<Client>;
  /** Remote workspace root; relative paths resolve here. */
  workdir: string;
}

/** SSH-mode workspace backed by SFTP + remote exec. */
export function createSshWorkspaceOperations(options: SshWorkspaceOptions): WorkspaceOperations {
  const root = normalizeRemote(options.workdir || "/");
  const canonicalize = async (path: string): Promise<string> => {
    const raw = path.trim() || ".";
    const target = raw.startsWith("/") ? raw : `${root === "/" ? "" : root}/${raw}`;
    const normalized = normalizeRemote(target);
    if (!withinRemote(normalized, root)) {
      throw new WorkspaceOperationError("OUT_OF_SCOPE", `Path escapes the workspace: ${path}`);
    }
    return normalized;
  };

  return {
    version: 1,
    root,
    capabilities: { read: true, write: true, exec: true, grep: true, find: true },

    canonicalize,
    async readFile(path) {
      const target = await canonicalize(path);
      return withSftp(options.getClient, (s) => sftpRead(s, target));
    },
    async writeFile(path, content) {
      const target = await canonicalize(path);
      const data = typeof content === "string" ? content : Buffer.from(content);
      await withSftp(options.getClient, async (s) => {
        await sftpMkdir(s, target.replace(/\/[^/]*$/, "") || "/");
        await sftpWrite(s, target, data);
      });
    },
    async remove(path) {
      const target = await canonicalize(path);
      await withSftp(options.getClient, (s) => sftpUnlink(s, target));
    },
    async mkdir(path) {
      const target = await canonicalize(path);
      await withSftp(options.getClient, (s) => sftpMkdir(s, target));
    },
    async stat(path): Promise<WorkspaceStat> {
      const target = await canonicalize(path);
      const attrs = await withSftp(options.getClient, (s) => sftpStat(s, target));
      return {
        isFile: !attrs.isDirectory(),
        isDirectory: attrs.isDirectory(),
        size: attrs.size,
        mtimeMs: attrs.mtime * 1000,
      };
    },
    async manifest(roots): Promise<WorkspaceManifest> {
      const targets: string[] = [];
      for (const root of roots) targets.push(await canonicalize(root));
      if (targets.length === 0) return { entries: [], truncated: false };
      const quoted = targets.map((target) => shellQuote(target)).join(" ");
      // GNU find's -printf is the one-round-trip fast path. On a non-GNU host
      // find fails (empty stdout) and the caller falls back to per-file stats.
      const script = [
        `for p in ${quoted}; do`,
        `  [ -e "$p" ] || continue;`,
        `  find "$p" \\( -type d -name .git -prune \\) -o \\( -type d -path '*/node_modules/.cache' -prune \\) -o -type f -printf '%s\\t%T@\\t%p\\n'`,
        `done`,
      ].join("\n");
      const client = await options.getClient();
      const result = await sshExec(client, script, "/", 30_000);
      if (result.code === 124) return { entries: [], truncated: true };
      if (result.code !== 0 && !result.stdout.trim()) {
        throw new WorkspaceOperationError(
          "UNSUPPORTED",
          `SSH manifest failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.code}`}`,
        );
      }
      const workspaceRoot = normalizeRemote(options.workdir || "/");
      const entries: WorkspaceManifest["entries"] = [];
      // A non-zero find (e.g. permission-denied subtree) means the listing is
      // incomplete: callers must fall back instead of deleting "missing" files.
      let truncated = result.code !== 0;
      for (const line of result.stdout.split("\n")) {
        if (!line) continue;
        const first = line.indexOf("\t");
        const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
        if (first <= 0 || second < 0) continue;
        const size = Number(line.slice(0, first));
        const seconds = Number(line.slice(first + 1, second));
        const path = line.slice(second + 1).replace(/\\/g, "/");
        let rel = path;
        if (workspaceRoot === "/") rel = path.replace(/^\/+/, "");
        else if (path === workspaceRoot) rel = "";
        else if (path.startsWith(`${workspaceRoot}/`)) rel = path.slice(workspaceRoot.length + 1);
        if (!rel || !Number.isFinite(size) || !Number.isFinite(seconds)) continue;
        if (entries.length >= 10_000) {
          truncated = true;
          break;
        }
        // SFTP stat 的 mtimeMs 是 attrs.mtime * 1000（整秒）：manifest 也必须
        // 截断到整秒，否则 reconcile 的 size+mtime 快路径永远不中，SSH 投影
        // 每回合退化为全量读。
        entries.push({ path: rel, size, mtimeMs: Math.floor(seconds) * 1000 });
      }
      return { entries, truncated };
    },
    async readdir(path): Promise<WorkspaceDirEntry[]> {
      const target = await canonicalize(path);
      const entries = await withSftp(options.getClient, (s) => sftpReadDir(s, target));
      return entries.map((entry) => ({
        name: entry.filename,
        isDirectory: entry.attrs.isDirectory(),
        size: entry.attrs.size,
      }));
    },
    async exec(command, execOptions: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
      const cwd = await canonicalize(execOptions.cwd ?? ".");
      const result = await sshExec(await options.getClient(), command, cwd, (execOptions.timeout ?? 120) * 1000);
      if (result.stdout) execOptions.onData?.(Buffer.from(result.stdout, "utf8"));
      if (result.stderr) execOptions.onData?.(Buffer.from(result.stderr, "utf8"));
      return {
        exitCode: result.code ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    async grep(params) {
      const target = await canonicalize(params.path ?? ".");
      const glob = params.glob ? ` --include=${shellQuote(params.glob)}` : "";
      const result = await sshExec(
        await options.getClient(),
        `grep -rnE${glob} -- ${shellQuote(params.pattern)} ${shellQuote(target)} 2>/dev/null | head -${params.limit ?? 100}`,
        root,
      );
      return result.stdout || "(no matches)";
    },
    async find(params) {
      const target = await canonicalize(params.path ?? ".");
      const result = await sshExec(
        await options.getClient(),
        `find ${shellQuote(target)} -maxdepth 20 -name ${shellQuote(params.pattern)} 2>/dev/null | head -${params.limit ?? 200}`,
        root,
      );
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },
  };
}
