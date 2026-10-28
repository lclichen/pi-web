import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

/**
 * 部署级快速会话专用 MCP（lib/quick-mcp.ts）合并语义：
 * 部署级条目物化进 quick home 的 .pi/mcp.json；部署覆盖同名；用户自加
 * 条目保留；幂等；文件缺失/畸形 = 不动现状。
 */

async function withDataDir(fn) {
  const dir = join(tmpdir(), `quick-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "quick-homes", "u7", ".pi"), { recursive: true });
  const prev = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

const quickTarget = (dir) => join(dir, "quick-homes", "u7", ".pi", "mcp.json");

test("materializes deployment servers into the quick home; user entries kept; same-name overridden", async () => {
  await withDataDir(async (dir) => {
    const { syncQuickMcpConfig } = await jiti.import("./quick-mcp.ts");
    // 用户已有自加条目 + 一个与部署同名的旧定义
    writeFileSync(
      quickTarget(dir),
      JSON.stringify({
        mcpServers: {
          "user-own": { command: "node user.js" },
          shared: { command: "old-version" },
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(dir, "mcp-quick.json"),
      JSON.stringify({
        mcpServers: {
          "quick-only": { command: "node q.js" },
          shared: { command: "new-version" },
        },
      }),
      "utf8",
    );

    syncQuickMcpConfig(7);

    const merged = JSON.parse(readFileSync(quickTarget(dir), "utf8"));
    assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["quick-only", "shared", "user-own"]);
    assert.equal(merged.mcpServers.shared.command, "new-version", "部署级覆盖同名");
    assert.equal(merged.mcpServers["user-own"].command, "node user.js", "用户条目保留");
  });
});

test("idempotent: identical result does not rewrite (mtime stable)", async () => {
  await withDataDir(async (dir) => {
    const { syncQuickMcpConfig } = await jiti.import("./quick-mcp.ts");
    writeFileSync(join(dir, "mcp-quick.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }), "utf8");
    syncQuickMcpConfig(7);
    const stat1 = (await import("node:fs")).statSync(quickTarget(dir));
    await new Promise((r) => setTimeout(r, 20));
    syncQuickMcpConfig(7);
    const stat2 = (await import("node:fs")).statSync(quickTarget(dir));
    assert.equal(stat1.mtimeMs, stat2.mtimeMs, "第二次同步不写盘");
  });
});

test("missing or malformed deployment file leaves everything untouched", async () => {
  await withDataDir(async (dir) => {
    const { syncQuickMcpConfig, deploymentQuickMcpPath } = await jiti.import("./quick-mcp.ts");
    // 缺失：quick home 连 .pi 都可以不存在
    rmSync(join(dir, "quick-homes", "u7"), { recursive: true, force: true });
    syncQuickMcpConfig(7);
    assert.ok(!existsSync(quickTarget(dir)), "无部署文件不创建任何东西");

    // 畸形：形状不对整体忽略
    writeFileSync(deploymentQuickMcpPath(), "{ not json", "utf8");
    syncQuickMcpConfig(7);
    assert.ok(!existsSync(quickTarget(dir)), "畸形文件不写目标");
  });
});
