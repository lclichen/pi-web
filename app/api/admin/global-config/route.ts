import { NextResponse } from "next/server";
import { requireAdminIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { platformGet, platformPut } from "@/lib/platform/client";
import { getPublicBaseUrl, getServerSettings, updateServerSettings } from "@/lib/server-settings";

export const dynamic = "force-dynamic";

/**
 * 全局配置（管理员）— 设置页「全局配置」分区的唯一后端：
 *   GET  /api/admin/global-config   对外地址 / SkillHub / 配置包上限 / 平台工作区上限
 *   PUT  /api/admin/global-config   { publicBaseUrl?, skillhubUrl?, bundleMaxMb?, workspaceMaxBytes? }
 *
 * 前两项与配置包上限落在 pi-web server-settings（立即生效，无需重启）；工作区
 * 单文件上限由平台执行，这里转调平台的 /api/v1/admin/limits（写 runtime-settings）。
 * 传 null 或空串表示清除覆盖：对外地址回到「按请求 Host 自动推断」（部署时若
 * 设置了 PI_WEB_PUBLIC_URL 则用其值），SkillHub 回到 skills.sh 公网流程。
 */

interface PlatformLimits {
  workspaceUploadMaxBytes: number;
  envDefaultBytes: number;
  minBytes: number;
  maxBytes: number;
}

interface GlobalConfigView {
  /** Configured/effective public base URL for absolute links; null = auto. */
  publicBaseUrl: string | null;
  /** Effective SkillHub base URL; null = skills.sh flow. */
  skillhubUrl: string | null;
  /** Config-bundle cap override in MB; null = deployment default. */
  bundleMaxMb: number | null;
  /** Workspace per-file cap from the platform; null when unreachable. */
  workspace: PlatformLimits | null;
}

async function readPlatformLimits(apiKey: string): Promise<PlatformLimits | null> {
  try {
    const view = await platformGet<PlatformLimits>("/api/v1/limits", apiKey);
    return typeof view.workspaceUploadMaxBytes === "number" ? view : null;
  } catch {
    return null;
  }
}

async function currentView(apiKey: string): Promise<GlobalConfigView> {
  const settings = getServerSettings();
  return {
    publicBaseUrl: getPublicBaseUrl() ?? null,
    skillhubUrl: settings.skillhubUrl ?? null,
    bundleMaxMb: settings.bundleUploadMaxMb ?? null,
    workspace: await readPlatformLimits(apiKey),
  };
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
  return NextResponse.json(await currentView(identity.session.apiKey), {
    headers: { "Cache-Control": "no-store" },
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
  let body: {
    publicBaseUrl?: unknown;
    skillhubUrl?: unknown;
    bundleMaxMb?: unknown;
    workspaceMaxBytes?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: {
    publicBaseUrl?: string;
    skillhubUrl?: string;
    bundleUploadMaxMb?: number | null;
  } = {};
  if (typeof body.publicBaseUrl === "string") patch.publicBaseUrl = body.publicBaseUrl;
  else if (body.publicBaseUrl === null) patch.publicBaseUrl = "";
  if (typeof body.skillhubUrl === "string") patch.skillhubUrl = body.skillhubUrl;
  else if (body.skillhubUrl === null) patch.skillhubUrl = "";
  if (body.bundleMaxMb === null) patch.bundleUploadMaxMb = null;
  else if (body.bundleMaxMb !== undefined) patch.bundleUploadMaxMb = Number(body.bundleMaxMb);

  if (Object.keys(patch).length > 0) {
    try {
      updateServerSettings(patch);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
  }

  if (body.workspaceMaxBytes !== undefined) {
    const value = body.workspaceMaxBytes === null ? null : Number(body.workspaceMaxBytes);
    if (value !== null && (!Number.isInteger(value) || value <= 0)) {
      return NextResponse.json({ error: "workspaceMaxBytes 必须是正整数或 null" }, { status: 400 });
    }
    try {
      await platformPut<PlatformLimits>("/api/v1/admin/limits", identity.session.apiKey, {
        workspaceUploadMaxBytes: value,
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: status && status >= 400 && status < 500 ? status : 502 },
      );
    }
  }

  return NextResponse.json(await currentView(identity.session.apiKey));
}
