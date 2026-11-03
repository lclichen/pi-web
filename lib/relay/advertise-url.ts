/**
 * Advertised relay URLs (browser-side helper).
 *
 * Priority for the `agent-client pair --server …` command, matching the share
 * link origin rule:
 *   1. `PI_RELAY_ADVERTISE_URL` (explicit relay endpoint; reverse proxies)
 *   2. the admin-configured global "public base URL" host (`PI_WEB_PUBLIC_URL`
 *      seeded), with the relay port appended
 *   3. the browser's own location (caller fallback)
 *
 * The global public base is the address other people use to reach this
 * deployment; deriving the pairing command from the browser host breaks when
 * an admin opens the UI via localhost while users reach it via a LAN name.
 */

function safeUrl(raw: string | null | undefined): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** `http(s)://host[:port]` origin of the configured public base, or null. */
export function publicBaseOrigin(base: string | null | undefined): string | null {
  return safeUrl(base)?.origin ?? null;
}

/**
 * Relay server URL derived from the public base host + the relay port.
 * Path/query of the public base are intentionally dropped (the relay has its
 * own port); use `PI_RELAY_ADVERTISE_URL` for path-based reverse proxies.
 */
export function relayServerUrlFromPublicBase(
  base: string | null | undefined,
  relayPort: number,
): string | null {
  if (!Number.isInteger(relayPort) || relayPort <= 0 || relayPort > 65535) return null;
  const url = safeUrl(base);
  if (!url || !url.hostname) return null;
  const host = url.hostname.includes(":") && !url.hostname.startsWith("[") ? `[${url.hostname}]` : url.hostname;
  return `${url.protocol}//${host}:${relayPort}`;
}
