import assert from "node:assert/strict";
import test from "node:test";

const {
  createEmbedAccessToken,
  getEmbedAccessToken,
  hashEmbedAccessToken,
  revokeEmbedAccessForProduct,
  revokeEmbedAccessToken,
} = await import("./embed-access.ts");

const user = { id: 11, username: "alice", email: null, role: "user", status: "active" };

function create(productId = "demo", ttlMs = 60_000) {
  return createEmbedAccessToken({
    user,
    apiKey: "",
    productId,
    scope: { kind: "project", projectId: "p1", cwd: "/data/p1" },
    allowedRoots: ["/data/p1"],
    mode: "local-machine",
    label: "P1",
    ttlMs,
  });
}

test("creates an in-memory token and resolves it by hash", () => {
  const { token, record } = create();
  assert.match(token, /^emba_[A-Za-z0-9_-]{40,}$/);
  assert.equal(record.tokenHash, hashEmbedAccessToken(token));
  const resolved = getEmbedAccessToken(token);
  assert.equal(resolved?.scope.projectId, "p1");
  assert.equal(resolved?.userId, user.id);
});

test("rejects expired and revoked tokens", () => {
  const { token, record } = create();
  globalThis.__piEmbedAccess.get(record.tokenHash).expiresAt = Date.now() - 1;
  assert.equal(getEmbedAccessToken(token), null);

  const second = create();
  assert.equal(revokeEmbedAccessToken(second.token), true);
  assert.equal(getEmbedAccessToken(second.token), null);
});

test("revokes all tokens for a product when its group/config changes", () => {
  const a = create("product-a");
  const b = create("product-b");
  assert.equal(revokeEmbedAccessForProduct("product-a"), 1);
  assert.equal(getEmbedAccessToken(a.token), null);
  assert.ok(getEmbedAccessToken(b.token));
});
