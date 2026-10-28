import { NextResponse } from "next/server";
import { requireBatchIdentity, canAccessBatchTask } from "@/lib/batch/batch-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getTask, isTerminal, toFullResult } from "@/lib/batch/task-store";
import { getBatchVersionInfo } from "@/lib/batch/version-info";

export const dynamic = "force-dynamic";

// GET /api/batch/tasks/[id]/result — full results (terminal states only).
// Returns 409 with current state if the task is still running.
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
  if (!canAccessBatchTask(auth.identity.user, task.ownerId)) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (!isTerminal(task.state)) {
    return NextResponse.json(
      { error: "Task is still running", state: task.state, statusUrl: `/api/batch/tasks/${id}` },
      { status: 409 },
    );
  }
  // Same payload as the SSE terminal `result` event.
  return NextResponse.json({
    ...toFullResult(task),
    versions: getBatchVersionInfo(),
  });
}
