"use client";

import { useState } from "react";

interface StepView {
  stepId: string;
  instruction: string;
  code?: string;
  codeLanguage?: string;
  expectedResult?: string;
  image?: string;
  notes: Note[];
  teaching?: TeachingGuidance;
  subSteps?: NavSubStep[];
}

interface TeachingGuidance {
  goal?: string;
  why?: string;
  commonMistakes?: string[];
  successSignals?: string[];
  hints?: string[];
}

interface Note {
  type: "warning" | "tip" | "info";
  content: string;
}

interface NavSubStep {
  stepId: string;
  instruction: string;
  code?: string;
  codeLanguage?: string;
  expectedResult?: string;
  notes: Note[];
  teaching?: TeachingGuidance;
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
}

const WIDGET_KEY = "lab-training";

const NOTE_STYLES: Record<Note["type"], { icon: string; color: string; bg: string }> = {
  warning: { icon: "!", color: "#f59e0b", bg: "#f59e0b1a" },
  tip: { icon: "*", color: "var(--accent)", bg: "transparent" },
  info: { icon: "i", color: "var(--text-muted)", bg: "transparent" },
};

interface Props {
  widgetMetadata?: unknown;
  onSendCommand: (command: string) => void;
  disabled?: boolean;
}

export function LabTrainingPanel({ widgetMetadata, onSendCommand, disabled }: Props) {
  const state = (widgetMetadata as WidgetState | null | undefined) ?? null;
  if (!state) return null;

  const showProgress = state.mode === "training" && state.stepTotal > 0;
  const showLocation = (state.mode === "training" || state.mode === "qa") && state.sectionTitle;
  const step = state.currentStep;

  const variantStyle = (v: WidgetAction["variant"]): React.CSSProperties => {
    if (v === "primary") return { background: "var(--accent)", color: "#fff", border: "none" };
    if (v === "danger") return { background: "#ef4444", color: "#fff", border: "none" };
    return { background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)" };
  };

  return (
    <div
      style={{
        width: 340,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          {state.mode === "qa" && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "#9333ea", color: "#fff" }}>
              QA
            </span>
          )}
          {state.mode === "training" && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "var(--accent)", color: "#fff" }}>
              LAB
            </span>
          )}
          {state.labTitle && (
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {state.labTitle}
            </span>
          )}
        </div>
        {showLocation && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {state.sectionTitle}
            {state.blockTitle ? ` > ${state.blockTitle}` : ""}
          </div>
        )}
        {showProgress && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, marginBottom: 3 }}>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                Step {state.stepIndex}/{state.stepTotal}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{state.progressPercent}%</span>
            </div>
            <div style={{ height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${state.progressPercent}%`, background: "var(--accent)", transition: "width 0.2s" }} />
            </div>
          </>
        )}
      </div>

      {state.sections.length > 0 && (
        <SectionNav
          sections={state.sections}
          currentSectionId={state.currentSectionId}
          currentBlockId={state.currentBlockId}
          onJump={(cmd) => onSendCommand(cmd)}
          disabled={disabled}
        />
      )}

      {/* Step content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px" }}>
        {state.mode === "idle" ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12, textAlign: "center", marginTop: 24 }}>
            Select a lab to begin training.
          </div>
        ) : state.mode === "qa" ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
            You are in Q&amp;A mode. Ask questions about the training material in the chat. The current step remains shown in the panel.
            {step && (
              <div style={{ marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)" }}>
                <div style={{ fontSize: 12, color: "var(--text)" }}>{step.instruction}</div>
              </div>
            )}
          </div>
        ) : step ? (
          <StepContent step={step} />
        ) : (
          <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No active step.</div>
        )}

        {state.pendingManualConfirm && (
          <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 6, background: "#f59e0b1a", border: "1px solid #f59e0b55", fontSize: 11, color: "#f59e0b" }}>
            Complete the step, then confirm.
          </div>
        )}
      </div>

      {/* Actions */}
      {state.actions.length > 0 && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", display: "flex", gap: 6, flexWrap: "wrap", flexShrink: 0 }}>
          {state.actions.map((action) => (
            <button
              key={action.id}
              onClick={() => onSendCommand(action.command)}
              disabled={disabled}
              style={{
                height: 28,
                padding: "0 12px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                cursor: disabled ? "default" : "pointer",
                opacity: disabled ? 0.5 : 1,
                ...variantStyle(action.variant),
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

function StepContent({ step }: { step: StepView }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {step.teaching?.goal && (
        <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>{step.teaching.goal}</div>
      )}

      <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text)" }}>{step.instruction}</div>

      {step.teaching?.why && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{step.teaching.why}</div>
      )}

      {step.code && (
        <pre
          style={{
            margin: 0,
            padding: 10,
            borderRadius: 6,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            overflowX: "auto",
            fontSize: 12,
            lineHeight: 1.5,
            fontFamily: "var(--font-mono)",
            color: "var(--text)",
          }}
        >
          <code>{step.code}</code>
        </pre>
      )}

      {step.expectedResult && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
          <span style={{ fontWeight: 600, color: "var(--text)" }}>Expected: </span>
          {step.expectedResult}
        </div>
      )}

      {step.image && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
          Screenshot: {step.image}
        </div>
      )}

      {step.notes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {step.notes.map((note, i) => {
            const ns = NOTE_STYLES[note.type] ?? NOTE_STYLES.info;
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 6,
                  padding: "6px 8px",
                  borderRadius: 5,
                  background: ns.bg,
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: ns.color,
                }}
              >
                <span style={{ fontWeight: 700, flexShrink: 0, width: 14, textAlign: "center" }}>{ns.icon}</span>
                <span>{note.content}</span>
              </div>
            );
          })}
        </div>
      )}

      <TeachingList title="Success" items={step.teaching?.successSignals} />
      <TeachingList title="Hints" items={step.teaching?.hints} />
      <TeachingList title="Watch" items={step.teaching?.commonMistakes} />

      {step.subSteps && step.subSteps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>Sub-steps</span>
          {step.subSteps.map((sub, i) => (
            <SubStepView key={sub.stepId} sub={sub} num={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubStepView({ sub, num }: { sub: NavSubStep; num: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 12, color: "var(--text)" }}>
        <span style={{ color: "var(--text-dim)", marginRight: 4 }}>{num}.</span>
        {sub.instruction}
      </div>
      {sub.code && (
        <pre
          style={{
            margin: 0,
            padding: 8,
            borderRadius: 5,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            overflowX: "auto",
            fontSize: 11,
            lineHeight: 1.4,
            fontFamily: "var(--font-mono)",
          }}
        >
          <code>{sub.code}</code>
        </pre>
      )}
      {sub.expectedResult && (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          <span style={{ fontWeight: 600 }}>Expected: </span>
          {sub.expectedResult}
        </div>
      )}
      <TeachingList title="Hints" items={sub.teaching?.hints} compact />
      {sub.notes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {sub.notes.map((note, i) => {
            const ns = NOTE_STYLES[note.type] ?? NOTE_STYLES.info;
            return (
              <div key={i} style={{ fontSize: 10, color: ns.color, paddingLeft: 4 }}>
                <span style={{ fontWeight: 700 }}>{ns.icon} </span>
                {note.content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeachingList({ title, items, compact }: { title: string; items?: string[]; compact?: boolean }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 2 : 4 }}>
      <span style={{ fontSize: compact ? 9 : 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>{title}</span>
      {items.map((item, i) => (
        <div key={i} style={{ fontSize: compact ? 10 : 11, color: "var(--text-muted)", lineHeight: 1.45 }}>
          {item}
        </div>
      ))}
    </div>
  );
}

export { WIDGET_KEY as LAB_WIDGET_KEY };

function SectionNav({
  sections,
  currentSectionId,
  currentBlockId,
  onJump,
  disabled,
}: {
  sections: SectionNode[];
  currentSectionId: string | null;
  currentBlockId: string | null;
  onJump: (command: string) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%",
          padding: "5px 12px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span style={{ fontSize: 9 }}>{expanded ? "▼" : "▶"}</span>
        Outline
      </button>
      {expanded && (
        <div style={{ maxHeight: 180, overflowY: "auto", paddingBottom: 4 }}>
          {sections.map((section) => {
            const isCurrent = section.id === currentSectionId;
            const hasBlocks = section.blocks && section.blocks.length > 0;
            const isSectionExpanded = expandedSections.has(section.id) || (hasBlocks && isCurrent);
            return (
              <div key={section.id}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  {hasBlocks && (
                    <button
                      onClick={() => toggleSection(section.id)}
                      style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: "0 2px", fontSize: 8, flexShrink: 0 }}
                    >
                      {isSectionExpanded ? "▼" : "▶"}
                    </button>
                  )}
                  <button
                    onClick={() => !disabled && onJump(`/lab goto ${section.id}`)}
                    disabled={disabled}
                    style={{
                      flex: 1,
                      textAlign: "left",
                      padding: "3px 6px",
                      border: "none",
                      borderRadius: 4,
                      background: isCurrent && !currentBlockId ? "var(--bg-selected)" : "transparent",
                      color: isCurrent ? "var(--accent)" : "var(--text-muted)",
                      fontSize: 11,
                      fontWeight: isCurrent ? 600 : 400,
                      cursor: disabled ? "default" : "pointer",
                    }}
                  >
                    {section.title}
                  </button>
                </div>
                {hasBlocks && isSectionExpanded && section.blocks!.map((block) => {
                  const isBlockCurrent = section.id === currentSectionId && block.id === currentBlockId;
                  return (
                    <button
                      key={`${section.id}/${block.id}`}
                      onClick={() => !disabled && onJump(`/lab goto ${section.id}/${block.id}`)}
                      disabled={disabled}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "3px 6px 3px 28px",
                        border: "none",
                        borderRadius: 4,
                        background: isBlockCurrent ? "var(--bg-selected)" : "transparent",
                        color: isBlockCurrent ? "var(--accent)" : "var(--text-dim)",
                        fontSize: 10,
                        fontWeight: isBlockCurrent ? 600 : 400,
                        cursor: disabled ? "default" : "pointer",
                      }}
                    >
                      {block.title}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
