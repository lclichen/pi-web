"use client";

import { useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";

/**
 * Display-math wrapper: KaTeX keeps the original TeX in an
 * <annotation encoding="application/x-tex"> element, so the copy button can
 * copy the source rather than the rendered glyphs.
 */
export function MathBlock({ className, children }: { className?: string; children: ReactNode }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  const copy = async () => {
    const tex = ref.current?.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (!tex) return;
    try {
      await copyText(tex);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard access can be denied; leave the button unchanged.
    }
  };

  return (
    <span ref={ref} className={className} style={{ position: "relative", display: "block" }}>
      <button
        type="button"
        className="markdown-code-action"
        onClick={() => void copy()}
        title={copied ? t("i18n.copied") : t("i18n.copy")}
        style={{ position: "absolute", top: 2, right: 2, zIndex: 1 }}
      >
        {copied ? t("i18n.copied") : t("i18n.copy")}
      </button>
      {children}
    </span>
  );
}
