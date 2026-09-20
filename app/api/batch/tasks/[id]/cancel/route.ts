import { NextResponse } from "next/server";
import { requireBatchIdentity } from "@/lib/batch/batch-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getTask, isTerminal, updateTask } from "@/lib/batch/task-store";
import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// POST /api/batch/tasks/[id]/cancel — cancel a running task.
// Idempotent: cancelling a terminal task returns its current state.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  if (isTerminal(task.state)) {
    return NextResponse.json({ taskId: id, state: task.state, message: "Task already in terminal state" });
  }

  // Abort the running session
  try {
    const wrapper = getRpcSession(task.sessionId);
    if (wrapper?.isAlive()) {
      await wrapper.send({ type: "abort" });
    }
  } catch {
    // Session may already be gone
  }

  updateTask(id, {
    state: "cancelled",
    stopReason: "cancelled",
    endedAt: Date.now(),
  });

  return NextResponse.json({ taskId: id, state: "cancelled" });
}
