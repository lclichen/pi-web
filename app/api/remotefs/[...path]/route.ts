import { NextResponse } from "next/server";
import { getFileName } from "@/lib/file-paths";
import {
  remoteCreateEmpty,
  remoteDelete,
  remoteList,
  remoteRead,
  remoteRename,
  remoteWrite,
  resolveRemoteSession,
} from "@/lib/remote-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Mode-scoped file API for sandbox / local-machine sessions — the same verbs
// the local /api/files route serves (list/read/put/delete/patch), executed on
// the session's remote backend (platform container or the user's relay).
// Query: ?src=<sessionId>&type=... — watch is unsupported (501).

function filePathFromSegments(segments: string[]): string {
  const joined = segments.map(decodeURIComponent).join("/");
  return ("/" + joined).replace(/\/{2,}/g, "/");
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("src");
  const type = url.searchParams.get("type") ?? "read";
  if (!sessionId) return NextResponse.json({ error: "src (sessionId) required" }, { status: 400 });
  const { path: segments } = await ctx.params;
  const filePath = filePathFromSegments(segments);

  const remote = await resolveRemoteSession(req, sessionId);
  if (!remote.ok) return NextResponse.json({ error: remote.error }, { status: remote.status });

  try {
    if (type === "watch") {
      return NextResponse.json({ error: "远程会话暂不支持文件监听" }, { status: 501 });
    }
    if (type === "list") {
      const entries = await remoteList(remote.ctx, filePath);
      return NextResponse.json({ entries, path: filePath });
    }
    if (type === "read" || type === "download") {
      const { content, size } = await remoteRead(remote.ctx, filePath);
      if (type === "download") {
        return new Response(content, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(getFileName(filePath))}"`,
          },
        });
      }
      return NextResponse.json({ content, language: "text", size });
    }
    return NextResponse.json({ error: `Unsupported type: ${type}` }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /No such file|ENOENT|not exist/i.test(msg) ? 404 : 502 });
  }
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("src");
  if (!sessionId) return NextResponse.json({ error: "src (sessionId) required" }, { status: 400 });
  const { path: segments } = await ctx.params;
  const filePath = filePathFromSegments(segments);

  const remote = await resolveRemoteSession(req, sessionId);
  if (!remote.ok) return NextResponse.json({ error: remote.error }, { status: remote.status });

  let body: { content?: unknown; type?: unknown };
  try {
    body = (await req.json()) as { content?: unknown; type?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // Create semantics (same shape as the host /api/files PUT): {type:"file"}
  // creates an empty file, {type:"dir"} creates a directory. The platform
  // write schema rejects zero-length content, so empty creates go through
  // touch/mkdir instead of the write tool.
  if (body.content === undefined) {
    if (body.type === "file" || body.type === "dir") {
      try {
        await remoteCreateEmpty(remote.ctx, filePath, body.type);
        return NextResponse.json({ success: true, path: filePath });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /No such file|ENOENT|not exist/i.test(msg) ? 404 : 502 });
      }
    }
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  try {
    await remoteWrite(remote.ctx, filePath, body.content);
    return NextResponse.json({ success: true, path: filePath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /No such file|ENOENT|not exist/i.test(msg) ? 404 : 502 });
  }
}

// POST — file uploads into a remote directory (same semantics as the host
// /api/files POST): ?type=upload-check {fileNames} reports conflicts, and
// ?type=upload&conflict=error|replace|skip takes multipart "files" entries.
// Powers the file explorer's upload button / folder context menu for sandbox,
// local-machine and SSH sessions.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("src");
  if (!sessionId) return NextResponse.json({ error: "src (sessionId) required" }, { status: 400 });
  const type = url.searchParams.get("type") ?? "upload";
  const { path: segments } = await ctx.params;
  const dirPath = filePathFromSegments(segments);

  const remote = await resolveRemoteSession(req, sessionId);
  if (!remote.ok) return NextResponse.json({ error: remote.error }, { status: remote.status });

  const sanitizeName = (name: string): string | null => {
    const base = name.split(/[\\/]/).pop() ?? "";
    if (!base || base === "." || base === "..") return null;
    return base;
  };

  try {
    if (type === "upload-check") {
      if (!hasJsonContentType(req)) {
        return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
      }
      const body = (await req.json().catch(() => null)) as { fileNames?: unknown } | null;
      if (!Array.isArray(body?.fileNames) || !body.fileNames.every((n) => typeof n === "string")) {
        return NextResponse.json({ error: "fileNames must be an array of strings" }, { status: 400 });
      }
      const names = (body.fileNames as string[]).map(sanitizeName);
      if (names.some((n) => n === null)) {
        return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
      }
      const entries = await remoteList(remote.ctx, dirPath);
      const byName = new Map(entries.map((e) => [e.name, e]));
      const conflicts: string[] = [];
      const nonReplaceable: string[] = [];
      for (const name of names as string[]) {
        const existing = byName.get(name);
        if (!existing) continue;
        conflicts.push(name);
        if (existing.isDir) nonReplaceable.push(name);
      }
      return NextResponse.json({ conflicts, nonReplaceable });
    }

    if (type !== "upload") {
      return NextResponse.json({ error: `Unsupported type: ${type}` }, { status: 400 });
    }

    const strategy = url.searchParams.get("conflict") ?? "error";
    if (!["error", "replace", "skip"].includes(strategy)) {
      return NextResponse.json({ error: "Invalid conflict strategy" }, { status: 400 });
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json({ error: "需要 multipart 表单上传" }, { status: 400 });
    }
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.length === 0) {
      return NextResponse.json({ error: "缺少上传文件（字段名 files）" }, { status: 400 });
    }
    const names = files.map((f) => sanitizeName(f.name));
    if (names.some((n) => n === null)) {
      return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
    }

    const entries = await remoteList(remote.ctx, dirPath);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const conflicts = (names as string[]).filter((n) => byName.has(n));
    if (strategy === "error" && conflicts.length > 0) {
      const nonReplaceable = conflicts.filter((n) => byName.get(n)?.isDir);
      return NextResponse.json({ error: "One or more files already exist", conflicts, nonReplaceable }, { status: 409 });
    }

    const uploaded: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    for (let i = 0; i < files.length; i += 1) {
      const name = names[i] as string;
      const exists = byName.has(name);
      if (exists && strategy === "skip") {
        skipped.push(name);
        continue;
      }
      if (exists && byName.get(name)?.isDir) {
        errors.push({ name, error: "Cannot replace a directory" });
        continue;
      }
      try {
        const content = Buffer.from(await files[i].arrayBuffer()).toString("utf8");
        const target = dirPath === "/" ? `/${name}` : `${dirPath}/${name}`;
        await remoteWrite(remote.ctx, target, content);
        uploaded.push(name);
      } catch (err) {
        errors.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return NextResponse.json({ uploaded, skipped, errors });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /No such file|ENOENT|not exist/i.test(msg) ? 404 : 502 });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("src");
  if (!sessionId) return NextResponse.json({ error: "src (sessionId) required" }, { status: 400 });
  const { path: segments } = await ctx.params;
  const filePath = filePathFromSegments(segments);

  const remote = await resolveRemoteSession(req, sessionId);
  if (!remote.ok) return NextResponse.json({ error: remote.error }, { status: remote.status });

  try {
    await remoteDelete(remote.ctx, filePath);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /No such file|ENOENT|not exist/i.test(msg) ? 404 : 502 });
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("src");
  if (!sessionId) return NextResponse.json({ error: "src (sessionId) required" }, { status: 400 });
  const { path: segments } = await ctx.params;
  const filePath = filePathFromSegments(segments);

  const remote = await resolveRemoteSession(req, sessionId);
  if (!remote.ok) return NextResponse.json({ error: remote.error }, { status: remote.status });

  let body: { newPath?: unknown };
  try {
    body = (await req.json()) as { newPath?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.newPath !== "string") {
    return NextResponse.json({ error: "newPath required" }, { status: 400 });
  }
  try {
    await remoteRename(remote.ctx, filePath, body.newPath);
    return NextResponse.json({ success: true, oldPath: filePath, newPath: body.newPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /No such file|ENOENT|not exist/i.test(msg) ? 404 : 502 });
  }
}
