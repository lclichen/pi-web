import { NextResponse, type NextRequest } from "next/server";
import { isApiRequestAllowed, isApiRequestHostAllowed } from "@/lib/request-security";
import { isValidBasicAuthorization, isWebPasswordEnabled } from "@/lib/web-auth";
import { getWebSession } from "@/lib/web-session";
import {
  embedResponseHeaders,
  embedTokenFromPath,
  isEmbedApiAllowed,
  resolveEmbedAccess,
  resolveEmbedRequest,
} from "@/lib/embed-auth";

// Next 16 runs the proxy (middleware) on the Node.js runtime, so it can read
// the real session store — not just cookie presence. This is the central
// anonymous gate for EVERY /api route; per-route requireUserIdentity calls
// remain as defense in depth and to resolve per-user ownership.

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest ? isApiRequestAllowed(request) : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // Embed tokens are bearer credentials scoped to one workspace. API requests
  // carrying one bypass the cookie/Basic gates but are still default-denied to
  // the chat-only surface; the routes re-check identity and scope.
  if (isApiRequest) {
    const embed = resolveEmbedRequest(request);
    if (embed.kind === "invalid") {
      return NextResponse.json({ error: "嵌入链接已失效" }, { status: 401 });
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

  // The embed page validates its own token server-side. Proxy only adds the
  // product's frame-ancestors/Referrer policy so a valid link can be framed by
  // the approved parent origins; an invalid link renders the not-found page.
  if (pathname === "/embed" || pathname.startsWith("/embed/")) {
    const response = NextResponse.next();
    const token = embedTokenFromPath(pathname);
    const access = token ? resolveEmbedAccess(token) : null;
    if (access) {
      for (const [key, value] of Object.entries(embedResponseHeaders(access.profile))) {
        response.headers.set(key, value);
      }
    }
    return response;
  }

  // Relay agent downloads are curl-able installers (the pairing modal emits
  // `curl …/install.sh | sh`); they carry no secrets and are a fixed
  // allowlist of prebuilt binaries, so they stay public in both auth modes.
  const isRelayDownload = pathname.startsWith("/api/agent-relay/download/");

  // Share downloads are bearer-token URLs: the 128-bit token in the path is
  // the credential, so an MCP service (or any other device/browser) fetches
  // them WITHOUT a session cookie. Only the token GET is public — the audit
  // list, creation and revocation stay session-gated. Malformed tokens still
  // reach the route, which answers 404 instead of a misleading 401.
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

export const config = { matcher: ["/", "/embed", "/embed/:path*", "/api/:path*"] };
