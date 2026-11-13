import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 本机模式（relay）工具层单测：通过注入口 rpc/agentForUser 模拟 Go agent，
 * 验证工具参数映射、路径策略（base vs 旧 agent prefix）、读改写与桥接。
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { makeRelayToolsExtension } = await jiti.import("./relay-tools.ts");

const WORKSPACE = "/home/u/proj";
const NEW_AGENT = { info: { agentVersion: "0.6.0", features: ["workspace-base", "binary-read", "binary-write"] } };
const LEGACY_AGENT = { info: { agentVersion: "0.3.0", features: [], workspaceRoot: "/home/u" } };

function harness({ agent = NEW_AGENT, options = {}, respond } = {}) {
  const tools = new Map();
  const handlers = new Map();
  const calls = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
  };
  const rpc = async (method, params, meta) => {
    calls.push({ method, params, meta });
    if (respond) return respond(method, params);
    switch (method) {
      case "fs.read":
        return { path: params.path, content: "alpha\nbeta" };
      case "fs.list":
        return [
          { name: "src", isDir: true },
          { name: "a.txt", isDir: false },
        ];
      case "search.fd":
        return ["src/a.ts", "src/b.ts"];
      case "search.grep":
        return [{ file: "src/a.ts", line: 3, text: "const x = 1;" }];
      case "exec.run":
        return { stdout: "hello\n", stderr: "", exitCode: 0 };
      default:
        return {};
    }
  };
  const factory = makeRelayToolsExtension(42, {
    workspaceDir: WORKSPACE,
    rpc,
    agentForUser: () => agent,
    ...options,
  });
  factory.factory(pi);
  const execute = (name, params, ctx = { cwd: "/tmp" }) =>
    tools.get(name).execute("call-1", params, undefined, undefined, ctx);
  return { tools, handlers, calls, execute };
}

test("read maps relative paths with the workspace base and numbers lines", async () => {
  const h = harness();
  const result = await h.execute("read", { path: "src/a.ts" });
  assert.equal(result.isError, undefined);
  const call = h.calls.find((c) => c.method === "fs.read");
  assert.deepEqual(call.params, { path: "src/a.ts", base: WORKSPACE });
  assert.deepEqual(call.meta, { userId: 42 });
  assert.match(result.content[0].text, /1→alpha\n2→beta/);
  assert.match(result.content[0].text, /\(src\/a\.ts, 2 lines\)/);
});

test("legacy agents get a root-relative prefix instead of base", async () => {
  const h = harness({ agent: LEGACY_AGENT });
  const result = await h.execute("read", { path: "src/a.ts" });
  assert.equal(result.isError, undefined);
  const call = h.calls.find((c) => c.method === "fs.read");
  assert.deepEqual(call.params, { path: "proj/src/a.ts" });
  assert.equal("base" in call.params, false);
});

test("absolute in-workspace paths are relativized; outside paths pass verbatim", async () => {
  const h = harness();
  await h.execute("read", { path: `${WORKSPACE}/src/a.ts` });
  await h.execute("read", { path: "/etc/hosts" });
  const calls = h.calls.filter((c) => c.method === "fs.read");
  assert.equal(calls[0].params.path, "src/a.ts");
  assert.equal(calls[1].params.path, "/etc/hosts");
});

test("missing/old agent fails closed without touching the relay", async () => {
  const noAgent = harness({ agent: null });
  const missing = await noAgent.execute("read", { path: "src/a.ts" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /未连接/);
  assert.equal(noAgent.calls.length, 0);

  const old = harness({ agent: { info: { agentVersion: "0.1.0" } } });
  const incompatible = await old.execute("read", { path: "src/a.ts" });
  assert.equal(incompatible.isError, true);
  assert.match(incompatible.content[0].text, /版本过低/);
  assert.equal(old.calls.length, 0);
});

test("write relays content and mirrors AGENTS.md back to the project home", async () => {
  const home = mkdtempSync(join(tmpdir(), "relay-mirror-"));
  try {
    const h = harness({ options: { projectHome: home } });
    const result = await h.execute("write", { path: "AGENTS.md", content: "# rules\n" }, { cwd: home });
    assert.equal(result.isError, undefined);
    const call = h.calls.find((c) => c.method === "fs.write");
    assert.deepEqual(call.params, { path: "AGENTS.md", content: "# rules\n", base: WORKSPACE });
    assert.equal(readFileSync(join(home, "AGENTS.md"), "utf8"), "# rules\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("edit does read-modify-write and rejects missing/ambiguous oldText", async () => {
  const h = harness({
    respond: (method) =>
      method === "fs.read" ? { path: "src/a.ts", content: "alpha\nbeta" } : {},
  });
  const ok = await h.execute("edit", { path: "src/a.ts", oldText: "beta", newText: "gamma" });
  assert.equal(ok.isError, undefined);
  const write = h.calls.find((c) => c.method === "fs.write");
  assert.equal(write.params.content, "alpha\ngamma");

  const missing = await h.execute("edit", { path: "src/a.ts", oldText: "nope", newText: "x" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/);

  const ambiguous = harness({
    respond: (method) =>
      method === "fs.read" ? { path: "src/a.ts", content: "x x" } : {},
  });
  const dup = await ambiguous.execute("edit", { path: "src/a.ts", oldText: "x", newText: "y" });
  assert.equal(dup.isError, true);
  assert.match(dup.content[0].text, /2 times/);
});

test("bash maps argv/cwd and marks non-zero exits as errors", async () => {
  const h = harness();
  const ok = await h.execute("bash", { argv: ["git", "status"], cwd: "src" });
  assert.equal(ok.isError, undefined);
  const call = h.calls.find((c) => c.method === "exec.run");
  assert.deepEqual(call.params, { argv: ["git", "status"], cwd: "src", base: WORKSPACE });
  assert.match(ok.content[0].text, /hello/);

  const failing = harness({
    respond: () => ({ stdout: "", stderr: "boom", exitCode: 2 }),
  });
  const bad = await failing.execute("bash", { argv: ["false"] });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /stderr/);
  assert.match(bad.content[0].text, /\[exit 2\]/);
});

test("ls/find/grep map methods, params and empty results", async () => {
  const h = harness();
  const ls = await h.execute("ls", { path: "src" });
  assert.match(ls.content[0].text, /d src/);
  assert.match(ls.content[0].text, /- a\.txt/);

  const find = await h.execute("find", { pattern: "*.ts", type: "f" });
  assert.deepEqual(
    h.calls.find((c) => c.method === "search.fd").params,
    { pattern: "*.ts", type: "f", base: WORKSPACE },
  );
  assert.match(find.content[0].text, /src\/a\.ts/);

  const grep = await h.execute("grep", { pattern: "const", glob: "*.ts" });
  assert.deepEqual(h.calls.find((c) => c.method === "search.grep").params, {
    pattern: "const",
    glob: "*.ts",
    base: WORKSPACE,
  });
  assert.match(grep.content[0].text, /src\/a\.ts:3: const x = 1;/);

  const empty = harness({ respond: () => [] });
  assert.equal((await empty.execute("ls", {})).content[0].text, "(empty directory)");
  assert.equal((await empty.execute("find", { pattern: "*" })).content[0].text, "(no matches)");
  assert.equal((await empty.execute("grep", { pattern: "x" })).content[0].text, "(no matches)");
});

test("runtime-config bridge serves skills locally instead of relaying", async () => {
  const home = mkdtempSync(join(tmpdir(), "relay-bridge-"));
  try {
    mkdirSync(join(home, ".pi", "skills", "demo"), { recursive: true });
    writeFileSync(join(home, ".pi", "skills", "demo", "SKILL.md"), "skill body\n");
    const h = harness({ options: { projectHome: home } });
    const result = await h.execute("read", { path: ".pi/skills/demo/SKILL.md" }, { cwd: home });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /skill body/);
    assert.equal(h.calls.length, 0, "bridged reads must not hit the relay");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("user_bash runs through exec.run with bash -c in the workspace scope", async () => {
  const h = harness();
  const handler = h.handlers.get("user_bash");
  assert.ok(handler, "user_bash handler registered");
  const { operations } = await handler();
  const chunks = [];
  const result = await operations.exec("ls | head", "/server/home", {
    onData: (buf) => chunks.push(buf.toString("utf8")),
    timeout: 5000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(h.calls[0].method, "exec.run");
  assert.deepEqual(h.calls[0].params.argv, ["bash", "-c", "ls | head"]);
  assert.equal(h.calls[0].params.cwd, ".");
  assert.equal(h.calls[0].params.base, WORKSPACE);
  assert.match(chunks.join(""), /hello/);
});
