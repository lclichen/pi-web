"use client";

import { useState } from "react";
import { DiffEditor, loader } from "@monaco-editor/react";

// See MonacoEditor.tsx — self-hosted AMD assets, no CDN.
let loaderConfigured = false;
function configureLoader(): void {
  if (loaderConfigured) return;
  loader.config({ paths: { vs: "/monaco/vs" } });
  loaderConfigured = true;
}

export interface MonacoDiffEditorProps {
  original: string;
  modified: string;
  language: string;
  isDark: boolean;
}

/**
 * Monaco DiffEditor for FileViewer's git-diff mode: original = HEAD blob,
 * modified = working-tree content. Adds a side-by-side / inline toggle on
 * top of the stock diff navigation (F8 / Shift+F8).
 */
export function MonacoDiffEditor({ original, modified, language, isDark }: MonacoDiffEditorProps) {
  configureLoader();
  const [sideBySide, setSideBySide] = useState(true);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <button
        onClick={() => setSideBySide((v) => !v)}
        title={sideBySide ? "切换为内联视图" : "切换为并排视图"}
        style={{
          position: "absolute", top: 6, right: 12, zIndex: 10,
          fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
          background: "var(--bg-panel)", color: "var(--text)",
          border: "1px solid var(--border)",
        }}
      >
        {sideBySide ? "内联" : "并排"}
      </button>
      <DiffEditor
        height="100%"
        language={language}
        original={original}
        modified={modified}
        theme={isDark ? "vs-dark" : "vs"}
        loading={
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)", fontSize: 12 }}>
            加载差异视图…
          </div>
        }
        options={{
          readOnly: true,
          renderSideBySide: sideBySide,
          automaticLayout: true,
          renderOverviewRuler: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12.5,
          fontFamily: "var(--font-mono, Menlo, Consolas, \"Courier New\", monospace)",
          renderLineHighlight: "none",
          ignoreTrimWhitespace: false,
        }}
      />
    </div>
  );
}
