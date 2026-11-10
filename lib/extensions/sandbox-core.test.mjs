import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Migrated from sandbox-platform's retired pi-sandbox-extension tests.
 * The extension now lives in pi-config/agent/extensions/amedac-core/src/sandbox;
 * these are the pure path/autocomplete/sync/operation cases the platform tests
 * covered, run against the shared implementation.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const sandbox = "../../pi-config/agent/extensions/amedac-core/src/sandbox";
const { extractAtPrefix, buildCompletionValue, suggestContainerFiles, createContainerAutocompleteProvider } =
  await jiti.import(`${sandbox}/autocomplete.ts`);
const { toContainerPath, containerPathToLocal } = await jiti.import(`${sandbox}/paths.ts`);
const { collectLocalFiles, syncWorkspaceToContainer, DEFAULT_SYNC_IGNORE } = await jiti.import(`${sandbox}/sync.ts`);
const { withContainerCwd } = await jiti.import(`${sandbox}/operations.ts`);

test("extractAtPrefix detects @ mentions at token boundaries", () => {
  assert.equal(extractAtPrefix("@"), "@");
  assert.equal(extractAtPrefix("@src/ut"), "@src/ut");
  assert.equal(extractAtPrefix("look at @foo/bar"), "@foo/bar");
  assert.equal(extractAtPrefix('check @"a b/c'), '@"a b/c');
  assert.equal(extractAtPrefix("user@example.com"), null);
  assert.equal(extractAtPrefix("x@y z"), null);
  assert.equal(extractAtPrefix('"foo'), null);
  assert.equal(extractAtPrefix('x="foo'), null);
});

test("buildCompletionValue quotes paths with spaces and keeps directory slashes", () => {
  assert.equal(buildCompletionValue("src/util.ts", { isDirectory: false, isAtPrefix: true, isQuotedPrefix: false }), "@src/util.ts");
  assert.equal(buildCompletionValue("my file.txt", { isDirectory: false, isAtPrefix: true, isQuotedPrefix: false }), '@"my file.txt"');
  assert.equal(buildCompletionValue("src/utils/", { isDirectory: true, isAtPrefix: true, isQuotedPrefix: true }), '@"src/utils/"');
});

const workspaceListing = [
  { name: "util.ts", isDirectory: false },
  { name: "utils", isDirectory: true },
  { name: "README.md", isDirectory: false },
  { name: ".git", isDirectory: true },
  { name: "node_modules", isDirectory: true },
];

test("suggestContainerFiles completes workspace-relative paths", async () => {
  const list = (dir) => Promise.resolve(dir === "/workspace" ? workspaceListing : []);
  assert.deepEqual((await suggestContainerFiles(list, "ut")).map((i) => i.label), ["util.ts", "utils/"]);
  assert.deepEqual((await suggestContainerFiles(list, "UTIL.TS")).map((i) => i.label), ["util.ts"]);
  const all = (await suggestContainerFiles(list, "")).map((i) => i.label);
  assert.ok(all.includes("util.ts"));
  assert.ok(all.includes("utils/"));
  assert.ok(!all.includes(".git/"));
  assert.ok(!all.includes("node_modules/"));
  assert.deepEqual(await suggestContainerFiles(list, "no/such"), []);
});

test("suggestContainerFiles descends into typed directories and absolute paths", async () => {
  const list = (dir) =>
    Promise.resolve(
      dir === "/workspace/src"
        ? [
            { name: "util.ts", isDirectory: false },
            { name: "ui", isDirectory: true },
          ]
        : dir === "/etc"
          ? [
              { name: "hosts", isDirectory: false },
              { name: "hostname", isDirectory: false },
            ]
          : [],
    );
  assert.deepEqual((await suggestContainerFiles(list, "src/ut")).map((i) => i.label), ["src/util.ts"]);
  assert.deepEqual((await suggestContainerFiles(list, "src/")).map((i) => i.label), ["src/util.ts", "src/ui/"]);
  assert.deepEqual((await suggestContainerFiles(list, "/etc/hos")).map((i) => i.label), ["/etc/hosts", "/etc/hostname"]);
});

const stubCurrent = {
  getSuggestions: async () => ({ items: [{ value: "@local.txt", label: "local.txt" }], prefix: "@" }),
  applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
  shouldTriggerFileCompletion: () => true,
};

test("autocomplete provider delegates when no container is connected", async () => {
  const provider = createContainerAutocompleteProvider(stubCurrent, () => undefined);
  const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
  assert.deepEqual(result, { items: [{ value: "@local.txt", label: "local.txt" }], prefix: "@" });
});

test("autocomplete provider lists container files when connected", async () => {
  const client = { toolLs: async (_id, dir) => (dir === "/workspace" ? [{ name: "main.ts", isDirectory: false }] : []) };
  const provider = createContainerAutocompleteProvider(stubCurrent, () => ({ client, containerId: 7 }));
  const result = await provider.getSuggestions(["look @main"], 0, 10, { signal: new AbortController().signal });
  assert.deepEqual(result, { items: [{ value: "@main.ts", label: "main.ts" }], prefix: "@main" });
});

test("autocomplete applies file and directory completions and preserves slash commands", () => {
  const provider = createContainerAutocompleteProvider(stubCurrent, () => undefined);
  assert.equal(provider.applyCompletion(["@main"], 0, 5, { value: "@main.ts", label: "main.ts" }, "@main").lines[0], "@main.ts ");
  assert.equal(provider.applyCompletion(["@src"], 0, 4, { value: "@src/", label: "src/" }, "@src").lines[0], "@src/");

  let delegated = null;
  const current = {
    ...stubCurrent,
    applyCompletion: (_lines, _line, _col, item, prefix) => {
      delegated = { item, prefix };
      return { lines: ["/sandbox-login "], cursorLine: 0, cursorCol: 14 };
    },
  };
  const slashProvider = createContainerAutocompleteProvider(current, () => ({ client: { toolLs: async () => [] }, containerId: 7 }));
  const result = slashProvider.applyCompletion(
    ["/sandbox-login"],
    0,
    14,
    { value: "sandbox-login", label: "sandbox-login" },
    "/sandbox-login",
  );
  assert.deepEqual(delegated, { item: { value: "sandbox-login", label: "sandbox-login" }, prefix: "/sandbox-login" });
  assert.equal(result.lines[0], "/sandbox-login ");
});

test("autocomplete respects an already-aborted signal", async () => {
  const client = { toolLs: async () => [{ name: "a.ts", isDirectory: false }] };
  const provider = createContainerAutocompleteProvider(stubCurrent, () => ({ client, containerId: 7 }));
  const controller = new AbortController();
  controller.abort();
  assert.equal(await provider.getSuggestions(["@a"], 0, 2, { signal: controller.signal }), null);
});

test("toContainerPath maps relative, absolute and doubled workspace paths", () => {
  assert.equal(toContainerPath("quicksort.py"), "/workspace/quicksort.py");
  assert.equal(toContainerPath("src/util.ts"), "/workspace/src/util.ts");
  assert.equal(toContainerPath("@quicksort.py"), "/workspace/quicksort.py");
  assert.equal(toContainerPath("/workspace/quicksort.py"), "/workspace/quicksort.py");
  assert.equal(toContainerPath("/etc/hostname"), "/etc/hostname");
  assert.equal(toContainerPath("."), "/workspace");
  assert.equal(toContainerPath("/workspace/workspace/quicksort.py"), "/workspace/quicksort.py");
  assert.equal(toContainerPath("workspace/quicksort.py"), "/workspace/quicksort.py");
});

test("toContainerPath un-mangles win32 paths and strips POSIX session cwd", () => {
  const winCwd = "D:\\workspace";
  assert.equal(toContainerPath("D:\\workspace\\quicksort.py", winCwd), "/workspace/quicksort.py");
  assert.equal(toContainerPath("D:\\workspace\\workspace\\quicksort.py", winCwd), "/workspace/quicksort.py");
  assert.equal(toContainerPath("D:\\workspace\\src\\util.ts", winCwd), "/workspace/src/util.ts");
  assert.equal(toContainerPath("D:\\etc\\hostname", winCwd), "/etc/hostname");
  assert.equal(toContainerPath("/home/u/proj/src/a.ts", "/home/u/proj"), "/workspace/src/a.ts");
});

test("containerPathToLocal maps the workspace root on every platform", () => {
  assert.equal(containerPathToLocal("/workspace", "C:\\proj"), "C:\\proj");
  assert.equal(containerPathToLocal("/", "C:\\proj"), "C:\\proj");
  assert.equal(containerPathToLocal(".", "C:\\proj"), "C:\\proj");
});

test(
  "containerPathToLocal keeps win32 local paths and joins relative container paths",
  { skip: process.platform !== "win32" },
  () => {
    const cwd = "C:\\proj";
    assert.equal(containerPathToLocal("/workspace/src/main.ts", cwd), "C:\\proj\\src\\main.ts");
    assert.equal(containerPathToLocal("src/util.ts", cwd), "C:\\proj\\src\\util.ts");
    assert.equal(containerPathToLocal("@/workspace/a.txt", cwd), "C:\\proj\\a.txt");
    assert.equal(containerPathToLocal("D:\\workspace\\quicksort.py", "D:\\workspace"), "D:\\workspace\\quicksort.py");
    assert.equal(containerPathToLocal("C:\\other\\file.txt", "D:\\workspace"), "C:\\other\\file.txt");
  },
);

test(
  "containerPathToLocal strips the POSIX session cwd",
  { skip: process.platform === "win32" },
  () => {
    const cwd = "/home/u/proj";
    assert.equal(containerPathToLocal("/workspace/src/main.ts", cwd), "/home/u/proj/src/main.ts");
    assert.equal(containerPathToLocal("/home/u/proj/src/a.ts", cwd), "/home/u/proj/src/a.ts");
  },
);

async function tempSyncDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-sandbox-sync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "src", "deep"), { recursive: true });
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, "README.md"), "readme");
  await writeFile(join(dir, "src", "main.ts"), "main");
  await writeFile(join(dir, "src", "deep", "nested.txt"), "nested");
  await writeFile(join(dir, "node_modules", "junk.js"), "junk");
  await writeFile(join(dir, ".git", "config"), "git");
  return dir;
}

async function tempUploadDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-sandbox-upload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "readme");
  await writeFile(join(dir, "src", "main.ts"), "main");
  return dir;
}

test("collectLocalFiles skips ignored dirs and oversized files", async (t) => {
  const dir = await tempSyncDir(t);
  const files = await collectLocalFiles(dir);
  assert.deepEqual(files.map((f) => f.rel).sort(), ["README.md", "src/deep/nested.txt", "src/main.ts"]);
  assert.equal(files.find((f) => f.rel === "src/main.ts")?.size, 4);
  const small = await collectLocalFiles(dir, { maxFileBytes: 5 });
  assert.deepEqual(small.map((f) => f.rel), ["src/main.ts"]);
});

test("syncWorkspaceToContainer uploads, reports failures and respects ignores", async (t) => {
  const dir = await tempUploadDir(t);
  const writes = [];
  const client = {
    toolWrite: async (_id, path, content) => {
      writes.push({ path, content: content.toString("utf8") });
    },
  };
  const result = await syncWorkspaceToContainer(client, 7, dir);
  assert.equal(result.files, 2);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(writes.map((w) => w.path).sort(), ["/workspace/README.md", "/workspace/src/main.ts"]);
  assert.equal(writes.find((w) => w.path === "/workspace/src/main.ts")?.content, "main");
  assert.equal(result.bytes, 6 + 4);

  const failing = {
    toolWrite: async (_id, path) => {
      if (path.endsWith("README.md")) throw new Error("boom");
    },
  };
  const partial = await syncWorkspaceToContainer(failing, 7, dir, { incremental: false });
  assert.equal(partial.files, 1);
  assert.deepEqual(partial.failures, ["README.md: boom"]);
});

test("syncWorkspaceToContainer skips unchanged files and re-uploads changed ones", async (t) => {
  const dir = await tempUploadDir(t);
  let writes = 0;
  const client = { toolWrite: async () => void (writes += 1) };
  const first = await syncWorkspaceToContainer(client, 7, dir);
  assert.equal(first.files, 2);
  assert.equal(first.unchanged, 0);
  assert.equal(writes, 2);

  writes = 0;
  const second = await syncWorkspaceToContainer(client, 7, dir);
  assert.equal(second.files, 0);
  assert.equal(second.unchanged, 2);
  assert.equal(writes, 0);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(dir, "src", "main.ts"), "main changed");
  writes = 0;
  const third = await syncWorkspaceToContainer(client, 7, dir);
  assert.equal(third.files, 1);
  assert.equal(third.unchanged, 1);
  assert.equal(writes, 1);

  assert.ok(DEFAULT_SYNC_IGNORE.has("node_modules"));
  const forced = await syncWorkspaceToContainer(client, 99, dir, { incremental: false });
  assert.equal(forced.files, 2);
});

test("withContainerCwd pins user_bash cwd to /workspace", async () => {
  const seen = [];
  const ops = {
    exec: async (command, cwd) => {
      seen.push({ command, cwd });
      return { exitCode: 0 };
    },
  };
  const wrapped = withContainerCwd(ops);
  await wrapped.exec("ls", "D:\\MyCourses\\26Q3\\AgentSandbox", {});
  assert.deepEqual(seen, [{ command: "ls", cwd: "/workspace" }]);
});
