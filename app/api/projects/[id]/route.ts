import { NextResponse } from "next/server";
import { deleteProject, getOwnedProject, readProjectSandboxConfig, updateProject, writeSandboxConfig, projectHome } from "@/lib/projects";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { invalidateModelsCache } from "@/lib/models-cache";

export const dynamic = "force-dynamic";

interface RouteCtx { params: Promise<{ id: string }> }

function own(req: Request, id: string) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { error: NextResponse.json({ error: "登录已失效" }, { status: identity.status }) };
  const project = getOwnedProject(id, identity.session.user.id, identity.session.user.role === "admin");
  if (!project) return { error: NextResponse.json({ error: "项目不存在" }, { status: 404 }) };
  return { identity, project };
}

// GET /api/projects/:id — record + project-scoped model credential files.
export async function GET(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const r = own(req, id);
  if (r.error) return r.error;
  const readOptional = (name: string): string | null => {
    try {
      return readFileSync(`${projectHome(r.project!)}/.pi/${name}`, "utf8");
    } catch {
      return null;
    }
  };
  let agentsMd: string | null = null;
  try {
    agentsMd = readFileSync(`${projectHome(r.project!)}/AGENTS.md`, "utf8");
  } catch {
    // absent — inherited from the global layer / SDK defaults
  }
  return NextResponse.json({
    project: r.project,
    ...(r.project!.mode === "sandbox" ? { sandbox: readProjectSandboxConfig(r.project!) } : {}),
    modelsJson: readOptional("models.json"),
    authJson: readOptional("auth.json"),
    agentsMd,
  });
}

// PATCH /api/projects/:id { name?, containerId?, pinSessionId?, unpinSessionId?,
//                            modelsJson?, authJson?, apiKey? }
export async function PATCH(req: Request, ctx: RouteCtx) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { id } = await ctx.params;
  const r = own(req, id);
  if (r.error) return r.error;
  const project = r.project!;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Credential files: JSON-validated, empty string removes (inherit global).
  let credentialsTouched = false;
  for (const key of ["modelsJson", "authJson"] as const) {
    if (body[key] === undefined) continue;
    const value = body[key];
    if (typeof value !== "string") return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
    const path = `${projectHome(project)}/.pi/${key === "modelsJson" ? "models.json" : "auth.json"}`;
    credentialsTouched = true;
    if (value.trim() === "") {
      try { unlinkSync(path); } catch { /* absent is fine */ }
      continue;
    }
    try {
      JSON.parse(value);
    } catch {
      return NextResponse.json({ error: `${key} 不是合法 JSON` }, { status: 400 });
    }
    mkdirSync(`${projectHome(project)}/.pi`, { recursive: true });
    writeFileSync(path, value, "utf8");
  }
  // The 60s models cache would otherwise serve the previous provider list.
  if (credentialsTouched) invalidateModelsCache();

  // Project instructions (AGENTS.md): written at the home root — the SDK
  // loads it as session instructions from the session cwd (the home), it
  // rides along on project duplication, and agent edits made in the
  // workspace are mirrored back here (sandbox extension / relay tools).
  // Empty string deletes the file.
  if (typeof body.agentsMd === "string") {
    const agentsPath = `${projectHome(project)}/AGENTS.md`;
    mkdirSync(`${projectHome(project)}`, { recursive: true });
    if (body.agentsMd.trim() === "") {
      try { unlinkSync(agentsPath); } catch { /* absent is fine */ }
    } else {
      writeFileSync(agentsPath, body.agentsMd, "utf8");
    }
  }

  // Sandbox credentials (platform API key) merge into the project config.
  if (typeof body.apiKey === "string" && body.apiKey && r.identity!.session.apiKey) {
    writeSandboxConfig(projectHome(project), { apiKey: r.identity!.session.apiKey });
  }

  const result = updateProject(id, {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(body.containerId !== undefined && (body.containerId === null || typeof body.containerId === "number")
      ? { containerId: body.containerId as number | null }
      : {}),
    ...(typeof body.workdir === "string" ? { workdir: body.workdir } : {}),
    ...(body.machineId !== undefined && (body.machineId === null || typeof body.machineId === "string")
      ? { machineId: body.machineId as string | null }
      : {}),
    ...(typeof body.pinSessionId === "string" ? { pinSessionId: body.pinSessionId } : {}),
    ...(typeof body.unpinSessionId === "string" ? { unpinSessionId: body.unpinSessionId } : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ project: result.project });
}

// DELETE /api/projects/:id — record + home directory.
export async function DELETE(req: Request, ctx: RouteCtx) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const r = own(req, id);
  if (r.error) return r.error;
  if (!deleteProject(id)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  return NextResponse.json({ success: true });
}
