import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { resolveSessionAccess } from "@/lib/session-access";
import { resolveSessionMode } from "@/lib/session-metas";
import { resolveRemoteSession, remoteRead, type RemoteSessionContext } from "@/lib/remote-session";
import { isExistingFilePathAllowed, isFilePathAllowed, getAllowedFileRootsForRequest } from "@/lib/file-access";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/plan?cwd=<session cwd>[&hash=<last hash>]
 *
 * 统一的计划（PLAN）读取口 —— 一个请求代替此前客户端对 2–3 个候选文件的
 * 逐个 /api/files、/api/remotefs 请求；由服务端决定每个候选走本地 fs 还是
 * 远程桥（远程模式的工作区计划经 remotefs 读，会话级计划永远在服务端 home）。
 *
 *   { plan: null }                     没有任何计划
 *   { path, hash, content }            计划内容（hash = sha256 前 16 hex）
 *   { path, hash, unchanged: true }    ?hash 与当前一致 —— 轮询时的省流响应
 *
 * 候选（与 use-session-plan 的旧客户端逻辑一致，首个非空命中）：
 *   1. <cwd>/.pi/plans/plan-sess_<sessionId>.md   （服务端 home，本地 fs）
 *   2. <cwd>/.pi/plan.md / <cwd>/PLAN.md          （远程模式=工作区根经 remotefs；
 *                                                   host=本地 fs）
 * cwd 必须落在文件 API 的允许根内（与会话目录一致），防止借本端点读任意路径。
 */

const PLAN_CANDIDATES = [".pi/plan.md", "PLAN.md"] as const;

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await resolveSessionAccess(req, id);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") ?? "";
  const lastHash = url.searchParams.get("hash") ?? "";
  if (!cwd || !cwd.startsWith("/")) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRootsForRequest(req);
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const meta = resolveSessionMode(id);
  const mode = meta?.mode ?? "host";
  const root = cwd.replace(/[\\/]+$/, "");

  const readLocal = (absPath: string): string | null => {
    if (!isExistingFilePathAllowed(absPath, allowedRoots)) return null;
    try {
      return readFileSync(absPath, "utf8");
    } catch {
      return null;
    }
  };

  // Remote bridge is resolved lazily and at most once per request: candidate 1
  // is always local, and legacy workspace candidates only need it for
  // sandbox/local-machine/ssh sessions.
  let remoteCtx: RemoteSessionContext | null | undefined;
  const remoteContext = async (): Promise<RemoteSessionContext | null> => {
    if (remoteCtx !== undefined) return remoteCtx;
    if (mode === "sandbox" || mode === "local-machine" || mode === "ssh") {
      const resolved = await resolveRemoteSession(req, id);
      remoteCtx = resolved.ok ? resolved.ctx : null;
    } else {
      remoteCtx = null;
    }
    return remoteCtx;
  };

  const candidates: Array<{ path: string; read: () => Promise<string | null> | string | null }> = [
    { path: `${root}/.pi/plans/plan-sess_${id}.md`, read: () => readLocal(`${root}/.pi/plans/plan-sess_${id}.md`) },
  ];
  for (const rel of PLAN_CANDIDATES) {
    if (mode === "sandbox" || mode === "local-machine" || mode === "ssh") {
      candidates.push({
        path: `${root}/${rel}`,
        read: async () => {
          const ctx = await remoteContext();
          if (!ctx) return null;
          try {
            // remotefs 的虚拟根 = 会话工作区；这里要读的是工作区里的旧版计划。
            const r = await remoteRead(ctx, `/${rel}`);
            return r.content;
          } catch {
            return null;
          }
        },
      });
    } else {
      candidates.push({ path: `${root}/${rel}`, read: () => readLocal(`${root}/${rel}`) });
    }
  }

  try {
    for (const candidate of candidates) {
      const content = await candidate.read();
      if (content === null || content.trim() === "") continue;
      const hash = contentHash(content);
      if (lastHash && lastHash === hash) {
        return NextResponse.json(
          { path: candidate.path, hash, unchanged: true },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      return NextResponse.json({ path: candidate.path, hash, content }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ plan: null }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
