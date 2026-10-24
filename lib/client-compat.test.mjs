import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * agent-client version contract (lib/client-compat.ts): the WebUI refuses
 * clients older than REQUIRED_CLIENT_VERSION at pairing and flags them at
 * runtime. Bump expectations together with the Go constant.
 */

async function api() {
  return jiti.import("./client-compat.ts");
}

test("version parsing and comparison", async () => {
  const { parseClientVersion, compareClientVersions } = await api();
  assert.deepEqual(parseClientVersion("0.3.0"), [0, 3, 0]);
  assert.deepEqual(parseClientVersion("v1.2.10"), [1, 2, 10]);
  assert.equal(parseClientVersion("unknown"), null);
  assert.equal(compareClientVersions("0.2.9", "0.3.0"), -1);
  assert.equal(compareClientVersions("0.3.0", "0.3.0"), 0);
  assert.equal(compareClientVersions("0.10.0", "0.9.9"), 1);
});

test("required minimum rejects old/unknown clients", async () => {
  const { clientCompatibility, REQUIRED_CLIENT_VERSION } = await api();
  assert.equal(REQUIRED_CLIENT_VERSION, "0.3.0");
  assert.equal(clientCompatibility("0.3.0").compatible, true);
  assert.equal(clientCompatibility("0.4.0").compatible, true);
  const old = clientCompatibility("0.2.0");
  assert.equal(old.compatible, false);
  assert.match(old.message, /0\.3\.0/);
  assert.equal(clientCompatibility(undefined).compatible, false);
  assert.equal(clientCompatibility("unknown").compatible, false);
});

test("asset names cover the shipped platforms", async () => {
  const { clientAssetName } = await api();
  assert.equal(clientAssetName("windows", "amd64"), "agent-client-windows-amd64.exe");
  assert.equal(clientAssetName("linux", "amd64"), "agent-client-linux-amd64");
  assert.equal(clientAssetName("linux", "aarch64"), "agent-client-linux-arm64");
  assert.equal(clientAssetName("darwin", "arm64"), "agent-client-darwin-arm64");
  assert.equal(clientAssetName("mac", "x86_64"), "agent-client-darwin-amd64");
});
