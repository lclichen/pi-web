import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { attachAgentSocket, consumePairingCode, DEFAULT_MACHINE_ID, isKnownAgentToken } from "./registry";
import { issueAgentToken, lookupTokenRecord, touchAgentToken } from "./relay-store";
import { clientIpOf, consumeRateLimit } from "../rate-limit";

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
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? "";
    if (!isKnownAgentToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const record = lookupTokenRecord(token);
    if (!record) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      attachAgentSocket(ws, record.userId, record.machineId);
      // Rolling token expiry: an actively-used machine never expires; an
      // abandoned pairing dies after 90 days.
      void touchAgentToken(token, record.machineId).catch(() => {});
    });
  });

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
    const body = (await readJson(req)) as { code?: unknown; machineId?: unknown; hostname?: unknown; label?: unknown };
    const code = typeof body.code === "string" ? body.code : "";
    // consumePairingCode returns the minting user's id — the agent token MUST
    // bind to it, otherwise every later per-user lookup (status/panel/RPC)
    // treats the connected agent as someone else's and reports offline
    // ("No local agent connected" despite a green dot).
    const ownerUserId = consumePairingCode(code);
    if (ownerUserId === null) {
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
    const hostname = typeof body.hostname === "string" ? body.hostname.slice(0, 100) : undefined;
    // Label precedence: the agent's own --label flag, else the label the user
    // chose when minting the code in the pairing dialog.
    const label =
      (typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 50) : undefined)
      ?? ownerUserId.label;
    const token = await issueAgentToken({ userId: ownerUserId.userId, machineId, hostname, label });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token, wsPath: "/ws", machineId }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
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
