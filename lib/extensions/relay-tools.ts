import { defineTool, type BashOperations, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { relayRpc } from "@/lib/relay/forward";
import { getAgentForUser } from "@/lib/relay/registry";
import { clientCompatibility } from "@/lib/client-compat";
import {
  resolveRelayWorkspaceScope,
  toRelayPath,
  toWorkspaceRelative,
  type RelayWorkspaceScope,
} from "@/lib/relay/workspace-base";
import { matchServerSkillPath } from "@/lib/relay/skill-bridge";
import type { ExecResult, FsEntry, FsReadResult, FsStatResult, GrepMatch } from "@/lib/relay/protocol";

/**
 * Inline extension for 本机模式 (local-machine) sessions: redefines the
 * seven built-in coding tools to execute on the web user's OWN machine via
 * their paired Go relay agent, instead of the pi-web server host.
 *
 * The project's workspaceDir (project.workdir) is the root every tool call is
 * scoped to: agents >= 0.2.0 receive it as the per-request `base`, older
 * agents get a root-relative prefix when the directory lives inside their
 * shared root. Instantiated once per session with the owning user captured in
 * the closure, so concurrent users hit their own relay slots.
 */

export interface RelayToolsOptions {
  /** Server-side project home (skills/AGENTS.md bridge source). */
  projectHome?: string;
  /** Project workspace on the user's machine (project.workdir). */
  workspaceDir?: string;
  /** Paired machine this project is bound to (multi-machine). */
  machineId?: string;
}

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

/**
 * Instruction files (AGENTS.md) live in the PLATFORM directory (project
 * home) — the SDK loads them from the session cwd, and duplicating a project
 * carries them over. When the agent edits the workspace-root copy, mirror the
 * change back so both sides stay in sync (the sync into the workspace is
 * one-way home→workspace). Best-effort: mirroring failures never fail the tool.
 */
async function mirrorInstructionsFile(path: string, content: string, sessionCwd?: string, workspaceDir?: string): Promise<void> {
  if (!sessionCwd) return;
  const rel = toWorkspaceRelative(path, workspaceDir);
  if (rel !== "AGENTS.md") return;
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(sessionCwd, "AGENTS.md"), content, "utf8");
  } catch {
    // best-effort mirror
  }
}

export function makeRelayToolsExtension(userId: number, options: RelayToolsOptions = {}): InlineExtension {
  const { projectHome, workspaceDir, machineId } = options;
  /** Resolve per call: an agent may upgrade/reconnect mid-session. */
  const currentScope = (): RelayWorkspaceScope => {
    const info = getAgentForUser(userId, machineId)?.info;
    if (info) {
      const compat = clientCompatibility(info.agentVersion);
      if (!compat.compatible) return { error: compat.message };
    }
    return resolveRelayWorkspaceScope(workspaceDir, info);
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

  /** Skills bridge (lib/relay/skill-bridge.ts): skill files live on the
   *  server (session homes' .pi/skills + server agent dir .pi/agent/skills),
   *  never on the user's machine — skill-shaped read/ls stays server-side. */
  const bridgeSkill = (p: string, ctxCwd?: string) =>
    matchServerSkillPath(p, { homes: [projectHome, ctxCwd] });

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

  const listLocalDir = async (absPath: string): Promise<ToolResult> => {
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(absPath, { withFileTypes: true });
      if (entries.length === 0) return ok("(empty directory)");
      return ok(entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`).sort().join("\n"));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  const factory = (pi: ExtensionAPI): void => {
    pi.registerTool(defineTool({
      name: "read",
      label: "Read",
      description: "Read a file from the user's machine (absolute path, or path relative to the project workspace). Returns the content with line numbers.",
      parameters: Type.Object({
        path: Type.String({ description: "File path: absolute, or relative to the project workspace" }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        // Skills bridge: runtime skill files live on the server, never on
        // the user's machine — serve them locally instead of relaying.
        const bridged = bridgeSkill(params.path, ctx?.cwd);
        if (bridged) return readLocalFile(bridged.path);
        const scope = currentScope();
        if (scope.error) return fail(scope.error);
        try {
          const r = await call<FsReadResult>("fs.read", { path: toRelayPath(params.path, scope, workspaceDir) }, scope);
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
      description: "Create or overwrite a file on the user's machine (absolute path, or path relative to the project workspace).",
      parameters: Type.Object({
        path: Type.String({ description: "File path: absolute, or relative to the project workspace" }),
        content: Type.String({ description: "Full file content" }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const scope = currentScope();
        if (scope.error) return fail(scope.error);
        try {
          await call("fs.write", { path: toRelayPath(params.path, scope, workspaceDir), content: params.content }, scope);
          await mirrorInstructionsFile(params.path, params.content, ctx?.cwd, workspaceDir);
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
        path: Type.String({ description: "File path: absolute, or relative to the project workspace" }),
        oldText: Type.String({ description: "Exact text to replace (must appear exactly once)" }),
        newText: Type.String({ description: "Replacement text" }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const scope = currentScope();
        if (scope.error) return fail(scope.error);
        const wirePath = toRelayPath(params.path, scope, workspaceDir);
        try {
          const r = await call<FsReadResult>("fs.read", { path: wirePath }, scope);
          const count = r.content.split(params.oldText).length - 1;
          if (count === 0) return fail(`oldText not found in ${params.path}`);
          if (count > 1) return fail(`oldText appears ${count} times in ${params.path}; make it unique`);
          const next = r.content.replace(params.oldText, params.newText);
          await call("fs.write", { path: wirePath, content: next }, scope);
          await mirrorInstructionsFile(params.path, next, ctx?.cwd, workspaceDir);
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
        cwd: Type.Optional(Type.String({ description: "Working directory: absolute, or relative to the project workspace (default \".\")" })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in ms" })),
      }),
      execute: async (_id, params) => {
        const scope = currentScope();
        if (scope.error) return fail(scope.error);
        try {
          const r = await call<ExecResult>("exec.run", {
            argv: params.argv,
            cwd: toRelayPath(params.cwd ?? ".", scope, workspaceDir),
            ...(params.timeout ? { timeout: params.timeout } : {}),
          }, scope);
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
      description: "List a directory on the user's machine (absolute, or relative to the project workspace).",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path (default \".\" = project workspace root)" })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const bridged = bridgeSkill(params.path ?? "", ctx?.cwd);
        if (bridged) return listLocalDir(bridged.path);
        const scope = currentScope();
        if (scope.error) return fail(scope.error);
        try {
          const entries = await call<FsEntry[]>("fs.list", { path: toRelayPath(params.path ?? ".", scope, workspaceDir) }, scope);
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
        path: Type.Optional(Type.String({ description: "Search root: absolute, or relative to the project workspace" })),
        type: Type.Optional(Type.Union([Type.Literal("f"), Type.Literal("d")], { description: "\"f\" files only, \"d\" dirs only" })),
      }),
      execute: async (_id, params) => {
        const scope = currentScope();
        if (scope.error) return fail(scope.error);
        try {
          const results = await call<string[]>("search.fd", {
            pattern: params.pattern,
            ...(params.path ? { path: toRelayPath(params.path, scope, workspaceDir) } : {}),
            ...(params.type ? { type: params.type } : {}),
          }, scope);
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
        path: Type.Optional(Type.String({ description: "Search root: absolute, or relative to the project workspace" })),
        glob: Type.Optional(Type.String({ description: "File glob filter, e.g. \"*.py\"" })),
      }),
      execute: async (_id, params) => {
        const scope = currentScope();
        if (scope.error) return fail(scope.error);
        try {
          const matches = await call<GrepMatch[]>("search.grep", {
            pattern: params.pattern,
            ...(params.path ? { path: toRelayPath(params.path, scope, workspaceDir) } : {}),
            ...(params.glob ? { glob: params.glob } : {}),
          }, scope);
          if (matches.length === 0) return ok("(no matches)");
          return ok(matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n"));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    }));

    // ---- user `!`/`!!` commands: execute on the user's own machine ----
    // pi hands the LOCAL session cwd (server-side project home), which has no
    // meaning on the user's machine — run in the project workspace instead.
    // relay exec.run is argv-based (no shell), so wrap with bash -c.
    pi.on("user_bash", async (): Promise<{ operations: BashOperations }> => ({
      operations: {
        exec: async (command: string, _cwd: string, options: { onData?: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }) => {
          const scope = currentScope();
          if (scope.error) throw new Error(scope.error);
          const r = await call<ExecResult>("exec.run", {
            argv: ["bash", "-c", command],
            cwd: scope.prefix || ".",
            ...(options.timeout ? { timeout: options.timeout } : {}),
          }, scope);
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
