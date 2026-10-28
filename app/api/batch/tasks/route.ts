import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireBatchIdentity, checkBatchUserQuota } from "@/lib/batch/batch-auth";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { createTaskRecord, listTasks, toSummary } from "@/lib/batch/task-store";
import { scheduleBatchTask } from "@/lib/batch/task-runner";
import { batchSseHeaders, createBatchTaskEventStream } from "@/lib/batch/task-event-stream";
import { requireCompatibleAgent } from "@/lib/relay/agent-gate";
import { validateAgentDirectory } from "@/lib/relay/browse";
import { getOwnedProject } from "@/lib/projects";

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
    toolNames?: unknown;
    thinkingLevel?: unknown;
    stream?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate required fields
  const mode = body.mode === "host" || body.mode === "sandbox" || body.mode === "local-machine" ? body.mode : null;
  if (!mode) {
    return NextResponse.json({ error: "mode must be 'host', 'sandbox' or 'local-machine' (ssh not yet supported)" }, { status: 400 });
  }
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  // Host mode requires an explicit workDir; sandbox/local-machine derive a
  // per-task home server-side. local-machine MAY pass workDir = the workspace
  // directory on the paired machine (validated below), or bind a project.
  let workDir = "";
  if (mode === "host") {
    if (typeof body.workDir !== "string" || body.workDir.trim().length === 0) {
      return NextResponse.json({ error: "workDir is required in host mode (absolute or server-relative path)" }, { status: 400 });
    }
    workDir = body.workDir;
  }
  if (body.files !== undefined && typeof body.files !== "object") {
    return NextResponse.json({ error: "files must be an object of {path: content}" }, { status: 400 });
  }
  if (mode === "sandbox") {
    // Sandbox mode requires the platform to be wired; refusing here beats the
    // old behavior of silently running tools on the pi-web server host.
    // (Container tool routing itself comes from the amedac-core sandbox
    // module injected by the task runner — no extension path env anymore.)
    if (!process.env.PI_WEB_PLATFORM_URL) {
      return NextResponse.json({ error: "沙盒模式未配置（缺少 PI_WEB_PLATFORM_URL）" }, { status: 400 });
    }
    if (typeof body.containerId !== "number") {
      return NextResponse.json({ error: "containerId is required in sandbox mode (pre-provisioned platform container)" }, { status: 400 });
    }
    if (body.files !== undefined || body.filePackagePath !== undefined) {
      return NextResponse.json({ error: "files/filePackagePath are not supported in sandbox mode — the workspace lives inside the container image" }, { status: 400 });
    }
  }
  // local-machine: the task runs on the key owner's paired machine. The
  // workspace is one of:
  //   · projectId → that local-machine project's workdir + bound machine;
  //   · workDir   → an explicit absolute directory on the paired machine;
  //   · neither   → the client's shared root (legacy behavior).
  let relayWorkspaceDir: string | undefined;
  let relayMachineId: string | undefined;
  let resolvedProject: ReturnType<typeof getOwnedProject>;
  if (mode === "local-machine") {
    if (body.files !== undefined || body.filePackagePath !== undefined) {
      return NextResponse.json({ error: "files/filePackagePath are not supported in local-machine mode — the workspace lives on the paired machine" }, { status: 400 });
    }
    const rawProject = typeof body.projectId === "string"
      ? body.projectId.trim()
      : typeof body.projectId === "number"
        ? String(body.projectId)
        : "";
    if (rawProject) {
      resolvedProject = getOwnedProject(rawProject, auth.identity.user.id, auth.identity.user.role === "admin");
      if (!resolvedProject) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
      if (resolvedProject.mode !== "local-machine") {
        return NextResponse.json({ error: "projectId 指向的不是本机模式项目" }, { status: 400 });
      }
      relayMachineId = resolvedProject.machineId;
      relayWorkspaceDir = resolvedProject.workdir;
    }
    const explicitWorkDir = typeof body.workDir === "string" ? body.workDir.trim() : "";
    if (explicitWorkDir) {
      if (relayWorkspaceDir) {
        return NextResponse.json({ error: "projectId 与 workDir 只能二选一（projectId 已绑定工作区）" }, { status: 400 });
      }
      relayWorkspaceDir = explicitWorkDir;
    }
    const gate = requireCompatibleAgent(auth.identity.user.id, relayMachineId);
    if (!gate.ok) {
      return NextResponse.json({ error: gate.error }, { status: gate.status });
    }
    if (relayWorkspaceDir) {
      try {
        relayWorkspaceDir = await validateAgentDirectory(auth.identity.user.id, gate.machineId, relayWorkspaceDir);
        workDir = relayWorkspaceDir;
      } catch (error) {
        return NextResponse.json(
          { error: `工作目录不可用：${error instanceof Error ? error.message : String(error)}` },
          { status: 400 },
        );
      }
    }
  }
  if (
    body.toolNames !== undefined
    && (!Array.isArray(body.toolNames) || body.toolNames.some((n) => typeof n !== "string"))
  ) {
    return NextResponse.json({ error: "toolNames must be an array of strings" }, { status: 400 });
  }
  const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel as typeof THINKING_LEVELS[number])) {
    return NextResponse.json({ error: "thinkingLevel must be one of: " + THINKING_LEVELS.join(", ") }, { status: 400 });
  }
  const num = (v: unknown, def: number, min: number, max: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : def;
    return Math.min(Math.max(n, min), max);
  };

  // Long-running tasks: default 10 min, hard cap 21 days (1_814_400_000 ms).
  const MAX_TIMEOUT_MS = 1_814_400_000;

  const taskId = randomUUID();
  // 用户级并发闸（开放普通用户，2026-10-22）：非管理员超限 429；含排队任务。
  const quota = checkBatchUserQuota(auth.identity.user);
  if (!quota.ok) {
    return NextResponse.json(
      { error: quota.error },
      {
        status: quota.status,
        headers: { "retry-after": String(Math.ceil(quota.retryAfterMs / 1000)) },
      },
    );
  }
  const task = createTaskRecord({
    taskId,
    sessionId: "",
    ownerId: auth.identity.user.id,
    mode,
    requestedWorkDir: workDir,
    actualWorkDir: "",
    prompt: body.prompt,
    model: typeof body.model === "object" && body.model !== null && "provider" in body.model
      ? body.model as { provider: string; modelId: string }
      : undefined,
    timeoutMs: num(body.timeoutMs, 600_000, 30_000, MAX_TIMEOUT_MS),
    // Auto-answer must fire WELL BEFORE the dialog's own timeout (exit_plan_mode
    // dialogs expire at 300s resolving as "not approved" — an equal default here
    // always loses that race and traps the agent in a planning loop, hit live
    // 9x on deep-swe smoke).
    inputTimeoutMs: num(body.inputTimeoutMs, 60_000, 5_000, MAX_TIMEOUT_MS),
    // Sandbox containers are provisioned/disposed by the caller (eval runner);
    // stopContainer only ever applied to host-managed state and is ignored.
    stopContainer: mode === "sandbox" ? false : body.stopContainer !== false,
    containerId: typeof body.containerId === "number" ? body.containerId : undefined,
    projectId: resolvedProject?.id
      ?? (typeof body.projectId === "number" ? body.projectId : undefined),
    ...(mode === "local-machine" && relayWorkspaceDir ? { workspaceDir: relayWorkspaceDir } : {}),
    ...(mode === "local-machine" && relayMachineId ? { machineId: relayMachineId } : {}),
    toolNames: Array.isArray(body.toolNames) ? body.toolNames as string[] : undefined,
    thinkingLevel: typeof body.thinkingLevel === "string" ? body.thinkingLevel as typeof THINKING_LEVELS[number] : undefined,
  });

  // Fire-and-forget: the task runs in the background; the caller polls or
  // (with stream: true) receives events over the SSE response below.
  scheduleBatchTask({
    taskId,
    prompt: body.prompt,
    workDir,
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
    relayWorkspaceDir: mode === "local-machine" ? relayWorkspaceDir : undefined,
    relayMachineId: mode === "local-machine" ? relayMachineId : undefined,
    platformApiKey: mode === "sandbox" ? auth.identity.apiKey : undefined,
    username: auth.identity.user.username,
    toolNames: task.toolNames,
    thinkingLevel: task.thinkingLevel,
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
  // 归属隔离（开放普通用户）：非管理员只见自己的任务；管理员见全部
  // （含 admin-only 时代的旧任务 ownerId=undefined）。
  const ownerId = auth.identity.user.role === "admin" ? undefined : auth.identity.user.id;
  return NextResponse.json({ tasks: listTasks(limit, ownerId).map(toSummary) });
}
