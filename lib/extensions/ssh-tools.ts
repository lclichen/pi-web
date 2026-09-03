/**
 * Inline extension for SSH-mode sessions: redefines the seven built-in coding
 * tools to execute on a remote host over SSH (exec for bash/grep/find, SFTP
 * for read/write/edit/ls). The SDK session itself runs on the pi-web server
 * (cwd = project home, so history/compaction work unchanged); only tool
 * effects are remote. Instantiated per session with the project's pooled
 * connection + remote workdir captured in the closure.
 */
import { defineTool, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Client, SFTPWrapper } from "ssh2";
import { getSshClient, sshExec, type SshConfig } from "../ssh";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}
function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}

/** Join the remote workdir with a (possibly relative or absolute) tool path. */
function remotePath(workdir: string, path: string): string {
  const p = path.trim();
  if (p.startsWith("/")) return p;
  return `${workdir.replace(/\/+$/, "")}/${p}`;
}

function sftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });
}

function sftpRead(s: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    s.readFile(path, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function sftpWrite(s: SFTPWrapper, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    s.writeFile(path, content, (err) => (err ? reject(err) : resolve()));
  });
}

interface SftpEntry {
  filename: string;
  attrs: { isDirectory(): boolean; size: number };
}

function sftpList(s: SFTPWrapper, path: string): Promise<SftpEntry[]> {
  return new Promise((resolve, reject) => {
    s.readdir(path, (err, list) => (err ? reject(err) : resolve(list as SftpEntry[])));
  });
}

/**
 * @param projectId owner of the pooled connection
 * @param sshConfig connection credentials (from the project home's ssh.json)
 * @param workdir default remote working directory for relative paths
 * @param projectHome server-side project home — skills under <home>/.pi/skills
 *   are discovered/loaded locally and do NOT exist on the remote host; read
 *   calls mapped there are bridged to the local side instead of SFTP.
 */
export function makeSshToolsExtension(opts: {
  projectId: string;
  sshConfig: SshConfig;
  workdir: string;
  projectHome?: string;
}): InlineExtension {
  const { projectId, sshConfig, workdir, projectHome } = opts;
  const client = () => getSshClient(projectId, sshConfig);

  /** Local .pi/skills bridge target for a tool path, or null. */
  const localSkillsPath = (p: string): string | null => {
    if (!projectHome) return null;
    const cleaned = p.replace(/^@/, "").trim();
    if (!cleaned) return null;
    const abs = cleaned.startsWith("/") ? cleaned : `${projectHome.replace(/\/+$/, "")}/${cleaned.replace(/^\/+/, "")}`;
    const rel = abs.startsWith(`${projectHome}/`) ? abs.slice(projectHome.length + 1) : null;
    if (rel === ".pi/skills" || rel?.startsWith(".pi/skills/")) return abs;
    return null;
  };

  /** Read a file on the pi-web server (skills bridge), formatted like the tool. */
  const readLocalFile = async (absPath: string): Promise<ToolResult> => {
    const { readFile } = await import("node:fs/promises");
    try {
      const buf = await readFile(absPath);
      const lines = buf.toString("utf8").split("\n");
      const numbered = lines.map((line, i) => `${i + 1}→${line}`).join("\n");
      return ok(`${numbered}\n\n(${absPath}, ${lines.length} lines)`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  const factory = (pi: ExtensionAPI): void => {
    // ---- bash ----
    pi.registerTool(defineTool({
      name: "bash",
      label: "Bash",
      description: "Run a shell command on the remote host (SSH). Executes in the project workdir.",
      parameters: Type.Object({
        command: Type.String({ description: "The shell command to run remotely." }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 120)." })),
      }),
      execute: async (_id, params) => {
        try {
          const c = await client();
          const r = await sshExec(c, params.command, workdir, (params.timeout ?? 120) * 1000);
          const out = [r.stdout, r.stderr ? `[stderr]\n${r.stderr}` : "", r.code !== 0 ? `[exit ${r.code}]` : ""]
            .filter(Boolean).join("\n");
          return r.code === 0 ? ok(out || "(no output)") : fail(out || `exit ${r.code}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    // ---- read ----
    pi.registerTool(defineTool({
      name: "read",
      label: "Read",
      description: "Read a remote file over SFTP. Returns content with line numbers.",
      parameters: Type.Object({
        path: Type.String({ description: "File path (absolute, or relative to the project workdir)" }),
      }),
      execute: async (_id, params) => {
        // Skills bridge: .pi/skills/** lives in the server-side project home,
        // not on the remote host — serve it locally.
        const bridged = localSkillsPath(params.path);
        if (bridged) return readLocalFile(bridged);
        try {
          const c = await client();
          const s = await sftp(c);
          const buf = await sftpRead(s, remotePath(workdir, params.path));
          const lines = buf.toString("utf8").split("\n");
          const numbered = lines.map((line, i) => `${i + 1}→${line}`).join("\n");
          return ok(`${numbered}\n\n(${params.path}, ${lines.length} lines)`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    // ---- write ----
    pi.registerTool(defineTool({
      name: "write",
      label: "Write",
      description: "Write a file on the remote host over SFTP (creates parent directories).",
      parameters: Type.Object({
        path: Type.String({ description: "File path (absolute, or relative to the project workdir)" }),
        content: Type.String({ description: "Full file content." }),
      }),
      execute: async (_id, params) => {
        try {
          const c = await client();
          const s = await sftp(c);
          const target = remotePath(workdir, params.path);
          const dir = target.replace(/\/[^/]*$/, "") || "/";
          await new Promise<void>((resolve, reject) => {
            s.mkdir(dir, { recursive: true } as never, (err) => {
              // recursive mkdir fails if parts exist — tolerate and verify
              if (err && !s) return reject(err);
              resolve();
            });
          });
          await sftpWrite(s, target, params.content);
          return ok(`Wrote ${params.path} (${params.content.length} bytes)`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    // ---- edit ----
    pi.registerTool(defineTool({
      name: "edit",
      label: "Edit",
      description: "Edit a remote file: replace the first exact occurrence of oldText with newText.",
      parameters: Type.Object({
        path: Type.String({ description: "File path (absolute, or relative to the project workdir)" }),
        oldText: Type.String({ description: "Exact text to replace." }),
        newText: Type.String({ description: "Replacement text." }),
      }),
      execute: async (_id, params) => {
        try {
          const c = await client();
          const s = await sftp(c);
          const target = remotePath(workdir, params.path);
          const buf = await sftpRead(s, target);
          const content = buf.toString("utf8");
          if (!content.includes(params.oldText)) {
            return fail(`oldText not found in ${params.path}`);
          }
          await sftpWrite(s, target, content.replace(params.oldText, params.newText));
          return ok(`Edited ${params.path}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    // ---- ls ----
    pi.registerTool(defineTool({
      name: "ls",
      label: "Ls",
      description: "List a remote directory over SFTP.",
      parameters: Type.Object({
        path: Type.String({ description: "Directory path (absolute, or relative to the project workdir)" }),
      }),
      execute: async (_id, params) => {
        try {
          const c = await client();
          const s = await sftp(c);
          const list = await sftpList(s, remotePath(workdir, params.path));
          const lines = list
            .map((e) => `${e.attrs.isDirectory() ? "d" : "-"} ${e.filename}`)
            .sort()
            .join("\n");
          return ok(lines || "(empty)");
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    // ---- grep ----
    pi.registerTool(defineTool({
      name: "grep",
      label: "Grep",
      description: "Search file contents on the remote host with grep.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Regex pattern (grep -E)." }),
        path: Type.Optional(Type.String({ description: "Directory to search (default: project workdir)" })),
        include: Type.Optional(Type.String({ description: "glob filter, e.g. '*.ts'" })),
      }),
      execute: async (_id, params) => {
        try {
          const c = await client();
          const base = remotePath(workdir, params.path ?? workdir);
          const inc = params.include ? ` --include='${params.include.replace(/'/g, "")}'` : "";
          const r = await sshExec(c, `grep -rnE${inc} -- '${params.pattern.replace(/'/g, `'\\''`)}' ${base} 2>/dev/null | head -100`, workdir);
          return ok(r.stdout || "No matches");
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    // ---- find ----
    pi.registerTool(defineTool({
      name: "find",
      label: "Find",
      description: "Find files by glob on the remote host with find.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Glob pattern, e.g. '*.yaml'" }),
        path: Type.Optional(Type.String({ description: "Directory to search (default: project workdir)" })),
      }),
      execute: async (_id, params) => {
        try {
          const c = await client();
          const base = remotePath(workdir, params.path ?? workdir);
          const pat = params.pattern.replace(/'/g, "");
          const r = await sshExec(c, `find ${base} -name '${pat}' 2>/dev/null | head -100`, workdir);
          return ok(r.stdout || "No matches");
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));
    // ---- user `!`/`!!` commands: execute on the remote host ----
    // pi hands the LOCAL session cwd (the server-side project home); pin it
    // to the remote workdir instead, matching the tools' path semantics.
    pi.on("user_bash", async (): Promise<{ operations: BashOperations }> => {
      const quotedWorkdir = `'${workdir.replace(/'/g, `'\\''`)}'`;
      return {
        operations: {
          exec: (command: string, _cwd: string, options: { onData?: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }) =>
            new Promise<{ exitCode: number | null }>((resolve, reject) => {
              void client().then((c) => {
                // `{ ${command}; }` 单行收尾：换行落在 command 与 `;` 之间会让
                // `;` 成为空语句（bash syntax error near `;`）。
                c.exec(`cd ${quotedWorkdir} 2>/dev/null || cd /; { ${command}; }`, (err: Error | undefined, stream: {
                  on(ev: "data", cb: (d: Buffer) => void): unknown;
                  on(ev: "close", cb: (code: number) => void): unknown;
                  stderr: { on(ev: "data", cb: (d: Buffer) => void): unknown };
                  close(): void;
                }) => {
                  if (err) return reject(err);
                  stream.on("data", (d: Buffer) => options.onData?.(d));
                  stream.stderr.on("data", (d: Buffer) => options.onData?.(d));
                  const timer = setTimeout(() => {
                    stream.close();
                    resolve({ exitCode: null });
                  }, options.timeout ?? 120_000);
                  options.signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    stream.close();
                    resolve({ exitCode: null });
                  }, { once: true });
                  stream.on("close", (code: number) => {
                    clearTimeout(timer);
                    resolve({ exitCode: code });
                  });
                });
              }).catch(reject);
            }),
        },
      };
    });
  };

  return factory;
}
