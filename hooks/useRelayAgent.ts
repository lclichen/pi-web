"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo } from "@/lib/relay/protocol";

export interface RelayStatusResponse {
  online: boolean;
  info?: AgentInfo;
  relayPort: number;
  advertiseUrl: string | null;
}

export interface UseRelayAgent extends RelayStatusResponse {
  /** True once the first status snapshot has arrived (SSE or poll). */
  ready: boolean;
  /** Re-fetch the status snapshot immediately. */
  refresh: () => void;
}

/**
 * Tracks the Local Agent connection status via the /api/agent-relay/status SSE
 * stream, with a visible-tab poll fallback. Mirrors the EventSource patterns in
 * hooks/useAgentSession.ts and components/SessionSidebar.tsx.
 */
export function useRelayAgent(): UseRelayAgent {
  const [state, setState] = useState<RelayStatusResponse>({
    online: false,
    relayPort: 30142,
    advertiseUrl: null,
  });
  const [ready, setReady] = useState(false);
  const stoppedRef = useRef(false);
  const apply = useCallback((data: Partial<RelayStatusResponse>) => {
    if (stoppedRef.current) return;
    setState((prev) => ({ ...prev, ...data }));
    setReady(true);
  }, []);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    stoppedRef.current = false;
    let stopped = false;


    // Seed relayPort/advertiseUrl + initial status from a one-shot fetch so the
    // pairing command is correct even before the SSE frame lands.
    const seed = async () => {
      try {
        const res = await fetch("/api/agent-relay/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as RelayStatusResponse;
        apply(data);
      } catch {
        // ignore — SSE will still drive updates
      }
    };
    void seed();

    const connect = () => {
      if (stopped) return;
      const es = new EventSource("/api/agent-relay/status/events");
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as Partial<RelayStatusResponse>;
          apply(data);
        } catch {
          // ignore malformed frames (heartbeats are comment lines, not onmessage)
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          // manual reconnect with a guard (EventSource won't retry on fatal)
          if (!stopped) {
            reconnectTimer.current = setTimeout(connect, 2000);
          }
        }
        // CONNECTING: let EventSource auto-reconnect
      };
    };
    connect();

    return () => {
      stopped = true;
      esRef.current?.close();
      esRef.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, []);

  const refresh = useCallback(() => {
    fetch("/api/agent-relay/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && !stoppedRef.current) apply(d as Partial<RelayStatusResponse>); })
      .catch(() => {});
  }, [apply]);
  return { ...state, ready, refresh };
}
