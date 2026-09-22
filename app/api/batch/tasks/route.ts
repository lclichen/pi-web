import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireBatchIdentity } from "@/lib/batch/batch-auth";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { createTaskRecord, listTasks, toSummary } from "@/lib/batch/task-store";
import { runBatchTask } from "@/lib/batch/task-runner";
import { batchSseHeaders, createBatchTaskEventStream } from "@/lib/batch/task-event-stream";

export const dynamic = "force-dynamic";

// POST /api/batch/tasks — create a batch test task.
//   Default: async — returns 202 + taskId; the caller polls.
//   stream: true — responds with an SSE stream of task events and closes
//   after the terminal result event (same events as GET /tasks/{id}/stream).
// GET  /api/batch/tasks?limit=50 — list recent tasks.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const auth = await requireBatchIdentity(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: {
    mode?: unknown;
    workDir?: unknown;
    prompt?: unknown;
    files?: unknown;
    filePackagePath?: unknown;
    model?: unknown;
    timeoutMs?: unknown;
    inputTimeoutMs?: unknown;
    stopContainer?: unknown;
    containerId?: unknown;
    projectId?: unknown;
    stream?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate required fields
  const mode = body.mode === "host" || body.mode === "sandbox" ? body.mode : null;
  if (!mode) {
    return NextResponse.json({ error: "mode must be 'host' or 'sandbox' (ssh/local-machine not yet supported)" }, { status: 400 });
  }
  if (typeof body.workDir !== "string" || body.workDir.trim().length === 0) {
    return NextResponse.json({ error: "workDir is required (absolute or server-relative path)" }, { status: 400 });
  }
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  if (body.files !== undefined && typeof body.files !== "object") {
    return NextResponse.json({ error: "files must be an object of {path: content}" }, { status: 400 });
  }
  const num = (v: unknown, def: number, min: number, max: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : def;
    return Math.min(Math.max(n, min), max);
  };

  const taskId = randomUUID();
  const task = createTaskRecord({
    taskId,
    sessionId: "",
    mode,
    requestedWorkDir: body.workDir,
    actualWorkDir: "",
    prompt: body.prompt,
    model: typeof body.model === "object" && body.model !== null && "provider" in body.model
      ? body.model as { provider: string; modelId: string }
      : undefined,
    timeoutMs: num(body.timeoutMs, 600_000, 30_000, 3_600_000),
    inputTimeoutMs: num(body.inputTimeoutMs, 300_000, 5_000, 3_600_000),
    stopContainer: body.stopContainer !== false,
    containerId: typeof body.containerId === "number" ? body.containerId : undefined,
    projectId: typeof body.projectId === "number" ? body.projectId : undefined,
  });

  // Fire-and-forget: the task runs in the background; the caller polls or
  // (with stream: true) receives events over the SSE response below.
  void runBatchTask({
    taskId,
    prompt: body.prompt,
    workDir: body.workDir,
    files: typeof body.files === "object" && body.files !== null ? body.files as Record<string, string> : undefined,
    filePackagePath: typeof body.filePackagePath === "string" ? body.filePackagePath : undefined,
    mode,
    model: task.model,
    timeoutMs: task.timeoutMs,
    inputTimeoutMs: task.inputTimeoutMs,
    stopContainer: task.stopContainer,
    ownerId: auth.identity.user.id,
    containerId: task.containerId,
    projectId: task.projectId,
  }).catch((e) => {
    // runBatchTask handles its own errors; this is a safety net
    console.error(`[batch] task ${taskId} crashed:`, e);
  });

  // Streaming mode: same task lifecycle, SSE view instead of 202 + polling.
  // A client disconnect only drops the view — the task keeps running and
  // stays reachable via polling / cancel / GET /tasks/{id}/stream.
  if (body.stream === true) {
    return new Response(createBatchTaskEventStream(taskId, req), {
      headers: batchSseHeaders(),
    });
  }

  return NextResponse.json(
    {
      taskId,
      statusUrl: `/api/batch/tasks/${taskId}`,
      resultUrl: `/api/batch/tasks/${taskId}/result`,
    },
    { status: 202 },
  );
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const auth = await requireBatchIdentity(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 50), 200);
  return NextResponse.json({ tasks: listTasks(limit).map(toSummary) });
}
