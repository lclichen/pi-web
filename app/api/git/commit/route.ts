import { NextResponse } from "next/server";
import { gitCommit } from "@/lib/git-operations";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: string; message?: string; files?: string[] };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.message?.trim()) return NextResponse.json({ error: "Commit message required" }, { status: 400 });
    const result = await gitCommit(body.cwd, body.message.trim(), body.files);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
