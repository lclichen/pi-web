import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanStaleNextTypes } from "../scripts/clean-stale-next-types.mjs";

/**
 * Next 16 的生成路由类型在路由重命名后会留下陈旧引用（dev 的 validator.ts
 * import 已删除的 route.js → TS2307）。predev/prebuild 必须清掉两份生成类型，
 * 但不能动 .next/cache。
 */

test("removes stale Next route-type dirs and keeps the build cache", () => {
  const root = mkdtempSync(join(tmpdir(), "next-types-"));
  mkdirSync(join(root, ".next/dev/types"), { recursive: true });
  writeFileSync(
    join(root, ".next/dev/types/validator.ts"),
    'const handler = {} as typeof import("../../../app/api/admin/upload-limits/route.js");',
  );
  mkdirSync(join(root, ".next/types"), { recursive: true });
  writeFileSync(join(root, ".next/types/validator.ts"), "stale");
  mkdirSync(join(root, ".next/cache"), { recursive: true });
  writeFileSync(join(root, ".next/cache/keep.bin"), "x");

  const removed = cleanStaleNextTypes(root);
  assert.deepEqual(removed, [".next/dev/types", ".next/types"]);
  assert.equal(existsSync(join(root, ".next/dev/types")), false);
  assert.equal(existsSync(join(root, ".next/types")), false);
  assert.equal(existsSync(join(root, ".next/cache/keep.bin")), true);
  rmSync(root, { recursive: true, force: true });
});

test("package scripts clean generated types before dev and build", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.predev, /clean-stale-next-types\.mjs/);
  assert.match(pkg.scripts.prebuild, /clean-stale-next-types\.mjs/);
});
