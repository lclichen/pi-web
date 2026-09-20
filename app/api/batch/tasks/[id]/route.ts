import { NextResponse } from "next/server";
import { requireBatchIdentity } from "@/lib/batch/batch-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getTask, toSummary } from "@/lib/batch/task-store";
import { getBatchVersionInfo } from "@/lib/batch/version-info";

export const dynamic = "force-dynamic";

// GET /api/batch/tasks/[id] — poll task status (lightweight summary + versions).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const auth = await requireBatchIdentity(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id } = await params;
  const task = getTask(id);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return NextResponse.json({ ...toSummary(task), versions: getBatchVersionInfo() });
}
