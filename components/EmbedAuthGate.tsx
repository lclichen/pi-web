"use client";

import { useCallback, useEffect, useState } from "react";
import { EmbedShell } from "./EmbedShell";
import { useI18n } from "@/hooks/useI18n";
import type { EmbedAuthResponse, EmbedPageContext } from "@/lib/embed-types";

interface Props {
  context: EmbedPageContext;
}

const TOKEN_PREFIX = "pi-embed-token:";
const KEY_PREFIX = "pi-embed-key:";

function readHashAuth(): { token: string | null; expiresAt: number | null } {
  if (typeof window === "undefined") return { token: null, expiresAt: null };
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token");
  const expires = Number(params.get("expires"));
  return {
    token: token?.startsWith("emba_") ? token : null,
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires : null,
  };
}

/**
 * API-key gate for `/embed/p/<projectId>`.
 *
 * Products with a logged-in user call the product `open` API and receive a URL
 * with a short-lived access token in the hash. If a link is opened without a
 * token, the user can paste their platform API key here; it stays inside the
 * pi-web iframe and is exchanged for an access token.
 */
export function EmbedAuthGate({ context }: Props) {
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(Date.now() + 12 * 60 * 60 * 1000);
  const [apiKey, setApiKey] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configUpdateAvailable, setConfigUpdateAvailable] = useState(context.configUpdateAvailable);
  const [checkedHash, setCheckedHash] = useState(false);

  const exchange = useCallback(
    async (key: string, persist: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/embed/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: context.project.id, apiKey: key }),
        });
        const data = (await response.json().catch(() => ({}))) as EmbedAuthResponse & { error?: string };
        if (!response.ok || !data.token) throw new Error(data.error ?? `HTTP ${response.status}`);
        setToken(data.token);
        setExpiresAt(data.expiresAt);
        setConfigUpdateAvailable(data.configUpdateAvailable);
        sessionStorage.setItem(`${TOKEN_PREFIX}${context.project.id}`, data.token);
        sessionStorage.setItem(`${KEY_PREFIX}${context.product.id}`, key);
        if (persist) localStorage.setItem(`${KEY_PREFIX}${context.product.id}`, key);
        else localStorage.removeItem(`${KEY_PREFIX}${context.product.id}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setToken(null);
      } finally {
        setBusy(false);
      }
    },
    [context.product.id, context.project.id],
  );

  useEffect(() => {
    const hash = readHashAuth();
    if (hash.token) {
      setToken(hash.token);
      if (hash.expiresAt) setExpiresAt(hash.expiresAt);
      sessionStorage.setItem(`${TOKEN_PREFIX}${context.project.id}`, hash.token);
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      }
      setCheckedHash(true);
      return;
    }
    const storedToken = sessionStorage.getItem(`${TOKEN_PREFIX}${context.project.id}`);
    if (storedToken?.startsWith("emba_")) {
      setToken(storedToken);
      setCheckedHash(true);
      return;
    }
    const storedKey =
      localStorage.getItem(`${KEY_PREFIX}${context.product.id}`) ??
      sessionStorage.getItem(`${KEY_PREFIX}${context.product.id}`);
    setCheckedHash(true);
    if (storedKey?.startsWith("sk_")) void exchange(storedKey, true);
  }, [context.product.id, context.project.id, exchange]);

  const handleAuthExpired = useCallback(() => {
    setToken(null);
    sessionStorage.removeItem(`${TOKEN_PREFIX}${context.project.id}`);
    const storedKey =
      localStorage.getItem(`${KEY_PREFIX}${context.product.id}`) ??
      sessionStorage.getItem(`${KEY_PREFIX}${context.product.id}`);
    if (storedKey?.startsWith("sk_")) {
      void exchange(storedKey, true);
    } else {
      setError(t("embed.sessionExpired"));
    }
  }, [context.product.id, context.project.id, exchange, t]);

  const switchAccount = useCallback(() => {
    localStorage.removeItem(`${KEY_PREFIX}${context.product.id}`);
    sessionStorage.removeItem(`${KEY_PREFIX}${context.product.id}`);
    sessionStorage.removeItem(`${TOKEN_PREFIX}${context.project.id}`);
    setToken(null);
    setApiKey("");
    setError(null);
  }, [context.product.id, context.project.id]);

  if (token) {
    return (
      <EmbedShell
        token={token}
        product={context.product}
        scope={context.scope}
        label={context.label}
        mode={context.project.mode}
        allowedCommands={context.allowedCommands}
        expiresAt={expiresAt}
        {...(context.initialSessionId ? { initialSessionId: context.initialSessionId } : {})}
        configUpdateAvailable={configUpdateAvailable}
        onConfigUpdateAvailableChange={setConfigUpdateAvailable}
        onAuthExpired={handleAuthExpired}
        onSwitchAccount={switchAccount}
      />
    );
  }

  if (!checkedHash) {
    return (
      <div className="embed-shell">
        <div className="embed-state" role="status">
          {t("embed.loading")}
        </div>
      </div>
    );
  }

  return (
    <div className="embed-shell" data-density="comfortable">
      <div className="embed-auth">
        <div className="embed-auth-product">{context.product.name}</div>
        <div className="embed-auth-title">{context.project.name}</div>
        <form
          style={{ display: "flex", flexDirection: "column", gap: 8, width: "min(340px, 100%)" }}
          onSubmit={(event) => {
            event.preventDefault();
            if (apiKey.trim() && !busy) void exchange(apiKey.trim(), remember);
          }}
        >
          <label className="embed-auth-label" htmlFor="embed-api-key">
            {t("embed.apiKey")}
          </label>
          <input
            id="embed-api-key"
            type="password"
            autoFocus
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk_..."
            className="embed-auth-input"
            disabled={busy}
          />
          <label className="embed-auth-remember">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            {t("embed.rememberKey")}
          </label>
          <button type="submit" className="embed-auth-submit" disabled={busy || !apiKey.trim()}>
            {busy ? t("embed.connecting") : t("embed.connect")}
          </button>
          {error && (
            <div className="embed-auth-error" role="alert">
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
