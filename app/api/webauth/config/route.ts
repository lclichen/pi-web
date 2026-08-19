import { NextResponse } from "next/server";
import { platformAnonGet } from "@/lib/platform/client";
import { isWebAuthEnabled } from "@/lib/web-session";

export const dynamic = "force-dynamic";

// GET /api/webauth/config — registration mode advertised by the platform,
// for the login page's register form.
export async function GET() {
  if (!isWebAuthEnabled()) {
    return NextResponse.json({ registerMode: "off" });
  }
  try {
    const res = await platformAnonGet<{ registerMode: string }>("/api/v1/auth/config");
    if (res.ok) return NextResponse.json({ registerMode: res.data.registerMode });
  } catch {
    // platform unreachable — fall through
  }
  return NextResponse.json({ registerMode: "off" });
}
