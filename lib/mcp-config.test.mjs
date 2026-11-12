import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// mcp-config reads quick scope from dataDir(); isolate it before importing.
process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "mcp-config-data-"));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const {
  readMcpConfig,
  setMcpServerDisabledViaProject,
  migrateLegacyMcpTimeoutsForSession,
  writeMcpSettings,
} = await jiti.import("./mcp-config.ts");

/**
 * 全局/快速 MCP 在当前项目的关闭 = .pi/mcp.json 里的 {disabled:true} 墓碑
 * （pi-mcp-adapter 的优先级规则）。读取时必须把它合并回原始条目展示，
 * 不能把只有 disabled 的空壳当成服务器配置。
 */

function projectConfig(cwd, servers) {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

test("project tombstone merges into the underlying quick server (disabled + projectOverride)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
  writeFileSync(
    join(process.env.PI_WEB_DATA_DIR, "mcp-quick.json"),
    JSON.stringify({ mcpServers: { demo: { command: "node", args: ["srv.js"] } } }),
  );
  projectConfig(cwd, { demo: { disabled: true } });

  const doc = readMcpConfig(cwd, { scopes: ["project", "quick"] });
  assert.equal(doc.servers.length, 1);
  const srv = doc.servers[0];
  assert.equal(srv.name, "demo");
  assert.equal(srv.scope, "quick", "display keeps the real config's scope");
  assert.equal(srv.entry.command, "node");
  assert.equal(srv.disabled, true);
  assert.equal(srv.scopeDisabled, false, "the quick entry itself is not disabled");
  assert.equal(srv.projectOverride, true);
});

test("removing the project override restores the underlying server", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
  writeFileSync(
    join(process.env.PI_WEB_DATA_DIR, "mcp-quick.json"),
    JSON.stringify({ mcpServers: { demo: { command: "node" } } }),
  );
  projectConfig(cwd, { demo: { disabled: true } });

  setMcpServerDisabledViaProject(cwd, "demo", false);
  const doc = readMcpConfig(cwd, { scopes: ["project", "quick"] });
  assert.equal(doc.servers[0].disabled, false);
  assert.equal(doc.servers[0].projectOverride, undefined);
  assert.equal(doc.servers[0].scope, "quick");
  const stored = JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8"));
  assert.equal(stored.mcpServers.demo, undefined, "disabled-only tombstone is removed entirely");
});

test("project-scope servers toggle their own disabled flag without a projectOverride marker", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
  projectConfig(cwd, { local: { command: "node" } });

  setMcpServerDisabledViaProject(cwd, "local", true);
  const off = readMcpConfig(cwd, { scopes: ["project"] }).servers[0];
  assert.equal(off.disabled, true);
  assert.equal(off.scopeDisabled, true);
  assert.equal(off.projectOverride, undefined);

  setMcpServerDisabledViaProject(cwd, "local", false);
  const on = readMcpConfig(cwd, { scopes: ["project"] }).servers[0];
  assert.equal(on.disabled, false);
  assert.equal(on.scopeDisabled, false);
});

test("a real project entry with disabled:true is not treated as a tombstone", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
  projectConfig(cwd, { local: { command: "node", disabled: true } });
  const srv = readMcpConfig(cwd, { scopes: ["project"] }).servers[0];
  assert.equal(srv.disabled, true);
  assert.equal(srv.scope, "project");
  assert.equal(srv.entry.command, "node");
  assert.equal(srv.projectOverride, undefined);
});

test("legacy toolTimeoutMs is migrated to adapter's requestTimeoutMs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
  projectConfig(cwd, {
    legacy: { command: "node", toolTimeoutMs: 1_800_000 },
    already: { command: "node", requestTimeoutMs: 5_000, toolTimeoutMs: 999_999 },
  });
  migrateLegacyMcpTimeoutsForSession(cwd);
  const stored = JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8"));
  assert.equal(stored.mcpServers.legacy.requestTimeoutMs, 1_800_000);
  assert.equal(stored.mcpServers.legacy.toolTimeoutMs, undefined);
  assert.equal(stored.mcpServers.already.requestTimeoutMs, 5_000, "existing requestTimeoutMs wins");
  assert.equal(stored.mcpServers.already.toolTimeoutMs, undefined);
});

test("saving MCP settings preserves adapter fields the UI does not know", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "mcp.json"),
    JSON.stringify({
      mcpServers: {},
      settings: { allowInstall: false, requestTimeoutMs: 60_000, deferWithMissingMetadata: true },
    }),
  );
  writeMcpSettings(cwd, "project", { requestTimeoutMs: 120_000, idleTimeout: 15 });
  const saved = JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8"));
  assert.equal(saved.settings.requestTimeoutMs, 120_000);
  assert.equal(saved.settings.idleTimeout, 15);
  assert.equal(saved.settings.allowInstall, false);
  assert.equal(saved.settings.deferWithMissingMetadata, true);

  writeMcpSettings(cwd, "project", { requestTimeoutMs: undefined });
  const cleared = JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8"));
  assert.equal(cleared.settings.requestTimeoutMs, undefined);
  assert.equal(cleared.settings.allowInstall, false);
});
