import { NextResponse } from "next/server";
import { getWebSession, isWebAuthEnabled } from "@/lib/web-session";
import { getServerSettings } from "@/lib/server-settings";

export const dynamic = "force-dynamic";

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
  return NextResponse.json({
    authEnabled: true,
    user: session.user,
    ...settings,
    ...(session.changeTicket ? { mustChangePassword: true } : {}),
  });
}
