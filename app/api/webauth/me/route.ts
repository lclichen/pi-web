import { NextResponse } from "next/server";
import { getWebSession, isWebAuthEnabled, sessionCookieRefreshHeader } from "@/lib/web-session";
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

// GET /api/webauth/me — current web identity. With auth off it reports
// { authEnabled: false, user: null }: no web session exists, but the server
// treats every request as the implicit host admin, so clients grant admin UI
// when authEnabled is false. Carries deployment-wide settings so the client
// can gate UI like the Lab Training panel before any session exists.
export async function GET(req: Request) {
  const settings = getServerSettings();
  if (!isWebAuthEnabled()) {
    return NextResponse.json({ authEnabled: false, user: null, ...settings });
  }
  const session = getWebSession(req);
  if (!session) return NextResponse.json({ authEnabled: true, user: null, ...settings }, { status: 401 });
  // Page loads double as a (throttled) sliding-renewal cookie refresh point.
  const refreshCookie = sessionCookieRefreshHeader(req);
  const consoleUrl = platformConsoleUrlFor(session.user.role, req);
  return NextResponse.json(
    {
      authEnabled: true,
      user: session.user,
      ...settings,
      ...(consoleUrl ? { platformConsoleUrl: consoleUrl } : {}),
      ...(session.changeTicket ? { mustChangePassword: true } : {}),
    },
    refreshCookie ? { headers: { "Set-Cookie": refreshCookie } } : undefined,
  );
}
