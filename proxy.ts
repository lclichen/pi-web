import { NextResponse, type NextRequest } from "next/server";
import { isApiRequestAllowed, isApiRequestHostAllowed } from "@/lib/request-security";
import { isValidBasicAuthorization, isWebPasswordEnabled } from "@/lib/web-auth";
import { getWebSession } from "@/lib/web-session";
import { getEmbedProfile } from "@/lib/embed-profiles";
import { getProject } from "@/lib/projects";
import {
  embedProductIdFromPath,
  embedCorsPreflight,
  isEmbedOriginAllowed,
} from "@/lib/embed-cors";
import {
  embedResponseHeaders,
  isEmbedApiAllowed,
  resolveEmbedAccess,
  resolveEmbedRequest,
} from "@/lib/embed-auth";

// Next 16 runs the proxy (middleware) on the Node.js runtime, so it can read
// the real session store — not just cookie presence. This is the central
// anonymous gate for EVERY /api route; per-route requireUserIdentity calls
// remain as defense in depth and to resolve per-user ownership.

function projectIdFromEmbedPage(pathname: string): string | null {
  const match = /^\/embed\/p\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");

  // Product API: CORS/API-key-authenticated. The productId is in the path so
  // preflight can enforce the product's origin allowlist before auth.
  const productId = isApiRequest ? embedProductIdFromPath(pathname) : null;
  if (productId) {
    if (!isApiRequestHostAllowed(request)) {
      return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
    }
    const product = getEmbedProfile(productId);
    if (!product || !product.enabled) return NextResponse.json({ error: "产品不存在或未启用" }, { status: 404 });
    if (request.method.toUpperCase() === "OPTIONS") return embedCorsPreflight(request, product);
    if (!isEmbedOriginAllowed(product, request.headers.get("origin"))) {
      return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
    }
    // Routes validate X-Platform-API-Key / cookie and group membership.
    return NextResponse.next();
  }

  // The auth gate exchanges a user API key for a short-lived access token. It
  // is same-origin iframe traffic, not a cross-site product API.
  if (isApiRequest && pathname === "/api/embed/auth") {
    if (!isApiRequestHostAllowed(request)) {
      return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
    }
    if (!isApiRequestAllowed(request)) {
      return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
    }
    return NextResponse.next();
  }

  // Stable project page: authentication is handled by the page's API-key gate.
  const embedPageProjectId = pathname.startsWith("/embed/p/") ? projectIdFromEmbedPage(pathname) : null;
  if (embedPageProjectId) {
    if (!isApiRequestHostAllowed(request)) return new NextResponse("Untrusted request", { status: 403 });
    const project = getProject(embedPageProjectId);
    const profile = project?.embed ? getEmbedProfile(project.embed.productId) : undefined;
    const response = NextResponse.next();
    if (profile) {
      for (const [key, value] of Object.entries(embedResponseHeaders(profile))) {
        response.headers.set(key, value);
      }
    }
    return response;
  }

  const isTrustedRequest = isApiRequest ? isApiRequestAllowed(request) : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // Short-lived embed access tokens bypass the cookie/Basic gates but remain
  // default-denied to the chat/file surface.
  if (isApiRequest) {
    const embed = resolveEmbedRequest(request);
    if (embed.kind === "invalid") {
      return NextResponse.json({ error: "嵌入会话已失效" }, { status: 401 });
    }
    if (embed.kind === "ok") {
      if (!isEmbedApiAllowed(request.method, pathname)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      const response = NextResponse.next();
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  }

  // Relay agent downloads are curl-able installers (the pairing modal emits
  // `curl …/install.sh | sh`); they carry no secrets and are a fixed
  // allowlist of prebuilt binaries, so they stay public in both auth modes.
  const isRelayDownload = pathname.startsWith("/api/agent-relay/download/");

  // Share downloads are bearer-token URLs: the 128-bit token in the path is
  // the credential, so an MCP service (or any other device/browser) fetches
  // them WITHOUT a session cookie. Only the token GET is public — the audit
  // list, creation and revocation stay session-gated.
  const isPublicShareDownload = request.method === "GET" && /^\/api\/share\/[^/]+\/?$/.test(pathname);

  // Batch test API authenticates with X-Platform-API-Key (sk_...), validated
  // against the platform inside the routes (requireBatchIdentity: key →
  // /auth/me → admin role). Without this bypass the session gate rejects
  // headless callers before the route ever runs. This is only a FORMAT
  // pre-check — the route's own validation remains the authority.
  const hasBatchPlatformKey =
    pathname.startsWith("/api/batch/") &&
    (() => {
      const direct = request.headers.get("x-platform-api-key");
      if (direct?.startsWith("sk_")) return true;
      const bearer = request.headers.get("authorization");
      return Boolean(bearer?.startsWith("Bearer sk_"));
    })();

  if (process.env.PI_WEB_AUTH === "on") {
    // /api/webauth/* validates its own credentials (login/register/config are
    // inherently pre-session; me/logout/change-password check the cookie
    // themselves and tolerate change-ticket sessions).
    const isWebAuthRoute = pathname.startsWith("/api/webauth/");
    if (!isRelayDownload && !isWebAuthRoute && !hasBatchPlatformKey && !isPublicShareDownload) {
      const session = getWebSession(request);
      const usable = session && !session.changeTicket;
      if (!usable) {
        if (isApiRequest) {
          return NextResponse.json({ error: "登录已失效" }, { status: 401 });
        }
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }
    return NextResponse.next();
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (
    !isRelayDownload &&
    !isPublicShareDownload &&
    !hasBatchPlatformKey &&
    isWebPasswordEnabled(password) &&
    !isValidBasicAuthorization(request.headers.get("authorization"), password)
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/embed/p/:path*", "/api/:path*"] };
