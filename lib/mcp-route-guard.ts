import { NextResponse } from "next/server";
import { resolveConfigCwdSync } from "./config-cwd";
import { isApiRequestAllowed, hasJsonContentType } from "./request-security";

/**
 * Shared guard for the MCP config routes (previously unauthenticated): CSRF
 * check (mutating verbs), identity + cwd ownership via resolveConfigCwdSync,
 * and admin-only global scope — global MCP config affects every session.
 */

export function guardMcpRequest(
  req: Request,
  params: { projectId?: string | null; cwd?: string | null; scope?: unknown },
  opts: { mutating: boolean },
): { ok: true; cwd: string; isAdmin: boolean } | { ok: false; response: NextResponse } {
  if (opts.mutating) {
    if (!isApiRequestAllowed(req)) {
      return { ok: false, response: NextResponse.json({ error: "Untrusted API request" }, { status: 403 }) };
    }
    if (hasJsonContentType(req) === false && req.method !== "DELETE") {
      return { ok: false, response: NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 }) };
    }
  }
  const dir = resolveConfigCwdSync(req, { projectId: params.projectId, cwd: params.cwd });
  if (!dir.ok) return { ok: false, response: NextResponse.json({ error: dir.error }, { status: dir.status }) };
  if (params.scope === "global" && !dir.isAdmin) {
    return { ok: false, response: NextResponse.json({ error: "全局 MCP 配置仅管理员可修改" }, { status: 403 }) };
  }
  return { ok: true, cwd: dir.cwd, isAdmin: dir.isAdmin };
}
