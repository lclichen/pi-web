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
  PATH_SCOPE_FILE,
  evaluateBashCommand,
  evaluatePathAgainstPolicy,
  normalizePolicyPath,
  parsePathPolicy,
  parsePathScope,
  parsePolicyDecisions,
  type PathPolicy,
} from "@/lib/extensions/path-guard";

export const dynamic = "force-dynamic";

/**
 * 设置 → 策略 页的后端：读写项目 .pi/path-policy.json 与决策文件。
 *
 * 锁定语义（用户 2026-10-26 定策，2026-11-03 放宽管理员）：sandbox /
 * local-machine / ssh 项目的策略随配置包分发，普通终端用户只读（防自行
 * 放开）；服务器管理员可在项目内追加/调整。Host 目录仍按原规则（管理员
 * 可编辑）。决策记录（“不再询问”）任何模式都可查看与移除——deny 记录随
 * 包导出后在分发端同样生效。
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
  // 项目宿主目录（sandbox / local-machine / ssh）：管理员可编辑，普通用户锁定。
  for (const project of listProjects(ownerId)) {
    if (normalizePolicyPath(projectHome(project)) === normalizePolicyPath(cwd)) {
      if (role === "admin") return { editable: true };
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
  const scope = parsePathScope(safeRead(join(dir.cwd, PATH_SCOPE_FILE)));
  const { editable, lockReason } = resolveEditable(dir.cwd, identity.session.user.id, identity.session.user.role);
  return NextResponse.json({
    cwd: dir.cwd,
    policyFilePresent: policyRaw !== null,
    policy: parsePathPolicy(policyRaw),
    defaults: DEFAULT_POLICY,
    decisions: parsePolicyDecisions(decisionsRaw),
    scope,
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
  // Windows 盘符路径同样是绝对路径（决策文件里存的就是 C:/...）。
  const isAbsolute =
    entryPath.startsWith("/") ||
    (entryPath.length >= 3 &&
      /[A-Za-z]/.test(entryPath[0]) &&
      entryPath[1] === ":" &&
      (entryPath[2] === "/" || entryPath.charCodeAt(2) === 92));
  if (!isAbsolute) {
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

/**
 * POST /api/policy — 策略试运行（只读，不落盘）。
 *
 * body: { cwd, path?, kind?, command? }
 * 让用户在设置页直接验证“这条路径/命令会不会被拦、为什么”，不用等 Agent
 * 真的撞一次。command 走与护栏完全相同的 bash 扫描（含 cd 追踪与内联执行
 * 兜底）；path+kind 走单路径判定。远程模式按 path-scope 映射后判定。
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  let body: { cwd?: unknown; path?: unknown; kind?: unknown; command?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const dir = resolveConfigCwdSync(req, {
    cwd: typeof body.cwd === "string" ? body.cwd : null,
  });
  if (!dir.ok) return NextResponse.json({ error: dir.error }, { status: dir.status });

  const policy = parsePathPolicy(safeRead(join(dir.cwd, PATH_POLICY_FILE)));
  const decisions = parsePolicyDecisions(safeRead(join(dir.cwd, PATH_DECISIONS_FILE)));
  const scope = parsePathScope(safeRead(join(dir.cwd, PATH_SCOPE_FILE)));

  if (typeof body.command === "string" && body.command.trim().length > 0) {
    const result = evaluateBashCommand(body.command, dir.cwd, policy, decisions, scope);
    return NextResponse.json({
      action: result.verdict.action,
      ...(result.verdict.action === "allow" ? {} : { reason: result.verdict.reason }),
      ...(result.target ? { target: result.target } : {}),
      scope,
    });
  }
  if (typeof body.path === "string" && body.path.trim().length > 0) {
    const kind = body.kind === "read" ? "read" : "write";
    // 与护栏一致：相对路径按会话 cwd 解析（试运行里用户常写 src/a.ts）。
    const raw = body.path.trim();
    const absPath = /^([A-Za-z]:[\\/]|\/)/.test(raw) ? raw : `${dir.cwd}/${raw}`;
    const verdict = evaluatePathAgainstPolicy(absPath, kind, dir.cwd, policy, decisions, scope);
    return NextResponse.json({
      action: verdict.action,
      ...(verdict.action === "allow" ? {} : { reason: verdict.reason }),
      scope,
    });
  }
  return NextResponse.json({ error: "需要 path 或 command 参数" }, { status: 400 });
}
