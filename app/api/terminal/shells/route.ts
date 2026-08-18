import { NextResponse } from "next/server";
import { listShells } from "@/lib/shell-resolver";

export const dynamic = "force-dynamic";

// GET /api/terminal/shells — shells available on the pi-web server host, for
// the terminal tab's dropdown. Best candidate first.
export async function GET() {
  return NextResponse.json({ success: true, data: { shells: listShells() } });
}
