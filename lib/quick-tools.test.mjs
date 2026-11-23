import assert from "node:assert/strict";
import test from "node:test";

const { quickToolAllowed, quickToolNames, quickToolAllowlist, serversForQuickTools } = await import("./quick-tools.ts");

test("quick tool allowlist is a closed world: empty/absent means zero tools", () => {
  assert.equal(quickToolAllowed("weather_now", undefined), false);
  assert.equal(quickToolAllowed("weather_now", { servers: [], tools: [] }), false);
  assert.deepEqual(quickToolNames(["weather_now"], undefined), []);
});

test("tool-level entries match exact adapter names only", () => {
  const allow = { servers: [], tools: ["weather_now"] };
  assert.equal(quickToolAllowed("weather_now", allow), true);
  assert.equal(quickToolAllowed("weather_tomorrow", allow), false);
  assert.equal(quickToolAllowed("db_query", allow), false);
  assert.deepEqual(quickToolNames(["weather_now", "weather_tomorrow", "weather_now"], allow), ["weather_now"]);
});

test("whole-server grants match the full <server>_ prefix, including underscores", () => {
  const allow = { servers: ["mcd_tool_1"], tools: [] };
  assert.equal(quickToolAllowed("mcd_tool_1_now-time-info", allow), true);
  assert.equal(quickToolAllowed("mcd_tool_2_now-time-info", allow), false);
  // A server name is not a prefix of an unrelated sibling that only shares text.
  assert.equal(quickToolAllowed("mcd_tool_10_x", allow), false);
});

test("servers and tools are unioned", () => {
  const allow = quickToolAllowlist({ mcpServers: ["weather"], mcpTools: ["db_query"] });
  assert.deepEqual(quickToolNames(["weather_now", "db_query", "other_x"], allow), ["weather_now", "db_query"]);
});

test("tool entries map back to the longest known server name", () => {
  assert.deepEqual(serversForQuickTools(["mcd_tool_1_now-time-info"], ["mcd", "mcd_tool_1"]), ["mcd_tool_1"]);
  assert.deepEqual(serversForQuickTools(["unknown_tool"], ["weather"]), []);
  assert.deepEqual(serversForQuickTools(["weather_now", "weather_tomorrow"], ["weather"]), ["weather"]);
});

test("allowlist normalization trims empties but keeps explicit empty arrays", () => {
  assert.deepEqual(quickToolAllowlist({ mcpServers: [], mcpTools: [] }), { servers: [], tools: [] });
  assert.deepEqual(quickToolAllowlist({ mcpServers: [" weather "], mcpTools: [" db_query "] }), {
    servers: ["weather"],
    tools: ["db_query"],
  });
});
