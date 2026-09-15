import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { parseUpdateCatalog, selectCatalogTarget, type CatalogFramework } from "@/lib/app-update";
import { applierPath, detectPkgKind, getAppRoot, readRuntimeVersion, updateStatusPath } from "@/lib/update-runtime";
import type { UpdateApplyResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";

/** 与 GET /api/app-update 一致但绕过缓存（apply 必须拿最新 catalog）。 */
async function loadCatalog(source: string) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`catalog 源返回 HTTP ${response.status}`);
    return parseUpdateCatalog(JSON.parse(await response.text()));
  }
  return parseUpdateCatalog(JSON.parse(await readFile(source, "utf8")));
}

function frameworkForKind(
  frameworks: Partial<Record<"tarball" | "appimage" | "electron", CatalogFramework>>,
  pkgKind: "tarball" | "appimage" | "electron",
): { kind: "tarball" | "appimage" | "electron"; framework: CatalogFramework } | null {
  // electron 部署优先 electron 专属产物，缺失时回落 tarball（同为目录交换）。
  if (pkgKind === "electron") {
    return frameworks.electron ? { kind: "electron", framework: frameworks.electron }
      : frameworks.tarball ? { kind: "tarball", framework: frameworks.tarball }
      : null;
  }
  return frameworks[pkgKind] ? { kind: pkgKind, framework: frameworks[pkgKind]! } : null;
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { user } = identity.session;
  if (user.id !== 0 && user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可以应用更新" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  const catalogSource = process.env.AMEDAC_UPDATE_CATALOG_URL?.trim();
  if (!catalogSource) {
    return NextResponse.json({ started: false, error: "未配置更新源（AMEDAC_UPDATE_CATALOG_URL）" } satisfies UpdateApplyResponse, { status: 400 });
  }
  const pkgKind = detectPkgKind();
  if (!pkgKind) {
    return NextResponse.json({ started: false, error: "无法识别部署形态（非打包部署，不支持自助更新）" } satisfies UpdateApplyResponse, { status: 400 });
  }
  const applier = applierPath();
  const statusFile = updateStatusPath();
  const appRoot = getAppRoot();
  if (!applier || !statusFile || (pkgKind !== "appimage" && !appRoot)) {
    return NextResponse.json({ started: false, error: "更新器组件缺失（AMEDAC_APP_ROOT / apply-update 脚本 / 数据目录不可用）" } satisfies UpdateApplyResponse, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { version?: unknown };
  try {
    // 互斥：上一轮 applier 还在跑（downloading~restarting）就拒绝并发触发。
    const statusFile = updateStatusPath();
    if (statusFile) {
      try {
        const current = JSON.parse(await readFile(statusFile, "utf8")) as { phase?: string };
        if (current.phase && ["downloading", "verifying", "staging", "swapping", "restarting"].includes(current.phase)) {
          return NextResponse.json({ started: false, error: "已有更新在进行中" } satisfies UpdateApplyResponse, { status: 429 });
        }
      } catch { /* 无状态文件 = idle */ }
    }
    const catalog = await loadCatalog(catalogSource);
    const { channel } = readRuntimeVersion();
    let target = selectCatalogTarget(catalog, channel);
    if (typeof body.version === "string" && body.version) {
      target = catalog.versions.find((v) => v.version === body.version) ?? null;
      if (!target) {
        return NextResponse.json({ started: false, error: `catalog 中不存在版本 ${body.version}` } satisfies UpdateApplyResponse, { status: 400 });
      }
    }
    if (!target) {
      return NextResponse.json({ started: false, error: "catalog 中没有匹配当前通道的版本" } satisfies UpdateApplyResponse, { status: 400 });
    }
    const selected = frameworkForKind(target.frameworks, pkgKind);
    if (!selected) {
      return NextResponse.json({ started: false, error: `版本 ${target.version} 没有 ${pkgKind} 形态的产物` } satisfies UpdateApplyResponse, { status: 400 });
    }

    const config = {
      catalogSource,
      version: target.version,
      framework: {
        kind: selected.kind,
        fileName: selected.framework.file_name,
        relativePath: selected.framework.relative_path,
        sha256: selected.framework.checksum_sha256,
        sizeBytes: selected.framework.size_bytes,
      },
      pkgKind,
      appRoot,
      appImagePath: pkgKind === "appimage" ? process.env.APPIMAGE ?? null : null,
      appDir: pkgKind === "appimage" ? process.env.APPDIR ?? null : null,
      electronExec: process.env.AMEDAC_ELECTRON_EXEC ?? null,
      dataDir: process.env.PI_WEB_DATA_DIR?.trim() ?? null,
    };
    if (!config.dataDir) {
      return NextResponse.json({ started: false, error: "PI_WEB_DATA_DIR 未配置" } satisfies UpdateApplyResponse, { status: 400 });
    }

    // 分离执行：applier 与本服务进程脱钩，交换目录/重启服务时它可以活着收尾。
    const child = spawn(process.execPath, [applier, JSON.stringify(config)], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();

    return NextResponse.json({ started: true, statusUrl: "/api/app-update/status" } satisfies UpdateApplyResponse, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { started: false, error: error instanceof Error ? error.message : String(error) } satisfies UpdateApplyResponse,
      { status: 502 },
    );
  }
}
