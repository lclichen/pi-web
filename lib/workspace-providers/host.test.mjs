import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createHostWorkspaceOperations } = await jiti.import("./host.ts");
const { WorkspaceOperationError } = await jiti.import("../workspace-operations.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-host-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.txt"), "hello");
  return root;
}

test("host provider reads, writes, stats and lists inside the workspace", async (t) => {
  const root = await fixture(t);
  const ws = createHostWorkspaceOperations(root);

  assert.equal((await ws.readFile("src/a.txt")).toString(), "hello");
  await ws.writeFile("src/b.txt", "new");
  await ws.mkdir("nested/dir");
  const stat = await ws.stat("src/b.txt");
  assert.equal(stat.isFile, true);
  assert.equal(stat.isDirectory, false);
  const entries = await ws.readdir("src");
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["a.txt", "b.txt"]);
  assert.equal(entries.find((entry) => entry.name === "b.txt")?.size, 3);
});

test("host provider rejects lexical and symlink escapes", async (t) => {
  const root = await fixture(t);
  const ws = createHostWorkspaceOperations(root);

  await assert.rejects(
    () => ws.readFile("../outside.txt"),
    (error) => error instanceof WorkspaceOperationError && error.code === "OUT_OF_SCOPE",
  );
  // A symlink inside the root pointing outside must still fail containment.
  const outside = await mkdtemp(join(tmpdir(), "pi-web-host-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "secret");
  const { symlink } = await import("node:fs/promises");
  await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => ws.readFile("link/secret.txt"),
    (error) => error instanceof WorkspaceOperationError && error.code === "OUT_OF_SCOPE",
  );
});

test("host provider exec returns output and does not leak the platform env", async (t) => {
  const root = await fixture(t);
  const ws = createHostWorkspaceOperations(root);
  const previous = process.env.PI_WEB_TEST_SECRET;
  process.env.PI_WEB_TEST_SECRET = "do-not-leak";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_TEST_SECRET;
    else process.env.PI_WEB_TEST_SECRET = previous;
  });

  const result = await ws.exec("echo hello");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);

  const leak = await ws.exec(
    process.platform === "win32"
      ? "echo %PI_WEB_TEST_SECRET%"
      : "node -e \"console.log(process.env.PI_WEB_TEST_SECRET ?? 'unset')\"",
  );
  assert.doesNotMatch(leak.stdout, /do-not-leak/);
});

test("host provider manifest lists regular files and skips repo/cache noise", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".pi/skills/demo/scripts"), { recursive: true });
  await mkdir(join(root, ".pi/skills/demo/node_modules/lib"), { recursive: true });
  await mkdir(join(root, ".pi/skills/demo/node_modules/.cache"), { recursive: true });
  await mkdir(join(root, ".pi/skills/demo/.git"), { recursive: true });
  await writeFile(join(root, ".pi/skills/demo/SKILL.md"), "# demo");
  await writeFile(join(root, ".pi/skills/demo/scripts/run.sh"), "echo hi");
  await writeFile(join(root, ".pi/skills/demo/node_modules/lib/a.js"), "keep");
  await writeFile(join(root, ".pi/skills/demo/node_modules/.cache/a.js"), "noise");
  await writeFile(join(root, ".pi/skills/demo/.git/config"), "noise");

  const ws = createHostWorkspaceOperations(root);
  const result = await ws.manifest([".pi/skills", ".pi/missing"]);
  assert.equal(result.truncated, false);
  const paths = result.entries.map((entry) => entry.path).sort();
  assert.deepEqual(paths, [
    ".pi/skills/demo/SKILL.md",
    ".pi/skills/demo/node_modules/lib/a.js",
    ".pi/skills/demo/scripts/run.sh",
  ]);
  for (const entry of result.entries) {
    assert.ok(entry.size > 0);
    assert.ok(entry.mtimeMs > 0);
  }
});
