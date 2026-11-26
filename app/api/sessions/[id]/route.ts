import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  attachSessionProjectInfo,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListForSession,
  buildSessionContext,
  readSessionHeader,
} from "@/lib/session-reader";
import { checkLiveSessionAccess, resolveSessionAccess } from "@/lib/session-access";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession, renameRpcSession } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import { deleteSessionImages } from "@/lib/session-images";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources, SUBAGENT_META_TYPE } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { invalidateSessionManagerCache, openSessionManager, openSessionManagerAsync } from "@/lib/session-open";
import { jsonResponse } from "@/lib/json-response";
import { setSessionArchived } from "@/lib/session-metas";
import { deleteSessionCascade } from "@/lib/state/lifecycle";
import { SIDE_META_TYPE } from "@/lib/side-session";
import { forgetSessionUiState } from "@/lib/session-ui-state";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Fast path for live sessions mirrors dev's events route; everything else
    // goes through dev's per-user access fence instead of upstream's global
    // resolveSessionPath (MERGE-NOTE(upgrade/0.84): space-aware lookup).
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    if (liveRpc) {
      // Registry hit: no file path to fence — check ownership explicitly.
      const fence = checkLiveSessionAccess(req, id);
      if (!fence.ok) return NextResponse.json({ error: fence.error }, { status: fence.status });
    }
    let resolvedPath: string | null = null;
    if (!liveRpc) {
      const access = await resolveSessionAccess(req, id, new URL(req.url).searchParams);
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      resolvedPath = access.path;
    }
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Cold detail view: cached read-only manager, large files parse on a
    // worker thread instead of stalling the shared event loop (dev 批次3).
    const sm = liveRpc?.inner.sessionManager ?? (await openSessionManagerAsync(resolvedPath!));
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // local: lazy URLs for historical tool-result images
    });
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try {
      modified = statSync(filePath).mtime.toISOString();
    } catch {
      /* use header timestamp */
    }
    const parentSessionId = header?.parentSession ? await resolveSessionIdByPath(header.parentSession) : undefined;
    const subagent = header ? readSubagentRun(entries as never, header.id, filePath) : null;
    const toolNames =
      readSubagentSessionResources(entries as never)?.tools ?? readSessionToolSelection(entries as never);
    const info = header
      ? (
          await attachSessionProjectInfo([
            {
              path: filePath,
              id: header.id,
              cwd: header.cwd ?? "",
              name: sessionName,
              created: header.timestamp,
              modified,
              messageCount: stats.totalMessages,
              firstMessage: firstUserMessage
                ? (() => {
                    const c = (firstUserMessage as { content: unknown }).content;
                    return typeof c === "string"
                      ? c
                      : (Array.isArray(c)
                          ? ((c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)
                              ?.text ?? "")
                          : "") || "(no messages)";
                  })()
                : "(no messages)",
              parentSessionId,
              ...(subagent
                ? {
                    relation: {
                      kind: "subagent" as const,
                      parentSessionId: subagent.parentSessionId,
                      profile: subagent.profile,
                      description: subagent.description,
                      status: liveRpc?.isRunning() ? ("running" as const) : subagent.status,
                    },
                  }
                : header.parentSession
                  ? {
                      relation: {
                        kind: "fork" as const,
                        ...(parentSessionId ? { originSessionId: parentSessionId } : {}),
                      },
                    }
                  : {}),
              transient: !filePath || !existsSync(filePath),
            },
          ])
        )[0]
      : null;

    return jsonResponse(req, {
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      stats,
      totalActiveMs,
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name?: string; archived?: boolean }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { name?: unknown; archived?: unknown };
    if (body.name !== undefined && typeof body.name !== "string") {
      return NextResponse.json({ error: "name must be a string" }, { status: 400 });
    }
    if (body.archived !== undefined && typeof body.archived !== "boolean") {
      return NextResponse.json({ error: "archived must be a boolean" }, { status: 400 });
    }
    if (body.name === undefined && body.archived === undefined) {
      return NextResponse.json({ error: "name or archived is required" }, { status: 400 });
    }
    const access = await resolveSessionAccess(req, id, new URL(req.url).searchParams);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const filePath = access.path;
    if (!filePath && !getRpcSession(id)?.isAlive()) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (body.name !== undefined) {
      const trimmed = body.name.trim();
      // A session a wrapper holds is renamed in it, never on disk behind its
      // back: the entry hangs off the live leaf and extensions get
      // session_info_changed. A start in flight or a closing wrapper is
      // awaited first; otherwise the file is appended directly.
      const renamed = await renameRpcSession(id, trimmed, () => {
        if (!filePath) return false;
        const sm = openSessionManager(filePath, { mutable: true });
        sm.appendSessionInfo(trimmed);
        invalidateSessionManagerCache(filePath);
        return true;
      });
      if (!renamed) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (body.archived !== undefined && !setSessionArchived(id, body.archived)) {
      return NextResponse.json({ error: "该会话缺少元数据，无法归档" }, { status: 409 });
    }
    invalidateSessionListForSession(filePath);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const access = await resolveSessionAccess(req, id, new URL(req.url).searchParams);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const filePath = access.path;
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read only the bounded header before deleting.
    let parentSessionPath: string | undefined;
    try {
      parentSessionPath = readSessionHeader(filePath)?.parentSession;
    } catch (error) {
      // Empty runtime sessions have a cached path before their first disk write.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let parentSessionId: string | undefined;
    if (parentSessionPath) {
      try {
        // The parent may have been deleted or moved already; treat it as absent.
        parentSessionId = readSessionHeader(parentSessionPath)?.id;
      } catch {
        parentSessionId = undefined;
      }
    }

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);

    // Subagent transcripts and side chats below this one go with it: their
    // metadata names the parent. Forks stay and are re-parented below.
    const removedDescendants: string[] = [];
    try {
      const byId = new Map<string, { path: string; subagentParent?: string; sideParent?: string }>();
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl") && sessionPathKey(join(dir, name)) !== targetPathKey)) {
        const childPath = join(dir, file);
        try {
          const lines = readFileSync(childPath, "utf8").split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; id?: string };
          if (header.type !== "session" || !header.id) continue;
          const info: { path: string; subagentParent?: string; sideParent?: string } = { path: childPath };
          for (let index = 1; index < lines.length; index += 1) {
            let entry: { type?: string; customType?: string; data?: unknown };
            try {
              entry = JSON.parse(lines[index]);
            } catch {
              continue;
            }
            if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) continue;
            const parentSessionId = (entry.data as { parentSessionId?: unknown }).parentSessionId;
            if (typeof parentSessionId !== "string") continue;
            if (entry.customType === SUBAGENT_META_TYPE) info.subagentParent = parentSessionId;
            if (entry.customType === SIDE_META_TYPE) info.sideParent = parentSessionId;
          }
          byId.set(header.id, info);
        } catch {
          /* skip malformed */
        }
      }
      const doomed = new Set<string>();
      for (let grew = true; grew; ) {
        grew = false;
        for (const [childId, info] of byId) {
          if (doomed.has(childId)) continue;
          const parents = [info.subagentParent, info.sideParent].filter((value): value is string => Boolean(value));
          if (parents.some((parentId) => parentId === id || doomed.has(parentId))) {
            doomed.add(childId);
            grew = true;
          }
        }
      }
      for (const childId of doomed) {
        const info = byId.get(childId);
        if (!info) continue;
        try {
          unlinkSync(info.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        invalidateSessionPathCache(childId);
        invalidateSessionManagerCache(info.path);
        invalidateSessionListForSession(info.path);
        deleteSessionCascade(childId);
        removedDescendants.push(childId);
      }
    } catch {
      /* best effort */
    }
    if (removedDescendants.length > 0) await forgetSessionUiState(removedDescendants);

    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; id?: string; parentSession?: string };
          if (
            header.type === "session" &&
            header.parentSession &&
            sessionPathKey(header.parentSession) === targetPathKey
          ) {
            // A side chat belongs to its parent's family: deleting the parent
            // takes it along, while deleting the side chat alone leaves the
            // parent and the sibling side chats untouched.
            const isSideOfTarget = lines.slice(1).some((line) => {
              try {
                const entry = JSON.parse(line) as {
                  type?: string;
                  customType?: string;
                  data?: { parentSessionId?: string };
                };
                return (
                  entry.type === "custom" &&
                  entry.customType === SIDE_META_TYPE &&
                  entry.data?.parentSessionId === id
                );
              } catch {
                return false;
              }
            });
            if (isSideOfTarget) {
              try {
                unlinkSync(childPath);
              } catch {
                /* already gone */
              }
              if (header.id) invalidateSessionPathCache(header.id);
              invalidateSessionListForSession(childPath);
              continue;
            }
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            if (parentSessionPath && parentSessionId) {
              for (let index = 1; index < lines.length; index += 1) {
                let entry: { type?: string; customType?: string; data?: unknown };
                try {
                  entry = JSON.parse(lines[index]);
                } catch {
                  continue;
                }
                if (
                  entry.type !== "custom" ||
                  entry.customType !== SUBAGENT_META_TYPE ||
                  typeof entry.data !== "object" ||
                  entry.data === null ||
                  Array.isArray(entry.data)
                )
                  continue;
                entry.data = {
                  ...entry.data,
                  parentSessionId,
                  parentSessionPath,
                };
                lines[index] = JSON.stringify(entry);
                break;
              }
            }
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* skip if dir unreadable */
    }

    await getRpcSession(id)?.shutdown();
    try {
      unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    invalidateSessionPathCache(id);
    invalidateSessionListForSession(filePath);
    deleteSessionImages(id);
    deleteSessionCascade(id);
    await forgetSessionUiState([id]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
