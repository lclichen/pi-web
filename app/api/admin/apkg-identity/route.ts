import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getApkgIdentityInfo } from "@/lib/apkg";
import { resolveApkgTool } from "@/lib/apkg-open";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/apkg-identity — 只读接收方公钥状态。
 *
 * v2 的私钥在打包时由 apkg-publisher seal 封进解密二进制，运行时只在内存
 * 解密；pi-web 只读取 config/apkg-recipient.json 的公钥元信息用于展示。
 * 旧 /api/admin/apkg-keys 的写入接口已移除。
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.status === 403 ? "仅管理员可用" : "登录已失效" },
      { status: identity.status },
    );
  }
  try {
    const toolPath = resolveApkgTool();
    return NextResponse.json({
      identity: getApkgIdentityInfo(),
      tool: {
        path: toolPath,
        configured: Boolean(toolPath),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
