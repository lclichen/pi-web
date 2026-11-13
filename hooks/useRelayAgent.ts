"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentInfo, MachineStatus } from "@/lib/relay/protocol";

export interface RelayStatusResponse {
  online: boolean;
  info?: AgentInfo;
  /** All paired machines (multi-machine); info = the default machine's. */
  machines?: MachineStatus[];
  /** Minimum agent-client version this WebUI requires. */
  requiredVersion?: string;
  relayPort: number;
  advertiseUrl: string | null;
  /** Admin-configured global public base URL (share links / pairing host). */
  publicBaseUrl: string | null;
}

export interface UseRelayAgent extends RelayStatusResponse {
  /** True once the first status snapshot has arrived (SSE or poll). */
  ready: boolean;
  /** Re-fetch the status snapshot immediately. */
  refresh: () => void;
}

const DEFAULT_STATE: RelayStatusResponse = {
  online: false,
  relayPort: 30142,
  advertiseUrl: null,
  publicBaseUrl: null,
};
const RECONNECT_DELAY_MS = 2000;

/**
 * One relay-status subscription per page. EnvironmentsMenu, LocalMachinesDialog
 * and its useAgentInstallInfo hook all call useRelayAgent(); letting each open
 * its own EventSource burned the browser's six HTTP/1.1 connections per host.
 * With a second window open (plus each window's agent event stream), ordinary
 * API fetches queued forever — the second window sat at "Loading session..."
 * until the other tab closed. The store keeps a single EventSource and fans
 * state out to every subscriber.
 */
export class RelayStatusStore {
  private state: RelayStatusResponse = DEFAULT_STATE;
  private ready = false;
  private listeners = new Set<() => void>();
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seedStarted = false;

  getSnapshot = (): RelayStatusResponse => this.state;

  isReady = (): boolean => this.ready;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.ensureConnected();
    return () => {
      this.listeners.delete(listener);
    };
  };

  refresh = (): void => {
    void this.fetchStatus();
  };

  /** Idempotent: the first subscriber opens the sole EventSource. */
  ensureConnected(): void {
    if (typeof window === "undefined") return;
    if (!this.seedStarted) {
      this.seedStarted = true;
      void this.fetchStatus();
    }
    if (this.source) return;
    this.connect();
  }

  private apply(data: Partial<RelayStatusResponse>): void {
    this.state = { ...this.state, ...data };
    this.ready = true;
    for (const listener of this.listeners) listener();
  }

  private async fetchStatus(): Promise<void> {
    try {
      const res = await fetch("/api/agent-relay/status", { cache: "no-store" });
      if (!res.ok) return;
      this.apply((await res.json()) as RelayStatusResponse);
    } catch {
      // SSE still drives updates.
    }
  }

  private connect(): void {
    if (this.source || typeof EventSource === "undefined") return;
    const es = new EventSource("/api/agent-relay/status/events");
    this.source = es;
    es.onmessage = (event) => {
      try {
        this.apply(JSON.parse(event.data) as Partial<RelayStatusResponse>);
      } catch {
        // Ignore malformed frames (heartbeats are comment lines, not onmessage).
      }
    };
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return; // CONNECTING: auto-reconnect
      es.close();
      if (this.source === es) this.source = null;
      if (this.reconnectTimer === null) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, RECONNECT_DELAY_MS);
      }
    };
  }
}

let sharedStore: RelayStatusStore | null = null;

export function getRelayStatusStore(): RelayStatusStore {
  sharedStore ??= new RelayStatusStore();
  return sharedStore;
}

export function useRelayAgent(): UseRelayAgent {
  const store = getRelayStatusStore();
  const [state, setState] = useState<RelayStatusResponse>(() => store.getSnapshot());
  const [ready, setReady] = useState(() => store.isReady());

  useEffect(() => {
    const sync = () => {
      setState(store.getSnapshot());
      setReady(store.isReady());
    };
    sync();
    return store.subscribe(sync);
  }, [store]);

  const refresh = useCallback(() => store.refresh(), [store]);
  return { ...state, ready, refresh };
}
