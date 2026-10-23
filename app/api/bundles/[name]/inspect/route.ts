import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { bundleExists, isValidBundleName, readBundle } from "@/lib/config-bundles-store";
import { isApkgBytes, getApkgKeys } from "@/lib/apkg";
import { openApkgViaTool } from "@/lib/apkg-open";
import { inspectBundleZip, looksBinary, readBundleFileFromZip } from "@/lib/bundle-inspect";

export const dynamic = "force-dynamic";

/**
 * GET /api/bundles/[name]/inspect[?path=<rel>] — Agents 管理 · Agent 定义
 * 的内容解析与文件预览。展示专用：不写盘、不消耗 .apkg 许可（那只在
 * 套用时发生）。内容含商业加密包的扩展代码，因此仅管理员可用。
 */
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "需要管理员权限" }, { status: identity.status });

  const { name } = await params;
  if (!isValidBundleName(name) || !bundleExists(name)) {
    return NextResponse.json({ error: "配置包不存在" }, { status: 404 });
  }

  let zipData = readBundle(name);
  if (isApkgBytes(zipData)) {
    try {
      zipData = await openApkgViaTool(zipData, getApkgKeys());
    } catch (e) {
      return NextResponse.json(
        { error: `配置包解密失败: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 },
      );
    }
  }

  const path = new URL(req.url).searchParams.get("path");
  try {
    if (path) {
      const file = await readBundleFileFromZip(zipData, path);
      const binary = looksBinary(file.bytes);
      return NextResponse.json({
        path,
        size: file.size,
        truncated: file.truncated,
        binary,
        ...(binary ? {} : { content: file.bytes.toString("utf8") }),
      });
    }
    const inspection = await inspectBundleZip(zipData);
    return NextResponse.json({ inspection });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
