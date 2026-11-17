import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./EmbedConfig.tsx", import.meta.url), "utf8");

test("lists and revokes tokens for the current user", () => {
  assert.match(source, /fetch\("\/api\/embed\/tokens"/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /t\("embed\.revokeConfirm"/);
});

test("keeps product configuration admin-only", () => {
  assert.match(source, /isAdmin && \(/);
  assert.match(source, /fetch\("\/api\/admin\/embed-profiles"/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /allowedCommands/);
  assert.match(source, /allowedOrigins/);
});

test("warns that links are credentials and only shown once", () => {
  assert.match(source, /t\("embed\.tokensHint"\)/);
  assert.match(source, /t\("embed\.commandsHint"\)/);
});
