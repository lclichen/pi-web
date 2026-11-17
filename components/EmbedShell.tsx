"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { List, Plus } from "lucide-react";
import { ChatWindow } from "./ChatWindow";
import { useI18n } from "@/hooks/useI18n";
import { installEmbedTransport } from "@/lib/embed-client";
import type { EmbedDensity, EmbedMode, EmbedScope } from "@/lib/embed-types";
import type { SessionInfo } from "@/lib/types";

const SESSION_REFRESH_MS = 30_000;

interface Props {
  token: string;
  product: { id: string; name: string };
  scope: EmbedScope;
  label: string;
  mode: EmbedMode;
  allowedCommands: string[];
  expiresAt: number;
  initialSessionId?: string;
}

function sessionTitle(session: SessionInfo, fallback: string): string {
  return session.name?.trim() || session.firstMessage?.trim() || fallback;
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString();
}

/**
 * Minimal session-only shell: product header + session list + ChatWindow.
 * No sidebar, project switcher, environment menu, or settings. The container
 * size (iframe viewport) drives a comfortable / compact / mini density so the
 * same page works as a full page, a tall side rail, or a short bottom bar.
 */
export function EmbedShell({
  token,
  product,
  scope,
  label,
  mode,
  allowedCommands,
  expiresAt,
  initialSessionId,
}: Props) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const initialAppliedRef = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [expired, setExpired] = useState(() => Date.now() >= expiresAt);
  const [chatKey, setChatKey] = useState(0);
  const [newDraftKey, setNewDraftKey] = useState(() => `embed-${token.slice(-8)}-new-${Date.now()}`);

  // Install the token transport before ChatWindow's mount effects run. The
  // initializer runs on the client before children render their effects.
  useState(() => {
    installEmbedTransport(token);
    return true;
  });

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize((previous) =>
        previous.width === Math.round(rect.width) && previous.height === Math.round(rect.height)
          ? previous
          : { width: Math.round(rect.width), height: Math.round(rect.height) },
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (Date.now() >= expiresAt) {
        setExpired(true);
        return;
      }
      // setTimeout caps at ~24.8 days; a 30-day token must re-arm.
      timer = setTimeout(check, Math.min(expiresAt - Date.now(), 2_147_483_647));
    };
    check();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [expiresAt]);

  const writeSessionParam = useCallback((sessionId: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (sessionId) url.searchParams.set("session", sessionId);
    else url.searchParams.delete("session");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  const selectSession = useCallback(
    (session: SessionInfo) => {
      setSelected(session);
      setChatKey((value) => value + 1);
      setListOpen(false);
      writeSessionParam(session.id);
    },
    [writeSessionParam],
  );

  const startNewChat = useCallback(() => {
    setSelected(null);
    setNewDraftKey(`embed-${token.slice(-8)}-new-${Date.now()}`);
    setChatKey((value) => value + 1);
    setListOpen(false);
    writeSessionParam(null);
  }, [token, writeSessionParam]);

  const loadSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (!response.ok) {
        setError(response.status === 401 || response.status === 403 ? t("embed.linkExpired") : t("embed.loadFailed"));
        setLoading(false);
        return;
      }
      const data = (await response.json()) as {
        sessions?: SessionInfo[];
        runningSessionIds?: string[];
      };
      const list = data.sessions ?? [];
      setSessions(list);
      setRunningIds(new Set(data.runningSessionIds ?? []));
      setError(null);
      setLoading(false);
      setSelected((previous) => {
        if (!previous) return null;
        return list.find((session) => session.id === previous.id) ?? previous;
      });
      if (!initialAppliedRef.current) {
        initialAppliedRef.current = true;
        const wanted = initialSessionId ? list.find((session) => session.id === initialSessionId) : undefined;
        const target = wanted ?? list[0];
        if (target) selectSession(target);
      }
    } catch {
      setError(t("embed.loadFailed"));
      setLoading(false);
    }
  }, [initialSessionId, selectSession, t]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadSessions();
    }, SESSION_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadSessions();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!listOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setListOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [listOpen]);

  const density: EmbedDensity =
    size.height > 0 && size.height < 240
      ? "mini"
      : (size.height > 0 && size.height < 480) || (size.width > 0 && size.width < 420)
        ? "compact"
        : "comfortable";
  const short = size.height > 0 && size.height < 480;
  const narrow = size.width > 0 && size.width < 420;
  const showLabels = density === "comfortable" && !narrow;
  const currentTitle = selected ? sessionTitle(selected, t("embed.untitled")) : t("embed.newChat");
  const sessionRunning = Boolean(selected && runningIds.has(selected.id));

  const handleSessionCreated = useCallback(
    (session: SessionInfo, sourceDraftKey: string) => {
      if (sourceDraftKey !== newDraftKey) return;
      const next: SessionInfo = {
        ...session,
        mode: session.mode ?? mode,
        ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
      };
      setSelected(next);
      setSessions((previous) => (previous.some((item) => item.id === next.id) ? previous : [next, ...previous]));
      writeSessionParam(next.id);
      void loadSessions();
    },
    [loadSessions, mode, newDraftKey, scope, writeSessionParam],
  );

  const handleSessionForked = useCallback(
    (newSessionId: string) => {
      setSelected((previous) => ({
        ...(previous ?? {
          path: "",
          cwd: scope.cwd,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 0,
          firstMessage: "",
        }),
        id: newSessionId,
        transient: false,
      }));
      setChatKey((value) => value + 1);
      writeSessionParam(newSessionId);
      void loadSessions();
    },
    [loadSessions, scope.cwd, writeSessionParam],
  );

  const handleAgentEnd = useCallback(() => {
    void loadSessions();
  }, [loadSessions]);

  if (expired) {
    return (
      <div ref={rootRef} className="embed-shell" data-density={density}>
        <div className="embed-state" role="alert">
          <div>{t("embed.linkExpired")}</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="embed-shell" data-density={density}>
      <header className="embed-header">
        <div className="embed-header-titles">
          <span className="embed-product" title={product.name}>
            {product.name}
          </span>
          <span className="embed-session-title" title={currentTitle}>
            {currentTitle}
          </span>
        </div>
        <div className="embed-header-actions">
          <button
            type="button"
            className="embed-header-button"
            title={t("embed.sessions")}
            aria-label={t("embed.sessions")}
            aria-expanded={listOpen}
            onClick={() => setListOpen((open) => !open)}
          >
            <List size={14} aria-hidden="true" />
            {showLabels && <span>{t("embed.sessions")}</span>}
          </button>
          <button
            type="button"
            className="embed-header-button"
            title={t("embed.newChat")}
            aria-label={t("embed.newChat")}
            onClick={startNewChat}
          >
            <Plus size={14} aria-hidden="true" />
            {showLabels && <span>{t("embed.newChat")}</span>}
          </button>
        </div>
      </header>

      {listOpen && (
        <>
          <button
            type="button"
            className="embed-sessions-backdrop"
            aria-label={t("embed.closeSessions")}
            onClick={() => setListOpen(false)}
          />
          <div className="embed-sessions-popover" role="dialog" aria-label={t("embed.sessions")}>
            <div className="embed-sessions-heading">{label}</div>
            {sessions.length === 0 ? (
              <div className="embed-sessions-empty">{t("embed.noSessions")}</div>
            ) : (
              sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="embed-session-row"
                  aria-current={selected?.id === session.id ? "true" : undefined}
                  onClick={() => selectSession(session)}
                >
                  <span className="embed-session-row-title">{sessionTitle(session, t("embed.untitled"))}</span>
                  <span className="embed-session-row-meta">
                    {runningIds.has(session.id) && <span className="embed-running-dot" aria-hidden="true" />}
                    {formatWhen(session.modified)}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}

      <main className="embed-main">
        {loading ? (
          <div className="embed-state" role="status">
            {t("embed.loading")}
          </div>
        ) : error ? (
          <div className="embed-state" role="alert">
            <div>{error}</div>
            <button type="button" className="embed-retry" onClick={() => void loadSessions()}>
              {t("embed.retry")}
            </button>
          </div>
        ) : (
          <ChatWindow
            key={chatKey}
            session={selected}
            sessionRunning={sessionRunning}
            newSessionCwd={selected ? null : scope.cwd}
            newSessionMode={selected ? undefined : mode}
            newSessionProjectId={selected ? null : scope.kind === "project" ? scope.projectId : null}
            newSessionDraftKey={selected ? null : newDraftKey}
            embedded
            embeddedDensity={density}
            embeddedShort={short}
            commandAllowlist={allowedCommands}
            onSessionCreated={handleSessionCreated}
            onSessionForked={handleSessionForked}
            onAgentEnd={handleAgentEnd}
          />
        )}
      </main>
    </div>
  );
}
