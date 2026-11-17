import { getPublicBaseUrl } from "./server-settings";

/** Absolute origin for generated links: configured public URL > request host. */
export function requestOrigin(req: Request): string {
  const configured = getPublicBaseUrl();
  if (configured) return configured;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return `${proto}://${host}`;
}
