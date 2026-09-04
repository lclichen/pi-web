import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createJiti } from "jiti";

// Multi-machine relay semantics (fix plan D1): token store normalization +
// registry routing. The relay store persists under the pi agent dir — point
// PI_CODING_AGENT_DIR at a temp dir so the real credentials are never touched.
// jiti resolves the extensionless TS imports inside the source modules.
const tmp = mkdtempSync(join(tmpdir(), "relay-multimachine-"));
process.env.PI_CODING_AGENT_DIR = tmp;

const jiti = createJiti(import.meta.url);
const { generatePairingCode } = await jiti.import("./pairing.ts");
const store = await jiti.import("./relay-store.ts");
const reg = await jiti.import("./registry.ts");

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function resetRegistry() {
  globalThis.__piRelayRegistry = undefined;
}

test("pairing codes are uniform (rejection sampling)", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generatePairingCode());
  assert.ok(seen.size > 490, `codes should be near-unique, got ${seen.size}/500`);
  for (const code of seen) assert.match(code, /^[0-9A-HJKMNPQRSTVWXYZ]{6}$/);
});

test("legacy token format (token -> number) normalizes on read", async () => {
  mkdirSync(tmp, { recursive: true });
  writeFileSync(
    join(tmp, "relay.json"),
    JSON.stringify({ token: null, generatedAt: null, tokens: { oldtoken: 7 } }),
    "utf8",
  );
  assert.equal(store.lookupTokenOwner("oldtoken"), 7);
  assert.equal(store.lookupTokenRecord("oldtoken").machineId, "default");
  // Prototype-chain names are not tokens.
  assert.equal(store.lookupTokenOwner("toString"), 0);
  assert.equal(store.lookupTokenRecord("constructor"), null);
  assert.equal(store.isKnownToken("valueOf"), false);
});

test("issueAgentToken: one token per machine, re-pair replaces it", async () => {
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "relay.json"), JSON.stringify({ token: null, generatedAt: null }), "utf8");
  const t1 = await store.issueAgentToken({ userId: 5, machineId: "mac-a", label: "工位机", hostname: "hostA" });
  const t2 = await store.issueAgentToken({ userId: 5, machineId: "mac-b", hostname: "hostB" });
  const t1again = await store.issueAgentToken({ userId: 5, machineId: "mac-a", label: "工位机2" });

  const all = store.listAgentTokens();
  const machines = new Set(all.map((e) => e.record.machineId));
  assert.ok(machines.has("mac-a") && machines.has("mac-b"));
  assert.equal(all.filter((e) => e.record.machineId === "mac-a").length, 1, "re-pair replaces the machine's old token");
  assert.equal(all.find((e) => e.token === t1), undefined, "old token revoked");
  assert.equal(store.lookupTokenRecord(t2).userId, 5);
  assert.equal(store.lookupTokenRecord(t1again).machineId, "mac-a");
  assert.equal(store.lookupTokenRecord(t1again).userId, 5);

  // revokeAgentMachine kills exactly that machine's token
  const revoked = await store.revokeAgentMachine(5, "mac-b");
  assert.equal(revoked, t2);
  assert.equal(store.lookupTokenRecord(t2), null);
  assert.equal(store.lookupTokenRecord(t1again).machineId, "mac-a");
});

test("registry: two machines per user, routing and eviction are per-machine", () => {
  resetRegistry();
  const wsA = new FakeWs();
  const wsB = new FakeWs();
  reg.attachAgentSocket(wsA, 5, "mac-a");
  reg.attachAgentSocket(wsB, 5, "mac-b");

  assert.equal(reg.getAgentForUser(5, "mac-a").machineId, "mac-a");
  assert.equal(reg.getAgentForUser(5, "mac-b").machineId, "mac-b");
  assert.equal(reg.getAgentForUser(5).machineId, "mac-b", "default = most recent");

  // Same machine reconnect evicts only that machine.
  const wsA2 = new FakeWs();
  reg.attachAgentSocket(wsA2, 5, "mac-a");
  assert.equal(reg.getAgentForUser(5, "mac-a").ws, wsA2);
  assert.equal(reg.getAgentForUser(5, "mac-b").ws, wsB, "other machine unaffected");
  assert.equal(wsA.readyState, 3, "old connection closed");

  // Machines list reports both with online flags.
  const machines = reg.getMachinesForUser(5);
  assert.equal(machines.length, 2);
  assert.ok(machines.every((m) => m.online));

  // Status snapshot carries machines.
  const status = reg.getStatusForUser(5);
  assert.equal(status.online, true);
  assert.equal(status.machines.length, 2);

  // Disconnect one: status flips, other machine stays routable.
  wsA2.close();
  assert.equal(reg.getAgentForUser(5, "mac-a"), null);
  assert.equal(reg.getAgentForUser(5, "mac-b").ws, wsB);
  const after = reg.getStatusForUser(5);
  assert.equal(after.machines.find((m) => m.machineId === "mac-a").online, false);
  wsB.close();
});

test("registry: PTY output is keyed by machine", () => {
  resetRegistry();
  const wsA = new FakeWs();
  const wsB = new FakeWs();
  reg.attachAgentSocket(wsA, 5, "mac-a");
  reg.attachAgentSocket(wsB, 5, "mac-b");

  const got = [];
  const gotB = [];
  const offA = reg.subscribePtyOutput("sid1", (d) => got.push(d), "mac-a");
  const offB = reg.subscribePtyOutput("sid1", (d) => gotB.push(d), "mac-b");

  // Machine A pushes pty.output for sid1 → only A's subscriber sees it.
  wsA.emit("message", JSON.stringify({ type: "event", event: "pty.output", sessionId: "sid1", data: "from-a" }));
  wsB.emit("message", JSON.stringify({ type: "event", event: "pty.output", sessionId: "sid1", data: "from-b" }));
  assert.deepEqual(got, ["from-a"]);
  assert.deepEqual(gotB, ["from-b"]);

  // pty.exit routes the same way.
  const exits = [];
  reg.subscribePtyExit("sid1", (c) => exits.push(c), "mac-a");
  wsA.emit("message", JSON.stringify({ type: "event", event: "pty.exit", sessionId: "sid1", code: 3 }));
  assert.deepEqual(exits, [3]);

  offA();
  offB();
  wsA.close();
  wsB.close();
});

test("registry: pairing codes bind to the minting user and label", () => {
  resetRegistry();
  const pc = reg.createPairingCode(9, "服务器");
  const consumed = reg.consumePairingCode(pc.code);
  assert.deepEqual(consumed, { userId: 9, label: "服务器" });
  assert.equal(reg.consumePairingCode(pc.code), null, "single use");
});
