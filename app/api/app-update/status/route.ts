import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { requireUserIdentity } from "@/lib/web-session";
import { updateStatusPath } from "@/lib/update-runtime";
import type { UpdateStatusResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";

/** 更新器状态：applier 原子写入 <dataDir>/update-status.json，本路由只读。 */
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const statusFile = updateStatusPath();
  if (!statusFile) return NextResponse.json({ phase: "idle" } satisfies UpdateStatusResponse);
  try {
    const raw = await readFile(statusFile, "utf8");
    return NextResponse.json(JSON.parse(raw) as UpdateStatusResponse);
  } catch {
    return NextResponse.json({ phase: "idle" } satisfies UpdateStatusResponse);
  }
}
