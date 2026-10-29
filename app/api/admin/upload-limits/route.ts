import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { platformGet, platformPut } from "@/lib/platform/client";
import { getServerSettings, updateServerSettings } from "@/lib/server-settings";

export const dynamic = "force-dynamic";

/**
 * 上传限制（管理员）：
 *   GET  /api/admin/upload-limits   当前有效值（配置包上限 + 平台工作区上限）
 *   PUT  /api/admin/upload-limits   { bundleMaxMb?, workspaceMaxBytes? }
 *
 * 配置包上限落在 pi-web 的 server-settings（立即生效）；工作区单文件上限由
 * 平台执行，这里转调平台的 /api/v1/admin/limits（写 runtime-settings，无需重启）。
 * 传 null 表示清除覆盖、回到默认。
 */

interface PlatformLimits {
  workspaceUploadMaxBytes: number;
  envDefaultBytes: number;
  minBytes: number;
  maxBytes: number;
}

async function readPlatformLimits(apiKey: string): Promise<PlatformLimits | null> {
  try {
    const view = await platformGet<PlatformLimits>("/api/v1/limits", apiKey);
    return typeof view.workspaceUploadMaxBytes === "number" ? view : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.status === 403 ? "仅管理员可用" : "登录已失效" },
      { status: identity.status },
    );
  }
  const workspace = await readPlatformLimits(identity.session.apiKey);
  return NextResponse.json({
    bundleMaxMb: getServerSettings().bundleUploadMaxMb ?? null,
    workspace,
  });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireAdminIdentity(req);
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.status === 403 ? "仅管理员可用" : "登录已失效" },
      { status: identity.status },
    );
  }
  let body: { bundleMaxMb?: unknown; workspaceMaxBytes?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    if (body.bundleMaxMb !== undefined) {
      updateServerSettings({
        bundleUploadMaxMb: body.bundleMaxMb === null ? null : Number(body.bundleMaxMb),
      });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  let workspace: PlatformLimits | null = null;
  if (body.workspaceMaxBytes !== undefined) {
    const value = body.workspaceMaxBytes === null ? null : Number(body.workspaceMaxBytes);
    if (value !== null && (!Number.isInteger(value) || value <= 0)) {
      return NextResponse.json({ error: "workspaceMaxBytes 必须是正整数或 null" }, { status: 400 });
    }
    try {
      workspace = await platformPut<PlatformLimits>("/api/v1/admin/limits", identity.session.apiKey, {
        workspaceUploadMaxBytes: value,
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: status && status >= 400 && status < 500 ? status : 502 },
      );
    }
  } else {
    workspace = await readPlatformLimits(identity.session.apiKey);
  }
  return NextResponse.json({
    bundleMaxMb: getServerSettings().bundleUploadMaxMb ?? null,
    workspace,
  });
}
