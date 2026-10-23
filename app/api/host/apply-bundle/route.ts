import { NextResponse } from "next/server";
import { existsSync, statSync } from "node:fs";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { getAllowedFileRootsForRequest, isExistingFilePathAllowed } from "@/lib/file-access";
import { applyBundleToDirectory, bundleExists, isValidBundleName } from "@/lib/config-bundles-store";
import { join } from "node:path";

export const dynamic = "force-dynamic";

/**
 * POST /api/host/apply-bundle { cwd, name } — 把配置模板套用到 Host 模式的
 * 服务器目录（Host 侧对应 /api/projects/:id/apply-bundle）。管理员专用，
 * 目录须通过与其余文件 API 相同的 host 空间栅栏。
 *
 * 与项目套用的"增量覆盖"不同：Host 目录通常是已有代码的裸目录，套用前
 * 要求目标**没有 .pi/ 目录**（409），防止模板静默覆盖既有配置。
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可用（Host 模式）" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { cwd?: unknown; name?: unknown };
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return NextResponse.json({ error: "目录不存在" }, { status: 400 });
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRootsForRequest(req))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!isValidBundleName(name) || !bundleExists(name)) {
    return NextResponse.json({ error: `配置模板不存在：${name}` }, { status: 400 });
  }
  if (existsSync(join(cwd, ".pi"))) {
    return NextResponse.json(
      { error: "该目录已存在 .pi/ 配置——Host 模式套用仅限未初始化的目录（防止覆盖既有配置）" },
      { status: 409 },
    );
  }

  try {
    await applyBundleToDirectory(name, cwd);
    return NextResponse.json({ ok: true, name, cwd });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
