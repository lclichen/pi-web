import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Batch 1: descriptor mapping and fail-closed restore. A session carrying
 * sandbox/relay/SSH metadata must never fall back to bare Host tools.
 */

const dataDir = mkdtempSync(join(tmpdir(), "session-descriptor-"));
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_WEB_AUTH = "";
delete process.env.PI_WEB_PLATFORM_URL;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  descriptorForNewSession,
  descriptorForProject,
  descriptorToLegacyMode,
  inferDescriptorFromMeta,
  isSessionDescriptor,
} = await jiti.import("./session-descriptor.ts");
const { copySessionMeta, getSessionMeta, recordSessionMeta } = await jiti.import("./session-metas.ts");
const { restoreSessionOptions, SessionRestoreError } = await jiti.import("./session-restore-options.ts");

test.after(() => {
  delete process.env.PI_WEB_DATA_DIR;
  delete process.env.PI_WEB_AUTH;
  rmSync(dataDir, { recursive: true, force: true });
});

test("new-session descriptors map management, execution, workspace and legacy mode", () => {
  const host = descriptorForNewSession({ mode: "host", ownerId: 1, cwd: "/srv/repo" });
  assert.deepEqual(host, {
    management: "webui",
    execution: "local",
    workspace: "external-dir",
    ownerId: 1,
    cwd: "/srv/repo",
  });
  assert.equal(descriptorToLegacyMode(host), "host");

  const quick = descriptorForNewSession({
    mode: "quick",
    ownerId: 1,
    cwd: "/data/quick",
    templateId: "t1",
    quickDir: "t1-abcd1234",
  });
  assert.equal(quick.profile, "quick");
  assert.equal(quick.workspace, "scratch");
  assert.equal(quick.execution, "local");
  assert.equal(descriptorToLegacyMode(quick), "quick");

  const sandbox = descriptorForNewSession({ mode: "sandbox", ownerId: 1, cwd: "/data/sandbox" });
  assert.equal(sandbox.execution, "sandbox");
  assert.equal(sandbox.workspace, "managed-home");
  assert.equal(descriptorToLegacyMode(sandbox), "sandbox");

  const relay = descriptorForNewSession({ mode: "local-machine", ownerId: 1, cwd: "/data/local" });
  assert.equal(relay.execution, "relay");
  assert.equal(descriptorToLegacyMode(relay), "local-machine");
});

test("project descriptors are WebUI-managed and retain the remote workspace root", () => {
  const descriptor = descriptorForProject(
    { id: "p1", ownerId: 7, mode: "local-machine", workdir: "/home/user/code" },
    7,
    "/data/local-homes/u7/p1",
    "/home/user/code",
  );
  assert.equal(descriptor.management, "webui");
  assert.equal(descriptor.projectId, "p1");
  assert.equal(descriptor.execution, "relay");
  assert.equal(descriptor.workspace, "managed-home");
  assert.equal(descriptor.workspaceRoot, "/home/user/code");
  assert.equal(descriptorToLegacyMode(descriptor), "local-machine");
});

test("legacy metadata infers safely; SSH without a project is rejected", () => {
  const host = inferDescriptorFromMeta({ mode: "host", ownerId: 3 });
  assert.equal(host?.management, "cli");
  assert.equal(host?.workspace, "external-dir");
  assert.equal(host?.execution, "local");

  const quick = inferDescriptorFromMeta({ mode: "quick", ownerId: 3, templateId: "t" });
  assert.equal(quick?.management, "webui");
  assert.equal(quick?.profile, "quick");

  assert.equal(inferDescriptorFromMeta({ mode: "ssh", ownerId: 3 }), null);
});

test("session meta persists descriptor and fork/clone copies the contract", () => {
  const descriptor = descriptorForNewSession({
    mode: "sandbox",
    ownerId: 4,
    projectId: "p2",
    cwd: "/data/sandbox-homes/u4/p2",
  });
  recordSessionMeta("source", {
    mode: "sandbox",
    ownerId: 4,
    projectId: "p2",
    descriptor,
    ownerName: "u4",
  });
  assert.ok(isSessionDescriptor(getSessionMeta("source")?.descriptor));

  assert.equal(copySessionMeta("source", "copied"), true);
  const copied = getSessionMeta("copied");
  assert.equal(copied?.mode, "sandbox");
  assert.equal(copied?.projectId, "p2");
  assert.equal(copied?.descriptor?.execution, "sandbox");
  assert.equal(copied?.descriptor?.workspace, "managed-home");
});

test("restore fails closed for SSH without project and sandbox without platform", async () => {
  recordSessionMeta("ssh-orphan", { mode: "ssh", ownerId: 0 });
  await assert.rejects(
    () => restoreSessionOptions(new Request("http://127.0.0.1/api/agent/ssh-orphan"), "ssh-orphan"),
    (error) =>
      error instanceof SessionRestoreError &&
      error.status === 409 &&
      /模式信息|SSH|拒绝/.test(error.message),
  );

  recordSessionMeta("sandbox-owner", {
    mode: "sandbox",
    ownerId: 0,
    descriptor: descriptorForNewSession({ mode: "sandbox", ownerId: 0, cwd: "/tmp/sandbox" }),
  });
  await assert.rejects(
    () => restoreSessionOptions(new Request("http://127.0.0.1/api/agent/sandbox-owner"), "sandbox-owner"),
    (error) => error instanceof SessionRestoreError && error.status === 409 && /沙箱/.test(error.message),
  );
});

test("restore keeps quick/local-machine/host modes and uses owner-scoped homes", async () => {
  recordSessionMeta("local-owner", { mode: "local-machine", ownerId: 0 });
  const local = await restoreSessionOptions(new Request("http://127.0.0.1/api/agent/local-owner"), "local-owner");
  assert.equal(local.mode, "local-machine");

  recordSessionMeta("quick-owner", { mode: "quick", ownerId: 0, templateId: "default" });
  const quick = await restoreSessionOptions(new Request("http://127.0.0.1/api/agent/quick-owner"), "quick-owner");
  assert.equal(quick.mode, "quick");

  recordSessionMeta("host-owner", { mode: "host", ownerId: 0 });
  const host = await restoreSessionOptions(new Request("http://127.0.0.1/api/agent/host-owner"), "host-owner");
  assert.equal(host.mode, "host");
});
