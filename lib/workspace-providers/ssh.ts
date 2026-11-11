import type { Client, SFTPWrapper } from "ssh2";
import { sshExec } from "../ssh";
import {
  WorkspaceOperationError,
  type WorkspaceDirEntry,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
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
function sftpRead(s: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => s.readFile(path, (err, data) => (err ? reject(err) : resolve(data))));
}
function sftpWrite(s: SFTPWrapper, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => s.writeFile(path, content, (err) => (err ? reject(err) : resolve())));
}
function sftpStat(s: SFTPWrapper, path: string): Promise<{ isDirectory(): boolean; size: number; mtime: number }> {
  return new Promise((resolve, reject) => s.stat(path, (err, attrs) => (err ? reject(err) : resolve(attrs))));
}
function sftpReadDir(s: SFTPWrapper, path: string): Promise<SftpEntry[]> {
  return new Promise((resolve, reject) =>
    s.readdir(path, (err, list) => (err ? reject(err) : resolve(list as SftpEntry[]))),
  );
}

/** Recursive mkdir; an existing directory is success, other errors stay errors. */
function sftpMkdir(s: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    s.mkdir(path, { recursive: true } as never, (err) => {
      if (!err) return resolve();
      s.stat(path, (statErr) => (statErr ? reject(err) : resolve()));
    });
  });
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
      const s = await sftp(await options.getClient());
      return sftpRead(s, await canonicalize(path));
    },
    async writeFile(path, content) {
      if (typeof content !== "string") {
        throw new WorkspaceOperationError("UNSUPPORTED", "SSH workspace writes only UTF-8 text");
      }
      const target = await canonicalize(path);
      const s = await sftp(await options.getClient());
      await sftpMkdir(s, target.replace(/\/[^/]*$/, "") || "/");
      await sftpWrite(s, target, content);
    },
    async mkdir(path) {
      const target = await canonicalize(path);
      const s = await sftp(await options.getClient());
      await sftpMkdir(s, target);
    },
    async stat(path): Promise<WorkspaceStat> {
      const target = await canonicalize(path);
      const s = await sftp(await options.getClient());
      const attrs = await sftpStat(s, target);
      return {
        isFile: !attrs.isDirectory(),
        isDirectory: attrs.isDirectory(),
        size: attrs.size,
        mtimeMs: attrs.mtime * 1000,
      };
    },
    async readdir(path): Promise<WorkspaceDirEntry[]> {
      const target = await canonicalize(path);
      const s = await sftp(await options.getClient());
      const entries = await sftpReadDir(s, target);
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
