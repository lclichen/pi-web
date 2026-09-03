import { defineTool, type BashOperations, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { relayRpc } from "@/lib/relay/forward";
import type { ExecResult, FsEntry, FsReadResult, FsStatResult, GrepMatch } from "@/lib/relay/protocol";

/**
 * Inline extension for 本机模式 (local-machine) sessions: redefines the
 * seven built-in coding tools to execute on the web user's OWN machine via
 * their paired Go relay agent, instead of the pi-web server host. Paths are
 * workspace-relative on the user's machine (the agent restricts fs.* to its
 * shared root). Instantiated once per session with the owning user captured
 * in the closure, so concurrent users hit their own relay slots.
 */

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

/** Strip a leading "/" so workspace-relative fs.* paths stay in-root. */
function rel(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Instruction files (AGENTS.md) live in the PLATFORM directory (project
 * home) — the SDK loads them from the session cwd, and duplicating a project
 * carries them over. When the agent edits the workspace-root copy, mirror the
 * change back so both sides stay in sync (the sync into the workspace is
 * one-way home→workspace). Best-effort: mirroring failures never fail the tool.
 */
async function mirrorInstructionsFile(workspaceRel: string, content: string, sessionCwd?: string): Promise<void> {
  if (!sessionCwd || workspaceRel.replace(/^\/+/, "") !== "AGENTS.md") return;
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(sessionCwd, "AGENTS.md"), content, "utf8");
  } catch {
    // best-effort mirror
  }
}

export function makeRelayToolsExtension(userId: number, projectHome?: string): InlineExtension {
  const call = <T>(method: Parameters<typeof relayRpc>[0], params?: Record<string, unknown>) =>
    relayRpc(method, params, { userId }) as Promise<T>;

  /** Local .pi/skills bridge: skills are discovered from the server-side
   *  project home and do NOT exist on the user's machine — read calls that
   *  resolve under <home>/.pi/skills are served from the pi-web server. */
  const localSkillsPath = (p: string): string | null => {
    if (!projectHome) return null;
    const cleaned = p.replace(/^@/, "").trim();
    if (!cleaned) return null;
    const abs = cleaned.startsWith("/") ? cleaned : `${projectHome.replace(/\/+$/, "")}/${cleaned.replace(/^\/+/, "")}`;
    const rel = abs.startsWith(`${projectHome}/`) ? abs.slice(projectHome.length + 1) : null;
    if (rel === ".pi/skills" || rel?.startsWith(".pi/skills/")) return abs;
    return null;
  };

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
    pi.registerTool(defineTool({
      name: "read",
      label: "Read",
      description: "Read a file from the user's machine (workspace-relative path). Returns the content with line numbers.",
      parameters: Type.Object({
        path: Type.String({ description: "Workspace-relative file path" }),
      }),
      execute: async (_id, params) => {
        // Skills bridge: .pi/skills/** lives in the server-side project home.
        const bridged = localSkillsPath(params.path);
        if (bridged) return readLocalFile(bridged);
        try {
          const r = await call<FsReadResult>("fs.read", { path: rel(params.path) });
          const lines = r.content.split("\n");
          const numbered = lines.map((line, i) => `${i + 1}→${line}`).join("\n");
          return ok(`${numbered}\n\n(${r.path}, ${lines.length} lines)`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    pi.registerTool(defineTool({
      name: "write",
      label: "Write",
      description: "Create or overwrite a file on the user's machine (workspace-relative path).",
      parameters: Type.Object({
        path: Type.String({ description: "Workspace-relative file path" }),
        content: Type.String({ description: "Full file content" }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        try {
          await call("fs.write", { path: rel(params.path), content: params.content });
          await mirrorInstructionsFile(rel(params.path), params.content, ctx?.cwd);
          return ok(`Wrote ${params.path}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    pi.registerTool(defineTool({
      name: "edit",
      label: "Edit",
      description: "Replace the first occurrence of oldText with newText in a file on the user's machine.",
      parameters: Type.Object({
        path: Type.String({ description: "Workspace-relative file path" }),
        oldText: Type.String({ description: "Exact text to replace (must appear exactly once)" }),
        newText: Type.String({ description: "Replacement text" }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        try {
          const r = await call<FsReadResult>("fs.read", { path: rel(params.path) });
          const count = r.content.split(params.oldText).length - 1;
          if (count === 0) return fail(`oldText not found in ${params.path}`);
          if (count > 1) return fail(`oldText appears ${count} times in ${params.path}; make it unique`);
          const next = r.content.replace(params.oldText, params.newText);
          await call("fs.write", { path: rel(params.path), content: next });
          await mirrorInstructionsFile(rel(params.path), next, ctx?.cwd);
          return ok(`Edited ${params.path}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    pi.registerTool(defineTool({
      name: "bash",
      label: "Bash",
      description: "Run a shell command on the user's machine (argv array, no shell interpolation). Use e.g. [\"bash\",\"-c\",\"...\"] for shell syntax.",
      parameters: Type.Object({
        argv: Type.Array(Type.String(), { description: "Command argv, e.g. [\"git\",\"status\"] or [\"bash\",\"-c\",\"ls | head\"]" }),
        cwd: Type.Optional(Type.String({ description: "Working directory (workspace-relative, default \".\")" })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in ms" })),
      }),
      execute: async (_id, params) => {
        try {
          const r = await call<ExecResult>("exec.run", {
            argv: params.argv,
            cwd: params.cwd ? rel(params.cwd) : ".",
            ...(params.timeout ? { timeout: params.timeout } : {}),
          });
          const parts: string[] = [];
          if (r.stdout) parts.push(r.stdout);
          if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
          parts.push(`[exit ${r.exitCode}]`);
          const result = ok(parts.join("\n"));
          if (r.exitCode !== 0) result.isError = true;
          return result;
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    pi.registerTool(defineTool({
      name: "ls",
      label: "List",
      description: "List a directory on the user's machine (workspace-relative).",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path (default \".\")" })),
      }),
      execute: async (_id, params) => {
        try {
          const entries = await call<FsEntry[]>("fs.list", { path: rel(params.path ?? ".") });
          if (entries.length === 0) return ok("(empty directory)");
          return ok(entries.map((e) => `${e.isDir ? "d" : "-"} ${e.name}`).join("\n"));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    pi.registerTool(defineTool({
      name: "find",
      label: "Find",
      description: "Find files/directories by name pattern on the user's machine.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Name pattern (glob-ish, e.g. \"*.ts\")" }),
        path: Type.Optional(Type.String({ description: "Search root (workspace-relative)" })),
        type: Type.Optional(Type.Union([Type.Literal("f"), Type.Literal("d")], { description: "\"f\" files only, \"d\" dirs only" })),
      }),
      execute: async (_id, params) => {
        try {
          const results = await call<string[]>("search.fd", {
            pattern: params.pattern,
            ...(params.path ? { path: rel(params.path) } : {}),
            ...(params.type ? { type: params.type } : {}),
          });
          return ok(results.length ? results.join("\n") : "(no matches)");
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    pi.registerTool(defineTool({
      name: "grep",
      label: "Grep",
      description: "Search file contents on the user's machine.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Regex pattern" }),
        path: Type.Optional(Type.String({ description: "Search root (workspace-relative)" })),
        glob: Type.Optional(Type.String({ description: "File glob filter, e.g. \"*.py\"" })),
      }),
      execute: async (_id, params) => {
        try {
          const matches = await call<GrepMatch[]>("search.grep", {
            pattern: params.pattern,
            ...(params.path ? { path: rel(params.path) } : {}),
            ...(params.glob ? { glob: params.glob } : {}),
          });
          if (matches.length === 0) return ok("(no matches)");
          return ok(matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n"));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    // ---- user `!`/`!!` commands: execute on the user's own machine ----
    // pi hands the LOCAL session cwd (server-side project home), which has no
    // meaning on the user's machine — run at the relay workspace root instead.
    // relay exec.run is argv-based (no shell), so wrap with bash -c.
    pi.on("user_bash", async (): Promise<{ operations: BashOperations }> => ({
      operations: {
        exec: async (command: string, _cwd: string, options: { onData?: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }) => {
          const r = await call<ExecResult>("exec.run", {
            argv: ["bash", "-c", command],
            cwd: ".",
            ...(options.timeout ? { timeout: options.timeout } : {}),
          });
          if (r.stdout) options.onData?.(Buffer.from(r.stdout, "utf8"));
          if (r.stderr) options.onData?.(Buffer.from(`[stderr]\n${r.stderr}`, "utf8"));
          return { exitCode: r.exitCode };
        },
      },
    }));
  };

  return { name: "pi-web-relay-tools", factory, hidden: true };
}

/** Re-exported for the terminal/fs panel: stat via the user's relay. */
export function relayStatFor(userId: number, path: string): Promise<FsStatResult> {
  return relayRpc("fs.stat", { path }, { userId }) as Promise<FsStatResult>;
}
