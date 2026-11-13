import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataRoot = mkdtempSync(join(tmpdir(), "project-lock-"));
process.env.PI_WEB_DATA_DIR = dataRoot;

const { createJiti } = await import("jiti");
const { withProjectConfigReadLock, withProjectConfigWriteLock, ProjectConfigLockBusyError } = await createJiti(
  import.meta.url,
  { tsconfigPaths: true },
).import("./project-config-lock.ts");
const lockfile = (await import("proper-lockfile")).default;

test("write locks serialize one project", async () => {
  const events = [];
  const first = withProjectConfigWriteLock("p-serialize", async () => {
    events.push("first-start");
    await new Promise((r) => setTimeout(r, 25));
    events.push("first-end");
  });
  const second = withProjectConfigWriteLock("p-serialize", async () => {
    events.push("second-start");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("read locks run concurrently", async () => {
  let active = 0;
  let peak = 0;
  const work = () =>
    withProjectConfigReadLock("p-read", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
    });
  await Promise.all([work(), work(), work()]);
  assert.equal(peak, 3);
});

test("a writer blocks new readers until it finishes", async () => {
  const events = [];
  const writer = withProjectConfigWriteLock("p-block", async () => {
    events.push("write-start");
    await new Promise((r) => setTimeout(r, 25));
    events.push("write-end");
  });
  const reader = withProjectConfigReadLock("p-block", async () => {
    events.push("read");
  });
  await Promise.all([writer, reader]);
  assert.deepEqual(events, ["write-start", "write-end", "read"]);
});

test("an external file lock makes the write lock fail fast", async () => {
  const projectId = "p-busy";
  const dir = join(dataRoot, "locks", projectId);
  const fs = await import("node:fs");
  fs.mkdirSync(dir, { recursive: true });
  const release = await lockfile.lock(dir, { realpath: false, retries: 0 });
  try {
    await assert.rejects(
      () => withProjectConfigWriteLock(projectId, async () => "never"),
      (err) => err instanceof ProjectConfigLockBusyError,
    );
  } finally {
    await release();
  }
});

test.after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});
