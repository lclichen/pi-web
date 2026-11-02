#!/usr/bin/env node
/**
 * Next 16 把路由类型生成到 .next/dev/types（dev）和 .next/types（build）。
 * 这两个目录是纯生成产物，不随源码里的路由重命名/删除而自动收缩：在旧路由
 * 上跑过 dev（例如 api/admin/upload-limits → api/admin/global-config），然后
 * 直接 next build 或 tsc，validator.ts 仍 import 已删除的 route.js，报
 * TS2307 "Cannot find module '../../../app/api/admin/upload-limits/route.js'"。
 *
 * 构建/开发前清掉这两份生成类型即可；保留 .next/cache 与 dev 的其它状态。
 * 作为 predev/prebuild 执行；也接受一个可选的根目录参数（测试用）。
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STALE_DIRS = [".next/dev/types", ".next/types"];

/** Remove generated route-type dirs under `root`; returns the removed paths. */
export function cleanStaleNextTypes(root) {
  const removed = [];
  for (const rel of STALE_DIRS) {
    const dir = join(root, rel);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(rel);
  }
  return removed;
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const root = process.argv[2] ?? join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const removed = cleanStaleNextTypes(root);
  if (removed.length > 0) {
    console.log(`[clean-next-types] removed stale generated types: ${removed.join(", ")}`);
  }
}
