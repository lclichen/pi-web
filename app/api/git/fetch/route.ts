import { NextResponse } from "next/server";
import { gitFetch } from "@/lib/git-operations";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: string };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    const result = await gitFetch(body.cwd);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
