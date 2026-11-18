import { NextResponse } from "next/server";
import type { EmbedProductProfile } from "./embed-types.ts";

/** `/api/embed/products/<productId>/...` — productId for CORS preflight. */
export function embedProductIdFromPath(pathname: string): string | null {
  const match = /^\/api\/embed\/products\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function isEmbedOriginAllowed(profile: EmbedProductProfile, origin: string | null): boolean {
  if (!origin) return true; // server-side caller
  if (profile.allowedOrigins.length === 0) return true;
  return profile.allowedOrigins.includes(origin);
}

export function embedCorsHeaders(
  request: Request,
  profile: EmbedProductProfile,
): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { Vary: "Origin" };
  if (!origin) return headers;
  if (profile.allowedOrigins.length === 0) {
    // The API key is a bearer header, not a cookie; no credentials mode.
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (profile.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function embedCorsPreflight(request: Request, profile: EmbedProductProfile): NextResponse {
  const origin = request.headers.get("origin");
  if (!isEmbedOriginAllowed(profile, origin)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...(origin
        ? {
            "Access-Control-Allow-Origin": profile.allowedOrigins.length === 0 ? "*" : origin,
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type,X-Platform-API-Key,Authorization",
            "Access-Control-Max-Age": "600",
          }
        : {}),
      Vary: "Origin",
    },
  });
}

export function withEmbedCors(
  request: Request,
  profile: EmbedProductProfile,
  response: NextResponse,
): NextResponse {
  for (const [key, value] of Object.entries(embedCorsHeaders(request, profile))) {
    response.headers.set(key, value);
  }
  return response;
}
