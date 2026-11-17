/**
 * Browser-side transport for the embed page.
 *
 * The embed page is served from pi-web's origin even when framed by another
 * product, so relative `/api/` requests are same-origin from the iframe's
 * point of view. Cookies are not sent cross-site, so:
 *   · fetch() carries the token as Authorization;
 *   · EventSource and <img> (which cannot set headers) carry it as a query
 *     parameter through withEmbedToken().
 *
 * Only same-origin /api/ URLs are touched.
 */

let activeToken: string | null = null;
let installed = false;

function sameOriginApiUrl(raw: string): URL | null {
  if (typeof window === "undefined") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw, window.location.href);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;
  if (parsed.pathname !== "/api" && !parsed.pathname.startsWith("/api/")) return null;
  return parsed;
}

export function installEmbedTransport(token: string): void {
  activeToken = token;
  if (typeof window === "undefined" || installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!activeToken) return originalFetch(input, init);
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!sameOriginApiUrl(raw)) return originalFetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("authorization")) headers.set("Authorization", `Bearer ${activeToken}`);

    if (input instanceof Request) {
      return originalFetch(new Request(input, { headers }), init);
    }
    return originalFetch(input, { ...init, headers });
  };

  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === "function") {
    class EmbedEventSource extends OriginalEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(withEmbedToken(String(url)), eventSourceInitDict);
      }
    }
    window.EventSource = EmbedEventSource as typeof EventSource;
  }
}

/**
 * Append the embed token to a same-origin /api/ URL. Non-API, data:, and
 * external URLs are returned untouched so data URIs and CDN assets keep
 * working.
 */
export function withEmbedToken(url: string): string {
  if (!activeToken || typeof window === "undefined") return url;
  if (!url.startsWith("/") && !url.startsWith(`${window.location.origin}/`)) return url;
  const parsed = sameOriginApiUrl(url);
  if (!parsed || parsed.searchParams.has("embed_token")) return url;
  parsed.searchParams.set("embed_token", activeToken);
  return url.startsWith("/") ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
}
