import { NextResponse } from "next/server";
import { getWebSession, isWebAuthEnabled, sessionCookieRefreshHeader } from "@/lib/web-session";
import { getServerSettings } from "@/lib/server-settings";

export const dynamic = "force-dynamic";

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
  return NextResponse.json(
    {
      authEnabled: true,
      user: session.user,
      ...settings,
      ...(session.changeTicket ? { mustChangePassword: true } : {}),
    },
    refreshCookie ? { headers: { "Set-Cookie": refreshCookie } } : undefined,
  );
}
