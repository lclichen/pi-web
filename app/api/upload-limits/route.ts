import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { platformGet } from "@/lib/platform/client";
import { BUNDLE_UPLOAD_CONFIRM_MB, getBundleUploadMaxMb } from "@/lib/server-settings";

export const dynamic = "force-dynamic";

export interface WorkspaceUploadLimits {
  /** Effective per-file cap on the platform (bytes). */
  maxBytes: number;
  /** Env/config default the override replaces (bytes). */
  envDefaultBytes: number;
  minBytes: number;
  /** Hard ceiling the platform accepts from the admin API (bytes). */
  maxAllowedBytes: number;
}

export interface UploadLimitsResponse {
  /** pi-web config-bundle (.zip/.apkg) hard cap (MB). */
  bundleMaxMb: number;
  /** Above this size the browser asks for an explicit confirmation (MB). */
  bundleConfirmMb: number;
  /** Workspace per-file cap from the platform; null when unreachable. */
  workspace: WorkspaceUploadLimits | null;
}

// GET /api/upload-limits — limits every upload UI needs before streaming a
// file (display + early rejection). Bundle caps live in pi-web server
// settings; workspace caps come from the platform's runtime settings.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const bundleMaxMb = getBundleUploadMaxMb();
  let workspace: WorkspaceUploadLimits | null = null;
  if (identity.session.apiKey) {
    try {
      const limits = await platformGet<{
        workspaceUploadMaxBytes?: number;
        envDefaultBytes?: number;
        minBytes?: number;
        maxBytes?: number;
      }>("/api/v1/limits", identity.session.apiKey);
      if (typeof limits.workspaceUploadMaxBytes === "number") {
        workspace = {
          maxBytes: limits.workspaceUploadMaxBytes,
          envDefaultBytes: limits.envDefaultBytes ?? limits.workspaceUploadMaxBytes,
          minBytes: limits.minBytes ?? 1024 * 1024,
          maxAllowedBytes: limits.maxBytes ?? limits.workspaceUploadMaxBytes,
        };
      }
    } catch {
      // Platform unreachable — the UI falls back to the env default wording.
    }
  }
  const body: UploadLimitsResponse = { bundleMaxMb, bundleConfirmMb: BUNDLE_UPLOAD_CONFIRM_MB, workspace };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
