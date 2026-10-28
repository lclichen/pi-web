"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  abortLabel: string;
  danger?: boolean;
}

// Module-level open counter: lets document-level Escape handlers (e.g. the
// settings dialog's) stand down while a confirm dialog owns the interaction.
let openDialogs = 0;

export function isConfirmDialogOpen(): boolean {
  return openDialogs > 0;
}

function ConfirmDialogView({ options, onSettle }: { options: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  useEffect(() => {
    openDialogs += 1;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onSettle(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      openDialogs -= 1;
      document.removeEventListener("keydown", handleKey);
    };
  }, [onSettle]);

  const confirmClass = options.danger ? "config-button-danger" : "config-button-primary";
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={options.title}
      className="confirm-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onSettle(false);
      }}
    >
      <div className="confirm-dialog-surface">
        <strong className="confirm-dialog-title">{options.title}</strong>
        <div className="confirm-dialog-message">{options.message}</div>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="config-button config-button-secondary config-button-default"
            onClick={() => onSettle(false)}
            autoFocus
          >
            {options.abortLabel}
          </button>
          <button
            type="button"
            className={`config-button ${confirmClass} config-button-default`}
            onClick={() => onSettle(true)}
          >
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Promise-based confirm dialog (styled, non-blocking — unlike window.confirm).
 * `const { confirm, confirmDialog } = useConfirm();` — await confirm(opts),
 * render {confirmDialog} somewhere in the component tree.
 */
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // A previous pending confirm resolves as aborted, never dangles.
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      setOptions(next);
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const confirmDialog = options ? <ConfirmDialogView options={options} onSettle={settle} /> : null;
  return { confirm, confirmDialog };
}
