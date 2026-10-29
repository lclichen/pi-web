import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * .apkg KEK store administration: the admin UI may add/rotate/revoke keys but
 * must never read them back. These tests pin the write-only contract (list
 * results carry metadata only), the env-override precedence, and the 0600
 * storage mode.
 */

process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "apkg-keys-"));
delete process.env.PI_WEB_APKG_KEYS;

const { addApkgKey, listApkgKeys, removeApkgKey, getApkgKeys } = await import("./apkg.ts");

function kekOf(byte) {
  return Buffer.alloc(32, byte);
}

test("add → list exposes metadata only; material stays server-side", () => {
  const key = addApkgKey("prod-2026-10", kekOf(7), "admin");
  assert.equal(key.keyId, "prod-2026-10");
  assert.equal(key.source, "file");
  assert.equal(key.addedBy, "admin");
  assert.ok(key.addedAt);

  const listed = listApkgKeys();
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ["addedAt", "addedBy", "keyId", "source"]);
  // Write-only: no serialized field may carry the KEK (base64 or otherwise).
  assert.ok(!JSON.stringify(listed).includes(kekOf(7).toString("base64")));

  // The runtime loader still resolves the material for decryption.
  assert.deepEqual(getApkgKeys()["prod-2026-10"], kekOf(7));

  // Storage is private (0600) on POSIX; Windows ignores mode but the file exists.
  const mode = statSync(join(process.env.PI_WEB_DATA_DIR, "apkg-keys.json")).mode;
  if (process.platform !== "win32") assert.equal(mode & 0o777, 0o600);
});

test("same keyId rotates the material in place", () => {
  addApkgKey("prod-2026-10", kekOf(9), "admin");
  assert.deepEqual(getApkgKeys()["prod-2026-10"], kekOf(9));
  assert.equal(listApkgKeys().length, 1, "rotation must not duplicate the keyId");
});

test("revoke removes the key; repeated revoke reports not-found", () => {
  removeApkgKey("prod-2026-10");
  assert.equal(listApkgKeys().length, 0);
  assert.equal(getApkgKeys()["prod-2026-10"], undefined);
  assert.throws(() => removeApkgKey("prod-2026-10"), /not-found/);
});

test("PI_WEB_APKG_KEYS is authoritative: cannot be shadowed or revoked", () => {
  process.env.PI_WEB_APKG_KEYS = JSON.stringify({ "env-key": kekOf(3).toString("base64") });
  try {
    const listed = listApkgKeys();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].source, "env");
    assert.deepEqual(getApkgKeys()["env-key"], kekOf(3));

    assert.throws(() => addApkgKey("env-key", kekOf(4), "admin"), /env-sourced/);
    assert.throws(() => removeApkgKey("env-key"), /env-not-removable/);
  } finally {
    delete process.env.PI_WEB_APKG_KEYS;
  }
});

test("validation rejects hostile keyIds and wrong-size KEKs", () => {
  assert.throws(() => addApkgKey("../escape", kekOf(1), "admin"), /invalid-key-id/);
  assert.throws(() => addApkgKey("k".repeat(65), kekOf(1), "admin"), /invalid-key-id/);
  assert.throws(() => addApkgKey("ok", Buffer.alloc(16, 1), "admin"), /invalid-kek/);
});

test("a corrupt key store degrades to an empty list instead of throwing", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(process.env.PI_WEB_DATA_DIR, "apkg-keys.json"), "{not json", "utf8");
  assert.deepEqual(listApkgKeys(), []);
  assert.deepEqual(getApkgKeys(), {});
  // Restore a clean store for the remaining assertions.
  writeFileSync(join(process.env.PI_WEB_DATA_DIR, "apkg-keys.json"), "{}", "utf8");
});
