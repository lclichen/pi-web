import { NextResponse } from "next/server";
import { platformGet, platformPost, platformDelete } from "@/lib/platform/client";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function apiKeyOf(req: Request): { ok: true; apiKey: string } | { ok: false; response: NextResponse } {
  const identity = requireUserIdentity(req);
  if (!identity.ok) {
    return { ok: false, response: NextResponse.json({ error: "登录已失效" }, { status: identity.status }) };
  }
  if (!identity.session.apiKey) {
    return { ok: false, response: NextResponse.json({ error: "缺少平台凭证，请重新登录" }, { status: 401 }) };
  }
  return { ok: true, apiKey: identity.session.apiKey };
}

// GET /api/workspaces/[id]/files?path=/[&type=download&file=<name>]
// List a directory, or download one file (streamed through the BFF).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = apiKeyOf(req);
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const path = url.searchParams.get("path") || "/";
  const wsId = Number(id);
  if (!Number.isInteger(wsId) || wsId <= 0) {
    return NextResponse.json({ error: "workspaceId invalid" }, { status: 400 });
  }
  try {
    if (url.searchParams.get("type") === "download") {
      const file = url.searchParams.get("file");
      if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });
      const base = `${process.env.PI_WEB_PLATFORM_URL?.replace(/\/+$/, "")}/api/v1/workspaces/${wsId}/files/content`;
      const upstream = await fetch(`${base}?path=${encodeURIComponent(`${path === "/" ? "" : path}/${file}`)}`, {
        headers: { "X-API-Key": guard.apiKey },
        cache: "no-store",
      });
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        return NextResponse.json({ error: text.slice(0, 200) || `HTTP ${upstream.status}` }, { status: 502 });
      }
      return new Response(upstream.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file)}`,
        },
      });
    }
    const list = await platformGet<{ path: string; entries?: Array<{ name: string; isDir?: boolean; is_dir?: boolean; size?: number; mtime?: string; modifiedAt?: string }> }>(
      `/api/v1/workspaces/${wsId}/files`,
      guard.apiKey,
      { path },
    );
    const entries = (list.entries ?? []).map((e) => ({
      name: e.name,
      isDir: e.isDir ?? e.is_dir ?? false,
      size: e.size ?? 0,
      modified: e.mtime ?? e.modifiedAt ?? "",
    }));
    return NextResponse.json({ path, entries });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

// POST /api/workspaces/[id]/files?path=/&name=<file>  body: raw octet-stream
// Upload one file into the workspace directory (platform caps per-file size).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const guard = apiKeyOf(req);
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  const wsId = Number(id);
  const url = new URL(req.url);
  const path = url.searchParams.get("path") || "/";
  const name = url.searchParams.get("name");
  if (!Number.isInteger(wsId) || wsId <= 0 || !name) {
    return NextResponse.json({ error: "workspaceId and name required" }, { status: 400 });
  }
  try {
    const body = Buffer.from(await req.arrayBuffer());
    const base = `${process.env.PI_WEB_PLATFORM_URL?.replace(/\/+$/, "")}/api/v1/workspaces/${wsId}/files`;
    const upstream = await fetch(`${base}?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "X-API-Key": guard.apiKey, "Content-Type": "application/octet-stream" },
      body: new Uint8Array(body),
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json({ error: text.slice(0, 300) || `HTTP ${upstream.status}` }, { status: 502 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

// DELETE /api/workspaces/[id]/files?path=/<name>
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const guard = apiKeyOf(req);
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  const wsId = Number(id);
  const path = new URL(req.url).searchParams.get("path") || "";
  if (!Number.isInteger(wsId) || wsId <= 0 || !path || path === "/") {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }
  try {
    const base = `${process.env.PI_WEB_PLATFORM_URL?.replace(/\/+$/, "")}/api/v1/workspaces/${wsId}/files`;
    const upstream = await fetch(`${base}?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: { "X-API-Key": guard.apiKey },
    });
    if (!upstream.ok && upstream.status !== 204) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json({ error: text.slice(0, 200) || `HTTP ${upstream.status}` }, { status: 502 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

// PATCH /api/workspaces/[id]/files  { path, to } — move/rename (platform R5)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const guard = apiKeyOf(req);
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  const wsId = Number(id);
  let body: { path?: unknown; to?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.path !== "string" || typeof body.to !== "string") {
    return NextResponse.json({ error: "path and to required" }, { status: 400 });
  }
  try {
    await platformPost(`/api/v1/workspaces/${wsId}/files/move`, guard.apiKey, { path: body.path, to: body.to });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
