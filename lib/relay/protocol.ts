// Shared wire protocol for the pi-web ↔ Local Agent relay.
//
// The browser never talks to the Local Agent directly. It calls Next.js routes
// under /api/agent-relay/**; those routes forward JSON-RPC requests to the
// connected agent over a single WebSocket (see lib/relay/ws-server.ts). The
// agent (a Go binary on the user's machine, e.g. CentOS 7) speaks the exact
// same message shapes defined here — keep them stable and minimal.
//
// Message framing over the WebSocket is one JSON object per text frame.

/** A request the relay forwards to the agent. `id` correlates the response. */
export interface RpcRequest {
  id: number;
  method: RpcMethod;
  params?: Record<string, unknown>;
}

/** Final one-shot response from the agent for a given request id. */
export interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** An intermediate streamed chunk for a long-running request (Phase 2). */
export interface RpcChunk {
  id: number;
  type: "chunk";
  data?: unknown;
}

/** Terminal frame for a streamed request. */
export interface RpcEnd {
  id: number;
  type: "end";
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** First message the agent sends after the WebSocket opens. */
export interface AgentHello {
  type: "hello";
  info: AgentInfo;
}

/** Anything the agent may push to the relay. */
export type AgentToRelayMessage = RpcResponse | RpcChunk | RpcEnd | AgentHello;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/** MVP method set. Phase 2 adds search.*, exec.stream, pty.*, fs.watch. */
export type RpcMethod =
  | "workspace.info"
  | "fs.list"
  | "fs.read"
  | "fs.write"
  | "fs.stat"
  | "fs.mkdir"
  | "fs.delete"
  | "fs.rename"
  | "search.grep"
  | "search.fd"
  | "exec.run"
  | "exec.stream";

/** Static metadata describing the connected machine + its workspace. */
export interface AgentInfo {
  hostname: string;
  os: string; // e.g. "linux", "darwin", "windows"
  arch: string; // e.g. "amd64", "arm64"
  workspaceRoot: string; // absolute path the agent restricts all fs.* calls to
  agentVersion: string;
}

/** Result rows for fs.list. */
export interface FsEntry {
  name: string;
  path: string; // relative to workspaceRoot
  isDir: boolean;
  size: number;
  mtime: number; // epoch ms
}

/** Result of fs.read. */
export interface FsReadResult {
  path: string;
  content: string;
  size: number;
  mtime: number;
}

/** Result of fs.stat. */
export interface FsStatResult {
  path: string;
  exists: boolean;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** Result of exec.run. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One hit from search.grep. */
export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/** Public-facing snapshot returned by /api/agent-relay/status. */
export interface RelayStatus {
  online: boolean;
  info?: AgentInfo;
}

/** Pairing code descriptor held in memory until consumed or expired. */
export interface PairingCode {
  code: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}
