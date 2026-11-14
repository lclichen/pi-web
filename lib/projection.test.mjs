import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataRoot = mkdtempSync(join(tmpdir(), "projection-data-"));
process.env.PI_WEB_DATA_DIR = dataRoot;

async function loadSubject() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  return {
    policy: await jiti.import("./projection/policy.ts"),
    reconcile: await jiti.import("./projection/reconcile.ts"),
    manifest: await jiti.import("./projection/manifest.ts"),
    status: await jiti.import("./projection/status.ts"),
    workspaceApi: await jiti.import("./workspace-operations.ts"),
  };
}

function fakeWorkspace() {
  const files = new Map();
  let tick = 1_000;
  return {
    version: 1,
    root: "/workspace",
    capabilities: { read: true, write: true, exec: false },
    async canonicalize(path) {
      return path;
    },
    async readFile(path) {
      const entry = files.get(path);
      if (!entry) throw new (workspaceApiRef.WorkspaceOperationError)("NOT_FOUND", path);
      return Buffer.from(entry.content);
    },
    async writeFile(path, content) {
      files.set(path, { content: Buffer.from(content), mtimeMs: tick++ });
    },
    async remove(path) {
      files.delete(path);
    },
    async mkdir() {},
    async stat(path) {
      const entry = files.get(path);
      if (!entry) throw new (workspaceApiRef.WorkspaceOperationError)("NOT_FOUND", path);
      return { isFile: true, isDirectory: false, size: entry.content.length, mtimeMs: entry.mtimeMs };
    },
    async readdir() {
      return [];
    },
    async exec() {
      throw new Error("exec not supported in fake workspace");
    },
    _put(rel, content, options = {}) {
      files.set(rel, {
        content: Buffer.from(content),
        mtimeMs: options.mtimeMs ?? tick++,
      });
    },
    _get(rel) {
      const entry = files.get(rel);
      return entry ? Buffer.from(entry.content) : null;
    },
    _has(rel) {
      return files.has(rel);
    },
  };
}

let workspaceApiRef;

function hostHome(files) {
  const home = mkdtempSync(join(tmpdir(), "projection-home-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(home, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  // Fixed mtimes keep the stat fast path deterministic across runs.
  const fixed = new Date("2026-01-01T00:00:00Z");
  return { home, touch: () => setAllMtimes(home, fixed) };
}

function setAllMtimes(dir, date) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, name.name);
    if (name.isDirectory()) setAllMtimes(abs, date);
    else utimesSync(abs, date, date);
  }
}

test.before(async () => {
  const loaded = await loadSubject();
  workspaceApiRef = loaded.workspaceApi;
});

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

test("policy selects only .pi skills/agents/attachments and refuses root workspaces", async () => {
  const { policy } = await loadSubject();
  assert.equal(policy.isProjectedPath(".pi/skills/demo/SKILL.md"), true);
  assert.equal(policy.isProjectedPath(".pi/agents/helper.md"), true);
  assert.equal(policy.isProjectedPath(".pi/attachments/a.png"), true);
  assert.equal(policy.isProjectedPath(".pi/attachments/.upload-tmp"), false);
  assert.equal(policy.isProjectedPath(".pi/.sync-backups/a/b"), false);
  assert.equal(policy.isProjectedPath(".pi/settings.json"), false);
  assert.equal(policy.isProjectedPath("README.md"), false);
  assert.equal(policy.isProjectedPath(".pi/skills/demo/node_modules/lib/a.js"), true);
  assert.equal(policy.isProjectedPath(".pi/skills/demo/.git/config"), false);
  assert.equal(policy.isProjectedPath(".pi/skills/demo/node_modules/.cache/a.js"), false);
  assert.equal(policy.isProjectionDir(".pi"), true);
  assert.equal(policy.isProjectionDir(".pi/skills/demo"), true);
  assert.equal(policy.isProjectionDir(".pi/skills/demo/.git/objects"), false);
  assert.equal(policy.isProjectionDir(".pi/skills/demo/node_modules/.cache"), false);
  assert.equal(policy.isProjectionDir(".pi/sessions"), false);
  assert.equal(policy.projectionRootError("/"), "工作区根目录无效，拒绝投影");
  assert.equal(policy.projectionRootError("D:/"), "工作区根目录是盘符根，拒绝投影");
  assert.equal(policy.projectionRootError("/workspace"), null);
  assert.ok(policy.projectionPriority(".pi/skills/x/node_modules/a.js") > policy.projectionPriority(".pi/skills/x/SKILL.md"));
});

test("first reconcile pushes Host files and the second run adopts them without rewriting", async () => {
  const { reconcile, manifest } = await loadSubject();
  const projectId = "proj-push-1";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({
    ".pi/skills/demo/SKILL.md": "# Demo\n",
    ".pi/agents/helper.md": "helper\n",
    ".pi/attachments/pic.bin": Buffer.from([1, 2, 3, 4]),
    ".pi/settings.json": "{}",
  });
  touch();
  try {
    const meta = { mode: "sandbox", root: "/workspace", backend: "platform#1", key: "1".repeat(32) };
    const first = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(first.errors, []);
    assert.deepEqual([...first.status.pushed].sort(), [
      ".pi/agents/helper.md",
      ".pi/attachments/pic.bin",
      ".pi/skills/demo/SKILL.md",
    ]);
    assert.equal(first.status.truncated, null);

    const second = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(second.status.pushed, []);
    assert.deepEqual([...second.status.adopted].sort(), [
      ".pi/agents/helper.md",
      ".pi/attachments/pic.bin",
      ".pi/skills/demo/SKILL.md",
    ]);
    assert.deepEqual(second.dirty, []);
    const saved = manifest.loadProjectionManifest(projectId, meta.key);
    assert.equal(Object.keys(saved.files).length, 3);
    assert.match(saved.hostDigest, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("local skill edits are kept as dirty until a forced repair", async () => {
  const { reconcile } = await loadSubject();
  const projectId = "proj-dirty-1";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/skills/demo/SKILL.md": "host-v1\n" });
  touch();
  try {
    const meta = { mode: "ssh", root: "/home/u/repo", backend: "10.0.0.5:22", key: "2".repeat(32) };
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    workspace._put(".pi/skills/demo/SKILL.md", "local-edit\n");
    const kept = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(kept.dirty, [".pi/skills/demo/SKILL.md"]);
    assert.deepEqual(kept.status.pushed, []);
    assert.equal(workspace._get(".pi/skills/demo/SKILL.md").toString(), "local-edit\n");

    const repaired = await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      forcePaths: [".pi/skills/demo/SKILL.md"],
    });
    assert.deepEqual(repaired.status.pushed, [".pi/skills/demo/SKILL.md"]);
    assert.deepEqual(repaired.dirty, []);
    assert.equal(workspace._get(".pi/skills/demo/SKILL.md").toString(), "host-v1\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Host deletion propagates to unedited workspace copies but preserves local edits as conflicts", async () => {
  const { reconcile } = await loadSubject();
  const projectId = "proj-delete-1";
  const workspace = fakeWorkspace();
  const files = {
    ".pi/skills/plain/SKILL.md": "plain\n",
    ".pi/skills/edited/SKILL.md": "edited-host\n",
  };
  const { home, touch } = hostHome(files);
  touch();
  const meta = { mode: "local-machine", root: "/repo", backend: "machine-a", key: "3".repeat(32) };
  try {
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    workspace._put(".pi/skills/edited/SKILL.md", "edited-local\n");
    // Resync so the manifest records the local edit as a workspace-only change,
    // which makes the later Host deletion a conflict rather than a delete.
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });

    unlinkSync(join(home, ".pi/skills/plain/SKILL.md"));
    unlinkSync(join(home, ".pi/skills/edited/SKILL.md"));
    const result = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(result.status.deleted, [".pi/skills/plain/SKILL.md"]);
    assert.deepEqual(result.conflicts, [".pi/skills/edited/SKILL.md"]);
    assert.equal(workspace._has(".pi/skills/plain/SKILL.md"), false);
    assert.equal(workspace._get(".pi/skills/edited/SKILL.md").toString(), "edited-local\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("attachments always follow the Host copy and periodic full verification catches stat-equal drift", async () => {
  const { reconcile } = await loadSubject();
  const projectId = "proj-attach-1";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/attachments/pic.bin": Buffer.from([1, 1, 1]) });
  touch();
  const meta = { mode: "sandbox", root: "/workspace", backend: "platform#2", key: "4".repeat(32) };
  try {
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    const entryMtime = workspace.stat(".pi/attachments/pic.bin").then((s) => s.mtimeMs);
    const originalMtime = await entryMtime;

    // Same size, same mtime, different bytes: only the full hash sweep sees it.
    workspace._put(".pi/attachments/pic.bin", Buffer.from([2, 2, 2]), { mtimeMs: originalMtime });
    const fast = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(fast.status.pushed, []);
    assert.equal(workspace._get(".pi/attachments/pic.bin")[0], 2);

    const verified = await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      forceFullVerify: true,
    });
    assert.deepEqual(verified.status.pushed, [".pi/attachments/pic.bin"]);
    assert.deepEqual([...workspace._get(".pi/attachments/pic.bin")], [1, 1, 1]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a changed Host attachment overwrites a locally edited workspace copy", async () => {
  const { reconcile } = await loadSubject();
  const projectId = "proj-attach-2";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/attachments/pic.bin": Buffer.from([1, 1, 1]) });
  touch();
  const meta = { mode: "sandbox", root: "/workspace", backend: "platform#3", key: "5".repeat(32) };
  try {
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    workspace._put(".pi/attachments/pic.bin", Buffer.from([9, 9, 9]));
    writeFileSync(join(home, ".pi/attachments/pic.bin"), Buffer.from([7, 7]));
    const result = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(result.status.pushed, [".pi/attachments/pic.bin"]);
    assert.deepEqual(result.dirty, []);
    assert.deepEqual([...workspace._get(".pi/attachments/pic.bin")], [7, 7]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("workspace key migration inherits the manifest when root and backend are unchanged", async () => {
  const { reconcile, manifest } = await loadSubject();
  const projectId = "proj-migrate-1";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/skills/demo/SKILL.md": "stable\n" });
  touch();
  const oldMeta = { mode: "ssh", root: "/home/u/repo/", backend: "host:22", key: "6".repeat(32) };
  const newMeta = { mode: "ssh", root: "/home/u/repo", backend: "host:22", key: "7".repeat(32) };
  try {
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: oldMeta });
    const result = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: newMeta });
    assert.deepEqual(result.status.pushed, []);
    assert.deepEqual(result.status.adopted, [".pi/skills/demo/SKILL.md"]);
    assert.equal(manifest.loadProjectionManifest(projectId, oldMeta.key), null);
    assert.ok(manifest.loadProjectionManifest(projectId, newMeta.key));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an invalid workspace root is refused without touching the workspace", async () => {
  const { reconcile, status } = await loadSubject();
  const projectId = "proj-root-1";
  const workspace = fakeWorkspace();
  const { home } = hostHome({ ".pi/skills/demo/SKILL.md": "x\n" });
  try {
    const meta = { mode: "local-machine", root: "/", backend: "machine-b", key: "8".repeat(32) };
    const result = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.equal(result.status.pushed.length, 0);
    assert.match(result.errors[0].error, /拒绝投影/);
    assert.equal(workspace._has(".pi/skills/demo/SKILL.md"), false);
    const stored = status.readProjectionStatus(projectId, meta.key);
    assert.match(stored.errors[0].error, /拒绝投影/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dirty flags force a run inside the TTL and a failed attempt waits instead of retrying", async () => {
  const { reconcile } = await loadSubject();
  const projectId = "proj-state-1";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/skills/demo/SKILL.md": "state\n" });
  touch();
  try {
    const meta = { mode: "sandbox", root: "/workspace", backend: "platform#9", key: "9".repeat(32) };
    assert.equal(reconcile.projectionNeedsRun(projectId, 60_000), true, "no state yet");
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.equal(reconcile.projectionNeedsRun(projectId, 60_000), false, "successful run waits the TTL");
    assert.equal(reconcile.isProjectionDirty(projectId), false);
    reconcile.markProjectionDirty(projectId);
    assert.equal(reconcile.projectionNeedsRun(projectId, 60_000), true, "explicit dirty bypasses TTL");
    assert.equal(reconcile.isProjectionDirty(projectId), true);
    reconcile.markProjectionAttempted(projectId);
    assert.equal(reconcile.projectionNeedsRun(projectId, 60_000), false, "failed attempt also waits");
    assert.equal(reconcile.isProjectionDirty(projectId), false);

    // A permanent root error records the attempt instead of retrying every prompt.
    const rootProject = "proj-state-root";
    assert.equal(reconcile.projectionNeedsRun(rootProject, 60_000), true, "no state yet");
    const bad = await reconcile.reconcileProjection({
      projectId: rootProject,
      hostHome: home,
      workspace,
      workspaceMeta: { ...meta, root: "/" },
    });
    assert.ok(bad.errors.length > 0);
    assert.equal(reconcile.projectionNeedsRun(rootProject, 60_000), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent reconciles for one project share a single flight", async () => {
  const { reconcile } = await loadSubject();
  const projectId = "proj-singleflight-1";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/skills/demo/SKILL.md": "one\n" });
  touch();
  try {
    const meta = { mode: "ssh", root: "/repo", backend: "h:22", key: "a".repeat(32) };
    const [a, b] = await Promise.all([
      reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta }),
      reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta }),
    ]);
    assert.equal(a, b, "both callers get the same result object");
    assert.deepEqual(a.status.pushed, [".pi/skills/demo/SKILL.md"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("badge summary is null without a status and counts dirty/conflict/error rows", async () => {
  const { status } = await loadSubject();
  assert.equal(status.projectionBadgeSummary(null), null);
  const pendingOnly = status.projectionBadgeSummary(null, 0, true);
  assert.equal(pendingOnly.pending, true);
  assert.equal(pendingOnly.dirty, 0);
  assert.equal(pendingOnly.fileCount, 0);
  const summary = status.projectionBadgeSummary(
    {
      ...status.emptyProjectionStatus("digest"),
      dirty: ["a", "b"],
      conflicts: ["c"],
      errors: [{ rel: "d", error: "boom" }],
      truncated: { reason: "max-files", skipped: 3 },
      timedOut: true,
      lastVerifiedAt: "2026-01-01T00:00:00.000Z",
    },
    42,
  );
  assert.equal(summary.dirty, 2);
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.truncated, { reason: "max-files", skipped: 3 });
  assert.equal(summary.timedOut, true);
  assert.equal(summary.pending, false);
  assert.equal(summary.fileCount, 42);
  assert.equal(summary.lastVerifiedAt, "2026-01-01T00:00:00.000Z");
});


