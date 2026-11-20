import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/** Batch 4b: platform user deletion also clears local derived state. */

const root = mkdtempSync(join(tmpdir(), "user-cleanup-"));
const dataDir = join(root, "data");
const agentDir = join(root, "agent");
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createWebSession, getWebSession } = await jiti.import("../web-session.ts");
const { vaultStoreApiKey, vaultLookupApiKey } = await jiti.import("../api-key-vault.ts");
const { issueAgentToken, lookupTokenOwner } = await jiti.import("../relay/relay-store.ts");
const { createProject, getProject } = await jiti.import("../projects.ts");
const { deleteUserLocalState } = await jiti.import("./user-cleanup.ts");
const { getUserSettings, updateUserSettings } = await jiti.import("../user-settings.ts");
const { userStateRoot } = await jiti.import("../user-config.ts");
const { createTaskRecord, getTask, updateTask } = await jiti.import("../batch/task-store.ts");

test.after(() => {
  delete process.env.PI_WEB_DATA_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(root, { recursive: true, force: true });
});

test("user deletion clears logins, vault, relay tokens, projects and user state", async () => {
  process.env.PI_WEB_AUTH = "on";
  try {
    const session = createWebSession(
      { id: 42, username: "u42", email: null, role: "user", status: "active" },
      "",
      "",
    );
    const cookie = `pi_web_sid=${session.sid}`;
    assert.ok(getWebSession(new Request("http://localhost/", { headers: { cookie } })));

    vaultStoreApiKey(42, 101, "k", "sk_secret");
    assert.equal(vaultLookupApiKey(42, 101), "sk_secret");

    const token = await issueAgentToken({ userId: 42, machineId: "m1" });
    assert.equal(lookupTokenOwner(token), 42);

    updateUserSettings(42, { askAutoContinue: true });
    assert.equal(getUserSettings(42).askAutoContinue, true);
    mkdirSync(userStateRoot(42), { recursive: true });
    mkdirSync(join(dataDir, "user-config", "u42", "skills"), { recursive: true });
    mkdirSync(join(dataDir, "attachments", "u42", "s1"), { recursive: true });

    const external = join(root, "external-host");
    mkdirSync(external, { recursive: true });
    const host = await createProject({
      name: "u42-host",
      ownerId: 42,
      mode: "host",
      workspaceRoot: external,
    });
    assert.equal(host.ok, true);
    if (!host.ok) return;

    const task = createTaskRecord({
      taskId: "active-task-42",
      sessionId: "batch-session-42",
      ownerId: 42,
      mode: "host",
      requestedWorkDir: join(root, "batch-work"),
      actualWorkDir: join(root, "batch-work"),
      prompt: "keep running",
      timeoutMs: 60_000,
      inputTimeoutMs: 10_000,
      stopContainer: false,
    });
    updateTask(task.taskId, { state: "running", startedAt: Date.now() });
    mkdirSync(join(dataDir, "batch-homes", task.taskId), { recursive: true });
    assert.equal(getTask(task.taskId)?.state, "running");

    await deleteUserLocalState(42);

    assert.equal(getWebSession(new Request("http://localhost/", { headers: { cookie } })), null);
    assert.equal(vaultLookupApiKey(42, 101), null);
    assert.equal(lookupTokenOwner(token), 0);
    assert.equal(getProject(host.project.id), undefined);
    assert.equal(getTask(task.taskId), undefined, "active batch task does not survive user deletion");
    assert.equal(existsSync(join(dataDir, "batch-homes", task.taskId)), false);
    assert.equal(existsSync(external), true, "external Host directory is not deleted");
    assert.equal(existsSync(userStateRoot(42)), false);
    assert.equal(existsSync(join(dataDir, "user-config", "u42")), false);
    assert.equal(existsSync(join(dataDir, "attachments", "u42")), false);
    assert.equal(getUserSettings(42).askAutoContinue, false);
  } finally {
    delete process.env.PI_WEB_AUTH;
  }
});
