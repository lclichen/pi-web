import { NextResponse } from "next/server";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { allowFileRoot } from "@/lib/file-access";
import { resolveProject } from "@/lib/worktree";
import { listHostDirs, normalizeHostRoot, removeHostDir, renameHostDir, upsertHostDir } from "@/lib/host-dirs";

export const dynamic = "force-dynamic";

/**
 * Host 目录注册表（"空项目"）。仅管理员（Host 模式天然 admin-only）。
 *
 * GET    /api/host/dirs                    → { dirs }
 * POST   /api/host/dirs { cwd, name? }     → { dir }（按 projectRoot 幂等 upsert）
 * PATCH  /api/host/dirs { id, name }       → { dir }（空字符串 = 恢复默认目录名）
 * DELETE /api/host/dirs?id=…              → { ok }
 *
 * 只维护"侧栏占位"这一件事：DELETE 绝不触碰真实目录，也不会删除任何会话。
 */
function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

function admin(req: Request):
  | { ok: true; userId: number }
  | { ok: false; response: NextResponse } {
  const identity = requireUserIdentity(req);
  if (!identity.ok) {
    return { ok: false, response: NextResponse.json({ error: "登录已失效" }, { status: identity.status }) };
  }
  if (identity.session.user.role !== "admin") {
    return { ok: false, response: NextResponse.json({ error: "仅管理员可用（Host 模式）" }, { status: 403 }) };
  }
  return { ok: true, userId: identity.session.user.id };
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const gate = admin(req);
  if (!gate.ok) return gate.response;
  return NextResponse.json({ dirs: listHostDirs(gate.userId) });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const gate = admin(req);
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => ({}))) as { cwd?: unknown; name?: unknown };
  const raw = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!raw) return NextResponse.json({ error: "需要目录路径 cwd" }, { status: 400 });

  const cwd = normalizeCwd(raw);
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return NextResponse.json({ error: `目录不存在：${raw}` }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: `目录不可访问：${raw}` }, { status: 400 });
  }
  // 与 /api/cwd/validate 一致：把该目录加入本次运行的文件访问根。
  allowFileRoot(cwd);
  const project = await resolveProject(cwd);
  const root = normalizeHostRoot(project.projectRoot);
  const dir = upsertHostDir({
    ownerId: gate.userId,
    root,
    name: typeof body.name === "string" ? body.name : null,
  });
  return NextResponse.json({ dir });
}

export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const gate = admin(req);
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "需要目录记录 id" }, { status: 400 });
  if (typeof body.name !== "string") return NextResponse.json({ error: "需要名称 name" }, { status: 400 });
  const result = renameHostDir(id, gate.userId, body.name);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ dir: result.dir });
}

export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const gate = admin(req);
  if (!gate.ok) return gate.response;

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "需要目录记录 id" }, { status: 400 });
  if (!removeHostDir(id, gate.userId)) {
    return NextResponse.json({ error: "目录记录不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
