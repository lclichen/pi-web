"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { markdownPreviewRehypePlugins, markdownPreviewRemarkPlugins } from "@/lib/markdown";
import { formatRelativeTime, type SubagentRecord } from "@/lib/subagent-shared";
import type { SubagentCall } from "@/hooks/useAgentSession";
import type { AgentMessage } from "@/lib/types";

interface Props {
  sessionId: string | null;
  /** Live foreground/background calls from the active chat (useAgentSession). */
  subagentCalls: SubagentCall[];
}

interface DirectoryRecord {
  key: string;
  id?: string;
  type: string;
  description: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  sessionId?: string;
}

/**
 * 子智能体目录 — right-panel tab listing subagent invocations for the active
 * session: 正在运行 (live calls) and 已结束 (subagents:record entries from
 * the session file, absolute timestamps -> relative labels). Clicking a
 * finished entry with a persisted conversation loads it read-only via the
 * existing sessions API; otherwise the record's result text is shown.
 */
export function SubagentDirectoryPanel({ sessionId, subagentCalls }: Props) {
  const [records, setRecords] = useState<SubagentRecord[]>([]);
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const [openAgent, setOpenAgent] = useState<DirectoryRecord | null>(null);
  const [conversation, setConversation] = useState<{ loading: boolean; messages: AgentMessage[] | null; error?: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const openAgentIdRef = useRef<string | null>(null);

  // Poll while mounted (the panel stays mounted-hidden, so records also stay
  // fresh for the widget's eventual "finished" transition).
  useEffect(() => {
    if (!sessionId) {
      setRecords([]);
      setSessions({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/subagents`);
        if (!res.ok || cancelled) return;
        const d = (await res.json()) as {
          records?: SubagentRecord[];
          sessions?: Record<string, string>;
        };
        if (cancelled) return;
        setRecords(d.records ?? []);
        setSessions(d.sessions ?? {});
      } catch {
        // next poll retries
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessionId]);

  // Keep relative labels ("3 分钟前") fresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Reset the drill-down when the session changes.
  useEffect(() => {
    setOpenAgent(null);
    setConversation(null);
    openAgentIdRef.current = null;
  }, [sessionId]);

  const finishedIds = useMemo(() => new Set(records.map((r) => r.id)), [records]);

  // Running = live calls whose agent isn't in the finished records yet
  // (background agents leave tool_execution_end as "background" forever).
  const running: DirectoryRecord[] = useMemo(() => {
    return subagentCalls
      .filter((c) => (c.status === "running" || c.status === "background")
        && !(c.agentId && finishedIds.has(c.agentId)))
      .map((c) => ({
        key: c.key,
        ...(c.agentId ? { id: c.agentId } : {}),
        type: c.type,
        description: c.description,
        status: "running",
        startedAt: c.startedAt,
      }));
  }, [subagentCalls, finishedIds]);

  const finished: DirectoryRecord[] = useMemo(() => {
    return records.map((r) => ({
      key: r.id,
      id: r.id,
      type: r.type,
      description: r.description,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      result: r.result,
      sessionId: sessions[r.id],
    }));
  }, [records, sessions]);

  const loadConversation = useCallback((record: DirectoryRecord) => {
    setOpenAgent(record);
    setConversation({ loading: true, messages: null });
    openAgentIdRef.current = record.key;
    const subagentSessionId = record.sessionId;
    if (!subagentSessionId || !record.id) {
      setConversation({ loading: false, messages: null });
      return;
    }
    void (async () => {
      try {
        const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
        const res = await fetch(`/api/sessions/${encodeURIComponent(subagentSessionId)}?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as { context?: { messages?: AgentMessage[] } };
        if (openAgentIdRef.current !== record.key) return;
        setConversation({ loading: false, messages: d.context?.messages ?? [] });
      } catch (e) {
        if (openAgentIdRef.current !== record.key) return;
        setConversation({ loading: false, messages: null, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  if (openAgent) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => { setOpenAgent(null); setConversation(null); openAgentIdRef.current = null; }}
            style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, padding: "0 4px" }}
            title="返回目录"
          >
            ←
          </button>
          <span style={{ fontSize: 11, fontWeight: 700 }}>{openAgent.type}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{openAgent.description}</span>
          {openAgent.completedAt !== undefined && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{formatRelativeTime(openAgent.completedAt, now)}</span>
          )}
        </div>
        <div style={{ flex: 1, overflowY: "auto", background: "var(--bg)" }}>
          {conversation?.loading ? (
            <div style={{ padding: 16, fontSize: 12, color: "var(--text-dim)" }}>加载对话…</div>
          ) : conversation?.error ? (
            <div style={{ padding: 16, fontSize: 12, color: "#f87171" }}>对话加载失败：{conversation.error}</div>
          ) : conversation?.messages?.length ? (
            <SubagentConversation messages={conversation.messages} />
          ) : (
            <div style={{ padding: "12px 16px" }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
                {openAgent.sessionId ? "会话无消息" : "未找到持久化会话，显示结果摘要："}
              </div>
              <div className="markdown-body" style={{ fontSize: 12 }}>
                <ReactMarkdown remarkPlugins={markdownPreviewRemarkPlugins} rehypePlugins={markdownPreviewRehypePlugins}>
                  {openAgent.result?.trim() || "（无输出）"}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflowY: "auto" }}>
      <div style={{ padding: "10px 14px 6px", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>子智能体目录</div>
      <Section title={`正在运行 · ${running.length}`}>
        {running.length === 0 ? (
          <Empty text="当前没有正在运行的子智能体" />
        ) : (
          running.map((r) => <Row key={r.key} record={r} now={now} onClick={() => loadConversation(r)} />)
        )}
      </Section>
      <Section title={`已结束 · ${finished.length}`}>
        {finished.length === 0 ? (
          <Empty text="暂无调用记录" />
        ) : (
          finished.map((r) => <Row key={r.key} record={r} now={now} onClick={() => loadConversation(r)} />)
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div style={{ padding: "6px 14px", fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: "4px 14px 12px", fontSize: 11, color: "var(--text-dim)" }}>{text}</div>;
}

function statusColor(status: string): string {
  if (status === "running") return "#4ade80";
  if (status === "error" || status === "aborted" || status === "stopped") return "#f87171";
  if (status === "completed") return "var(--text-muted)";
  return "var(--text-muted)";
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    running: "运行中",
    completed: "已完成",
    error: "出错",
    stopped: "已停止",
    aborted: "已中止",
    steered: "已转向",
  };
  return map[status] ?? status;
}

function Row({ record, now, onClick }: { record: DirectoryRecord; now: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        padding: "7px 14px", border: "none", textAlign: "left",
        background: "transparent", cursor: "pointer", fontSize: 11,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-selected)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <span
        style={{
          flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {record.type}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
        {record.description || "(无描述)"}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10, color: statusColor(record.status) }}>
        {record.status === "running" && (
          <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 999, background: "#4ade80", marginRight: 4, verticalAlign: "middle" }} />
        )}
        {statusLabel(record.status)}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", minWidth: 56, textAlign: "right" }}>
        {record.completedAt !== undefined
          ? formatRelativeTime(record.completedAt, now)
          : record.startedAt !== undefined
            ? formatRelativeTime(record.startedAt, now)
            : ""}
      </span>
    </button>
  );
}

/** Compact read-only transcript of a subagent session. */
function SubagentConversation({ messages }: { messages: AgentMessage[] }) {
  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
      {messages.map((message, i) => {
        if (message.role === "user") {
          const text = typeof message.content === "string"
            ? message.content
            : message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
          if (!text.trim()) return null;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <RoleLabel role="user" />
              <div className="markdown-body" style={{ fontSize: 12 }}>
                <ReactMarkdown remarkPlugins={markdownPreviewRemarkPlugins} rehypePlugins={markdownPreviewRehypePlugins}>{text}</ReactMarkdown>
              </div>
            </div>
          );
        }
        if (message.role === "assistant") {
          const text = message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
          if (!text.trim()) return null;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <RoleLabel role="assistant" />
              <div className="markdown-body" style={{ fontSize: 12 }}>
                <ReactMarkdown remarkPlugins={markdownPreviewRemarkPlugins} rehypePlugins={markdownPreviewRehypePlugins}>{text}</ReactMarkdown>
              </div>
            </div>
          );
        }
        return null; // toolResult/thinking/custom omitted from the compact view
      })}
    </div>
  );
}

function RoleLabel({ role }: { role: "user" | "assistant" }) {
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: role === "user" ? "var(--accent)" : "var(--text-dim)" }}>
      {role === "user" ? "USER" : "AGENT"}
    </span>
  );
}
