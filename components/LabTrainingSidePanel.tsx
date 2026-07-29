"use client";

import { useState, useCallback, useEffect } from "react";

interface StepView {
  stepId: string;
  instruction: string;
  code?: string;
  codeLanguage?: string;
  expectedResult?: string;
  image?: string;
  notes: { type: "warning" | "tip" | "info"; content: string }[];
  teaching?: {
    goal?: string;
    why?: string;
    commonMistakes?: string[];
    successSignals?: string[];
    hints?: string[];
  };
  subSteps?: {
    stepId: string;
    instruction: string;
    code?: string;
    codeLanguage?: string;
    expectedResult?: string;
    notes: { type: "warning" | "tip" | "info"; content: string }[];
    teaching?: StepView["teaching"];
  }[];
}

interface WidgetAction {
  id: string;
  label: string;
  command: string;
  variant: "primary" | "default" | "danger";
}

interface SectionNode {
  id: string;
  title: string;
  blocks?: { id: string; title: string }[];
}

interface WidgetState {
  mode: "training" | "qa" | "idle";
  labTitle: string | null;
  sectionTitle: string | null;
  blockTitle: string | null;
  currentSectionId: string | null;
  currentBlockId: string | null;
  stepIndex: number;
  stepTotal: number;
  progressPercent: number;
  pendingManualConfirm: boolean;
  actions: WidgetAction[];
  currentStep: StepView | null;
  sections: SectionNode[];
  verifyEnabled: boolean;
}

interface Props {
  widgetState: WidgetState | null;
  hasLabTraining: boolean;
  onSendCommand: (command: string) => void;
  onStartLabTraining?: () => void;
  disabled?: boolean;
  onOpenSettings?: () => void;
}

const NOTE_STYLES: Record<string, { icon: string; color: string; bg: string }> = {
  warning: { icon: "!", color: "#f59e0b", bg: "rgba(245,158,11,0.08)" },
  tip: { icon: "*", color: "var(--accent)", bg: "transparent" },
  info: { icon: "i", color: "var(--text-muted)", bg: "transparent" },
};

export function LabTrainingSidePanel({ widgetState, hasLabTraining, onSendCommand, onStartLabTraining, disabled, onOpenSettings }: Props) {
  const [outlineExpanded, setOutlineExpanded] = useState(false);

  if (!hasLabTraining && !widgetState) return null;

  const state = widgetState;
  const isIdle = !state || state.mode === "idle";
  const isQA = state?.mode === "qa";
  const isTraining = state?.mode === "training";
  const step = state?.currentStep ?? null;

  const variantStyle = (v: WidgetAction["variant"]): React.CSSProperties => {
    if (v === "primary") return { background: "var(--accent)", color: "#fff", border: "none" };
    if (v === "danger") return { background: "#ef4444", color: "#fff", border: "none" };
    return { background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)" };
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0,
        background: "var(--bg-panel)",
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" />
        </svg>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>Lab Training</span>
        {state?.verifyEnabled === false && (
          <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 600, padding: "1px 5px", borderRadius: 8, background: "rgba(245,158,11,0.1)" }}>
            VERIFY OFF
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={onOpenSettings}
          title="Lab Training Settings"
          style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: 2 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* QA Mode Banner */}
      {isQA && (
        <div style={{
          padding: "6px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0,
          background: "rgba(168,85,247,0.08)",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%", background: "#a855f7",
            animation: "pulse 1.5s ease-in-out infinite",
          }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: "#a855f7" }}>QA Mode</span>
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
            Ask questions freely. Type "next" to return.
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => onSendCommand("next")}
            disabled={disabled}
            style={{
              height: 20, padding: "0 8px", borderRadius: 10,
              border: "1px solid #a855f7", background: "rgba(168,85,247,0.1)",
              color: "#a855f7", fontSize: 10, fontWeight: 600, cursor: "pointer",
            }}
          >
            Exit QA
          </button>
        </div>
      )}

      {/* Idle / Initial State */}
      {isIdle && (
        <div style={{
          flex: 1, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", padding: 24, gap: 16,
        }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity={0.8}>
            <path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" />
          </svg>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
              Lab Training Ready
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 200, lineHeight: 1.5 }}>
              Start an interactive training session with guided steps and automatic verification.
            </div>
          </div>
          <button
            onClick={() => { if (onStartLabTraining) onStartLabTraining(); else onSendCommand("/lab"); }}
            disabled={disabled}
            style={{
              padding: "8px 24px", borderRadius: 8,
              background: "var(--accent)", color: "#fff", border: "none",
              fontSize: 12, fontWeight: 600, cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            Start Lab Training
          </button>
        </div>
      )}

      {/* Training Content */}
      {(isTraining || isQA) && state && step && (
        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          {/* Progress bar */}
          {state.stepTotal > 0 && (
            <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600 }}>
                  Step {state.stepIndex}/{state.stepTotal}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                  ({state.progressPercent}%)
                </span>
                <div style={{ flex: 1 }} />
                {state.verifyEnabled !== false && (
                  <button
                    onClick={() => onSendCommand("/lab verify")}
                    disabled={disabled}
                    title="Toggle verification"
                    style={{
                      height: 18, padding: "0 6px", borderRadius: 9,
                      border: "1px solid var(--border)", background: "transparent",
                      color: state.verifyEnabled ? "var(--accent)" : "var(--text-dim)",
                      fontSize: 9, fontWeight: 600, cursor: "pointer",
                    }}
                  >
                    {state.verifyEnabled ? "Verify ON" : "Verify OFF"}
                  </button>
                )}
              </div>
              <div style={{ height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                <div style={{ width: `${state.progressPercent}%`, height: "100%", background: "var(--accent)", borderRadius: 2, transition: "width 0.2s" }} />
              </div>
            </div>
          )}

          {/* Section / Block label */}
          <div style={{ padding: "8px 12px 4px" }}>
            {state.labTitle && (
              <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, marginBottom: 2 }}>
                {state.labTitle}
              </div>
            )}
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {state.sectionTitle}
              {state.blockTitle ? ` > ${state.blockTitle}` : ""}
            </div>
          </div>

          {/* Step instruction */}
          <div style={{ padding: "4px 12px 8px" }}>
            <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.5, fontWeight: 500 }}>
              {step.instruction}
            </div>
          </div>

          {/* Code block */}
          {step.code && (
            <div style={{ margin: "4px 12px", borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
              <div style={{ padding: "4px 8px", background: "var(--bg-panel)", fontSize: 9, color: "var(--text-dim)", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between" }}>
                <span>{step.codeLanguage ?? "code"}</span>
              </div>
              <pre style={{ margin: 0, padding: "8px 10px", fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text)", overflowX: "auto", background: "var(--bg)" }}>
                <code>{step.code}</code>
              </pre>
            </div>
          )}

          {/* Expected result */}
          {step.expectedResult && (
            <div style={{ margin: "4px 12px", padding: "6px 10px", borderRadius: 4, background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.15)" }}>
              <div style={{ fontSize: 9, color: "#22c55e", fontWeight: 600, marginBottom: 2 }}>Expected Result</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>{step.expectedResult}</div>
            </div>
          )}

          {/* Notes */}
          {step.notes?.map((note, i) => {
            const ns = NOTE_STYLES[note.type] ?? NOTE_STYLES.info;
            return (
              <div key={i} style={{ margin: "3px 12px", padding: "4px 8px", borderRadius: 4, background: ns.bg, display: "flex", gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: ns.color, flexShrink: 0 }}>{ns.icon}</span>
                <span style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.4 }}>{note.content}</span>
              </div>
            );
          })}

          {/* Teaching guidance */}
          {step.teaching && (
            <details style={{ margin: "4px 12px" }}>
              <summary style={{ fontSize: 10, color: "var(--text-dim)", cursor: "pointer", fontWeight: 600 }}>
                Teaching Guide
              </summary>
              <div style={{ padding: "6px 0", fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {step.teaching.goal && <div><strong>Goal:</strong> {step.teaching.goal}</div>}
                {step.teaching.why && <div style={{ marginTop: 3 }}><strong>Why:</strong> {step.teaching.why}</div>}
                {step.teaching.hints?.map((h, i) => (
                  <div key={i} style={{ marginTop: 3 }}><strong>Hint {i + 1}:</strong> {h}</div>
                ))}
                {step.teaching.commonMistakes?.map((m, i) => (
                  <div key={`m${i}`} style={{ marginTop: 3, color: "#f59e0b" }}><strong>Common Mistake:</strong> {m}</div>
                ))}
              </div>
            </details>
          )}

          {/* Sub-steps */}
          {step.subSteps && step.subSteps.length > 0 && (
            <div style={{ margin: "4px 12px" }}>
              <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, marginBottom: 4 }}>Sub-steps</div>
              {step.subSteps.map((sub, i) => (
                <div key={sub.stepId} style={{ marginBottom: 8, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>
                  <div style={{ fontSize: 11, color: "var(--text)", fontWeight: 500 }}>{i + 1}. {sub.instruction}</div>
                  {sub.code && (
                    <pre style={{ margin: "3px 0", padding: "4px 6px", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", background: "var(--bg-panel)", borderRadius: 3, overflowX: "auto" }}>
                      <code>{sub.code}</code>
                    </pre>
                  )}
                  {sub.expectedResult && (
                    <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Expected: {sub.expectedResult}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pending manual confirm */}
          {state.pendingManualConfirm && (
            <div style={{ margin: "4px 12px", padding: "6px 10px", borderRadius: 4, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 16 }}>?</span>
              <span style={{ fontSize: 10, color: "#f59e0b", flex: 1 }}>Awaiting confirmation</span>
            </div>
          )}

          {/* Outline */}
          {state.sections.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 4 }}>
              <button
                onClick={() => setOutlineExpanded((v) => !v)}
                style={{ width: "100%", padding: "5px 12px", background: "none", border: "none", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 4 }}
              >
                <span style={{ fontSize: 8 }}>{outlineExpanded ? "\u25BC" : "\u25B6"}</span>
                Outline
              </button>
              {outlineExpanded && (
                <div style={{ paddingBottom: 4 }}>
                  {state.sections.map((sec) => {
                    const isCurrent = sec.id === state.currentSectionId;
                    return (
                      <div key={sec.id}>
                        <div
                          onClick={() => onSendCommand(`/lab goto ${sec.id}`)}
                          style={{
                            padding: "2px 12px", cursor: "pointer", fontSize: 10,
                            color: isCurrent ? "var(--accent)" : "var(--text-muted)",
                            fontWeight: isCurrent ? 600 : 400,
                          }}
                        >
                          {sec.title}
                        </div>
                        {sec.blocks?.map((blk) => (
                          <div
                            key={blk.id}
                            onClick={() => onSendCommand(`/lab goto ${sec.id}/${blk.id}`)}
                            style={{
                              padding: "2px 24px", cursor: "pointer", fontSize: 10,
                              color: blk.id === state.currentBlockId ? "var(--accent)" : "var(--text-dim)",
                              fontWeight: blk.id === state.currentBlockId ? 600 : 400,
                            }}
                          >
                            {blk.title}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action buttons — always visible when training */}
      {(isTraining || isQA) && state && (
        <div style={{
          borderTop: "1px solid var(--border)", padding: "8px 10px",
          display: "flex", gap: 4, flexShrink: 0, background: "var(--bg-panel)",
        }}>
          {state.actions.map((action) => (
            <button
              key={action.id}
              onClick={() => onSendCommand(action.command)}
              disabled={disabled}
              style={{
                ...variantStyle(action.variant),
                flex: action.variant === "primary" ? 2 : 1,
                height: 28, borderRadius: 6,
                fontSize: 11, fontWeight: 600, cursor: disabled ? "default" : "pointer",
                opacity: disabled ? 0.5 : 1,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 3,
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
