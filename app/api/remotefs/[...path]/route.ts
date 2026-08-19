import { NextResponse } from "next/server";
import { getFileName } from "@/lib/file-paths";
import {
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
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
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

  let body: { content?: unknown };
  try {
    body = (await req.json()) as { content?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  try {
    await remoteWrite(remote.ctx, filePath, body.content);
    return NextResponse.json({ success: true, path: filePath });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
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
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
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
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
