import { NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { requireBatchIdentity } from "@/lib/batch/batch-auth";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getTask, isTerminal } from "@/lib/batch/task-store";
import { resolveArtifactPath } from "@/lib/batch/batch-utils";

export const dynamic = "force-dynamic";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

const TEXT_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonc": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".mjs": "text/plain; charset=utf-8",
  ".cjs": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".ini": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
};

// GET /api/batch/tasks/[id]/artifacts/[...path] — fetch one artifact's
// content (evaluation harnesses judge produced files; the list in the result
// payload carries paths+sizes only). The task's scanned artifact list is the
// whitelist: only terminal tasks, only listed paths, ≤2MB per file.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const auth = await requireBatchIdentity(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { id, path: segments } = await params;
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
  const abs = resolveArtifactPath(task.actualWorkDir, task.artifacts ?? [], segments ?? []);
  if (!abs) {
    return NextResponse.json(
      { error: "Artifact not in this task's artifact list", artifactsUrl: `/api/batch/tasks/${id}/result` },
      { status: 404 },
    );
  }
  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch {
    return NextResponse.json({ error: "Artifact file no longer exists" }, { status: 410 });
  }
  if (size > MAX_ARTIFACT_BYTES) {
    return NextResponse.json(
      { error: `Artifact too large (${size} bytes > ${MAX_ARTIFACT_BYTES})`, path: segments.join("/") },
      { status: 413 },
    );
  }
  try {
    const content = await readFile(abs);
    const type = TEXT_TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream";
    return new Response(new Uint8Array(content), {
      headers: {
        "Content-Type": type,
        "Content-Length": String(content.length),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Artifact file no longer exists" }, { status: 410 });
  }
}
