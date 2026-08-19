import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { attachAgentSocket, consumePairingCode, isKnownAgentToken } from "./registry";
import { issueAgentToken, lookupTokenOwner } from "./relay-store";

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
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      attachAgentSocket(ws, lookupTokenOwner(token));
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

  // The agent is a CLI client with no browser origin; still emit permissive CORS
  // so future browser-tooling / probes work without surprises.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
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
    const body = (await readJson(req)) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code : "";
    if (!consumePairingCode(code)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid or expired pairing code" }));
      return;
    }
    const token = await issueAgentToken();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token, wsPath: "/ws" }));
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
