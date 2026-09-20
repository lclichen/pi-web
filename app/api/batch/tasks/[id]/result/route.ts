import { NextResponse } from "next/server";
import { requireBatchIdentity } from "@/lib/batch/batch-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getTask, isTerminal } from "@/lib/batch/task-store";

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
  if (!isTerminal(task.state)) {
    return NextResponse.json(
      { error: "Task is still running", state: task.state, statusUrl: `/api/batch/tasks/${id}` },
      { status: 409 },
    );
  }
  return NextResponse.json({
    taskId: task.taskId,
    sessionId: task.sessionId,
    state: task.state,
    stopReason: task.stopReason,
    finalResponse: task.finalResponse,
    usage: task.usage,
    toolCallLog: task.toolCallLog,
    artifacts: task.artifacts,
    sessionFile: task.sessionFile,
    durationMs: task.endedAt && task.startedAt ? task.endedAt - task.startedAt : undefined,
    workDir: task.actualWorkDir,
    error: task.error,
  });
}
