"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";

interface QuickTemplate {
  id: string;
  name: string;
}

type QuickTemplateSnapshot = NonNullable<SessionInfo["quickTemplate"]>;

/**
 * Quick sessions run a template (model, system prompt, MCP allowlist). A fresh
 * draft can still switch templates — the selection belongs to the shell and
 * the workspace follows it. Once the first message created the session the
 * template snapshot is fixed, so the bar shows what the session runs instead.
 */
export function QuickTemplateBar({
  session,
  newSessionTemplateId,
  onNewSessionTemplateChange,
  disabled = false,
}: {
  session: SessionInfo | null;
  newSessionTemplateId?: string | null;
  onNewSessionTemplateChange?: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<QuickTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  // List rows need not carry the template snapshot; the session's own read does.
  const [fetchedSnapshot, setFetchedSnapshot] = useState<QuickTemplateSnapshot | null>(null);

  useEffect(() => {
    const sessionId = session?.id;
    if (!sessionId || session?.quickTemplate) {
      setFetchedSnapshot(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ quickTemplate?: QuickTemplateSnapshot }>) : null))
      .then((data) => {
        if (!cancelled) setFetchedSnapshot(data?.quickTemplate ?? null);
      })
      .catch(() => {
        if (!cancelled) setFetchedSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.id, session?.quickTemplate]);

  useEffect(() => {
    if (session) return;
    let cancelled = false;
    setLoading(true);
    fetch("/api/quick-templates")
      .then((res) => (res.ok ? (res.json() as Promise<{ templates?: QuickTemplate[] }>) : null))
      .then((data) => {
        if (!cancelled) setTemplates(data?.templates ?? []);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const snapshot = session?.quickTemplate ?? fetchedSnapshot;
  if (session) {
    if (!snapshot) return null;
    return (
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 16px 0", fontSize: 11, color: "var(--text-dim)", minWidth: 0 }}
      >
        <span aria-hidden="true">⚡</span>
        <span style={{ color: "var(--text-muted)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {snapshot.name}
        </span>
        <code style={{ fontFamily: "var(--font-mono)", opacity: 0.8 }}>{snapshot.hash.slice(0, 8)}</code>
        {snapshot.detached ? (
          <span style={{ color: "var(--warning, #d97706)" }}>{t("quick.templateDetached")}</span>
        ) : snapshot.stale ? (
          <span style={{ color: "var(--warning, #d97706)" }}>{t("quick.templateStale")}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 16px 0", fontSize: 11, color: "var(--text-dim)", minWidth: 0 }}
    >
      <span aria-hidden="true">⚡</span>
      <label style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span>{t("quick.template")}</span>
        <select
          value={newSessionTemplateId ?? ""}
          disabled={disabled || loading}
          onChange={(event) => {
            if (event.target.value) onNewSessionTemplateChange?.(event.target.value);
          }}
          style={{
            maxWidth: 260,
            minWidth: 0,
            padding: "2px 6px",
            fontSize: 11,
            color: "var(--text)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <option value="" disabled>
            {loading ? t("quick.templateLoading") : t("quick.templateSelect")}
          </option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
