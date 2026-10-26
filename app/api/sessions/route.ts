import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRpcSessionOwner,
  getRunningRpcSessionInfos,
} from "@/lib/rpc-manager";
import { requireUserIdentity } from "@/lib/web-session";
import { spaceForRequest } from "@/lib/session-spaces";
import { getSessionMetas, inferLegacyModeFromCwd } from "@/lib/session-metas";
import { getProject } from "@/lib/projects";
import { getAgentForUser } from "@/lib/relay/registry";

export const dynamic = "force-dynamic";

// GET /api/sessions[?space=host][&force=1] — sessions visible to the caller:
// their own space, plus the host space (CLI sessions) for admins via ?space=host.
// Entries carry the pi-web execution mode from the sidecar metas; live (not yet
// persisted) RPC sessions are merged in, fenced per user.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });
  const { user } = identity.session;

  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    const space = spaceForRequest(identity.session, searchParams);
    // MERGE-NOTE(upgrade/0.84): upstream's listAllSessions({ force }) became
    // listAllSessions(space, { force }) — dev shards the catalogue per user.
    // Runtime (not-yet-persisted) sessions are merged in per upstream, but
    // filtered to the caller's own live sessions (admins see all).
    const [persistedSessions, runtimeSessions, metas] = await Promise.all([
      listAllSessions(space, { force }),
      Promise.resolve(getRpcSessionInfos())
        .then((infos) => attachSessionProjectInfo(infos.filter((s) => {
          const owner = getRpcSessionOwner(s.id);
          return user.role === "admin" || !owner || owner.ownerId === user.id;
        }))),
      Promise.resolve(getSessionMetas()),
    ]);
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions).map((s) => {
      const meta = metas[s.id];
      // 无 meta 的遗留沙箱会话按 cwd 兜底推断，避免落进 Host 目录组。
      const mode = meta?.mode ?? inferLegacyModeFromCwd(s.cwd);
      // local-machine/ssh：附真实工作区（用户机器/远程主机上的绝对路径）。
      // cwd 是服务端 home——模型输出里的文件链接若按 cwd 解析会指到 host
      // 目录（bug 2026-10-26），前端用 workspaceDir 作链接解析基。
      const remoteProject = (mode === "local-machine" || mode === "ssh") && meta?.projectId
        ? getProject(meta.projectId)
        : undefined;
      let workspaceDir = remoteProject?.workdir;
      // 未绑 workdir 的 local-machine 会话跑在 agent 共享根上——在线 agent
      // 的 workspaceRoot 就是它的真实工作区（离线时未知，回落旧行为）。
      if (!workspaceDir && mode === "local-machine") {
        workspaceDir = getAgentForUser(meta?.ownerId ?? user.id)?.info?.workspaceRoot;
      }
      return {
        ...s,
        ...(mode ? { mode, ...(meta?.projectId ? { projectId: meta.projectId } : {}) } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
      };
    });
    // Capture AFTER the scan: mutations during the scan bump the generation,
    // so the client sees a version it cannot reconcile and refreshes again.
    const sessionListVersion = getSessionListVersion();
    // Live-sessions are per-user unless the caller is an admin on the host space.
    const runningSessionIds = getRunningRpcSessionInfos()
      .filter((r) => (user.role === "admin" ? true : r.ownerId === user.id))
      .map((r) => r.sessionId);
    // Web-push completion-notification suppression rides along behind the same
    // per-user fence so other users' session ids never leak.
    const visibleRunning = new Set(runningSessionIds);
    const completionNotificationSuppressedSessionIds = getCompletionNotificationSuppressedRpcSessionIds()
      .filter((sessionId) => visibleRunning.has(sessionId));
    return jsonResponse(
      req,
      {
        sessions,
        sessionListVersion,
        runningSessionIds,
        completionNotificationSuppressedSessionIds,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
