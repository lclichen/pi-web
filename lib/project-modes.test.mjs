import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Batch 3: managed Host projects point at an external directory (never
 * deleted by pi-web); Quick projects are stable per (user, template) while
 * their workspaces stay versioned.
 */

const root = mkdtempSync(join(tmpdir(), "project-modes-"));
const dataDir = join(root, "data");
const agentDir = join(root, "agent");
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  createProject,
  deleteProject,
  duplicateProject,
  ensureQuickProject,
  findQuickProject,
  markQuickTemplateMissing,
  projectHome,
  publicProject,
} = await jiti.import("./projects.ts");
const { getQuickTemplate, createQuickTemplate, deleteQuickTemplate } = await jiti.import("./quick-templates.ts");
const { getSessionMeta, recordSessionMeta } = await jiti.import("./session-metas.ts");
const { migrateQuickSessionMetas } = await jiti.import("./quick-project-migration.ts");

test.after(() => {
  delete process.env.PI_WEB_DATA_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(root, { recursive: true, force: true });
});

test("managed Host project uses an external directory and never deletes it", async () => {
  const external = join(root, "external-code");
  mkdirSync(external, { recursive: true });
  const created = await createProject({
    name: "host-managed",
    ownerId: 1,
    ownerName: "admin",
    mode: "host",
    workspaceRoot: external,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.project.mode, "host");
  assert.equal(created.project.workspaceRoot, external);
  assert.equal(projectHome(created.project), external);
  assert.equal("workspaceRoot" in publicProject(created.project), false);

  assert.equal(deleteProject(created.project.id), true);
  assert.equal(existsSync(external), true, "external workspace survives project deletion");
  assert.equal(findQuickProject(1, "x"), undefined);
});

test("Host/Quick projects are not copyable", async () => {
  const external = join(root, "external-copy");
  mkdirSync(external, { recursive: true });
  const created = await createProject({
    name: "host-copy",
    ownerId: 1,
    mode: "host",
    workspaceRoot: external,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const copied = await duplicateProject(created.project.id, "host-copy-2");
  assert.equal(copied.ok, false);
  deleteProject(created.project.id);
});

test("Quick project is stable per owner+template while workspace versions move", async () => {
  const template = getQuickTemplate("default");
  assert.ok(template);
  const first = await ensureQuickProject(7, "u7", template);
  assert.equal(first.mode, "quick");
  assert.equal(first.templateId, "default");
  assert.ok(first.quickDir);
  assert.ok(first.workspaceRoot);
  const firstWorkspace = first.workspaceRoot;

  const again = await ensureQuickProject(7, "u7", template);
  assert.equal(again.id, first.id);

  const edited = { ...template, systemPrompt: `${template.systemPrompt}\n\n版本二` };
  const next = await ensureQuickProject(7, "u7", edited);
  assert.equal(next.id, first.id);
  assert.notEqual(next.quickDir, first.quickDir);
  assert.notEqual(next.workspaceRoot, firstWorkspace);
  assert.ok(existsSync(firstWorkspace), "old workspace version remains addressable");
  assert.ok(existsSync(next.workspaceRoot));
  assert.equal(findQuickProject(7, "default")?.id, first.id);

  markQuickTemplateMissing("default");
  assert.equal(findQuickProject(7, "default")?.templateMissing, true);
  deleteProject(first.id);
});

test("legacy quick session metadata is linked to its project lazily", async () => {
  recordSessionMeta("legacy-quick", {
    mode: "quick",
    ownerId: 9,
    templateId: "default",
    quickDir: "default-legacy",
  });
  assert.equal(await migrateQuickSessionMetas(9), true);
  const meta = getSessionMeta("legacy-quick");
  assert.ok(meta?.projectId);
  assert.equal(findQuickProject(9, "default")?.id, meta.projectId);
  assert.equal(meta?.descriptor?.profile, "quick");
});

test("custom Quick template deletion can mark its project missing", async () => {
  const created = createQuickTemplate({ name: "custom quick", systemPrompt: "hello" });
  assert.ok(created.template);
  const template = created.template;
  const project = await ensureQuickProject(8, "u8", template);
  const deleted = deleteQuickTemplate(template.id);
  assert.equal(deleted.ok, true);
  markQuickTemplateMissing(template.id);
  assert.equal(findQuickProject(8, template.id)?.templateMissing, true);
  deleteProject(project.id);
});

test("Host creation API is admin-gated and uses workspaceRoot; sessions use project branches", () => {
  const api = readFileSync(new URL("../app/api/projects/route.ts", import.meta.url), "utf8");
  assert.match(api, /mode === "host" && identity\.session\.user\.role !== "admin"/);
  assert.match(api, /mode === "host" && workdir \? \{ workspaceRoot: workdir \}/);
  assert.match(api, /mode === "quick"/);

  const agent = readFileSync(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  assert.match(agent, /project\.mode === "host"/);
  assert.match(agent, /project\.mode === "quick"/);
  assert.match(agent, /ensureQuickProject\(/);
  assert.match(agent, /descriptorForProject\(quickProject/);

  const sessions = readFileSync(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8");
  assert.match(sessions, /migrateQuickSessionMetas/);
});
