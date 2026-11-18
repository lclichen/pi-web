import { getEmbedAccessToken } from "./embed-access.ts";
import { getEmbedProfile } from "./embed-profiles.ts";
import type {
  EmbedAccessRecord,
  EmbedPageContext,
  EmbedProductProfile,
} from "./embed-types.ts";

/**
 * Server-side resolution for short-lived embed access tokens and the public
 * project page context. Project ids are stable references; access tokens are
 * the only credential the page/API carries.
 */

export interface EmbedAccess {
  record: EmbedAccessRecord;
  profile: EmbedProductProfile;
}

export type EmbedRequestAccess =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "ok"; access: EmbedAccess };

/** `emba_` tokens carried by fetch / EventSource / media URLs. */
export function extractEmbedToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(\S+)\s*$/i);
    if (match?.[1]?.startsWith("emba_")) return match[1];
  }
  const direct = request.headers.get("x-embed-token")?.trim();
  if (direct?.startsWith("emba_")) return direct;
  const query = new URL(request.url).searchParams.get("embed_token")?.trim();
  return query?.startsWith("emba_") ? query : null;
}

export function resolveEmbedAccess(raw: string): EmbedAccess | null {
  const record = getEmbedAccessToken(raw);
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

/**
 * Public page bootstrap for `/embed/p/<projectId>`. Authentication happens in
 * the client auth gate; this only exposes names/config that the iframe needs.
 */
export async function getEmbedProjectPageContext(
  projectId: string,
  initialSessionId?: string,
): Promise<EmbedPageContext | null> {
  const { getProject, projectHome } = await import("./projects.ts");
  const project = getProject(projectId);
  if (!project?.embed) return null;
  const profile = getEmbedProfile(project.embed.productId);
  if (!profile || !profile.enabled) return null;
  const { embedConfigUpdateAvailable } = await import("./embed-workspaces.ts");
  return {
    product: { id: profile.id, name: profile.name },
    project: { id: project.id, name: project.name, mode: project.mode },
    scope: { kind: "project", projectId: project.id, cwd: projectHome(project) },
    label: project.name,
    allowedCommands: [...profile.allowedCommands],
    configUpdateAvailable: embedConfigUpdateAvailable(project, profile),
    ...(initialSessionId ? { initialSessionId } : {}),
  };
}

/**
 * Default-deny API surface for access tokens. Session rename/archive/delete
 * are allowed because they remain project-scoped; project/admin routes stay
 * closed.
 */
export function isEmbedApiAllowed(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const get = verb === "GET";
  const post = verb === "POST";
  const put = verb === "PUT";
  const patch = verb === "PATCH";
  const del = verb === "DELETE";

  if (get && path === "/api/models") return true;
  if (get && path === "/api/git/status") return true;
  if (get && path === "/api/sessions") return true;
  if (get && /^\/api\/sessions\/(?!search$)[^/]+$/.test(path)) return true;
  if ((patch || del) && /^\/api\/sessions\/(?!search$)[^/]+$/.test(path)) return true;
  if (get && /^\/api\/sessions\/(?!search$)[^/]+\/(?:context|state|plan|plan-versions)$/.test(path)) return true;
  if (get && /^\/api\/sessions\/(?!search$)[^/]+\/entries\/[^/]+\/(?:thinking|tool-result-image)$/.test(path)) {
    return true;
  }

  if (post && path === "/api/agent/new") return true;
  if ((get || post) && /^\/api\/agent\/[^/]+$/.test(path)) return true;
  if (get && /^\/api\/agent\/[^/]+\/events$/.test(path)) return true;
  if (post && /^\/api\/agent\/[^/]+\/lease$/.test(path)) return true;
  if (get && /^\/api\/agent\/[^/]+\/bash-output$/.test(path)) return true;

  if (get && path === "/api/file-index") return true;
  if (get && path === "/api/skills") return true;
  if ((get || post || put) && (path === "/api/files" || path.startsWith("/api/files/"))) return true;
  if ((get || post || put) && (path === "/api/remotefs" || path.startsWith("/api/remotefs/"))) return true;
  if (post && path === "/api/embed/workspace/reapply-config") return true;

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
