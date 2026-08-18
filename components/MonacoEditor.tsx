"use client";

import { useRef } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";

// Self-hosted AMD assets (copied to public/monaco/vs by scripts/copy-monaco.mjs)
// instead of the jsdelivr CDN default — required for offline packaging.
let loaderConfigured = false;
function configureLoader(): void {
  if (loaderConfigured) return;
  loader.config({ paths: { vs: "/monaco/vs" } });
  loaderConfigured = true;
}

export interface MonacoEditorProps {
  value: string;
  language: string;
  isDark: boolean;
  readOnly?: boolean;
  /** Distinguishes models per file so undo history doesn't leak across files. */
  path?: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  /** Click on the line-number gutter — used for file:line @-mentions. */
  onLineClick?: (line: number) => void;
  /** Multi-line selection change (collapsed selection reports null) — feeds
   *  the "mention selected lines" button in read-only mode. */
  onSelectionChange?: (range: { startLine: number; endLine: number } | null) => void;
  options?: Record<string, unknown>;
}

/**
 * Monaco-backed code editor/viewer for FileViewer. The line-click reference
 * feature works in both read-only and edit modes: clicking the gutter (or a
 * line's text in read-only mode) fires onLineClick with the line number, and
 * the hovered line gets a subtle highlight — parity with the old Prism-based
 * renderer's data-line-number behavior.
 */
export function MonacoEditor({
  value,
  language,
  isDark,
  readOnly = false,
  path,
  onChange,
  onSave,
  onLineClick,
  onSelectionChange,
  options,
}: MonacoEditorProps) {
  configureLoader();
  // Callbacks in refs so re-renders don't rebind editor listeners.
  const saveRef = useRef(onSave);
  const lineClickRef = useRef(onLineClick);
  const selectionChangeRef = useRef(onSelectionChange);
  saveRef.current = onSave;
  lineClickRef.current = onLineClick;
  selectionChangeRef.current = onSelectionChange;

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current?.();
    });

    if (!onLineClick) return;

    // Hovered-line highlight via decorations.
    const hoverClass = "pi-web-monaco-line-hover";
    const oldDecorations = editor.createDecorationsCollection([]);
    const highlightLine = (lineNumber: number | null) => {
      oldDecorations.set(
        lineNumber
          ? [{ range: new monaco.Range(lineNumber, 1, lineNumber, 1), options: { isWholeLine: true, className: hoverClass } }]
          : [],
      );
    };

    editor.onMouseDown((e) => {
      const t = e.target.type;
      // Only the gutter references immediately (both modes). Clicking line
      // content never mentions on its own — read-only keeps the old
      // select-then-mention flow via onSelectionChange, and in edit mode
      // content clicks stay ordinary cursor moves.
      if (
        t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
      ) {
        const line = e.target.position?.lineNumber;
        if (line) lineClickRef.current?.(line);
      }
    });
    if (onSelectionChange) {
      editor.onDidChangeCursorSelection((e) => {
        const sel = e.selection;
        if (sel.isEmpty()) {
          selectionChangeRef.current?.(null);
        } else {
          selectionChangeRef.current?.({
            startLine: sel.startLineNumber,
            endLine: sel.endLineNumber,
          });
        }
      });
    }
    editor.onMouseMove((e) => {
      const line = e.target.position?.lineNumber ?? null;
      highlightLine(line);
    });
    editor.onMouseLeave(() => highlightLine(null));
  };

  return (
    <>
      <style>{`.pi-web-monaco-line-hover { background: rgba(128, 128, 128, 0.16) !important; }`}</style>
      <Editor
        height="100%"
        path={path}
        language={language}
        value={value}
        theme={isDark ? "vs-dark" : "vs"}
        onChange={(v) => onChange?.(v ?? "")}
        onMount={onMount}
        loading={
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)", fontSize: 12 }}>
            加载编辑器…
          </div>
        }
        options={{
          readOnly,
          automaticLayout: true,
          tabSize: 2,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12.5,
          fontFamily: "var(--font-mono, Menlo, Consolas, \"Courier New\", monospace)",
          renderLineHighlight: "none",
          // Only the viewer is clickable for references; in edit mode the
          // gutter remains the reference target so text editing is unimpeded.
          lineNumbersMinChars: 3,
          ...(options ?? {}),
        }}
      />
    </>
  );
}
