import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * .apkg v2 identity resolution: the private key is embedded in the release,
 * never returned by the admin API; the public key is exposed for the publisher.
 */

const dataDir = mkdtempSync(join(tmpdir(), "apkg-identity-"));
process.env.PI_WEB_DATA_DIR = dataDir;
delete process.env.PI_WEB_APKG_IDENTITY;

const { getApkgIdentityInfo, loadApkgIdentity } = await import("./apkg.ts");

function identityPair() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const priv = privateKey.export({ format: "jwk" }).d;
  const id = `r_${createHash("sha256").update(pub).digest("hex").slice(0, 16)}`;
  return { id, pub: pub.toString("base64url"), priv };
}

test("missing identity is reported without inventing keys or paths", () => {
  const info = getApkgIdentityInfo();
  assert.equal(info.configured, false);
  assert.equal(info.id, null);
  assert.equal(info.publicKey, null);
  assert.match(info.error ?? "", /apkg-identity/);
});

test("data-dir identity exposes id/public key only", () => {
  const pair = identityPair();
  writeFileSync(
    join(dataDir, "apkg-identity.json"),
    JSON.stringify({ version: 2, id: pair.id, publicKey: pair.pub, privateKey: pair.priv }),
  );
  const info = getApkgIdentityInfo();
  assert.equal(info.configured, true);
  assert.equal(info.id, pair.id);
  assert.equal(info.publicKey, pair.pub);
  assert.equal(info.source, "data");
  assert.ok(!JSON.stringify(info).includes(pair.priv));
  assert.equal(loadApkgIdentity()?.identity.privateKey, pair.priv);
});

test("PI_WEB_APKG_IDENTITY takes precedence over the data-dir identity", () => {
  const pair = identityPair();
  const envFile = join(dataDir, "env-identity.json");
  writeFileSync(envFile, JSON.stringify({ version: 2, id: pair.id, publicKey: pair.pub, privateKey: pair.priv }));
  process.env.PI_WEB_APKG_IDENTITY = envFile;
  try {
    const info = getApkgIdentityInfo();
    assert.equal(info.configured, true);
    assert.equal(info.id, pair.id);
    assert.equal(info.source, "env");
  } finally {
    delete process.env.PI_WEB_APKG_IDENTITY;
  }
});

test("malformed identity is rejected rather than half-loaded", () => {
  writeFileSync(join(dataDir, "apkg-identity.json"), "{not json");
  const info = getApkgIdentityInfo();
  assert.equal(info.configured, false);
  assert.match(info.error ?? "", /格式无效/);
});
