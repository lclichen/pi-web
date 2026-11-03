import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { McpServerInfo } from "./api-types.ts";
import { listAgentEventStreams, type AgentEventStreamInfo } from "./agent-event-stream.ts";
import { readMcpConfig } from "./mcp-config.ts";
import { getProjectTrustStatus } from "./project-trust.ts";
import {
  getRpcSessionDebugSnapshots,
  getRpcStartingSessionCwds,
  type RpcSessionDebugSnapshot,
} from "./rpc-manager.ts";

export interface DebugSessionRow extends RpcSessionDebugSnapshot {
  streams: number;
}

export interface DebugMcpServer {
  name: string;
  scope: string;
  transport: string;
  directToolsOn: boolean;
  disabled: boolean;
}

export interface DebugSnapshot {
  now: number;
  uptimeMs: number;
  totals: {
    wrappers: number;
    alive: number;
    running: number;
    streams: number;
    startingCwds: number;
  };
  sessions: DebugSessionRow[];
  startingCwds: Array<{ cwd: string; count: number }>;
  streams: AgentEventStreamInfo[];
  selected: {
    sessionId: string;
    trust: { requiresTrust: boolean; trusted: boolean; reasons: string[] };
    mcpServers: DebugMcpServer[];
  } | null;
}

function read<T>(source: () => T, fallback: T): T {
  try {
    return source();
  } catch {
    return fallback;
  }
}

/**
 * Read-only snapshot for GET /api/agent/debug. Never starts a wrapper, opens a
 * stream or sends a command; each registry read is isolated so one stale
 * object cannot fail the whole answer.
 */
export function buildDebugSnapshot(sessionId: string | null, now = Date.now()): DebugSnapshot {
  const wrappers = read(() => getRpcSessionDebugSnapshots(), []);
  const streams = read(() => listAgentEventStreams(), []);
  const startingCwds = read(() => getRpcStartingSessionCwds(), []);

  const streamsBySession = new Map<string, number>();
  for (const stream of streams) {
    streamsBySession.set(stream.sessionId, (streamsBySession.get(stream.sessionId) ?? 0) + 1);
  }

  const sessions: DebugSessionRow[] = wrappers
    .map((wrapper) => ({
      ...wrapper,
      streams: streamsBySession.get(wrapper.sessionId ?? "") ?? 0,
    }))
    .sort((a, b) => (a.sessionId ?? "").localeCompare(b.sessionId ?? ""));

  const selectedWrapper = sessionId ? wrappers.find((wrapper) => wrapper.sessionId === sessionId) : undefined;
  const selected = selectedWrapper?.cwd
    ? (() => {
        const trust = read(
          () => getProjectTrustStatus(selectedWrapper.cwd, getAgentDir()),
          { requiresTrust: false, trusted: true, reasons: [] },
        );
        const mcpServers = read(
          () => readMcpConfig(selectedWrapper.cwd).servers,
          [] as McpServerInfo[],
        );
        return {
          sessionId: selectedWrapper.sessionId ?? "",
          trust: { requiresTrust: trust.requiresTrust, trusted: trust.trusted, reasons: trust.reasons },
          mcpServers: mcpServers.map((server) => ({
            name: server.name,
            scope: server.scope,
            transport: server.transport,
            directToolsOn: server.directToolsOn,
            disabled: server.disabled,
          })),
        };
      })()
    : null;

  return {
    now,
    uptimeMs: Math.round(process.uptime() * 1000),
    totals: {
      wrappers: wrappers.length,
      alive: wrappers.filter((wrapper) => wrapper.alive).length,
      running: wrappers.filter((wrapper) => wrapper.running).length,
      streams: streams.length,
      startingCwds: startingCwds.length,
    },
    sessions,
    startingCwds,
    streams,
    selected,
  };
}
