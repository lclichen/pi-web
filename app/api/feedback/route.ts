import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

/**
 * Thin proxy in front of the AI gateway's feedback store
 * (docs/dev/feedback-api.md). The gateway trusts this proxy to assert the
 * user — browsers never talk to the gateway directly, so their (potentially
 * spoofed) `user` field is dropped and re-stamped from the web session.
 *
 * POST /api/feedback          — any logged-in user, batch ≤50, gateway-validated
 * GET  /api/feedback          — admin-only passthrough of the gateway's
 *                               full JSONL export
 *
 * Transport failures answer `{"accepted":[]}` with 5xx so the client keeps
 * its outbox and retries on the next verdict.
 */

export const dynamic = "force-dynamic";

/** Base URL of the agentgateway admin/UI port, e.g. http://127.0.0.1:4001.
 * Read per request so config changes apply without a re-import. */
function gatewayBase(): string | null {
  return process.env.AGENTGATEWAY_URL?.trim().replace(/\/+$/, "") || null;
}
/** Same limit the gateway enforces — reject before forwarding. */
const MAX_BATCH = 50;

function gatewayUrl(path: string): string | null {
  const base = gatewayBase();
  return base ? `${base}${path}` : null;
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  const body = (await req.json().catch(() => null)) as { feedback?: unknown } | null;
  if (!body || !Array.isArray(body.feedback) || body.feedback.length === 0) {
    return NextResponse.json({ error: "feedback array required" }, { status: 400 });
  }
  if (body.feedback.length > MAX_BATCH) {
    return NextResponse.json({ error: `feedback batch exceeds the maximum of ${MAX_BATCH}` }, { status: 400 });
  }
  const url = gatewayUrl("/api/feedback");
  if (!url) return NextResponse.json({ accepted: [] }, { status: 503 });
  // The gateway column is `username`; pi-web's login name fits it directly.
  const user = identity.session.user.username || `u${identity.session.user.id}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, feedback: body.feedback }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ accepted: [] }, { status: 502 });
  }
  // 2xx/4xx pass through verbatim; a gateway 5xx is a transport failure for
  // the client, so answer the outbox contract instead of leaking its body.
  if (res.status >= 500) return NextResponse.json({ accepted: [] }, { status: 502 });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (identity.session.user.id !== 0 && identity.session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可以导出反馈数据" }, { status: 403 });
  }
  const url = gatewayUrl("/api/feedback/export");
  if (!url) return NextResponse.json({ error: "AGENTGATEWAY_URL 未配置" }, { status: 503 });

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch {
    return NextResponse.json({ error: "无法连接 AI Gateway" }, { status: 502 });
  }
  if (!res.ok && !res.body) {
    return NextResponse.json({ error: "AI Gateway 导出失败" }, { status: 502 });
  }
  return new NextResponse(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/x-ndjson" },
  });
}
