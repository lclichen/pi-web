import { getEmbedProfile } from "./embed-profiles.ts";
import { getEmbedTokenByRaw } from "./embed-tokens.ts";
import type {
  EmbedPageContext,
  EmbedProductProfile,
  EmbedTokenRecord,
} from "./embed-types.ts";

/**
 * Server-side embed token resolution and API fence.
 *
 * The page and every token-authenticated API request share this module so the
 * visible command set, workspace scope and frame-ancestors policy can never
 * drift between them.
 */

export interface EmbedAccess {
  record: EmbedTokenRecord;
  profile: EmbedProductProfile;
}

export type EmbedRequestAccess =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "ok"; access: EmbedAccess };

/** `emb_` tokens carried by fetch (Authorization) / EventSource or images. */
export function extractEmbedToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(\S+)\s*$/i);
    if (match?.[1]?.startsWith("emb_")) return match[1];
  }
  const direct = request.headers.get("x-embed-token")?.trim();
  if (direct?.startsWith("emb_")) return direct;
  const query = new URL(request.url).searchParams.get("embed_token")?.trim();
  return query?.startsWith("emb_") ? query : null;
}

/** `/embed/<token>` — used by the page route and its proxy headers. */
export function embedTokenFromPath(pathname: string): string | null {
  const match = /^\/embed\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    const token = decodeURIComponent(match[1]);
    return token.startsWith("emb_") ? token : null;
  } catch {
    return null;
  }
}

export function resolveEmbedAccess(raw: string): EmbedAccess | null {
  const record = getEmbedTokenByRaw(raw);
  if (!record) return null;
  const profile = getEmbedProfile(record.productId);
  if (!profile || !profile.enabled) return null;
  return { record, profile };
}

export function resolveEmbedRequest(request: Request): EmbedRequestAccess {
  const raw = extractEmbedToken(request);
  if (!raw) return { kind: "none" };
  const access = resolveEmbedAccess(raw);
  return access ? { kind: "ok", access } : { kind: "invalid" };
}

/** Page bootstrap: token + product + project must all still exist. */
export async function getEmbedPageContext(raw: string, initialSessionId?: string): Promise<EmbedPageContext | null> {
  const access = resolveEmbedAccess(raw);
  if (!access) return null;
  const { record, profile } = access;
  let mode = record.mode;
  let label = record.label;
  if (record.scope.kind === "project") {
    const { getProject } = await import("./projects.ts");
    const project = getProject(record.scope.projectId);
    if (!project) return null;
    mode = project.mode;
    label = label || project.name;
  }
  return {
    token: raw,
    product: { id: profile.id, name: profile.name },
    scope: { ...record.scope },
    label,
    mode,
    allowedCommands: [...profile.allowedCommands],
    expiresAt: record.expiresAt,
    ...(initialSessionId ? { initialSessionId } : {}),
  };
}

/**
 * Default-deny API surface for embed tokens. Only the chat client's real
 * endpoints are listed; project/admin/session-management routes stay closed.
 * Method matters: session deletion/rename and file deletion are never allowed.
 */
export function isEmbedApiAllowed(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const get = verb === "GET";
  const post = verb === "POST";
  const put = verb === "PUT";

  if (get && path === "/api/models") return true;
  if (get && path === "/api/git/status") return true;
  if (get && path === "/api/sessions") return true;
  if (get && /^\/api\/sessions\/(?!search$)[^/]+$/.test(path)) return true;
  if (get && /^\/api\/sessions\/(?!search$)[^/]+\/(?:context|state|plan|plan-versions)$/.test(path)) return true;
  if (get && /^\/api\/sessions\/(?!search$)[^/]+\/entries\/[^/]+\/(?:thinking|tool-result-image)$/.test(path)) {
    return true;
  }
  if (get && /^\/api\/sessions\/(?!search$)[^/]+\/images\/[^/]+$/.test(path)) return true;

  if (post && path === "/api/agent/new") return true;
  if ((get || post) && /^\/api\/agent\/[^/]+$/.test(path)) return true;
  if (get && /^\/api\/agent\/[^/]+\/events$/.test(path)) return true;
  if (post && /^\/api\/agent\/[^/]+\/lease$/.test(path)) return true;
  if (get && /^\/api\/agent\/[^/]+\/bash-output$/.test(path)) return true;

  if (get && path === "/api/file-index") return true;
  if (get && path === "/api/skills") return true;
  if ((get || post || put) && (path === "/api/files" || path.startsWith("/api/files/"))) return true;
  if ((get || post || put) && (path === "/api/remotefs" || path.startsWith("/api/remotefs/"))) return true;

  return false;
}

/** CSP frame-ancestors value for a product; empty origins = any parent. */
export function embedFrameAncestors(profile: EmbedProductProfile): string {
  const origins = profile.allowedOrigins.filter((origin) => {
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === origin;
    } catch {
      return false;
    }
  });
  if (origins.length === 0) return "*";
  return ["'self'", ...origins].join(" ");
}

export function embedResponseHeaders(profile: EmbedProductProfile): Record<string, string> {
  return {
    "Content-Security-Policy": `frame-ancestors ${embedFrameAncestors(profile)};`,
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
