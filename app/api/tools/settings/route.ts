import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  isPowerShellToolEnabled,
  readPowerShellToolEnabled,
  replaceShellTool,
  writePowerShellToolEnabled,
} from "@/lib/powershell-settings";
import { createUserSettingsManager, updateUserAgentSettings } from "@/lib/user-settings-storage";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

const BASE_TOOLS = ["read", "bash", "edit", "write"];

async function userPowerShellEnabled(userId: number): Promise<boolean> {
  const manager = createUserSettingsManager(process.cwd(), userId);
  return isPowerShellToolEnabled(manager.getDefaultTools());
}

// GET /api/tools/settings[?scope=global]
// Default = the calling user's preference; scope=global is the admin default.
export async function GET(req: Request) {
  try {
    const identity = requireUserIdentity(req);
    if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
    const user = identity.session.user;
    const globalScope = new URL(req.url).searchParams.get("scope") === "global";
    if (globalScope && user.id !== 0 && user.role !== "admin") {
      return NextResponse.json({ error: "全局工具设置仅管理员可查看" }, { status: 403 });
    }
    return NextResponse.json({
      isWindows: process.platform === "win32",
      powerShellEnabled: globalScope ? await readPowerShellToolEnabled() : await userPowerShellEnabled(user.id),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// PUT /api/tools/settings { enabled, scope?: "user" | "global" }
// "user" is the default and never changes the global defaultTools.
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  if (process.platform !== "win32") {
    return NextResponse.json({ error: "PowerShell tool settings are only available on Windows" }, { status: 404 });
  }

  try {
    const identity = requireUserIdentity(req);
    if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
    const user = identity.session.user;
    const body = (await req.json()) as { enabled?: unknown; scope?: unknown };
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    const globalScope = body.scope === "global";
    if (globalScope) {
      if (user.id !== 0 && user.role !== "admin") {
        return NextResponse.json({ error: "全局工具设置仅管理员可修改" }, { status: 403 });
      }
      return NextResponse.json({
        isWindows: true,
        powerShellEnabled: await writePowerShellToolEnabled(body.enabled),
      });
    }

    const manager = createUserSettingsManager(process.cwd(), user.id);
    const current = manager.getDefaultTools() ?? BASE_TOOLS;
    let next = replaceShellTool(current, body.enabled);
    if (!current.some((name) => name === "bash" || name === "powershell")) {
      next = [...next, body.enabled ? "powershell" : "bash"];
    }
    if (user.id > 0) updateUserAgentSettings(user.id, { defaultTools: next });
    else await writePowerShellToolEnabled(body.enabled);
    return NextResponse.json({ isWindows: true, powerShellEnabled: body.enabled });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
