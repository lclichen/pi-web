import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import WebSocket from "ws";

// End-to-end checks for the agent endpoint's duplicate-connection guard and
// pairing behaviour. A real ws listener is started on an ephemeral port; the
// token store points at a temp agent dir so no real credentials are touched.
const tmp = mkdtempSync(join(tmpdir(), "relay-ws-"));
process.env.PI_CODING_AGENT_DIR = tmp;
process.env.PI_RELAY_PORT = "0";
process.env.PI_RELAY_HOST = "127.0.0.1";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./relay-store.ts");
const reg = await jiti.import("./registry.ts");
const { startRelayServer } = await jiti.import("./ws-server.ts");

await startRelayServer();
const port = globalThis.__piRelayServer.server.address().port;
const wsBase = `ws://127.0.0.1:${port}/ws`;
const httpBase = `http://127.0.0.1:${port}`;

/** Dial the relay; resolves { ws } on 101, or { status, body } otherwise. */
function dial(token, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}?token=${token}`, { headers });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.once("open", () => finish({ ws }));
    ws.once("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      res.on("end", () => finish({ status: res.statusCode, body }));
    });
    ws.once("error", (err) => finish({ error: err }));
  });
}

function waitClosed(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
  });
}

async function pair(code, machineId, force = false) {
  const res = await fetch(`${httpBase}/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, machineId, clientVersion: "0.5.0", hostname: "host-x", force }),
  });
  return { status: res.status, body: await res.json() };
}

test("ws: second live process is refused with 409; same process/replace allowed", async () => {
  const token = await store.issueAgentToken({ userId: 77, machineId: "m-ws" });

  const first = await dial(token, { "x-agent-instance": "proc-a" });
  assert.ok(first.ws, `expected an open connection, got ${JSON.stringify(first)}`);
  first.ws.send(JSON.stringify({ type: "hello", info: { hostname: "lab", agentVersion: "0.5.0" } }));

  const second = await dial(token, { "x-agent-instance": "proc-b" });
  assert.equal(second.status, 409);
  assert.equal(JSON.parse(second.body).code, "machine-connected");
  assert.equal(JSON.parse(second.body).connection.hostname, "lab");
  assert.equal(first.ws.readyState, WebSocket.OPEN, "live connection must survive");

  // The same process may reconnect (network blip) and evicts its own socket.
  const again = await dial(token, { "x-agent-instance": "proc-a" });
  assert.ok(again.ws, `same-process reconnect refused: ${JSON.stringify(again)}`);
  await waitClosed(first.ws);

  // A different process may take over only with --replace.
  const replaced = await dial(token, { "x-agent-instance": "proc-c", "x-agent-replace": "1" });
  assert.ok(replaced.ws, `replace refused: ${JSON.stringify(replaced)}`);
  await waitClosed(again.ws);
  replaced.ws.close();
  await waitClosed(replaced.ws);
});

test("pair: refuses to rotate a live machine's token unless forced", async () => {
  const token = await store.issueAgentToken({ userId: 78, machineId: "m-pair" });
  const live = await dial(token, { "x-agent-instance": "proc-p" });
  assert.ok(live.ws, `expected an open connection, got ${JSON.stringify(live)}`);

  // Refusal must not consume the code: the same code works after stopping.
  const code1 = reg.createPairingCode(78).code;
  const refused = await pair(code1, "m-pair", false);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "machine-connected");
  assert.equal(live.ws.readyState, WebSocket.OPEN, "live connection must survive");

  const code2 = reg.createPairingCode(78).code;
  const forced = await pair(code2, "m-pair", true);
  assert.equal(forced.status, 200);
  assert.ok(forced.body.token && forced.body.token !== token);
  await waitClosed(live.ws);
  assert.equal(store.lookupTokenRecord(token), null, "old token revoked");

  const reconnected = await dial(forced.body.token, { "x-agent-instance": "proc-p2" });
  assert.ok(reconnected.ws, `new token refused: ${JSON.stringify(reconnected)}`);
  reconnected.ws.close();
  await waitClosed(reconnected.ws);
});

test("ws: unknown token is rejected with 401", async () => {
  const { status } = await dial("not-a-real-token");
  assert.equal(status, 401);
});

test.after(() => {
  globalThis.__piRelayServer?.server.close();
});
