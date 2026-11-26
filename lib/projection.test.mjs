import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
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

function fakeWorkspace(options = {}) {
  const files = new Map();
  let tick = 1_000;
  let statCalls = 0;
  let manifestCalls = 0;
  const ws = {
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
      statCalls += 1;
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
    _statCalls() {
      return statCalls;
    },
    _manifestCalls() {
      return manifestCalls;
    },
  };
  if (options.manifest) {
    ws.manifest = async (roots) => {
      manifestCalls += 1;
      if (options.manifestError) throw new Error("manifest boom");
      const entries = [];
      for (const [path, entry] of files) {
        if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) continue;
        entries.push({ path, size: entry.content.length, mtimeMs: entry.mtimeMs });
      }
      return { entries, truncated: options.manifestTruncated === true };
    };
  }
  return ws;
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

test("policy selects only projected config/runtime roots and refuses root workspaces", async () => {
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
  assert.equal(policy.isProjectedPath(".pi/runtime/tools/v0_cli.py"), true);
  assert.equal(policy.isProjectedPath(".pi/runtime/sample/config.json"), true);
  assert.equal(policy.isProjectedPath(".pi/.apkg_runtime/apkg.py"), true);
  assert.equal(policy.isProjectedPath(".pi/.apkg_runtime/python.bundle"), true);
  assert.equal(policy.isProjectedPath(".pi/.apkg_runtime/apkg-publisher"), true);
  assert.equal(policy.isProjectedPath(".pi/.apkg_runtime/other.py"), false);
  assert.equal(policy.isProjectedPath(".apkg_runtime/python.bundle"), true);
  assert.equal(policy.isProjectedPath(".apkg_runtime/other.py"), false);
  assert.equal(policy.isProjectedPath(".pi/extensions/demo/index.js"), false);
  assert.equal(policy.isProjectionDir(".pi"), true);
  assert.equal(policy.isProjectionDir(".pi/skills/demo"), true);
  assert.equal(policy.isProjectionDir(".pi/runtime/tools"), true);
  assert.equal(policy.isProjectionDir(".pi/.apkg_runtime"), true);
  assert.equal(policy.isProjectionDir(".apkg_runtime"), true);
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
    ".pi/runtime/tools/v0_cli.py": "print('cli')\n",
    ".pi/runtime/sample/config.json": "{}\n",
    ".pi/.apkg_runtime/apkg.py": "# loader\n",
    ".pi/.apkg_runtime/python.bundle": Buffer.from([9, 8, 7]),
    ".apkg_runtime/apkg.py": "# root loader\n",
    ".apkg_runtime/python.bundle": Buffer.from([6, 5, 4]),
    ".pi/settings.json": "{}",
  });
  touch();
  try {
    const meta = { mode: "sandbox", root: "/workspace", backend: "platform#1", key: "1".repeat(32) };
    const first = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(first.errors, []);
    assert.deepEqual([...first.status.pushed].sort(), [
      ".apkg_runtime/apkg.py",
      ".apkg_runtime/python.bundle",
      ".pi/.apkg_runtime/apkg.py",
      ".pi/.apkg_runtime/python.bundle",
      ".pi/agents/helper.md",
      ".pi/attachments/pic.bin",
      ".pi/runtime/sample/config.json",
      ".pi/runtime/tools/v0_cli.py",
      ".pi/skills/demo/SKILL.md",
    ]);
    assert.equal(first.status.truncated, null);

    const second = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(second.status.pushed, []);
    assert.deepEqual([...second.status.adopted].sort(), [
      ".apkg_runtime/apkg.py",
      ".apkg_runtime/python.bundle",
      ".pi/.apkg_runtime/apkg.py",
      ".pi/.apkg_runtime/python.bundle",
      ".pi/agents/helper.md",
      ".pi/attachments/pic.bin",
      ".pi/runtime/sample/config.json",
      ".pi/runtime/tools/v0_cli.py",
      ".pi/skills/demo/SKILL.md",
    ]);
    assert.deepEqual(second.dirty, []);
    const saved = manifest.loadProjectionManifest(projectId, meta.key);
    assert.equal(Object.keys(saved.files).length, 9);
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

test("manifest fast path replaces per-file stats; failures and truncation fall back", async () => {
  const { reconcile } = await loadSubject();
  const files = {
    ".pi/skills/demo/SKILL.md": "manifest\n",
    ".pi/agents/helper.md": "agent\n",
    ".pi/attachments/pic.bin": Buffer.from([1, 2, 3]),
  };
  const projectId = "proj-manifest-1";
  const workspace = fakeWorkspace({ manifest: true });
  const { home, touch } = hostHome(files);
  touch();
  try {
    const meta = { mode: "ssh", root: "/repo", backend: "h:22", key: "b".repeat(32) };
    const first = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.equal(first.status.pushed.length, 3);
    assert.equal(workspace._manifestCalls(), 1);
    const statsAfterFirst = workspace._statCalls();
    assert.ok(statsAfterFirst >= 3, "pushes still stat the written files");

    const second = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(second.status.pushed, []);
    assert.equal(workspace._statCalls(), statsAfterFirst, "second run trusts the manifest index");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const failing = fakeWorkspace({ manifest: true, manifestError: true });
  const projectId2 = "proj-manifest-2";
  const { home: home2, touch: touch2 } = hostHome(files);
  touch2();
  try {
    const meta = { mode: "ssh", root: "/repo", backend: "h:22", key: "c".repeat(32) };
    const result = await reconcile.reconcileProjection({
      projectId: projectId2,
      hostHome: home2,
      workspace: failing,
      workspaceMeta: meta,
    });
    assert.equal(result.status.pushed.length, 3);
    assert.equal(result.errors.length, 0, "manifest failure degrades quietly");
    assert.ok(failing._statCalls() >= 3, "fallback uses per-file stats");
  } finally {
    rmSync(home2, { recursive: true, force: true });
  }

  const truncated = fakeWorkspace({ manifest: true, manifestTruncated: true });
  const projectId3 = "proj-manifest-3";
  const { home: home3, touch: touch3 } = hostHome(files);
  touch3();
  try {
    const meta = { mode: "ssh", root: "/repo", backend: "h:22", key: "d".repeat(32) };
    const result = await reconcile.reconcileProjection({
      projectId: projectId3,
      hostHome: home3,
      workspace: truncated,
      workspaceMeta: meta,
    });
    assert.equal(result.status.pushed.length, 3);
    assert.ok(truncated._statCalls() >= 3, "truncated listings are not authoritative");
  } finally {
    rmSync(home3, { recursive: true, force: true });
  }
});

test("manifest index still propagates Host deletions without extra stats", async () => {
  const { reconcile } = await loadSubject();
  const projectId = "proj-manifest-delete";
  const workspace = fakeWorkspace({ manifest: true });
  const { home, touch } = hostHome({ ".pi/skills/demo/SKILL.md": "gone\n" });
  touch();
  const meta = { mode: "sandbox", root: "/workspace", backend: "platform#m", key: "e".repeat(32) };
  try {
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    const statsAfterFirst = workspace._statCalls();
    unlinkSync(join(home, ".pi/skills/demo/SKILL.md"));
    const result = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.deepEqual(result.status.deleted, [".pi/skills/demo/SKILL.md"]);
    assert.equal(workspace._has(".pi/skills/demo/SKILL.md"), false);
    assert.equal(workspace._statCalls(), statsAfterFirst);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a Host readdir failure (EACCES) never propagates deletion for that subtree", async () => {
  const { reconcile, manifest } = await loadSubject();
  const projectId = "proj-hostread-1";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({
    ".pi/skills/demo/SKILL.md": "demo\n",
    ".pi/skills/blocked/SKILL.md": "blocked\n",
  });
  touch();
  const meta = { mode: "ssh", root: "/repo", backend: "h:22", key: "ab".repeat(16) };
  try {
    const first = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.equal(first.status.pushed.length, 2);
    const before = manifest.loadProjectionManifest(projectId, meta.key);
    assert.ok(before.files[".pi/skills/blocked/SKILL.md"]);

    // 第二轮：.pi/skills/blocked 的 readdir 抛 EACCES —— 整个子树从 hostFiles
    // “消失”，但绝不能当成 Host 已删除做删除传播。
    const eacces = Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
    const failingFs = {
      async readdir(path, options) {
        if (path.replaceAll("\\", "/").endsWith(".pi/skills/blocked")) throw eacces;
        return fsReaddir(path, options);
      },
      async stat(path, options) {
        return fsStat(path, options);
      },
    };
    const second = await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      hostFs: failingFs,
    });
    assert.deepEqual(second.status.deleted, [], "不可信子树不得触发远端删除");
    assert.deepEqual(second.status.adopted, [".pi/skills/demo/SKILL.md"], "可读部分照常对账");
    assert.ok(
      second.errors.some((entry) => entry.rel === "<host-read-incomplete>"),
      `errors 应有汇总：${JSON.stringify(second.errors)}`,
    );
    assert.equal(workspace._has(".pi/skills/blocked/SKILL.md"), true, "远端副本保留");
    const after = manifest.loadProjectionManifest(projectId, meta.key);
    assert.ok(after.files[".pi/skills/blocked/SKILL.md"], "manifest 条目保持原样");
    assert.equal(after.files[".pi/skills/blocked/SKILL.md"].sha256, before.files[".pi/skills/blocked/SKILL.md"].sha256);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a Host stat failure (non-ENOENT) also blocks deletion propagation for that file", async () => {
  const { reconcile, manifest } = await loadSubject();
  const projectId = "proj-hostread-2";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/attachments/pic.bin": Buffer.from([5, 5]) });
  touch();
  const meta = { mode: "ssh", root: "/repo", backend: "h:22", key: "ac".repeat(16) };
  try {
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace, workspaceMeta: meta });
    assert.ok(manifest.loadProjectionManifest(projectId, meta.key).files[".pi/attachments/pic.bin"]);

    // stat 抛 EACCES（文件仍在 Host 上）：attachments 的无条件删除也必须被拦下。
    const eacces = Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" });
    const failingFs = {
      async readdir(path, options) {
        return fsReaddir(path, options);
      },
      async stat(path, options) {
        if (path.replaceAll("\\", "/").endsWith(".pi/attachments/pic.bin")) throw eacces;
        return fsStat(path, options);
      },
    };
    const result = await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      hostFs: failingFs,
    });
    assert.deepEqual(result.status.deleted, [], "读不到 ≠ 已删除");
    assert.ok(result.errors.some((entry) => entry.rel === "<host-read-incomplete>"));
    assert.equal(workspace._has(".pi/attachments/pic.bin"), true);
    assert.ok(manifest.loadProjectionManifest(projectId, meta.key).files[".pi/attachments/pic.bin"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("with an injected delegating hostFs, a genuinely deleted file still propagates", async () => {
  const { reconcile } = await loadSubject();
  const projectId = "proj-hostread-3";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/skills/plain/SKILL.md": "plain\n" });
  touch();
  const meta = { mode: "local-machine", root: "/repo", backend: "machine-c", key: "ad".repeat(16) };
  const delegatingFs = {
    readdir: (path, options) => fsReaddir(path, options),
    stat: (path, options) => fsStat(path, options),
  };
  try {
    await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      hostFs: delegatingFs,
    });
    unlinkSync(join(home, ".pi/skills/plain/SKILL.md"));
    const result = await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      hostFs: delegatingFs,
    });
    assert.deepEqual(result.status.deleted, [".pi/skills/plain/SKILL.md"], "真删除照常传播");
    assert.equal(workspace._has(".pi/skills/plain/SKILL.md"), false);
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a workspace identity change during reconcile aborts the run without saving the manifest", async () => {
  const { reconcile, manifest, status } = await loadSubject();
  const projectId = "proj-recheck-1";
  const workspace = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/skills/demo/SKILL.md": "v1\n" });
  touch();
  const meta = { mode: "ssh", root: "/repo", backend: "h:22", key: "ae".repeat(16) };
  try {
    // 基线：首尾复校一致 → 正常保存。
    const okRun = await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      workspaceRecheck: () => meta,
    });
    assert.equal(okRun.status.aborted, false);
    const savedBefore = manifest.loadProjectionManifest(projectId, meta.key);
    assert.ok(savedBefore);

    // reconcile 进行中用户改了 workdir → 复校发现 root 变化 → 放弃本轮结果。
    writeFileSync(join(home, ".pi/skills/demo/SKILL.md"), "v2\n");
    const moved = { ...meta, root: "/moved", key: "af".repeat(16) };
    const abortedByRoot = await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      workspaceRecheck: () => moved,
    });
    assert.equal(abortedByRoot.status.aborted, true);
    assert.ok(abortedByRoot.errors.some((entry) => entry.rel === "<workspace-changed>"));
    assert.deepEqual(manifest.loadProjectionManifest(projectId, meta.key), savedBefore, "manifest 未被写入");
    const stored = status.readProjectionStatus(projectId, meta.key);
    assert.equal(stored.aborted, true);
    // 可重试：下一个 prompt 立即重新 reconcile。
    assert.equal(reconcile.projectionNeedsRun(projectId, 60_000), true);

    // 仅 key 变化（root 相同的别名迁移场景之外）同样放弃。
    const rekeyed = await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      workspaceRecheck: () => ({ ...meta, key: "b0".repeat(16) }),
    });
    assert.equal(rekeyed.status.aborted, true);

    // 项目已不存在 → 复校返回 null，同样放弃。
    const vanished = await reconcile.reconcileProjection({
      projectId,
      hostHome: home,
      workspace,
      workspaceMeta: meta,
      workspaceRecheck: () => null,
    });
    assert.equal(vanished.status.aborted, true);
    assert.ok(vanished.errors.some((entry) => entry.error.includes("项目已不存在")));
    assert.deepEqual(manifest.loadProjectionManifest(projectId, meta.key), savedBefore, "manifest 仍未被写入");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("same container on a different platform backend does not inherit the manifest", async () => {
  const { reconcile, manifest } = await loadSubject();
  const projectId = "proj-platform-split";
  const workspaceA = fakeWorkspace();
  const workspaceB = fakeWorkspace();
  const { home, touch } = hostHome({ ".pi/skills/demo/SKILL.md": "same\n" });
  touch();
  // B4 之后 sandbox backend 形如 platform:<origin>#container:<id>：
  // 同容器不同平台部署必须得到不同 key / 互不继承 manifest。
  const metaA = { mode: "sandbox", root: "/workspace", backend: "platform:http://a:3000#container:7", key: "b1".repeat(16) };
  const metaB = { mode: "sandbox", root: "/workspace", backend: "platform:http://b:3000#container:7", key: "b2".repeat(16) };
  try {
    await reconcile.reconcileProjection({ projectId, hostHome: home, workspace: workspaceA, workspaceMeta: metaA });
    const result = await reconcile.reconcileProjection({ projectId, hostHome: home, workspace: workspaceB, workspaceMeta: metaB });
    assert.deepEqual(result.status.pushed, [".pi/skills/demo/SKILL.md"], "新平台按全新工作区全量重推");
    assert.ok(manifest.loadProjectionManifest(projectId, metaA.key), "旧平台 manifest 不被迁移走");
    assert.ok(manifest.loadProjectionManifest(projectId, metaB.key));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});



