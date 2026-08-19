import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "@/lib/web-auth";
import { WEB_SESSION_COOKIE } from "@/lib/web-session";

function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.get(WEB_SESSION_COOKIE)?.value !== undefined;
}

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

  // Multi-user mode: API routes carry their own session validation (the
  // session store lives outside the middleware runtime); here we enforce a
  // cheap cookie presence check so anonymous traffic never reaches route
  // handlers, and bounce anonymous page loads to the login screen.
  if (process.env.PI_WEB_AUTH === "on") {
    const isWebAuthRoute = pathname.startsWith("/api/webauth/");
    if (!isWebAuthRoute && !hasSessionCookie(request)) {
      if (isApiRequest) {
        return NextResponse.json({ error: "登录已失效" }, { status: 401 });
      }
      return NextResponse.redirect(new URL("/login", request.url));
    }
    return NextResponse.next();
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (
    isWebPasswordEnabled(password)
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
