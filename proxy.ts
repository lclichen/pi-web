import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "@/lib/web-auth";
import { getWebSession } from "@/lib/web-session";

// Next 16 runs the proxy (middleware) on the Node.js runtime, so it can read
// the real session store — not just cookie presence. This is the central
// anonymous gate for EVERY /api route; per-route requireUserIdentity calls
// remain as defense in depth and to resolve per-user ownership.

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // Relay agent downloads are curl-able installers (the pairing modal emits
  // `curl …/install.sh | sh`); they carry no secrets and are a fixed
  // allowlist of prebuilt binaries, so they stay public in both auth modes.
  const isRelayDownload = pathname.startsWith("/api/agent-relay/download/");

  // Batch test API authenticates with X-Platform-API-Key (sk_...), validated
  // against the platform inside the routes (requireBatchIdentity: key →
  // /auth/me → admin role). Without this bypass the session gate rejects
  // headless callers before the route ever runs. This is only a FORMAT
  // pre-check — the route's own validation remains the authority.
  const hasBatchPlatformKey = pathname.startsWith("/api/batch/")
    && (() => {
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
    if (!isRelayDownload && !isWebAuthRoute && !hasBatchPlatformKey) {
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
    !isRelayDownload
    && !hasBatchPlatformKey
    && isWebPasswordEnabled(password)
    && !isValidBasicAuthorization(request.headers.get("authorization"), password)
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

export const config = { matcher: ["/", "/api/:path*"] };
