import { randomUUID } from "node:crypto";
import {
  defineTool,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { relayRpc } from "@/lib/relay/forward";
import { getAgentForUser } from "@/lib/relay/registry";
import { clientCompatibility } from "@/lib/client-compat";
import {
  agentSupportsMcpRelay,
  type RelayWorkspaceScope,
} from "@/lib/relay/workspace-base";
import { readMcpConfig } from "@/lib/mcp-config";
import { readPreferences } from "@/lib/preferences-service";
import { isRelayWorkspaceStdio, relayWorkspaceEntryProblem } from "@/lib/relay-mcp-policy";
import type { McpRelayCallResult, McpRelayTool, McpRelayToolList } from "@/lib/relay/protocol";
import type { ServerEntry } from "@/lib/api-types";

/**
 * Relay-hosted MCP tools for local-machine sessions.
 *
 * A project-level `.pi/mcp.json` entry with:
 *
 *   { "command": "node", "args": [".pi/mcp/cli.js"],
 *     "piWeb": { "plane": "workspace", "risk": "read" } }
 *
 * is NOT spawned by pi-mcp-adapter on the pi-web server. Instead the Go agent
 * on the user's paired machine hosts the process; this extension lists its
 * tools once at session start and calls them over the relay. Tool names use
 * the `mcp_<server>_<tool>` prefix so they cannot collide with adapter tools
 * (the adapter's own `plane=workspace` server is clamped in remote modes).
 *
 * v1 scope: stdio only, project scope only, local-machine sessions only.
 * Tool metadata is a session-start snapshot; start a new session after editing
 * the MCP server.
 */

export interface RelayMcpOptions {
  userId: number;
  userName: string;
  /** Server-side project home that owns `.pi/mcp.json`. */
  projectHome: string;
  /** Project workspace on the user's machine (project.workdir). */
  workspaceDir?: string;
  machineId?: string;
  /** Test seams. */
  rpc?: typeof relayRpc;
  agentForUser?: typeof getAgentForUser;
  serverKeyPrefix?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 15_000;
const MAX_TOOLS_PER_SERVER = 200;

/** Only project-scope stdio servers that explicitly opt into workspace
 *  execution are hosted on the paired machine. */
export function isRelayWorkspaceServer(entry: ServerEntry): boolean {
  return isRelayWorkspaceStdio(entry);
}

/**
 * Session-start guard: refuse to boot a local-machine session whose relay MCP
 * config could make pi-mcp-adapter connect/spawn it on the server before this
 * extension takes over. Callers turn the thrown error into their own 4xx.
 */
export function assertRelayWorkspaceMcpSafe(projectHome: string, userId?: number): void {
  const doc = readMcpConfig(projectHome, { scopes: ["project"], userId });
  for (const server of doc.servers) {
    const problem = relayWorkspaceEntryProblem(server.entry);
    if (problem) throw new Error(`workspace MCP「${server.name}」配置不安全：${problem}`);
  }
}

export function relayMcpToolName(serverName: string, toolName: string): string {
  return `mcp_${sanitizeSegment(serverName)}_${sanitizeSegment(toolName)}`;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "unnamed";
}

function metaFor(userId: number, userName: string, sessionId: string): Record<string, unknown> {
  return {
    "amedac/session_id": sessionId,
    "amedac/user_id": userId,
    "amedac/user_name": userName,
  };
}

function sessionIdFrom(
  ctx: { sessionManager?: { getHeader?: () => { id?: string } | null | undefined } } | undefined,
): string {
  try {
    return ctx?.sessionManager?.getHeader?.()?.id ?? "";
  } catch {
    return "";
  }
}

function contentToResult(
  serverName: string,
  toolName: string,
  result: McpRelayCallResult,
): ToolResult {
  const texts: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const rawContent = Array.isArray(result.content) ? result.content : [];
  for (const item of rawContent) {
    if (!item || typeof item !== "object") continue;
    const part = item as {
      type?: string;
      text?: string;
      data?: string;
      mimeType?: string;
      resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
    };
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
      continue;
    }
    if (part.type === "image" && typeof part.data === "string") {
      images.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" });
      continue;
    }
    if (part.type === "resource" && part.resource) {
      const resource = part.resource;
      const mime = resource.mimeType || "application/octet-stream";
      if (typeof resource.text === "string") {
        texts.push(resource.text);
      } else if (typeof resource.blob === "string" && mime.startsWith("image/")) {
        images.push({ type: "image", data: resource.blob, mimeType: mime });
      } else {
        texts.push(`[resource ${resource.uri ?? "(unknown)"} ${mime}]`);
      }
      continue;
    }
    // Unknown future content blocks stay visible instead of being dropped.
    texts.push(JSON.stringify(item));
  }

  const content: ToolResult["content"] = [];
  if (texts.length > 0 || images.length === 0) {
    content.push({ type: "text", text: texts.join("\n") || "(no content returned by MCP server)" });
  }
  content.push(...images);
  return {
    content,
    details: { server: serverName, tool: toolName },
    ...(result.isError === true ? { isError: true } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function makeRemoteMcpToolsExtension(options: RelayMcpOptions): InlineExtension {
  const {
    userId,
    userName,
    projectHome,
    workspaceDir,
    machineId,
    rpc = relayRpc,
    agentForUser = getAgentForUser,
    serverKeyPrefix = randomUUID(),
  } = options;

  const agentReady = (): boolean => {
    const info = agentForUser(userId, machineId)?.info;
    if (!info) return false;
    if (!clientCompatibility(info.agentVersion).compatible) return false;
    return agentSupportsMcpRelay(info);
  };

  const relayScope = (): RelayWorkspaceScope => ({
    ...(workspaceDir ? { base: workspaceDir } : {}),
  });

  const call = <T>(method: Parameters<typeof relayRpc>[0], params: Record<string, unknown>, timeoutMs: number) =>
    rpc(method, params, {
      userId,
      ...(machineId ? { machineId } : {}),
      timeoutMs,
    }) as Promise<T>;

  const factory = async (pi: ExtensionAPI): Promise<void> => {
    const serverKeys = new Set<string>();
    try {
      if (!readPreferences(projectHome).mcpEnabled) return;
    } catch {
      // Unreadable preferences fall back to MCP enabled.
    }
    let doc: ReturnType<typeof readMcpConfig>;
    try {
      doc = readMcpConfig(projectHome, { scopes: ["project"], userId });
    } catch {
      return;
    }
    const servers = doc.servers.filter(
      (server) => isRelayWorkspaceServer(server.entry) && !relayWorkspaceEntryProblem(server.entry),
    );
    if (servers.length === 0 || !agentReady()) return;

    pi.on("session_shutdown", async () => {
      await Promise.allSettled(
        [...serverKeys].map((serverKey) =>
          call("mcp.close", { serverKey }, 5_000).catch(() => undefined),
        ),
      );
    });

    const usedToolNames = new Set<string>();
    for (const server of servers) {
      const entry = server.entry;
      const serverKey = `${serverKeyPrefix}:${server.name}`;
      serverKeys.add(serverKey);
      const requestTimeoutMs =
        typeof entry.requestTimeoutMs === "number" && entry.requestTimeoutMs > 0
          ? entry.requestTimeoutMs
          : DEFAULT_REQUEST_TIMEOUT_MS;
      let tools: McpRelayTool[];
      try {
        const listed = await call<McpRelayToolList>(
          "mcp.listTools",
          {
            serverKey,
            command: entry.command,
            args: entry.args ?? [],
            env: entry.env ?? {},
            ...(entry.cwd ? { cwd: entry.cwd } : {}),
            ...relayScope(),
            timeoutMs: Math.min(requestTimeoutMs, LIST_TIMEOUT_MS),
            clientName: "pi-web-relay",
            clientVersion: "1.0.0",
          },
          LIST_TIMEOUT_MS + 5_000,
        );
        tools = Array.isArray(listed?.tools) ? listed.tools : [];
      } catch {
        // Server failed to start/list: leave the session usable. The next
        // session retries; we do not spawn anything on the server host.
        continue;
      }

      const include = new Set(entry.includeTools ?? []);
      const exclude = new Set(entry.excludeTools ?? []);
      let registered = 0;
      for (const tool of tools) {
        if (!tool || typeof tool.name !== "string" || !tool.name.trim()) continue;
        if (registered >= MAX_TOOLS_PER_SERVER) break;
        if (include.size > 0 && !include.has(tool.name)) continue;
        if (exclude.has(tool.name)) continue;
        let name = relayMcpToolName(server.name, tool.name);
        if (usedToolNames.has(name)) {
          let suffix = 2;
          while (usedToolNames.has(`${name}_${suffix}`)) suffix += 1;
          name = `${name}_${suffix}`;
        }
        usedToolNames.add(name);
        const inputSchema =
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object", properties: {} };

        pi.registerTool(
          defineTool({
            name,
            label: `MCP · ${server.name}/${tool.name}`,
            description:
              tool.description?.trim() ||
              `MCP tool "${tool.name}" from server "${server.name}" (runs on your paired machine).`,
            parameters: Type.Unsafe(inputSchema as never),
            execute: async (_id, params, _signal, _onUpdate, ctx) => {
              const sessionId = sessionIdFrom(ctx) || serverKey;
              try {
                const result = await call<McpRelayCallResult>(
                  "mcp.callTool",
                  {
                    serverKey,
                    command: entry.command,
                    args: entry.args ?? [],
                    env: entry.env ?? {},
                    ...(entry.cwd ? { cwd: entry.cwd } : {}),
                    ...relayScope(),
                    name: tool.name,
                    arguments: asRecord(params),
                    _meta: metaFor(userId, userName, sessionId),
                    timeoutMs: requestTimeoutMs,
                    clientName: "pi-web-relay",
                    clientVersion: "1.0.0",
                  },
                  requestTimeoutMs + 15_000,
                );
                return contentToResult(server.name, tool.name, result ?? {});
              } catch (error) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `MCP tool ${server.name}/${tool.name} failed: ${
                        error instanceof Error ? error.message : String(error)
                      }`,
                    },
                  ],
                  details: { server: server.name, tool: tool.name },
                  isError: true,
                };
              }
            },
          }),
        );
        registered += 1;
      }
    }
  };

  return { name: "pi-web-remote-mcp", factory, hidden: true };
}
