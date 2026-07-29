import { NextResponse } from "next/server";
import { getGitBranchInfo } from "@/lib/git-operations";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  const info = await getGitBranchInfo(cwd);
  return NextResponse.json(info);
}
