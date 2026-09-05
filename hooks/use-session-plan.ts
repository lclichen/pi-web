"use client";

import { useEffect, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";

export interface SessionPlan {
  path: string;
  content: string;
}

export interface UseSessionPlanResult {
  plan: SessionPlan | null;
  loading: boolean;
}

interface RemoteCtx {
  sessionId: string;
  label: string;
}

/**
 * Single source of truth for the session plan, consumed by the AppShell
 * (计划 tab visibility), PlanPanel (content view) and ChatStatusWidget
 * (capsule pin / popover row).
 *
 * Candidates, first hit wins:
 *   1. <cwd>/.pi/plans/plan-sess_<sessionId>.md — per-session plan written by
 *      the session-plan extension (plan_save tool / @plan auto-capture).
 *      Always read through /api/files: the file lives in the server-side
 *      project home even for remote-mode sessions.
 *   2. <cwd>/.pi/plan.md, <cwd>/PLAN.md — legacy workspace plans (remote
 *      sessions read them through /api/remotefs).
 *
 * While no plan exists the probe re-runs every 8s (so a newly saved plan
 * shows up); once found it is refreshed via SSE watch locally or 10s polling
 * for remote legacy files.
 */
export function useSessionPlan({
  sessionId,
  cwd,
  remote,
}: {
  sessionId?: string | null;
  cwd?: string;
  remote?: RemoteCtx | null;
}): UseSessionPlanResult {
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!cwd || cwd === "") {
      setPlan(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let es: EventSource | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let reprobeTimer: ReturnType<typeof setInterval> | null = null;

    const root = cwd.replace(/[\\/]+$/, "");
    type Candidate = { path: string; via: "files" | "remotefs"; watch: "sse" | "poll" | "none" };
    const candidates: Candidate[] = [];
    if (sessionId) {
      candidates.push({
        path: `${root}/.pi/plans/plan-sess_${sessionId}.md`,
        via: "files",
        watch: "sse",
      });
    }
    for (const p of [`${root}/.pi/plan.md`, `${root}/PLAN.md`]) {
      candidates.push(
        remote
          ? { path: p, via: "remotefs", watch: "poll" }
          : { path: p, via: "files", watch: "sse" },
      );
    }

    const readUrl = (c: Candidate, type: "read" | "watch"): string => {
      if (c.via === "remotefs") {
        const rel = c.path.replace(/^\//, "");
        return `/api/remotefs/${encodeFilePathForApi(rel)}?src=${encodeURIComponent(remote!.sessionId)}&type=read`;
      }
      return `/api/files/${encodeFilePathForApi(c.path)}?type=${type}`;
    };

    const read = async (c: Candidate): Promise<string | null> => {
      try {
        const res = await fetch(readUrl(c, "read"));
        if (!res.ok) return null;
        const d = (await res.json()) as { content?: unknown };
        return typeof d.content === "string" ? d.content : null;
      } catch {
        return null;
      }
    };

    const detachRefresh = () => {
      es?.close();
      es = null;
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
    };

    const startReprobe = () => {
      if (reprobeTimer || cancelled) return;
      reprobeTimer = setInterval(async () => {
        if (cancelled) return;
        const ok = await probe();
        if (!cancelled && ok) {
          if (reprobeTimer) clearInterval(reprobeTimer);
          reprobeTimer = null;
        }
      }, 8_000);
    };

    // Probe all candidates in order; first non-empty hit wins.
    const probe = async (): Promise<boolean> => {
      for (const c of candidates) {
        const content = await read(c);
        if (cancelled) return false;
        if (content === null || content.trim() === "") continue;
        setPlan({ path: c.path, content });
        attachRefresh(c);
        return true;
      }
      setPlan(null);
      return false;
    };

    const attachRefresh = (c: Candidate) => {
      const refresh = async () => {
        const content = await read(c);
        if (cancelled) return;
        // The watched plan was deleted or emptied: clear the state and fall
        // back to re-probing (a different candidate may take over).
        if (content === null || content.trim() === "") {
          setPlan(null);
          detachRefresh();
          startReprobe();
          return;
        }
        setPlan({ path: c.path, content });
      };
      if (c.watch === "sse" && c.via === "files") {
        try {
          es = new EventSource(`/api/files/${encodeFilePathForApi(c.path)}?type=watch`);
          es.addEventListener("change", () => void refresh());
          return;
        } catch {
          // SSE unavailable — fall through to polling.
        }
      }
      refreshTimer = setInterval(() => void refresh(), 10_000);
    };

    void (async () => {
      setLoading(true);
      const found = await probe();
      if (cancelled) return;
      setLoading(false);
      // Nothing yet: keep a slow re-probe so a newly created plan appears
      // (plan_save / @plan capture happen while the tab may be hidden).
      if (!found) startReprobe();
    })();

    return () => {
      cancelled = true;
      detachRefresh();
      if (reprobeTimer) clearInterval(reprobeTimer);
    };
  }, [sessionId, cwd, remote?.sessionId, remote?.label]);

  return { plan, loading };
}
