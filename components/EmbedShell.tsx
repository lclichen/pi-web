"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, List, LogOut, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ChatWindow } from "./ChatWindow";
import { useConfirm } from "./use-confirm";
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
  configUpdateAvailable?: boolean;
  onConfigUpdateAvailableChange?: (available: boolean) => void;
  onAuthExpired?: () => void;
  onSwitchAccount?: () => void;
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
  configUpdateAvailable = false,
  onConfigUpdateAvailableChange,
  onAuthExpired,
  onSwitchAccount,
}: Props) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
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
  const [configBusy, setConfigBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [sessionBusy, setSessionBusy] = useState<string | null>(null);

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
        if (onAuthExpired) onAuthExpired();
        else setExpired(true);
        return;
      }
      timer = setTimeout(check, Math.min(expiresAt - Date.now(), 2_147_483_647));
    };
    check();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [expiresAt, onAuthExpired]);

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
      try {
        localStorage.setItem(`pi-embed-last:${scope.projectId}`, session.id);
      } catch {
        // storage is best-effort
      }
    },
    [scope.projectId, writeSessionParam],
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
      const response = await fetch(`/api/sessions${showArchived ? "?includeArchived=1" : ""}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          onAuthExpired?.();
          return;
        }
        setError(t("embed.loadFailed"));
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
        let last: SessionInfo | undefined;
        try {
          const lastId = localStorage.getItem(`pi-embed-last:${scope.projectId}`);
          last = lastId ? list.find((session) => session.id === lastId) : undefined;
        } catch {
          // storage is best-effort
        }
        const target = wanted ?? last ?? list[0];
        if (target) selectSession(target);
      }
    } catch {
      setError(t("embed.loadFailed"));
      setLoading(false);
    }
  }, [initialSessionId, onAuthExpired, scope.projectId, selectSession, showArchived, t]);

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
        projectId: scope.projectId,
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

  const reapplyConfig = useCallback(async () => {
    if (configBusy) return;
    setConfigBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/embed/workspace/reapply-config", { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      onConfigUpdateAvailableChange?.(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConfigBusy(false);
    }
  }, [configBusy, onConfigUpdateAvailableChange]);

  const patchSession = useCallback(
    async (sessionId: string, body: { name?: string; archived?: boolean }) => {
      setSessionBusy(sessionId);
      setError(null);
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        setMenuSessionId(null);
        setRenamingId(null);
        await loadSessions();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSessionBusy(null);
      }
    },
    [loadSessions],
  );

  const deleteSession = useCallback(
    async (session: SessionInfo) => {
      const ok = await confirm({
        title: t("embed.deleteSession"),
        message: t("embed.deleteSessionConfirm", { name: sessionTitle(session, t("embed.untitled")) }),
        confirmLabel: t("common.delete"),
        abortLabel: t("common.cancel"),
        danger: true,
      });
      if (!ok) return;
      setSessionBusy(session.id);
      setError(null);
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        if (selected?.id === session.id) {
          setSelected(null);
          writeSessionParam(null);
          setChatKey((value) => value + 1);
        }
        setMenuSessionId(null);
        await loadSessions();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSessionBusy(null);
      }
    },
    [confirm, loadSessions, selected?.id, t, writeSessionParam],
  );

  if (expired) {
    return (
      <div ref={rootRef} className="embed-shell" data-density={density}>
        <div className="embed-state" role="alert">
          <div>{t("embed.sessionExpired")}</div>
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
          {configUpdateAvailable && (
            <button
              type="button"
              className="embed-header-button"
              title={t("embed.updateConfig")}
              aria-label={t("embed.updateConfig")}
              disabled={configBusy}
              onClick={() => void reapplyConfig()}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          )}
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
          {onSwitchAccount && (
            <button
              type="button"
              className="embed-header-button"
              title={t("embed.switchAccount")}
              aria-label={t("embed.switchAccount")}
              onClick={onSwitchAccount}
            >
              <LogOut size={14} aria-hidden="true" />
            </button>
          )}
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
            <div className="embed-sessions-heading">
              <span>{label}</span>
              <button
                type="button"
                className="embed-sessions-toggle"
                onClick={() => setShowArchived((value) => !value)}
              >
                {showArchived ? t("embed.hideArchived") : t("embed.showArchived")}
              </button>
            </div>
            {sessions.length === 0 ? (
              <div className="embed-sessions-empty">{t("embed.noSessions")}</div>
            ) : (
              sessions.map((session) => (
                <div key={session.id} className="embed-session-row-wrap" data-archived={session.archivedAt ? "true" : undefined}>
                  {renamingId === session.id ? (
                    <form
                      className="embed-session-rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const name = renameValue.trim();
                        if (name && !sessionBusy) void patchSession(session.id, { name });
                      }}
                    >
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setRenamingId(null);
                        }}
                        aria-label={t("embed.renameSession")}
                        maxLength={120}
                      />
                      <button type="submit" disabled={Boolean(sessionBusy)} aria-label={t("common.save")}>
                        ✓
                      </button>
                      <button type="button" onClick={() => setRenamingId(null)} aria-label={t("common.cancel")}>
                        ×
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="embed-session-row"
                      aria-current={selected?.id === session.id ? "true" : undefined}
                      onClick={() => selectSession(session)}
                    >
                      <span className="embed-session-row-title">
                        {sessionTitle(session, t("embed.untitled"))}
                        {session.archivedAt && <span className="embed-session-archived">{t("embed.archived")}</span>}
                      </span>
                      <span className="embed-session-row-meta">
                        {runningIds.has(session.id) && <span className="embed-running-dot" aria-hidden="true" />}
                        {formatWhen(session.modified)}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="embed-session-row-menu"
                    title={t("embed.sessionActions")}
                    aria-label={t("embed.sessionActions")}
                    aria-expanded={menuSessionId === session.id}
                    disabled={sessionBusy === session.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuSessionId((current) => (current === session.id ? null : session.id));
                    }}
                  >
                    <MoreHorizontal size={14} aria-hidden="true" />
                  </button>
                  {menuSessionId === session.id && (
                    <div className="embed-session-actions" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setRenameValue(sessionTitle(session, ""));
                          setRenamingId(session.id);
                          setMenuSessionId(null);
                        }}
                      >
                        <Pencil size={12} aria-hidden="true" />
                        {t("embed.renameSession")}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void patchSession(session.id, { archived: !session.archivedAt })}
                      >
                        {session.archivedAt ? (
                          <ArchiveRestore size={12} aria-hidden="true" />
                        ) : (
                          <Archive size={12} aria-hidden="true" />
                        )}
                        {session.archivedAt ? t("embed.unarchiveSession") : t("embed.archiveSession")}
                      </button>
                      <button type="button" role="menuitem" className="is-danger" onClick={() => void deleteSession(session)}>
                        <Trash2 size={12} aria-hidden="true" />
                        {t("embed.deleteSession")}
                      </button>
                    </div>
                  )}
                </div>
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
            newSessionProjectId={selected ? null : scope.projectId}
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
      {confirmDialog}
    </div>
  );
}
