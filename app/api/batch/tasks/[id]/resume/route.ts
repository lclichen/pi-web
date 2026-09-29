import { NextResponse } from "next/server";
import { requireBatchIdentity } from "@/lib/batch/batch-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getTask, updateTask } from "@/lib/batch/task-store";
import { runBatchTask } from "@/lib/batch/task-runner";

export const dynamic = "force-dynamic";

// POST /api/batch/tasks/[id]/resume — resume an interrupted task.
//
// Interruptions are pi-web restarts: the persisted record survives, the pi
// session file survives, but the in-process agent session is gone. Resume
// reopens the session file (continuing the transcript) in the same workDir /
// per-task home and sends a continuation prompt. The timeout budget restarts
// with this run; the model and tool allowlist come from the original record.
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
  if (task.state !== "interrupted") {
    return NextResponse.json(
      { error: `Task is '${task.state}' — only interrupted tasks can be resumed` },
      { status: 409 },
    );
  }

  let prompt: string | undefined;
  try {
    const body = (await req.json()) as { prompt?: unknown };
    if (body?.prompt !== undefined) {
      if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
        return NextResponse.json({ error: "prompt must be a non-empty string" }, { status: 400 });
      }
      prompt = body.prompt;
    }
  } catch {
    // No body / empty body → default continuation prompt below
  }
  const continuation =
    prompt
    ?? "The pi-web server restarted while you were working on the task above. Continue where you left off and finish the task. If you already finished, verify your work (e.g. re-run the tests) and re-state your final answer.";

  updateTask(id, {
    state: "running",
    startedAt: Date.now(),
    resumedCount: (task.resumedCount ?? 0) + 1,
    interruptedAt: undefined,
    error: undefined,
    prompt: continuation,
  });

  void runBatchTask({
    taskId: id,
    prompt: continuation,
    workDir: task.requestedWorkDir || task.actualWorkDir,
    mode: task.mode === "sandbox" ? "sandbox" : "host",
    model: task.model,
    timeoutMs: task.timeoutMs,
    inputTimeoutMs: task.inputTimeoutMs,
    stopContainer: false,
    ownerId: auth.identity.user.id,
    containerId: task.containerId,
    platformApiKey: task.mode === "sandbox" ? auth.identity.apiKey : undefined,
    username: auth.identity.user.username,
    toolNames: task.toolNames,
    resume: true,
  }).catch((e) => {
    console.error(`[batch] resumed task ${id} crashed:`, e);
  });

  return NextResponse.json({ taskId: id, state: "running", resumed: true }, { status: 202 });
}
