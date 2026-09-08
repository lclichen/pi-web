"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFeedback, setFeedback, type FeedbackValue } from "@/lib/message-feedback";

/**
 * 👍/👎 verdict control for one assistant message — sits next to the copy
 * button, appears on row hover, click toggles (third click clears). Verdicts
 * persist locally and drain to the AI gateway once its endpoint exists
 * (docs/dev/feedback-api.md).
 */
export function MessageFeedback({ sessionId, entryId, snippet, visible }: {
  sessionId?: string;
  entryId?: string;
  snippet: string;
  visible: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState<FeedbackValue | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!sessionId || !entryId) return;
    setValue(getFeedback(sessionId, entryId));
    setLoaded(true);
  }, [sessionId, entryId]);

  if (!sessionId || !entryId || !loaded) return null;

  const apply = (next: FeedbackValue) => {
    const resolved = value === next ? null : next;
    setValue(resolved);
    setFeedback(sessionId, entryId, resolved, snippet);
  };

  const btn = (kind: FeedbackValue): React.ButtonHTMLAttributes<HTMLButtonElement> & { type: "button" } => ({
    type: "button",
    onClick: () => apply(kind),
    title: t(kind === "up" ? "这条回复有帮助" : "这条回复没有帮助"),
    "aria-label": t(kind === "up" ? "这条回复有帮助" : "这条回复没有帮助"),
    "aria-pressed": value === kind,
    style: {
      display: "flex", alignItems: "center", justifyContent: "center",
      width: 22, height: 22, padding: 0,
      background: "none", border: "none", borderRadius: 5,
      color: value === kind ? (kind === "up" ? "#22c55e" : "#f87171") : "var(--text-dim)",
      cursor: "pointer",
      opacity: visible ? 1 : 0,
      pointerEvents: visible ? "auto" : ("none" as const),
      transition: "opacity 0.12s, color 0.12s",
    },
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
      if (value !== kind) e.currentTarget.style.color = "var(--accent)";
    },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
      if (value !== kind) e.currentTarget.style.color = "var(--text-dim)";
    },
  });

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
      <button {...btn("up")}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill={value === "up" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
        </svg>
      </button>
      <button {...btn("down")}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill={value === "down" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: "rotate(180deg)" }}>
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
        </svg>
      </button>
    </span>
  );
}
