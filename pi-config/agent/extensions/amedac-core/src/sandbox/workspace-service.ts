/**
 * Workspace event bridge (v1).
 *
 * Each session's mode extension registers this bridge with its own
 * WorkspaceOperations provider. Third-party extensions call the provider over
 * the shared extension event bus; they never receive credentials or a raw
 * transport handle.
 *
 * Protocol: see builder-skills/pi-extension-dev/references/remote-workspace.md.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  WORKSPACE_REQUEST_EVENT,
  WorkspaceOperationError,
  workspaceReplyEvent,
  type WorkspaceBridgeResponse,
  type WorkspaceExecResult,
  type WorkspaceOperations,
} from "./workspace-api.ts";

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringParam(params: Record<string, unknown>, key: string, required = true): string {
  const value = params[key];
  if (typeof value !== "string") {
    if (!required && value === undefined) return "";
    throw new WorkspaceOperationError("UNSUPPORTED", `${key} must be a string`);
  }
  return value;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkspaceOperationError("UNSUPPORTED", `${key} must be a number`);
  }
  return value;
}

function optionalStringRecord(params: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceOperationError("UNSUPPORTED", `${key} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new WorkspaceOperationError("UNSUPPORTED", `${key}.${name} must be a string`);
    out[name] = entry;
  }
  return out;
}

function normalizeExec(result: WorkspaceExecResult): WorkspaceExecResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function dispatch(ws: WorkspaceOperations, method: string, rawParams: unknown): Promise<unknown> {
  const params = record(rawParams) ?? {};
  switch (method) {
    case "capabilities":
      return { ...ws.capabilities };
    case "canonicalize":
      return ws.canonicalize(stringParam(params, "path"));
    case "readFile": {
      const path = stringParam(params, "path");
      // Pre-check when the provider can stat cheaply: never pull a huge file
      // into memory just to reject it afterwards.
      const info = await ws.stat(path).catch(() => null);
      if (info && info.size > MAX_TRANSFER_BYTES) {
        throw new WorkspaceOperationError("UNSUPPORTED", `file exceeds ${MAX_TRANSFER_BYTES} bytes`);
      }
      const data = await ws.readFile(path);
      if (data.length > MAX_TRANSFER_BYTES) {
        throw new WorkspaceOperationError("UNSUPPORTED", `file exceeds ${MAX_TRANSFER_BYTES} bytes`);
      }
      return data.toString("base64");
    }
    case "writeFile": {
      const dataBase64 = params.dataBase64;
      const content = params.content;
      if (typeof dataBase64 !== "string" && typeof content !== "string") {
        throw new WorkspaceOperationError("UNSUPPORTED", "dataBase64 or content is required");
      }
      const data =
        typeof dataBase64 === "string" ? Buffer.from(dataBase64, "base64") : Buffer.from(content as string, "utf8");
      if (data.length > MAX_TRANSFER_BYTES) {
        throw new WorkspaceOperationError("UNSUPPORTED", `file exceeds ${MAX_TRANSFER_BYTES} bytes`);
      }
      await ws.writeFile(stringParam(params, "path"), data);
      return null;
    }
    case "mkdir":
      await ws.mkdir(stringParam(params, "path"));
      return null;
    case "stat":
      return ws.stat(stringParam(params, "path"));
    case "readdir":
      return ws.readdir(stringParam(params, "path"));
    case "exec": {
      if (!ws.capabilities.exec) throw new WorkspaceOperationError("READ_ONLY", "Workspace does not support exec");
      const command = stringParam(params, "command");
      const cwd = stringParam(params, "cwd", false) || undefined;
      const timeout = optionalNumber(params, "timeout");
      const env = optionalStringRecord(params, "env");
      return normalizeExec(
        await ws.exec(command, {
          ...(cwd ? { cwd } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          ...(env ? { env } : {}),
        }),
      );
    }
    case "grep": {
      if (!ws.grep) throw new WorkspaceOperationError("UNSUPPORTED", "Workspace does not support grep");
      return ws.grep({
        pattern: stringParam(params, "pattern"),
        ...(params.path !== undefined ? { path: stringParam(params, "path") } : {}),
        ...(params.glob !== undefined ? { glob: stringParam(params, "glob") } : {}),
        ...(typeof params.literal === "boolean" ? { literal: params.literal } : {}),
        ...(typeof params.ignoreCase === "boolean" ? { ignoreCase: params.ignoreCase } : {}),
        ...(params.context !== undefined ? { context: optionalNumber(params, "context") } : {}),
        ...(params.limit !== undefined ? { limit: optionalNumber(params, "limit") } : {}),
      });
    }
    case "find": {
      if (!ws.find) throw new WorkspaceOperationError("UNSUPPORTED", "Workspace does not support find");
      return ws.find({
        pattern: stringParam(params, "pattern"),
        ...(params.path !== undefined ? { path: stringParam(params, "path") } : {}),
        ...(params.limit !== undefined ? { limit: optionalNumber(params, "limit") } : {}),
      });
    }
    default:
      throw new WorkspaceOperationError("UNSUPPORTED", `Unknown workspace method: ${method}`);
  }
}

async function handleRequest(
  pi: ExtensionAPI,
  getProvider: () => WorkspaceOperations | Promise<WorkspaceOperations>,
  raw: unknown,
): Promise<void> {
  const request = record(raw);
  const id = request?.id;
  if (typeof id !== "string" || !REQUEST_ID_RE.test(id)) return;
  const reply = (body: WorkspaceBridgeResponse) => pi.events.emit(workspaceReplyEvent(id), body);
  const method = request?.method;
  if (request?.v !== 1 || typeof method !== "string") {
    reply({
      v: 1,
      id,
      ok: false,
      error: { code: "UNSUPPORTED", message: "Invalid workspace request (v/method)" },
    });
    return;
  }
  try {
    const ws = await getProvider();
    const result = await dispatch(ws, method, request.params);
    reply({ v: 1, id, ok: true, result });
  } catch (error) {
    const code = error instanceof WorkspaceOperationError ? error.code : "EXEC_FAILED";
    reply({
      v: 1,
      id,
      ok: false,
      error: { code, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Register the event bridge. Call once from the session's mode extension
 * factory. `getProvider` is lazy so a relay/SSH/sandbox connection can change
 * between requests.
 */
export function registerWorkspaceService(
  pi: ExtensionAPI,
  getProvider: () => WorkspaceOperations | Promise<WorkspaceOperations>,
): void {
  // Older/custom hosts may not expose the extension event bus; the bridge is
  // then simply unavailable instead of breaking the whole mode extension.
  if (!pi.events?.on) return;
  const off = pi.events.on(WORKSPACE_REQUEST_EVENT, (raw: unknown) => {
    void handleRequest(pi, getProvider, raw);
  });
  pi.on("session_shutdown", () => off());
}
