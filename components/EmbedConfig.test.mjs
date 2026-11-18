import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./EmbedConfig.tsx", import.meta.url), "utf8");

test("keeps product configuration admin-only", () => {
  assert.match(source, /if \(!isAdmin\)/);
  assert.match(source, /fetch\("\/api\/admin\/embed-profiles"/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /allowedCommands/);
  assert.match(source, /allowedOrigins/);
});

test("edits the product user group, fixed bundle, and default mode", () => {
  assert.match(source, /embed\.members/);
  assert.match(source, /members: \[\.\.\.members, user\.id\]/);
  assert.match(source, /fetch\(`\/api\/admin\/users\?search=/);
  assert.match(source, /embed\.configBundle/);
  assert.match(source, /embed\.defaultMode/);
  assert.match(source, /\/api\/bundles/);
});

test("does not expose legacy token links anymore", () => {
  assert.doesNotMatch(source, /\/api\/embed\/tokens/);
  assert.doesNotMatch(source, /embed\.tokens/);
  assert.doesNotMatch(source, /copyLink/);
});
