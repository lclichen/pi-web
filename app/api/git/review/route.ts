import { NextResponse } from "next/server";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { restoreSessionOptions } from "@/lib/session-restore-options";
import { resolveSessionAccess } from "@/lib/session-access";
import { generateGitInsight, type GitInsightMode } from "@/lib/git-review";
import { checkGitAccess, gitRecentSubjects, gitReviewDiff } from "@/lib/git-operations";
import { getGitStatus } from "@/lib/git-changes";
import { isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getAllowedFileRootsForRequest } from "@/lib/file-access";
import { requireUserIdentity } from "@/lib/web-session";

/**
 * AI git insights driven by the selected session's own model:
 *   mode=review         → structured code review of the working-tree diff
 *   mode=commit-message → a ready-to-use commit message in repo style
 *
 * The session is only used as the provider configuration source (shadow agent,
 * no tools, empty history); the diff comes from the server-side git exec.
 */
export async function POST(req: Request) {
  try {
    const identity = requireUserIdentity(req);
    if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

    const body = (await req.json().catch(() => ({}))) as {
      sessionId?: string;
      cwd?: string;
      mode?: string;
    };
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const mode: GitInsightMode = body.mode === "commit-message" ? "commit-message" : "review";
    if (!sessionId) return NextResponse.json({ error: "需要一个会话来提供模型（先选择或创建会话）" }, { status: 400 });
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRootsForRequest(req);
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const access = await checkGitAccess(cwd);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: 400 });

    // Diff + style context first — cheap, and failures here need no model call.
    const [diffRes, status, recentSubjects] = await Promise.all([
      gitReviewDiff(cwd),
      getGitStatus(cwd),
      gitRecentSubjects(cwd, 8),
    ]);
    if (!diffRes.ok) return NextResponse.json({ error: diffRes.error }, { status: 500 });
    const hasChanges = status.files.length > 0;
    if (!hasChanges && !diffRes.diff) {
      return NextResponse.json({ error: "工作区没有可审查的改动" }, { status: 400 });
    }
    const fileSummary = status.files.length > 0
      ? status.files.map((f) => `${f.code ?? "?"} ${f.filePath}`).join("\n")
      : "（仅有未跟踪文件的元信息）";

    // Resolve the session (owner-fenced) and reuse its model configuration.
    const sessionAccess = await resolveSessionAccess(req, sessionId);
    if (!sessionAccess.ok) {
      return NextResponse.json({ error: sessionAccess.error }, { status: sessionAccess.status });
    }
    if (!sessionAccess.path) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const existing = getRpcSession(sessionId);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(sessionId, sessionAccess.path, undefined, await restoreSessionOptions(req, sessionId));
    await session.waitUntilReady?.();

    const result = await generateGitInsight(session.inner as never, {
      mode,
      diff: diffRes.diff ?? "",
      fileSummary,
      recentSubjects,
      branch: null,
    });

    return NextResponse.json({ text: result.text, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
