import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { askAutoContinueTimeoutMs, getUserSettings, updateUserSettings } from "@/lib/user-settings";
import { refreshRpcAskTimeouts } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET/PUT /api/user-settings — settings scoped to the calling login
// (data/user-settings/u<id>.json). One user's switch never affects another's.
// GET also reports the deployment ask timeout so the UI can describe the
// switch with the real value instead of a hardcoded "5 minutes".
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });
  return NextResponse.json({
    ...getUserSettings(identity.session.user.id),
    askTimeoutMinutes: Math.round(askAutoContinueTimeoutMs() / 60_000),
  });
}

export async function PUT(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: 401 });
  let body: { askAutoContinue?: unknown };
  try {
    body = (await req.json()) as { askAutoContinue?: unknown };
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  const patch: { askAutoContinue?: boolean } = {};
  if (body.askAutoContinue !== undefined) {
    if (typeof body.askAutoContinue !== "boolean") {
      return NextResponse.json({ error: "askAutoContinue 必须是布尔值" }, { status: 400 });
    }
    patch.askAutoContinue = body.askAutoContinue;
  }
  const settings = updateUserSettings(identity.session.user.id, patch);
  // Pending dialogs re-arm immediately: turning the switch off cancels the
  // countdown of questions already waiting ("当前和后续提问会一直等待").
  refreshRpcAskTimeouts();
  return NextResponse.json({
    ...settings,
    askTimeoutMinutes: Math.round(askAutoContinueTimeoutMs() / 60_000),
  });
}
