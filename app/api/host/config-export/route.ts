import { NextResponse } from "next/server";
import { existsSync, statSync } from "node:fs";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getAllowedFileRootsForRequest, isExistingFilePathAllowed } from "@/lib/file-access";
import { bundleDownloadResponse, exportProjectConfigBundle } from "@/lib/project-config-bundle";

export const dynamic = "force-dynamic";

// GET /api/host/config-export?cwd=<server directory> — download that
// directory's config bundle (.pi/ minus credentials + labs/). Host-mode
// counterpart of the per-project export; admin-only, and the directory must
// pass the same host-space root fence as every other file API.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可用（Host 模式）" }, { status: 403 });
  }

  const cwd = new URL(req.url).searchParams.get("cwd") ?? "";
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return NextResponse.json({ error: "目录不存在" }, { status: 400 });
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRootsForRequest(req))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const name = cwd.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "directory";
    const { bytes, stats } = await exportProjectConfigBundle(cwd, name);
    if (stats.files === 0) {
      return NextResponse.json(
        { error: "该目录没有可导出的配置（缺少 .pi/ 与 labs/）" },
        { status: 400 },
      );
    }
    return bundleDownloadResponse(bytes, `${name}-config.zip`);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
