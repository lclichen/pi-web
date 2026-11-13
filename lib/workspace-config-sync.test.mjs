import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { collectWorkspaceConfig, planWorkspaceConfigSync, applyWorkspaceConfigSync } =
  await jiti.import("./workspace-config-sync.ts");

function fakeWorkspace(files) {
  const dirs = new Set([".pi"]);
  for (const rel of Object.keys(files)) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  const all = new Set([...dirs, ...Object.keys(files)]);
  const parentOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
  return {
    version: 1,
    root: "/workspace",
    capabilities: { read: true, write: true, exec: true, grep: true, find: true },
    async canonicalize(path) {
      if (path.split("/").some((p) => p === "..")) throw new Error("escape");
      return `/${path.replace(/^\/+/, "")}`;
    },
    async stat(path) {
      if (dirs.has(path)) return { isFile: false, isDirectory: true, size: 0, mtimeMs: 1 };
      if (path in files) {
        const content = Buffer.from(files[path]);
        return { isFile: true, isDirectory: false, size: content.length, mtimeMs: 1 };
      }
      throw new Error(`NOT_FOUND ${path}`);
    },
    async readdir(path) {
      return [...all]
        .filter((entry) => parentOf(entry) === path && entry !== path)
        .map((entry) => ({ name: entry.slice(path.length + 1), isDirectory: dirs.has(entry), size: 0 }));
    },
    async readFile(path) {
      if (!(path in files)) throw new Error(`NOT_FOUND ${path}`);
      return Buffer.from(files[path]);
    },
    async writeFile() {},
    async mkdir() {},
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function baseTree() {
  return {
    ".pi/agents/reviewer.md": "---\ndescription: review\n---\nReview.\n",
    ".pi/skills/lint/SKILL.md": "---\nname: lint\ndescription: lint\n---\nLint.\n",
    ".pi/skills/lint/references/rules.md": "rules\n",
    ".pi/mcp.json": JSON.stringify({ mcpServers: { web: { url: "https://mcp.example/mcp" } } }),
    ".pi/models.json": JSON.stringify({ providers: { p: { models: [{ id: "m" }] } } }),
    ".pi/auth.json": '{"token":"SECRET"}',
    ".pi/ssh.json": '{"password":"SECRET"}',
    ".pi/sandbox-platform.json": '{"apiKey":"SECRET"}',
    ".pi/path-policy.scope.json": "{}",
    ".pi/sandbox-sync.json": "{}",
    ".pi/extensions/pi-sandbox-extension/index.js": "legacy",
    ".pi/sessions/s1.jsonl": "{}",
    ".pi/tmp/scratch": "x",
    ".pi/plans/plan.md": "p",
  };
}

test("collect reads only allowed .pi files and reports denied runtime files", async () => {
  const ws = fakeWorkspace(baseTree());
  const collected = await collectWorkspaceConfig(ws);
  const paths = collected.files.map((f) => f.rel).sort();
  assert.deepEqual(paths, [
    ".pi/agents/reviewer.md",
    ".pi/mcp.json",
    ".pi/skills/lint/SKILL.md",
    ".pi/skills/lint/references/rules.md",
  ]);
  const skipped = collected.skipped.join("\n");
  assert.match(skipped, /\.pi\/models\.json/);
  assert.match(skipped, /\.pi\/auth\.json/);
  assert.match(skipped, /\.pi\/ssh\.json/);
  assert.match(skipped, /\.pi\/sandbox-platform\.json/);
  assert.match(skipped, /\.pi\/path-policy\.scope\.json/);
  assert.match(skipped, /\.pi\/sandbox-sync\.json/);
  assert.match(skipped, /\.pi\/extensions\/pi-sandbox-extension/);
  assert.match(skipped, /\.pi\/sessions/);
  assert.match(skipped, /\.pi\/tmp/);
  assert.match(skipped, /\.pi\/plans/);
});

test("plan computes added/overwritten/unchanged without writing", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "workspace-sync-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".pi", "skills", "lint"), { recursive: true });
  await mkdir(join(home, ".pi", "agents"), { recursive: true });
  await writeFile(join(home, ".pi", "agents", "reviewer.md"), "old\n");
  await writeFile(join(home, ".pi", "models.json"), baseTree()[".pi/models.json"]);
  await writeFile(join(home, ".pi", "auth.json"), '{"token":"KEEP"}');

  const collected = await collectWorkspaceConfig(fakeWorkspace(baseTree()));
  const plan = await planWorkspaceConfigSync(home, collected, { mode: "sandbox", allowStdioMcp: false });
  assert.equal(plan.stats.files, 4);
  assert.equal(plan.stats.added, 3); // skill files + mcp.json
  assert.equal(plan.stats.overwritten, 1); // agents/reviewer.md changed
  assert.equal(plan.stats.unchanged, 0);
  assert.equal(plan.stats.skipped, 10); // includes models.json (sync deny)
  assert.equal(await readFile(join(home, ".pi", "agents", "reviewer.md"), "utf8"), "old\n");

  await applyWorkspaceConfigSync(home, plan);
  assert.equal(
    await readFile(join(home, ".pi", "agents", "reviewer.md"), "utf8"),
    baseTree()[".pi/agents/reviewer.md"],
  );
  assert.equal(await readFile(join(home, ".pi", "auth.json"), "utf8"), '{"token":"KEEP"}');
});

test("invalid mcp.json aborts before any file is written", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "workspace-sync-invalid-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const files = {
    ".pi/agents/a.md": "a\n",
    ".pi/mcp.json": JSON.stringify({ mcpServers: { broken: {} } }),
  };
  const collected = await collectWorkspaceConfig(fakeWorkspace(files));
  await assert.rejects(
    () => planWorkspaceConfigSync(home, collected, { mode: "sandbox", allowStdioMcp: true }),
    /缺少 command/,
  );
  await assert.rejects(() => readFile(join(home, ".pi", "agents", "a.md")), /ENOENT/);
});

test("stdio MCP is gated by user role and then by the project mode policy", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "workspace-sync-mcp-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stdio = {
    ".pi/mcp.json": JSON.stringify({ mcpServers: { local: { command: "node", args: ["srv.js"] } } }),
  };
  const collected = await collectWorkspaceConfig(fakeWorkspace(stdio));

  await assert.rejects(
    () => planWorkspaceConfigSync(home, collected, { mode: "sandbox", allowStdioMcp: false }),
    /普通用户不可导入/,
  );
  await assert.rejects(
    () => planWorkspaceConfigSync(home, collected, { mode: "sandbox", allowStdioMcp: true }),
    /工具模式检查未通过/,
  );

  const hostPlane = {
    ".pi/mcp.json": JSON.stringify({
      mcpServers: { local: { command: "node", args: ["srv.js"], piWeb: { plane: "host" } } },
    }),
  };
  const allowed = await collectWorkspaceConfig(fakeWorkspace(hostPlane));
  const plan = await planWorkspaceConfigSync(home, allowed, { mode: "sandbox", allowStdioMcp: true });
  assert.equal(plan.stats.added, 1);
});
