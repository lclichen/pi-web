import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { inferLegacyModeFromCwd } = await jiti.import("./session-metas.ts");

test("infers sandbox for legacy pre-meta sessions by cwd", () => {
  // Windows 与 POSIX 形态的沙箱家目录都识别（含旧仓路径）。
  assert.equal(inferLegacyModeFromCwd("D:\\x\\pi-web\\data\\sandbox-homes\\u1\\ac8adf41-6d14"), "sandbox");
  assert.equal(inferLegacyModeFromCwd("/srv/app/data/sandbox-homes/u3/abc"), "sandbox");
  // 非 sandbox-homes 路径不推断（host/CLI 会话保持无 mode 默认）。
  assert.equal(inferLegacyModeFromCwd("/home/user/some-project"), null);
  assert.equal(inferLegacyModeFromCwd("D:\\work\\local-homes\\u1\\p1"), null);
  assert.equal(inferLegacyModeFromCwd(undefined), null);
  assert.equal(inferLegacyModeFromCwd(""), null);
});

test("sessions route falls back to cwd inference when meta is absent", async () => {
  const routeSource = await readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8");
  assert.match(routeSource, /inferLegacyModeFromCwd/);
  assert.match(routeSource, /meta\?\.mode \?\? inferLegacyModeFromCwd\(s\.cwd\)/);
});
