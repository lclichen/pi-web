import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  attachAgentSocket,
  claimAgentConnection,
  consumePairingCode,
  DEFAULT_MACHINE_ID,
  disconnectMachine,
  isKnownAgentToken,
  liveConnectionConflict,
  peekPairingCode,
  releaseAgentConnectionClaim,
} from "./registry";
import { issueAgentToken, lookupTokenRecord, touchAgentToken } from "./relay-store";
import { clientIpOf, consumeRateLimit } from "../rate-limit";
import { clientCompatibility, REQUIRED_CLIENT_VERSION } from "../client-compat";

// The agent-facing endpoint: a plain http.Server on its own port (default
// 30142), started once from instrumentation.ts. It serves:
//   POST /pair/exchange   — exchange a pairing code for an agent token
//   GET  /health          — liveness probe
//   WS   /ws?token=...    — the data channel (token-authenticated)
//
// The browser never reaches this port; it talks to the Next.js routes under
// /api/agent-relay/** on the main web port, which share this process's
// in-memory registry (globalThis.__piRelayRegistry).

const DEFAULT_PORT = 30142;
const DEFAULT_HOST = "0.0.0.0"; // reachable from LAN/container; tighten via PI_RELAY_HOST

declare global {
  var __piRelayServer: { server: Server; port: number; host: string } | undefined;
}

export function getRelayInfo(): { port: number; host: string } {
  if (globalThis.__piRelayServer) {
    return { port: globalThis.__piRelayServer.port, host: globalThis.__piRelayServer.host };
  }
  return {
    port: Number(process.env.PI_RELAY_PORT ?? DEFAULT_PORT),
    host: process.env.PI_RELAY_HOST ?? DEFAULT_HOST,
  };
}

export async function startRelayServer(): Promise<void> {
  if (globalThis.__piRelayServer) return; // already started (survives hot-reload)

  const port = Number(process.env.PI_RELAY_PORT ?? DEFAULT_PORT);
  const host = process.env.PI_RELAY_HOST ?? DEFAULT_HOST;

  const wss = new WebSocketServer({ noServer: true });

  const server = createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      try {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      } catch {
        // ignore
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((err: unknown) => {
      writeHttpResponse(socket, 500, "Internal Server Error", { error: String(err) });
    });
  });

  // The agent sends X-Agent-Instance (its per-process id) and optionally
  // X-Agent-Replace. A second live process for the same machine is refused
  // with 409 BEFORE the upgrade, so it cannot silently evict the live
  // connection (and its pair-time token rotation cannot strand it).
  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? "";
    if (!isKnownAgentToken(token)) {
      writeHttpResponse(socket, 401, "Unauthorized");
      return;
    }
    const record = lookupTokenRecord(token);
    if (!record) {
      writeHttpResponse(socket, 401, "Unauthorized");
      return;
    }
    const rawInstance = req.headers["x-agent-instance"];
    const instanceHeader = typeof rawInstance === "string" ? rawInstance : "";
    const instanceId = /^[A-Za-z0-9_-]{1,64}$/.test(instanceHeader) ? instanceHeader : "";
    const replaceHeader = req.headers["x-agent-replace"];
    const replace = replaceHeader === "1" || replaceHeader === "true";

    let conflict;
    try {
      conflict = await claimAgentConnection({
        userId: record.userId,
        machineId: record.machineId,
        instanceId,
        replace,
      });
    } catch (err) {
      writeHttpResponse(socket, 500, "Internal Server Error", { error: String(err) });
      return;
    }
    if (conflict) {
      writeHttpResponse(socket, 409, "Conflict", {
        error: "this machine is already connected; stop the other client or use --replace",
        code: "machine-connected",
        connection: conflict,
      });
      return;
    }

    let attached = false;
    try {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        attached = true;
        attachAgentSocket(ws, record.userId, record.machineId, { instanceId });
        // Rolling token expiry: an actively-used machine never expires; an
        // abandoned pairing dies after 90 days.
        void touchAgentToken(token, record.machineId).catch(() => {});
      });
    } finally {
      if (!attached) releaseAgentConnectionClaim(record.userId, record.machineId);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve());
  });

  globalThis.__piRelayServer = { server, port, host };
  console.log(`[relay] agent endpoint listening on http://${host}:${port} (ws /ws)`);
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // The agent is a CLI client (curl/Go) and never sends an Origin header; it
  // does not need CORS at all. Deliberately NO Access-Control-Allow-Origin —
  // a permissive wildcard would let any web page brute-force pairing codes
  // from a victim's browser and READ the exchanged token.
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/pair/exchange") {
    // Pairing codes are 6 chars: rate-limit guesses per IP and globally so a
    // LAN-local (or multi-code) brute force cannot run for the whole 5-min TTL.
    const ip = clientIpOf(req as unknown as Parameters<typeof clientIpOf>[0]);
    const perIp = consumeRateLimit(`pair:ip:${ip}`, 10, 60_000);
    const global = consumeRateLimit("pair:global", 60, 5 * 60_000);
    if (!perIp.allowed || !global.allowed) {
      const retry = Math.ceil(Math.max(perIp.retryAfterMs, global.retryAfterMs) / 1000);
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(retry) });
      res.end(JSON.stringify({ error: `too many attempts; retry in ${retry}s` }));
      return;
    }
    const body = (await readJson(req)) as {
      code?: unknown;
      machineId?: unknown;
      hostname?: unknown;
      label?: unknown;
      clientVersion?: unknown;
      force?: unknown;
    };
    const code = typeof body.code === "string" ? body.code : "";
    const force = body.force === true;
    // Version gate at pairing time: an outdated binary must not obtain a
    // token (it would connect and then fail every protocol expectation).
    const clientVersion = typeof body.clientVersion === "string" ? body.clientVersion : "";
    const compat = clientCompatibility(clientVersion);
    if (!compat.compatible) {
      res.writeHead(426, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: compat.message,
          requiredVersion: REQUIRED_CLIENT_VERSION,
        }),
      );
      return;
    }
    // Peek (do not consume) so a refusal below leaves the user's code usable.
    // consumePairingCode returns the minting user's id — the agent token MUST
    // bind to it, otherwise every later per-user lookup (status/panel/RPC)
    // treats the connected agent as someone else's and reports offline
    // ("No local agent connected" despite a green dot).
    const pending = peekPairingCode(code);
    if (pending === null) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid or expired pairing code" }));
      return;
    }
    // Machine identity: the agent sends its persisted machineId (stable across
    // restarts) so a re-pair replaces the SAME machine's token instead of
    // piling up one token per pairing.
    const machineId =
      typeof body.machineId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.machineId)
        ? body.machineId
        : DEFAULT_MACHINE_ID;
    // Rotating the token of a machine that is CURRENTLY connected would strand
    // that client on a dead credential at its next reconnect. Refuse unless
    // the user explicitly forces it (then the live socket is closed too).
    if (!force) {
      const conflict = await liveConnectionConflict(pending.userId, machineId);
      if (conflict) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "this machine is already connected; stop the other client first or re-pair with --force",
            code: "machine-connected",
            connection: conflict,
          }),
        );
        return;
      }
    }
    const ownerUserId = consumePairingCode(code);
    if (ownerUserId === null) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid or expired pairing code" }));
      return;
    }
    const hostname = typeof body.hostname === "string" ? body.hostname.slice(0, 100) : undefined;
    // Label precedence: the agent's own --label flag, else the label the user
    // chose when minting the code in the pairing dialog.
    const label =
      (typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 50) : undefined) ??
      ownerUserId.label;
    const token = await issueAgentToken({ userId: ownerUserId.userId, machineId, hostname, label });
    if (force) {
      // The old token is gone; the live socket keeps working on the old
      // handshake until closed. Close it now so both sides agree on reality.
      disconnectMachine(ownerUserId.userId, machineId, 4002, "token rotated");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token, wsPath: "/ws", machineId, requiredVersion: REQUIRED_CLIENT_VERSION }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

function writeHttpResponse(socket: Duplex, status: number, statusText: string, payload?: unknown): void {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const head = [
    `HTTP/1.1 ${status} ${statusText}`,
    ...(body ? ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`] : []),
    "Connection: close",
    "",
    body,
  ].join("\r\n");
  try {
    socket.end(head);
  } catch {
    socket.destroy(); // peer already gone
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}
