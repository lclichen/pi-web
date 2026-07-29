import { NextResponse } from "next/server";
import { gitStage } from "@/lib/git-operations";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: string; files?: string[] };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    const result = await gitStage(body.cwd, body.files);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
