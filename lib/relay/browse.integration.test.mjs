import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";
import { WebSocket, WebSocketServer } from "ws";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * Integration check for the local-machine browse API: the relay forwards the
 * project directory as the per-request `base` (agent >= 0.3.0) or as a
 * root-relative path (legacy agents). A fake agent speaks the wire protocol
 * over a real WebSocket so the registry/forward path is exercised too.
 */

async function withFakeAgent(info, fn) {
  const registry = await jiti.import("./registry.ts");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const port = wss.address().port;
  const received = [];
  let client;

  const connected = new Promise((resolve) => {
    wss.once("connection", (serverWs) => {
      registry.attachAgentSocket(serverWs, 42, "m-test");
      resolve();
    });
  });
  client = new WebSocket(`ws://127.0.0.1:${port}`);
  await Promise.all([connected, new Promise((resolve) => client.once("open", resolve))]);

  client.on("message", (raw) => {
    const req = JSON.parse(raw.toString());
    received.push(req);
    let result;
    if (req.method === "fs.list") {
      result = [{ name: "src", path: "src", isDir: true, size: 0, mtime: 0 }];
    } else if (req.method === "fs.stat") {
      result = { path: req.params.path, exists: true, isDir: true, size: 0, mtime: 0 };
    } else {
      result = { ok: true };
    }
    client.send(JSON.stringify({ id: req.id, ok: true, result }));
  });
  client.send(JSON.stringify({ type: "hello", info }));
  // Let the registry consume the hello before the first RPC.
  await new Promise((resolve) => setTimeout(resolve, 25));

  try {
    await fn(received);
  } finally {
    client.close();
    wss.close();
    registry.disconnectMachine(42, "m-test");
  }
}

test("browse + mkdir carry the absolute workspace as `base` (agent >= 0.2.0)", async () => {
  const browse = await jiti.import("./browse.ts");
  await withFakeAgent(
    {
      hostname: "fake", os: "linux", arch: "amd64", workspaceRoot: "/srv/shared",
      agentVersion: "0.3.0", machineId: "m-test", features: ["workspace-base"],
    },
    async (received) => {
      const listing = await browse.browseAgentDirectory(42, "m-test", "/data/proj");
      assert.deepEqual(listing, {
        path: "/data/proj",
        parentPath: "/data",
        directories: [{ name: "src", path: "/data/proj/src" }],
      });
      assert.deepEqual(received[0].params, { path: ".", base: "/data/proj" });

      const created = await browse.createAgentDirectory(42, "m-test", "/data/proj", "new-dir");
      assert.equal(created, "/data/proj/new-dir");
      assert.deepEqual(received[1].params, { path: "new-dir", base: "/data/proj" });

      // Project creation validates the workdir with fs.stat, scoped to its parent.
      const validated = await browse.validateAgentDirectory(42, "m-test", "/data/proj");
      assert.equal(validated, "/data/proj");
      assert.deepEqual(received[2].params, { path: "proj", base: "/data" });
    },
  );
});

test("legacy agent: nested workspace becomes a root-relative path, outside root errors", async () => {
  const browse = await jiti.import("./browse.ts");
  await withFakeAgent(
    {
      hostname: "fake", os: "linux", arch: "amd64", workspaceRoot: "/srv/shared",
      agentVersion: "0.3.0", machineId: "m-test",
    },
    async (received) => {
      const listing = await browse.browseAgentDirectory(42, "m-test", "/srv/shared/projects/demo");
      assert.equal(listing.path, "/srv/shared/projects/demo");
      assert.deepEqual(received[0].params, { path: "projects/demo" });

      await assert.rejects(
        () => browse.browseAgentDirectory(42, "m-test", "/data/elsewhere"),
        /不在本机 Agent 的共享根/,
      );
    },
  );
});
