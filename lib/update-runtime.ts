/**
 * 运行时版本与部署形态发现（更新器共用）。
 *
 * - 版本：优先读运行目录的 version.json（打包时随包分发，dev 环境即仓库根），
 *   缺失回落构建期注入的 NEXT_PUBLIC_APP_VERSION。
 * - 部署形态（pkg-kind）：AMEDAC_PKG_KIND 环境变量（start-all.sh 按包根
 *   pkg-kind 文件导出）→ AppImage 运行时的 APPIMAGE 环境变量 → 未知（null，
 *   不支持自助更新）。
 * - 应用根（AMEDAC_APP_ROOT）：tarball/electron 部署的可交换目录；由
 *   start-all.sh / Electron 主进程导出。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeVersion {
  version: string;
  channel: string;
}

let cached: RuntimeVersion | null = null;

export function readRuntimeVersion(): RuntimeVersion {
  if (cached) return cached;
  let version = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
  let channel = process.env.NEXT_PUBLIC_APP_CHANNEL ?? "stable";
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "version.json"), "utf8")) as {
      version?: string;
      channel?: string;
    };
    if (raw.version) version = raw.version;
    if (raw.channel) channel = raw.channel;
  } catch { /* dev 环境无 version.json：保留构建期值 */ }
  cached = { version, channel };
  return cached;
}

export function detectPkgKind(): "tarball" | "appimage" | "electron" | null {
  const fromEnv = process.env.AMEDAC_PKG_KIND?.trim();
  if (fromEnv === "tarball" || fromEnv === "appimage" || fromEnv === "electron") return fromEnv;
  if (process.env.APPIMAGE) return "appimage";
  return null;
}

/** tarball/electron 部署的应用根（可交换目录）；appimage 返回 null（更新的是文件本身）。 */
export function getAppRoot(): string | null {
  if (detectPkgKind() === "appimage") return null;
  return process.env.AMEDAC_APP_ROOT?.trim() || null;
}

/** 更新器状态文件路径：<PI_WEB_DATA_DIR>/update-status.json（与 applier 约定一致）。 */
export function updateStatusPath(): string | null {
  const dataDir = process.env.PI_WEB_DATA_DIR?.trim();
  return dataDir ? join(dataDir, "update-status.json") : null;
}

/** 更新器脚本是否存在（package-linux 打平进 <root>/scripts/apply-update.cjs）。 */
export function applierPath(): string | null {
  const root = getAppRoot() ?? process.cwd();
  for (const candidate of [join(root, "scripts", "apply-update.cjs"), join(root, "app", "scripts", "apply-update.cjs")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 当前实例是否具备自助更新条件（形态 + applier + 状态目录齐备）。 */
export function canSelfUpdate(): boolean {
  return detectPkgKind() !== null && applierPath() !== null && updateStatusPath() !== null;
}
