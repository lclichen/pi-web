import { NextResponse } from "next/server";
import { readMcpConfig } from "@/lib/mcp-config";
import { requireUserIdentity } from "@/lib/web-session";
import { quickHomeDir } from "@/lib/mode-homes";
import { resolveConfigCwdSync } from "@/lib/config-cwd";

export const dynamic = "force-dynamic";

// GET /api/mcp?cwd=|projectId= — merged project+global config document.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  // ?quick=1：解析为当前用户的 quick home——快速会话专用 MCP 作用域
  //（部署级 dataDir/mcp-quick.json 物化产物 + 用户自加条目）。
  if (searchParams.get("quick") === "1") {
    const identity = requireUserIdentity(req);
    if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
    return NextResponse.json(readMcpConfig(quickHomeDir(identity.session.user.id)));
  }
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });
  try {
    return NextResponse.json(readMcpConfig(dir.cwd));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
