import { NextResponse } from "next/server";
import { probeServer } from "@/lib/mcp-probe";
import type { ServerEntry } from "@/lib/api-types";

export const dynamic = "force-dynamic";

// POST /api/mcp/probe  body: { entry, timeoutMs? }
// Read-only: never modifies any config file.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { entry?: ServerEntry; timeoutMs?: number };
    if (!body.entry || typeof body.entry !== "object") {
      return NextResponse.json({ error: "entry required" }, { status: 400 });
    }
    if (!body.entry.command && !body.entry.url) {
      return NextResponse.json(
        { error: "entry must have either command or url" },
        { status: 400 },
      );
    }
    const timeoutMs =
      typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : 15000;
    const result = await probeServer(body.entry, timeoutMs);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
