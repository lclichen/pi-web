import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./PlatformAdminDialog.tsx", import.meta.url), "utf8");

test("platform admin tabs are grouped in one row and keep domains together", () => {
  assert.match(source, /role="tablist"/);
  assert.match(source, /ADMIN_TABS\[index - 1\]\.group !== item\.group/);
  const tabs = [...source.matchAll(/\{ id: "([a-z]+)", label: "admin\.([a-zA-Z]+)", group: "([a-z]+)" \}/g)].map(
    (match) => [match[1], match[3]],
  );
  assert.deepEqual(tabs, [
    ["overview", "overview"],
    ["users", "access"],
    ["quotas", "access"],
    ["containers", "sandbox"],
    ["images", "sandbox"],
    ["workspaces", "sandbox"],
    ["logs", "audit"],
  ]);
});

test("per-user LLM virtual keys and budgets are gone from the admin UI", () => {
  assert.doesNotMatch(source, /LlmTab|LlmBindingRow|admin\.llm|virtual-key budgets/);
  assert.doesNotMatch(source, /id: "llm"/);
  assert.match(source, /title=\{t\("i18n\.close"\)\}/);
});
