"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { CodeBlock } from "./MermaidBlock";

/**
 * ```svg fence: render the markup as an image (an <img> data URL never runs
 * scripts or loads remote subresources), with a source toggle. MermaidBlock's
 * pattern, minus zoom/download.
 */
export function SvgBlock({ code, isStreaming }: { code: string; isStreaming?: boolean }) {
  const { t } = useI18n();
  const [showSource, setShowSource] = useState(false);
  const src = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`,
    [code],
  );
  const action = (
    <button
      type="button"
      onClick={() => setShowSource((value) => !value)}
      disabled={isStreaming}
      title={
        showSource
          ? t("i18n.preview")
          : t("i18n.source")
      }
      className={["markdown-code-action", !showSource ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {showSource ? t("i18n.preview") : t("i18n.source")}
    </button>
  );

  if (showSource || isStreaming) {
    return <CodeBlock code={code} lang="svg" headerAction={action} isStreaming={isStreaming} />;
  }

  return (
    <div
      className="markdown-svg-preview"
      style={{
        position: "relative",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 10,
        margin: "8px 0",
        background: "var(--bg-secondary, transparent)",
        overflow: "auto",
      }}
    >
      <div style={{ position: "absolute", top: 4, right: 4 }}>{action}</div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="SVG preview"
        style={{ display: "block", maxWidth: "100%", height: "auto", margin: "0 auto" }}
      />
    </div>
  );
}
