import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * .apkg v2 recipient metadata: pi-web only reads the public key. The private
 * key is sealed into the decryption binary and is never present here.
 */

const dataDir = mkdtempSync(join(tmpdir(), "apkg-recipient-"));
process.env.PI_WEB_DATA_DIR = dataDir;
delete process.env.PI_WEB_APKG_RECIPIENT;

const { getApkgIdentityInfo } = await import("./apkg.ts");

function publicIdentity() {
  const { publicKey } = generateKeyPairSync("x25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const id = `r_${createHash("sha256").update(pub).digest("hex").slice(0, 16)}`;
  return { id, pub: pub.toString("base64url") };
}

test("missing recipient metadata is reported without inventing keys or paths", () => {
  const info = getApkgIdentityInfo();
  assert.equal(info.configured, false);
  assert.equal(info.id, null);
  assert.equal(info.publicKey, null);
  assert.match(info.error ?? "", /未启用|联系管理员/);
});

test("data-dir recipient file exposes id/public key and never a private key", () => {
  const pair = publicIdentity();
  writeFileSync(
    join(dataDir, "apkg-recipient.json"),
    JSON.stringify({ version: 2, id: pair.id, publicKey: pair.pub }),
  );
  const info = getApkgIdentityInfo();
  assert.equal(info.configured, true);
  assert.equal(info.id, pair.id);
  assert.equal(info.publicKey, pair.pub);
  assert.ok(!JSON.stringify(info).includes("privateKey"));
  assert.ok(!("path" in info));
  assert.ok(!("source" in info));
});

test("PI_WEB_APKG_RECIPIENT takes precedence over the data-dir file", () => {
  const pair = publicIdentity();
  const envFile = join(dataDir, "env-recipient.json");
  writeFileSync(envFile, JSON.stringify({ version: 2, id: pair.id, publicKey: pair.pub }));
  process.env.PI_WEB_APKG_RECIPIENT = envFile;
  try {
    const info = getApkgIdentityInfo();
    assert.equal(info.configured, true);
    assert.equal(info.id, pair.id);
  } finally {
    delete process.env.PI_WEB_APKG_RECIPIENT;
  }
});

test("malformed recipient metadata is rejected rather than half-loaded", () => {
  writeFileSync(join(dataDir, "apkg-recipient.json"), "{not json");
  const info = getApkgIdentityInfo();
  assert.equal(info.configured, false);
  assert.match(info.error ?? "", /未启用|联系管理员/);
});

test("dev identity file exposes only public metadata", () => {
  rmSync(join(dataDir, "apkg-recipient.json"), { force: true });
  const pair = publicIdentity();
  const devFile = join(dataDir, "dev-identity.json");
  writeFileSync(
    devFile,
    JSON.stringify({
      version: 2,
      id: pair.id,
      publicKey: pair.pub,
      privateKey: "secret-private-key-value",
    }),
  );
  process.env.PI_WEB_APKG_IDENTITY = devFile;
  try {
    const info = getApkgIdentityInfo();
    assert.equal(info.configured, true);
    assert.equal(info.dev, true);
    assert.equal(info.id, pair.id);
    assert.equal(info.publicKey, pair.pub);
    assert.ok(!JSON.stringify(info).includes("privateKey"));
    assert.ok(!JSON.stringify(info).includes("secret-private-key-value"));
    assert.ok(!("path" in info));
    assert.ok(!("source" in info));
  } finally {
    delete process.env.PI_WEB_APKG_IDENTITY;
  }
});
