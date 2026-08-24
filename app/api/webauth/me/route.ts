import { NextResponse } from "next/server";
import { getWebSession, isWebAuthEnabled } from "@/lib/web-session";
import { getServerSettings } from "@/lib/server-settings";
import { platformUrl } from "@/lib/platform/client";

export const dynamic = "force-dynamic";

function platformConsoleUrlFor(role: string): string | null {
  // Admins get a direct link to the sandbox platform's ops console (images /
  // users / quotas / LLM keys) — routine container management lives in pi-web.
  if (role !== "admin") return null;
  try {
    return platformUrl();
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
  const consoleUrl = platformConsoleUrlFor(session.user.role);
  return NextResponse.json({
    authEnabled: true,
    user: session.user,
    ...settings,
    ...(consoleUrl ? { platformConsoleUrl: consoleUrl } : {}),
    ...(session.changeTicket ? { mustChangePassword: true } : {}),
  });
}
