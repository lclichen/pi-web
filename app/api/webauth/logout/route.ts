import { NextResponse } from "next/server";
import { dropWebSession, getWebSession, clearSessionCookieHeader } from "@/lib/web-session";
import { platformUrl } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

// POST /api/webauth/logout — drop the web session; best-effort revoke the
// platform API key created at login.
export async function POST(req: Request) {
  const session = getWebSession(req);
  if (session?.apiKey && session.apiKeyId) {
    try {
      await fetch(`${platformUrl()}/api/v1/auth/api-keys/${encodeURIComponent(String(session.apiKeyId))}`, {
        method: "DELETE",
        headers: { "X-API-Key": session.apiKey },
      }).catch(() => {});
    } catch {
      // best-effort
    }
  }
  dropWebSession(req);
  return NextResponse.json({ success: true }, { headers: { "Set-Cookie": clearSessionCookieHeader() } });
}
