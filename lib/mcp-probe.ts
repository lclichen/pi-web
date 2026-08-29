import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpTool, ProbeResult, ServerEntry }  from "./api-types";

const DEFAULT_TIMEOUT_MS = 15000;

function buildHeaders(entry: ServerEntry): Record<string, string> {
  const headers: Record<string, string> = { ...(entry.headers ?? {}) };
  if (entry.auth === "bearer" && entry.bearerToken) {
    headers.Authorization = `Bearer ${entry.bearerToken}`;
  }
  return headers;
}

function looksLikeSse(url: string): boolean {
  return /\/sse\/?(\?.*)?$/i.test(url);
}

function buildStdioTransport(entry: ServerEntry): StdioClientTransport {
  return new StdioClientTransport({
    command: entry.command as string,
    args: entry.args ?? [],
    env: entry.env ?? undefined,
    cwd: entry.cwd,
    stderr: entry.debug ? "inherit" : "ignore",
  });
}

async function connectHttp(client: Client, entry: ServerEntry): Promise<void> {
  const url = new URL(entry.url as string);
  const headers = buildHeaders(entry);
  const requestInit = { headers } as RequestInit;
  if (looksLikeSse(entry.url as string)) {
    await client.connect(new SSEClientTransport(url, { requestInit }));
    return;
  }
  // Try StreamableHTTP first (modern servers); fall back to legacy SSE.
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
  } catch {
    await client.connect(new SSEClientTransport(url, { requestInit }));
  }
}

export async function probeServer(
  entry: ServerEntry,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> {
  if (!entry.url && !entry.command && !entry.socket) {
    return { tools: [], error: "Server entry has neither url, command, nor socket" };
  }
  if (entry.socket) {
    return { tools: [], error: "rmcp-mux Unix socket probing is not supported from the web panel" };
  }
  const client = new Client(
    { name: "pi-web-mcp-probe", version: "1.0.0" },
    { capabilities: {} },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    client.close().catch(() => {});
  }, timeoutMs);
  try {
    if (entry.url) {
      await connectHttp(client, entry);
    } else {
      await client.connect(buildStdioTransport(entry));
    }
    const { tools } = await client.listTools();
    const mapped: McpTool[] = (tools ?? []).map((t) => {
      const maybe = t as { title?: string };
      return {
        name: t.name,
        title: maybe.title,
        description: t.description,
        inputSchema: t.inputSchema,
      };
    });
    return { tools: mapped };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (timedOut) return { tools: [], error: `Probe timed out after ${timeoutMs}ms` };
    const needsAuth = /\b401\b|unauthor/i.test(msg);
    return { tools: [], error: msg, needsAuth };
  } finally {
    clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
  }
}
