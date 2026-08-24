import { NextResponse } from "next/server";
import { getWebSession, isWebAuthEnabled } from "@/lib/web-session";
import { getServerSettings } from "@/lib/server-settings";
import { platformUrl } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

function platformConsoleUrlFor(role: string, req: Request): string | null {
  // Admins get a direct link to the sandbox platform's ops console (images /
  // users / quotas / LLM keys) — routine container management lives in pi-web.
  // The platform is typically co-located with pi-web, so rewrite loopback
  // hosts to the REQUEST's host (PI_WEB_PLATFORM_URL is often 127.0.0.1,
  // which would send the browser to the user's own machine).
  if (role !== "admin") return null;
  try {
    const url = new URL(platformUrl());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "0.0.0.0") {
      // req.url is reconstructed from the bind address; the Host header is
      // what the browser actually used.
      const hostHeader = req.headers.get("host");
      const hostname = hostHeader ? hostHeader.split(":")[0] : null;
      if (hostname) url.host = hostname + (url.port ? `:${url.port}` : "");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// GET /api/webauth/me — current web identity (also works with auth off,
// reporting the implicit host admin so the client can render uniformly).
// Carries deployment-wide settings so the client can gate UI like the Lab
// Training panel before any session exists.
export async function GET(req: Request) {
  const settings = getServerSettings();
  if (!isWebAuthEnabled()) {
    return NextResponse.json({ authEnabled: false, user: null, ...settings });
  }
  const session = getWebSession(req);
  if (!session) return NextResponse.json({ authEnabled: true, user: null, ...settings }, { status: 401 });
  const consoleUrl = platformConsoleUrlFor(session.user.role, req);
  return NextResponse.json({
    authEnabled: true,
    user: session.user,
    ...settings,
    ...(consoleUrl ? { platformConsoleUrl: consoleUrl } : {}),
    ...(session.changeTicket ? { mustChangePassword: true } : {}),
  });
}
