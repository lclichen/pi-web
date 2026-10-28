import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfigCwdSync } from "@/lib/config-cwd";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { listProjects, projectHome } from "@/lib/projects";
import {
  DEFAULT_POLICY,
  PATH_DECISIONS_FILE,
  PATH_POLICY_FILE,
  normalizePolicyPath,
  parsePathPolicy,
  parsePolicyDecisions,
  type PathPolicy,
} from "@/lib/extensions/path-guard";

export const dynamic = "force-dynamic";

/**
 * 设置 → 策略 页的后端：读写项目 .pi/path-policy.json 与决策文件。
 *
 * 锁定语义（用户 2026-10-26 定策）：策略文件仅 Host 模式（管理员的服务器
 * 目录，不隶属任何项目）可编辑；sandbox / local-machine / ssh 项目只读
 * （策略随配置包分发，锁定防终端用户自行放开）。决策记录（“不再询问”）
 * 是用户自己的授权/拒绝记录，任何模式都可查看与移除——deny 记录随包
 * 导出后在分发端同样生效。
 */
function safeRead(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function resolveEditable(
  cwd: string,
  ownerId: number,
  role: "admin" | "user",
): { editable: boolean; lockReason?: string } {
  // 项目宿主目录（sandbox / local-machine / ssh）→ 锁定。
  for (const project of listProjects(ownerId)) {
    if (normalizePolicyPath(projectHome(project)) === normalizePolicyPath(cwd)) {
      return { editable: false, lockReason: `project:${project.mode}` };
    }
  }
  if (role !== "admin") {
    return { editable: false, lockReason: "not-admin" };
  }
  return { editable: true }; // 服务器目录（Host 空间）= 管理员可编辑
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { searchParams } = new URL(req.url);
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });

  const policyRaw = safeRead(join(dir.cwd, PATH_POLICY_FILE));
  const decisionsRaw = safeRead(join(dir.cwd, PATH_DECISIONS_FILE));
  const { editable, lockReason } = resolveEditable(dir.cwd, identity.session.user.id, identity.session.user.role);
  return NextResponse.json({
    cwd: dir.cwd,
    policyFilePresent: policyRaw !== null,
    policy: parsePathPolicy(policyRaw),
    defaults: DEFAULT_POLICY,
    decisions: parsePolicyDecisions(decisionsRaw),
    editable,
    ...(lockReason ? { lockReason } : {}),
  });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { searchParams } = new URL(req.url);
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });

  const { editable, lockReason } = resolveEditable(dir.cwd, identity.session.user.id, identity.session.user.role);
  if (!editable) {
    return NextResponse.json(
      {
        error:
          lockReason === "not-admin"
            ? "策略仅管理员在 Host 模式目录下可编辑"
            : "项目策略已锁定（随配置包分发；仅 Host 模式目录可自定义）",
      },
      { status: 403 },
    );
  }

  let body: { policy?: unknown };
  try {
    body = (await req.json()) as { policy?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  // 校验兼规范化：经 parsePathPolicy 往返，字段非法/缺失回默认，坏结构整体拒绝。
  let serialized: string;
  try {
    serialized = JSON.stringify(body.policy);
  } catch {
    return NextResponse.json({ error: "策略内容无法序列化" }, { status: 400 });
  }
  const normalized: PathPolicy = parsePathPolicy(serialized);
  const target = join(dir.cwd, PATH_POLICY_FILE);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  } catch (e) {
    return NextResponse.json({ error: `写入失败: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, policy: normalized });
}

// DELETE /api/policy?cwd=…&path=… — 移除一条“不再询问”决策记录。
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { searchParams } = new URL(req.url);
  const dir = resolveConfigCwdSync(req, { projectId: searchParams.get("projectId"), cwd: searchParams.get("cwd") });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });
  const entryPath = searchParams.get("path") ?? "";
  if (!entryPath.startsWith("/")) {
    return NextResponse.json({ error: "需要绝对路径参数 path" }, { status: 400 });
  }
  const target = join(dir.cwd, PATH_DECISIONS_FILE);
  const decisions = parsePolicyDecisions(safeRead(target));
  const norm = normalizePolicyPath(entryPath);
  const before = decisions.entries.length;
  decisions.entries = decisions.entries.filter((e) => e.path !== norm);
  if (decisions.entries.length === before) {
    return NextResponse.json({ error: "决策记录不存在" }, { status: 404 });
  }
  try {
    writeFileSync(target, JSON.stringify(decisions, null, 2) + "\n", "utf8");
  } catch (e) {
    return NextResponse.json({ error: `写入失败: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
