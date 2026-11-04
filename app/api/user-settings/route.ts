import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import {
  askAutoContinueTimeoutMs,
  getUserSettings,
  updateUserSettings,
  type UserSettingsUi,
} from "@/lib/user-settings";
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
  let body: { askAutoContinue?: unknown; ui?: unknown };
  try {
    body = (await req.json()) as { askAutoContinue?: unknown; ui?: unknown };
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  const patch: { askAutoContinue?: boolean; ui?: UserSettingsUi } = {};
  if (body.askAutoContinue !== undefined) {
    if (typeof body.askAutoContinue !== "boolean") {
      return NextResponse.json({ error: "askAutoContinue 必须是布尔值" }, { status: 400 });
    }
    patch.askAutoContinue = body.askAutoContinue;
  }
  if (body.ui !== undefined) {
    if (body.ui === null || typeof body.ui !== "object" || Array.isArray(body.ui)) {
      return NextResponse.json({ error: "ui 必须是对象" }, { status: 400 });
    }
    const raw = body.ui as Record<string, unknown>;
    const ui: UserSettingsUi = {};
    if (raw.theme !== undefined) {
      if (raw.theme !== "light" && raw.theme !== "dark" && raw.theme !== "auto") {
        return NextResponse.json({ error: "ui.theme 无效" }, { status: 400 });
      }
      ui.theme = raw.theme;
    }
    if (raw.locale !== undefined) {
      if (typeof raw.locale !== "string" || raw.locale.length > 32) {
        return NextResponse.json({ error: "ui.locale 无效" }, { status: 400 });
      }
      ui.locale = raw.locale;
    }
    if (raw.chatWidth !== undefined) {
      if (typeof raw.chatWidth !== "number" || !Number.isFinite(raw.chatWidth) || raw.chatWidth < 400 || raw.chatWidth > 4000) {
        return NextResponse.json({ error: "ui.chatWidth 无效" }, { status: 400 });
      }
      ui.chatWidth = Math.round(raw.chatWidth);
    }
    if (raw.chatFontSize !== undefined) {
      if (
        typeof raw.chatFontSize !== "number" ||
        !Number.isFinite(raw.chatFontSize) ||
        raw.chatFontSize < 8 ||
        raw.chatFontSize > 48
      ) {
        return NextResponse.json({ error: "ui.chatFontSize 无效" }, { status: 400 });
      }
      ui.chatFontSize = Math.round(raw.chatFontSize);
    }
    if (raw.thinkingExpanded !== undefined) {
      if (typeof raw.thinkingExpanded !== "boolean") {
        return NextResponse.json({ error: "ui.thinkingExpanded 无效" }, { status: 400 });
      }
      ui.thinkingExpanded = raw.thinkingExpanded;
    }
    if (raw.quoteSelection !== undefined) {
      if (typeof raw.quoteSelection !== "boolean") {
        return NextResponse.json({ error: "ui.quoteSelection 无效" }, { status: 400 });
      }
      ui.quoteSelection = raw.quoteSelection;
    }
    patch.ui = ui;
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
