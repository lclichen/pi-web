import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * 子智能体内联扩展桥（lib/subagent-bridge.ts）：按父会话模式返回同一套
 * 模式扩展，子智能体与父会话在同一后端执行。钉住各模式的注入集合与
 * "查不到父会话不注入"的兜底。
 */

async function withDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-bridge-"));
  const prev = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function factoryNames(exts) {
  return exts.map((e) => e?.name).sort();
}

test("local-machine parent (no project): relay + remote-verify + env-info", async () => {
  await withDataDir(async () => {
    const { childExtensionsFor } = await jiti.import("./subagent-bridge.ts");
    const exts = childExtensionsFor({ mode: "local-machine", ownerId: 7, cwd: "/srv/homes/u7" }, undefined);
    assert.ok(Array.isArray(exts) && exts.length === 3, "three extensions");
    const names = factoryNames(exts);
    assert.ok(
      names.some((n) => String(n).includes("relay")),
      "relay tools present: " + names.join(","),
    );
    // SDK 内联扩展两种合法形态：{name, factory} 对象（relay-tools）或纯函数
    // （remote-verify / environment-info）。
    assert.ok(
      exts.every((e) => typeof e === "function" || (e && typeof e === "object" && typeof e.factory === "function")),
      "extensions are loadable",
    );
  });
});

test("ssh parent without a resolvable project config injects nothing (broken parent)", async () => {
  await withDataDir(async () => {
    const { childExtensionsFor } = await jiti.import("./subagent-bridge.ts");
    // 无项目 meta → ssh 分支拿不到凭据，宁可不注入也不落到服务器本机。
    const exts = childExtensionsFor({ mode: "ssh", ownerId: 1, cwd: "/srv/homes/u1/x" }, undefined);
    assert.equal(exts, undefined);
  });
});

test("sandbox parent: sandbox tools + remote-verify + env-info (inline bridge)", async () => {
  await withDataDir(async () => {
    const { childExtensionsFor } = await jiti.import("./subagent-bridge.ts");
    const exts = childExtensionsFor({ mode: "sandbox", ownerId: 3, cwd: "/srv/homes/u3/p" }, undefined);
    assert.ok(Array.isArray(exts) && exts.length === 3, "three extensions");
  });
});

test("host parent: env-info only; quick parent: none", async () => {
  await withDataDir(async () => {
    const { childExtensionsFor } = await jiti.import("./subagent-bridge.ts");
    const host = childExtensionsFor({ mode: "host", ownerId: 1, cwd: "/home/op/data" }, undefined);
    assert.ok(Array.isArray(host) && host.length === 1, "env-info only");
    const quick = childExtensionsFor({ mode: "quick", ownerId: 1, cwd: "/srv/quick/u1" }, undefined);
    assert.equal(quick, undefined);
  });
});

test("installed hook: unknown parent session injects nothing and never throws", async () => {
  await withDataDir(async () => {
    const { installSubagentBridge } = await jiti.import("./subagent-bridge.ts");
    installSubagentBridge(() => undefined);
    const hook = globalThis.__piWebChildExtensions;
    assert.equal(typeof hook, "function");
    assert.equal(hook("no-such-session"), undefined);
    // lookup 抛异常也不外溢
    installSubagentBridge(() => {
      throw new Error("boom");
    });
    assert.equal(globalThis.__piWebChildExtensions("any"), undefined);
  });
});
