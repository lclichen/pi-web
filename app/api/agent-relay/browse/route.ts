import { NextResponse } from "next/server";
import { AgentUnavailableError } from "@/lib/relay/forward";
import { browseAgentDirectory, createAgentDirectory } from "@/lib/relay/browse";
import { requireUserIdentity } from "@/lib/web-session";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function parseMachineId(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return null;
  return raw;
}

function failure(error: unknown) {
  if (error instanceof AgentUnavailableError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
}

// GET /api/agent-relay/browse?path=<abs>&machineId=<id>
// List the sub-directories of a directory on the user's paired machine. An
// empty path starts at the agent's shared root. Used by the new-project
// wizard's local-machine directory picker.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  const url = new URL(req.url);
  const machineId = parseMachineId(url.searchParams.get("machineId"));
  if (machineId === null) return NextResponse.json({ error: "machineId 不合法" }, { status: 400 });
  const path = url.searchParams.get("path")?.trim() || undefined;

  try {
    const listing = await browseAgentDirectory(identity.session.user.id, machineId, path);
    return NextResponse.json(listing, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

// POST /api/agent-relay/browse  { path, name, machineId? }
// Create one direct child directory inside `path`; returns its absolute path.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  let body: { path?: unknown; name?: unknown; machineId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const machineId = parseMachineId(body.machineId);
  if (machineId === null) return NextResponse.json({ error: "machineId 不合法" }, { status: 400 });
  const parent = typeof body.path === "string" ? body.path.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!parent) return NextResponse.json({ error: "缺少父目录" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "文件夹名不能为空" }, { status: 400 });

  try {
    const created = await createAgentDirectory(identity.session.user.id, machineId, parent, name);
    return NextResponse.json({ path: created }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
