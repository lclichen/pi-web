import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./EmbedAuthGate.tsx", import.meta.url), "utf8");

test("prefers a short-lived access token from the URL hash", () => {
  assert.match(source, /new URLSearchParams\(window\.location\.hash/);
  assert.match(source, /token\?\.startsWith\("emba_"\)/);
  assert.match(source, /window\.history\.replaceState/);
  assert.match(source, /sessionStorage\.setItem/);
});

test("falls back to an in-iframe API key exchange", () => {
  assert.match(source, /fetch\("\/api\/embed\/auth"/);
  assert.match(source, /body: JSON\.stringify\(\{ projectId: context\.project\.id, apiKey: key \}\)/);
  assert.match(source, /embed\.apiKey/);
  assert.match(source, /embed\.rememberKey/);
  assert.match(source, /localStorage\.setItem/);
});

test("reconnects or switches account without leaking the key into the parent page", () => {
  assert.match(source, /onAuthExpired=\{handleAuthExpired\}/);
  assert.match(source, /onSwitchAccount=\{switchAccount\}/);
  assert.match(source, /localStorage\.removeItem/);
});
