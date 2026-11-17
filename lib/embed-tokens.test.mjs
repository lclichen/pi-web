import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-tokens-"));
process.env.PI_WEB_DATA_DIR = dataDir;

const {
  createEmbedToken,
  EMBED_TOKEN_MIN_TTL_MS,
  EmbedTokenLimitError,
  getEmbedTokenByRaw,
  hashEmbedToken,
  listEmbedTokens,
  MAX_EMBED_TOKENS_PER_USER,
  revokeEmbedToken,
} = await import("./embed-tokens.ts");

const owner = { id: 7, username: "alice", email: null, role: "user", status: "active" };

function make(ttlMs = 60_000) {
  return createEmbedToken({
    owner,
    productId: "default",
    scope: { kind: "project", projectId: "p1", cwd: "/data/p1" },
    allowedRoots: ["/data/p1"],
    mode: "sandbox",
    label: "Project One",
    apiKey: "",
    apiKeyId: 3,
    ttlMs,
  });
}

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test("creates a one-time raw token and stores only its hash", () => {
  const { token, record } = make();
  assert.match(token, /^emb_[A-Za-z0-9_-]{40,}$/);
  assert.equal(record.tokenHash, hashEmbedToken(token));
  const resolved = getEmbedTokenByRaw(token);
  assert.equal(resolved?.id, record.id);
  assert.equal(resolved?.scope.kind, "project");
  assert.deepEqual(resolved?.allowedRoots, ["/data/p1"]);
});

test("clamps short TTLs to the minimum and never stores the raw token", () => {
  const { record } = make(1);
  assert.ok(record.expiresAt - record.createdAt >= EMBED_TOKEN_MIN_TTL_MS);
  const view = listEmbedTokens({ ownerId: owner.id })[0];
  assert.ok(view);
  assert.equal("tokenHash" in view, false);
  assert.equal("apiKey" in view, false);
});

test("expired tokens stop resolving and are removed", () => {
  const { token, record } = make();
  const store = globalThis.__piEmbedTokens;
  const stored = store.tokens.find((entry) => entry.id === record.id);
  assert.ok(stored);
  stored.expiresAt = Date.now() - 1;
  assert.equal(getEmbedTokenByRaw(token), null);
  assert.equal(listEmbedTokens({ ownerId: owner.id }).some((entry) => entry.id === record.id), false);
});

test("owner/admin revocation only", () => {
  const { record } = make();
  assert.equal(revokeEmbedToken(record.id, 999, false), undefined);
  assert.ok(revokeEmbedToken(record.id, 999, true));
  assert.equal(getEmbedTokenByRaw("emb_missing"), null);
});

test("caps active tokens per user", () => {
  const limitedOwner = { ...owner, id: 99 };
  for (let i = 0; i < MAX_EMBED_TOKENS_PER_USER; i += 1) {
    createEmbedToken({
      owner: limitedOwner,
      productId: "default",
      scope: { kind: "host", cwd: dataDir },
      allowedRoots: [dataDir],
      mode: "host",
      label: `token-${i}`,
      apiKey: "",
      apiKeyId: "",
      ttlMs: 60_000,
    });
  }
  assert.throws(
    () =>
      createEmbedToken({
        owner: limitedOwner,
        productId: "default",
        scope: { kind: "host", cwd: dataDir },
        allowedRoots: [dataDir],
        mode: "host",
        label: "too-many",
        apiKey: "",
        apiKeyId: "",
        ttlMs: 60_000,
      }),
    EmbedTokenLimitError,
  );
});
