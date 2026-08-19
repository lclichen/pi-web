import { NextResponse } from "next/server";
import { getWebSession, isWebAuthEnabled } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/webauth/me — current web identity (also works with auth off,
// reporting the implicit host admin so the client can render uniformly).
export async function GET(req: Request) {
  if (!isWebAuthEnabled()) {
    return NextResponse.json({ authEnabled: false, user: null });
  }
  const session = getWebSession(req);
  if (!session) return NextResponse.json({ authEnabled: true, user: null }, { status: 401 });
  return NextResponse.json({
    authEnabled: true,
    user: session.user,
    ...(session.changeTicket ? { mustChangePassword: true } : {}),
  });
}
