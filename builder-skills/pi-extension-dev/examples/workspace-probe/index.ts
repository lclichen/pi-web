/**
 * workspace-probe — minimal third-party extension for pi-web's
 * WorkspaceOperations v1 event bridge.
 *
 * It registers one tool (`workspace_probe`) that asks the CURRENT session's
 * host for its workspace provider and reports capabilities + stat/read/exec
 * results. The extension never receives SSH/relay/platform credentials.
 *
 * This file is shipped as a reference example by the pi-extension-dev skill.
 * Install it as a project extension:
 *
 *   <project>/.pi/extensions/workspace-probe/
 *     package.json
 *     index.ts
 *
 * In the pi CLI (no pi-web host bridge) the tool returns a clear error instead
 * of guessing a transport.
 */
import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

const REQUEST_EVENT = "pi-web:workspace:request";
const REPLY_PREFIX = "pi-web:workspace:reply:";
const REQUEST_TIMEOUT_MS = 30_000;

interface WorkspaceStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

interface WorkspaceDirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

interface WorkspaceExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface WorkspaceCapabilities {
  read: boolean;
  write: boolean;
  exec: boolean;
  grep?: boolean;
  find?: boolean;
}

type WorkspaceReply =
  | { v: 1; id: string; ok: true; result: unknown }
  | { v: 1; id: string; ok: false; error: { code: string; message: string } };

function workspaceRequest<T>(pi: ExtensionAPI, method: string, params?: unknown): Promise<T> {
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const event = `${REPLY_PREFIX}${id}`;
    let settled = false;
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      off?.();
      fn();
    };
    off = pi.events.on(event, (raw: unknown) => {
      const reply = raw as WorkspaceReply;
      if (reply?.id !== id || reply?.v !== 1) return;
      finish(() => {
        if (reply.ok) resolve(reply.result as T);
        else reject(new Error(`${reply.error.code}: ${reply.error.message}`));
      });
    });
    timer = setTimeout(
      () => finish(() => reject(new Error(`workspace request timed out after ${REQUEST_TIMEOUT_MS}ms`))),
      REQUEST_TIMEOUT_MS,
    );
    pi.events.emit(REQUEST_EVENT, { v: 1, id, method, params });
  });
}

export default function workspaceProbeExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "workspace_probe",
      label: "Workspace Probe",
      description:
        "Example third-party tool: inspect the CURRENT session's workspace through pi-web's WorkspaceOperations event bridge " +
        "(capabilities, stat, bounded read, readdir, optional command). Works in host/sandbox/local-machine/SSH sessions; " +
        "returns an explicit error under the plain pi CLI.",
      promptSnippet: "workspace_probe — inspect the current workspace through the pi-web bridge (example extension)",
      parameters: Type.Object({
        path: Type.Optional(
          Type.String({
            description: "Workspace-relative or absolute-in-workspace path. Default: the workspace root.",
          }),
        ),
        command: Type.Optional(
          Type.String({ description: "Optional command to run in the workspace (exec capability must be enabled)." }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        try {
          const capabilities = await workspaceRequest<WorkspaceCapabilities>(pi, "capabilities");
          const target = params.path?.trim() || ".";
          const stat = await workspaceRequest<WorkspaceStat>(pi, "stat", { path: target });
          const result: Record<string, unknown> = { capabilities, path: target, stat };

          if (stat.isDirectory) {
            const entries = await workspaceRequest<WorkspaceDirEntry[]>(pi, "readdir", { path: target });
            result.entries = entries;
          } else if (stat.isFile && stat.size <= 1024 * 1024) {
            const base64 = await workspaceRequest<string>(pi, "readFile", { path: target });
            result.text = Buffer.from(base64, "base64").toString("utf8");
          } else if (stat.isFile) {
            result.note = "file is larger than 1 MiB; skipped inline read";
          }

          if (params.command?.trim()) {
            if (!capabilities.exec) throw new Error("read-only workspace: exec is disabled");
            result.exec = await workspaceRequest<WorkspaceExecResult>(pi, "exec", {
              command: params.command,
              cwd: stat.isDirectory ? target : ".",
            });
          }

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `workspace_probe failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: {},
            isError: true,
          };
        }
      },
    }),
  );
}
