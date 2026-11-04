import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { requireUserIdentity } from "@/lib/web-session";
import {
  deleteSubagentProfile,
  listSubagentProfileSources,
  saveSubagentProfile,
  type SubagentProfile,
  type SubagentWritableScope,
} from "@/lib/subagents";

export const dynamic = "force-dynamic";

async function validateCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new Error("Valid cwd required");
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Access denied");
  return cwd;
}

function validateScope(scope: unknown): SubagentWritableScope {
  if (scope !== "global" && scope !== "user" && scope !== "project") {
    throw new Error("scope must be global, user or project");
  }
  return scope;
}

function caller(req: Request): { userId: number; isAdmin: boolean } {
  const identity = requireUserIdentity(req);
  if (!identity.ok) throw new Error("登录已失效");
  const user = identity.session.user;
  return { userId: user.id, isAdmin: user.id === 0 || user.role === "admin" };
}

function assertScopeWrite(scope: SubagentWritableScope, call: { userId: number; isAdmin: boolean }): void {
  if (scope === "global" && !call.isAdmin) throw new Error("全局 Agent 仅管理员可修改");
  if (scope === "user" && call.userId <= 0) throw new Error("用户 Agent 需要登录用户");
}

function assertProjectTrusted(cwd: string, scope: SubagentWritableScope): void {
  if (scope !== "project") return;
  if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) {
    throw new Error("Project resources must be trusted before modifying project agents");
  }
}

export async function GET(req: Request) {
  try {
    const call = caller(req);
    const cwd = await validateCwd(new URL(req.url).searchParams.get("cwd"));
    return NextResponse.json({ profiles: listSubagentProfileSources(cwd, call.userId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "登录已失效" ? 401 : message === "Access denied" ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(req: Request) {
  try {
    const call = caller(req);
    const body = (await req.json()) as {
      cwd?: unknown;
      scope?: unknown;
      profile?: Omit<SubagentProfile, "scope" | "filePath">;
    };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    assertScopeWrite(scope, call);
    assertProjectTrusted(cwd, scope);
    if (!body.profile || typeof body.profile.name !== "string") {
      return NextResponse.json({ error: "profile required" }, { status: 400 });
    }
    return NextResponse.json({ profile: saveSubagentProfile(cwd, scope, body.profile, call.userId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "登录已失效" ? 401 : message === "Access denied" ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(req: Request) {
  try {
    const call = caller(req);
    const body = (await req.json()) as { cwd?: unknown; scope?: unknown; name?: unknown; enabled?: unknown };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    assertScopeWrite(scope, call);
    assertProjectTrusted(cwd, scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled required" }, { status: 400 });
    const name = body.name;
    const source = listSubagentProfileSources(cwd, call.userId).find(
      (profile) => profile.scope === scope && profile.name.toLowerCase() === name.toLowerCase(),
    );
    if (!source) return NextResponse.json({ error: "Agent profile not found" }, { status: 404 });
    const profile: Omit<SubagentProfile, "scope" | "filePath"> = {
      name: source.name,
      displayName: source.displayName,
      description: source.description,
      systemPrompt: source.systemPrompt,
      tools: source.tools,
      loadSkills: source.loadSkills,
      loadExtensions: source.loadExtensions,
      model: source.model,
      thinking: source.thinking,
      maxTurns: source.maxTurns,
      inheritContext: source.inheritContext,
      runInBackground: source.runInBackground,
      enabled: source.enabled,
    };
    return NextResponse.json({
      profile: saveSubagentProfile(cwd, scope, { ...profile, enabled: body.enabled }, call.userId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "登录已失效" ? 401 : message === "Access denied" ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: Request) {
  try {
    const call = caller(req);
    const body = (await req.json()) as { cwd?: unknown; scope?: unknown; name?: unknown };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    assertScopeWrite(scope, call);
    assertProjectTrusted(cwd, scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    deleteSubagentProfile(cwd, scope, body.name, call.userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "登录已失效" ? 401 : message === "Access denied" ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
