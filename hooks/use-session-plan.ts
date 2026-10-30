"use client";

import { useEffect, useRef, useState } from "react";

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
 * All reads go through ONE backend endpoint (GET /api/sessions/[id]/plan):
 * the server checks the candidate files (per-session plan in the server home,
 * legacy .pi/plan.md / PLAN.md in the workspace — via the remote bridge for
 * sandbox/local-machine/ssh), which unifies remote and local modes and
 * replaces the old 2–3 client-side file requests per probe.
 *
 * Cadence:
 *   · plan present  — poll with ?hash= every 10s (30s for remote: each remote
 *     probe is a round trip to the user's machine). Unchanged answers are a
 *     few hundred bytes, so an idle tab costs ~nothing.
 *   · plan absent   — exponential re-probe 8s → 60s (plans only appear from
 *     agent tool calls).
 *   · reprobeSignal — incremented by AppShell on plan-affecting tool events;
 *     triggers an immediate refetch, so live updates do not wait for the timer.
 */
export function useSessionPlan({
  sessionId,
  cwd,
  remote,
  reprobeSignal,
}: {
  sessionId?: string | null;
  cwd?: string;
  remote?: RemoteCtx | null;
  /** Incremented by the AppShell when a plan-affecting tool event lands
   *  (plan_save, or write/edit touching a plan path) — triggers an immediate
   *  probe so a freshly saved plan appears instantly instead of waiting for
   *  the backoff timer; idle sessions then poll at the backoff only. */
  reprobeSignal?: number;
}): UseSessionPlanResult {
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const hashRef = useRef<string>("");
  const probeNowRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!sessionId || !cwd || cwd === "") {
      setPlan(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const baseUrl = `/api/sessions/${encodeURIComponent(sessionId)}/plan?cwd=${encodeURIComponent(cwd)}`;

    const fetchPlan = async (): Promise<boolean> => {
      const hashParam = hashRef.current ? `&hash=${encodeURIComponent(hashRef.current)}` : "";
      try {
        const res = await fetch(`${baseUrl}${hashParam}`, { cache: "no-store" });
        if (!res.ok) return false;
        const d = (await res.json()) as {
          plan?: null;
          path?: string;
          content?: string;
          hash?: string;
          unchanged?: boolean;
        };
        if (cancelled) return false;
        if (d.plan === null || !d.path) {
          hashRef.current = "";
          setPlan(null);
          return false;
        }
        if (d.hash) hashRef.current = d.hash;
        if (d.unchanged) return true; // keep the content we already have
        if (typeof d.content === "string") {
          setPlan({ path: d.path, content: d.content });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    };

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    // Poll while a plan exists (cheap hash round trip); back off while absent.
    const schedulePresent = () => {
      clearTimer();
      if (cancelled) return;
      timer = setTimeout(
        async () => {
          if (cancelled) return;
          const ok = await fetchPlan();
          if (cancelled) return;
          if (ok) schedulePresent();
          else startAbsent();
        },
        remote ? 30_000 : 10_000,
      );
    };

    const startAbsent = () => {
      clearTimer();
      if (cancelled) return;
      let delay = 8_000;
      const schedule = () => {
        clearTimer();
        if (cancelled) return;
        timer = setTimeout(async () => {
          if (cancelled) return;
          const ok = await fetchPlan();
          if (cancelled) return;
          if (ok) {
            schedulePresent();
            return;
          }
          delay = Math.min(delay * 2, 60_000);
          schedule();
        }, delay);
      };
      schedule();
    };

    void (async () => {
      setLoading(true);
      const found = await fetchPlan();
      if (cancelled) return;
      setLoading(false);
      if (found) schedulePresent();
      else startAbsent();
    })();

    probeNowRef.current = () => {
      if (cancelled) return;
      clearTimer();
      void fetchPlan().then((ok) => {
        if (cancelled) return;
        if (ok) schedulePresent();
        else startAbsent();
      });
    };

    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [sessionId, cwd, remote?.sessionId, remote?.label]);

  useEffect(() => {
    if (reprobeSignal === undefined) return;
    probeNowRef.current();
  }, [reprobeSignal]);

  return { plan, loading };
}
