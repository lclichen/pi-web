import { NextResponse } from "next/server";
import { basename, resolve } from "node:path";
import { statSync } from "node:fs";
import { requireUserIdentity } from "@/lib/web-session";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getAllowedFileRootsForRequest, isExistingFilePathAllowed } from "@/lib/file-access";
import { isCallerSessionCwdAllowed } from "@/lib/session-cwd-access";
import { ensureProjectHome, getOwnedProject, projectHome } from "@/lib/projects";
import { getEmbedProfile } from "@/lib/embed-profiles";
import {
  createEmbedToken,
  EMBED_TOKEN_DEFAULT_TTL_MS,
  EMBED_TOKEN_MAX_TTL_MS,
  EMBED_TOKEN_MIN_TTL_MS,
  EmbedTokenLimitError,
  listEmbedTokens,
  pruneExpiredEmbedTokens,
} from "@/lib/embed-tokens";
import { platformDelete, platformPost, type PlatformApiKeyCreated } from "@/lib/platform/client";
import { requestOrigin } from "@/lib/request-origin";
import type { EmbedMode, EmbedScope } from "@/lib/embed-types";

export const dynamic = "force-dynamic";

const MAX_LABEL_LENGTH = 80;

interface TokenBody {
  projectId?: unknown;
  cwd?: unknown;
  productId?: unknown;
  ttlMinutes?: unknown;
  label?: unknown;
}

function revokePlatformKey(record: { apiKey: string; apiKeyId: number | string }): void {
  if (!record.apiKey) return;
  void platformDelete(`/api/v1/auth/api-keys/${encodeURIComponent(String(record.apiKeyId))}`, record.apiKey).catch(
    () => {
      // The token is already gone locally; an orphan key is best-effort cleanup.
    },
  );
}

// GET /api/embed/tokens — the caller's links (admins see all).
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  for (const expired of pruneExpiredEmbedTokens()) revokePlatformKey(expired);
  const tokens = listEmbedTokens({
    ownerId: identity.session.user.id,
    includeAll: identity.session.user.role === "admin",
  });
  return NextResponse.json({ tokens }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/embed/tokens — create a workspace-scoped embed link.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { user } = identity.session;

  let body: TokenBody;
  try {
    body = (await req.json()) as TokenBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  const profile = productId ? getEmbedProfile(productId) : undefined;
  if (!profile || !profile.enabled) {
    return NextResponse.json({ error: "产品不存在或未启用" }, { status: 400 });
  }

  const hasProject = typeof body.projectId === "string" && body.projectId.trim().length > 0;
  const hasCwd = typeof body.cwd === "string" && body.cwd.trim().length > 0;
  if (hasProject === hasCwd) {
    return NextResponse.json({ error: "projectId 或 cwd 必须二选一" }, { status: 400 });
  }

  let scope: EmbedScope;
  let allowedRoots: string[];
  let mode: EmbedMode;
  let label: string;

  if (hasProject) {
    if (user.id === 0) {
      return NextResponse.json({ error: "项目嵌入需要登录（多用户模式）" }, { status: 400 });
    }
    const project = getOwnedProject(String(body.projectId), user.id, user.role === "admin");
    if (!project || project.ownerId !== user.id) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }
    const home = ensureProjectHome(project);
    scope = { kind: "project", projectId: project.id, cwd: home };
    allowedRoots = [home];
    mode = project.mode;
    label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : project.name;
  } else {
    const requested = String(body.cwd).trim();
    const cwd = resolve(requested);
    try {
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${requested}` }, { status: 400 });
    }
    const roots = await getAllowedFileRootsForRequest(req);
    const permitted =
      user.id === 0 ||
      user.role === "admin" ||
      isExistingFilePathAllowed(cwd, roots) ||
      (await isCallerSessionCwdAllowed(req, cwd));
    if (!permitted) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    scope = { kind: "host", cwd };
    allowedRoots = [cwd];
    mode = "host";
    label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : basename(cwd);
  }

  label = label.slice(0, MAX_LABEL_LENGTH);

  let ttlMs = EMBED_TOKEN_DEFAULT_TTL_MS;
  if (body.ttlMinutes !== undefined) {
    if (typeof body.ttlMinutes !== "number" || !Number.isFinite(body.ttlMinutes)) {
      return NextResponse.json({ error: "ttlMinutes must be a number" }, { status: 400 });
    }
    ttlMs = body.ttlMinutes * 60_000;
    if (ttlMs < EMBED_TOKEN_MIN_TTL_MS || ttlMs > EMBED_TOKEN_MAX_TTL_MS) {
      return NextResponse.json(
        {
          error: `ttlMinutes must be between ${Math.ceil(EMBED_TOKEN_MIN_TTL_MS / 60_000)} and ${Math.floor(
            EMBED_TOKEN_MAX_TTL_MS / 60_000,
          )}`,
        },
        { status: 400 },
      );
    }
  }

  let apiKey = "";
  let apiKeyId: number | string = "";
  if (identity.session.apiKey) {
    try {
      const key = await platformPost<PlatformApiKeyCreated>("/api/v1/auth/api-keys", identity.session.apiKey, {
        name: `pi-web embed ${new Date().toISOString().slice(0, 10)}`,
      });
      apiKey = key.key;
      apiKeyId = key.id;
    } catch (error) {
      return NextResponse.json(
        { error: `创建嵌入凭证失败：${error instanceof Error ? error.message : String(error)}` },
        { status: 502 },
      );
    }
  }

  try {
    const { token, record } = createEmbedToken({
      owner: user,
      productId: profile.id,
      scope,
      allowedRoots,
      mode,
      label,
      apiKey,
      apiKeyId,
      ttlMs,
    });
    return NextResponse.json(
      {
        id: record.id,
        url: `${requestOrigin(req)}/embed/${token}`,
        expiresAt: record.expiresAt,
        product: { id: profile.id, name: profile.name },
        scope: record.scope,
        label: record.label,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (apiKey) revokePlatformKey({ apiKey, apiKeyId });
    if (error instanceof EmbedTokenLimitError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
