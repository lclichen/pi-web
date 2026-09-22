import { NextResponse } from "next/server";
import { requireBatchIdentity } from "@/lib/batch/batch-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getTask } from "@/lib/batch/task-store";
import { batchSseHeaders, createBatchTaskEventStream } from "@/lib/batch/task-event-stream";

export const dynamic = "force-dynamic";

// GET /api/batch/tasks/[id]/stream — SSE stream of one task's events.
// Replays the buffered events (task_created onward), then forwards live
// events and closes after the terminal `result` event. Works at any task
// age: attaching to a finished task replays everything and closes at once.
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
  return new Response(createBatchTaskEventStream(id, req), {
    headers: batchSseHeaders(),
  });
}
