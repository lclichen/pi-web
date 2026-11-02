import { NextResponse } from "next/server";
import { statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { getAllowedFileRootsForRequest } from "@/lib/file-access";
import { allowedRootsWithSessionCwds } from "@/lib/session-cwd-access";
import { resolveSessionAccess } from "@/lib/session-access";
import { resolveRemoteSession, remoteReadBinary } from "@/lib/remote-session";
import { getPreviewMime } from "@/lib/file-types";
import { getPublicBaseUrl } from "@/lib/server-settings";
import { createShare, listShares, SHARE_MAX_BYTES, ShareLimitError } from "@/lib/share-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/share — create a one-file share link (docs/dev/mcp-file-sharing.md).
 *
 *   { path, srcSession?, ttlMinutes?=30, maxDownloads?=10, oneTime? }
 *   → { url, token, expiresAt, downloads: 0, path, kind }
 *
 * Two payload kinds:
 *   · host file (no srcSession): live share — path must exist inside the
 *     caller's allowed roots; GET re-reads it, re-fenced against the recorded
 *     authorizing root.
 *   · remote session file (srcSession): SNAPSHOT share — bytes are captured
 *     now through the remotefs bridge (requires the session to be online at
 *     creation); the link keeps working after the container/agent goes away.
 *
 * Browser-session API (cookie + CSRF guard). Agents use the share_file tool,
 * which calls the same store in-process.
 */

function originOf(req: Request): string {
  // 管理员配置的对外地址（含 PI_WEB_PUBLIC_URL 播种）> 按请求 Host 推断。
  const configured = getPublicBaseUrl();
  if (configured) return configured;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  return `${proto}://${host}`;
}

/** Find the allowed root that contains `abs` (longest match wins). */
function authorizingRoot(abs: string, roots: Set<string>): string | null {
  let best: string | null = null;
  for (const root of roots) {
    const r = resolve(root);
    const contained = abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep);
    if (contained && (best === null || r.length > best.length)) best = r;
  }
  return best;
}

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

  let body: {
    path?: unknown;
    srcSession?: unknown;
    ttlMinutes?: unknown;
    maxDownloads?: unknown;
    oneTime?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  const srcSession = typeof body.srcSession === "string" && body.srcSession ? body.srcSession : undefined;
  const fileName = basename(path.replace(/\\/g, "/")) || "file";

  try {
    if (srcSession) {
      // Remote file: ownership fence, then snapshot the bytes NOW.
      const access = await resolveSessionAccess(req, srcSession);
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      const remote = await resolveRemoteSession(req, srcSession);
      if (!remote.ok) {
        return NextResponse.json({ error: remote.error }, { status: remote.status });
      }
      // remotefs semantics: "/x" = workspace root; bare relative also works.
      const normalized = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) ? path : `/${path}`;
      let bytes: Buffer;
      try {
        bytes = (await remoteReadBinary(remote.ctx, normalized)).bytes;
      } catch (e) {
        return NextResponse.json(
          { error: `读取远程文件失败：${e instanceof Error ? e.message : String(e)}` },
          { status: 502 },
        );
      }
      if (bytes.length === 0) return NextResponse.json({ error: "文件为空" }, { status: 400 });
      if (bytes.length > SHARE_MAX_BYTES) {
        return NextResponse.json(
          { error: `文件过大（${bytes.length} 字节 > 上限 ${SHARE_MAX_BYTES}）` },
          { status: 413 },
        );
      }
      const { token, entry } = createShare({
        path,
        fileName,
        ownerId: user.id,
        ownerName: user.username,
        srcSession,
        ...(typeof body.ttlMinutes === "number" ? { ttlMinutes: body.ttlMinutes } : {}),
        ...(typeof body.maxDownloads === "number" ? { maxDownloads: body.maxDownloads } : {}),
        ...(body.oneTime === true ? { oneTime: true } : {}),
        snapshot: { bytes, mime: getPreviewMime(path) ?? "application/octet-stream" },
      });
      return NextResponse.json(
        {
          url: `${originOf(req)}/api/share/${token}`,
          token,
          expiresAt: new Date(entry.expiresAt).toISOString(),
          downloads: 0,
          maxDownloads: entry.maxDownloads,
          path,
          kind: "snapshot",
        },
        { status: 201 },
      );
    }

    // Host file: live share within the caller's allowed roots.
    if (!isAbsolute(path) && !/^[a-zA-Z]:[\\/]/.test(path)) {
      return NextResponse.json({ error: "path must be absolute (host shares)" }, { status: 400 });
    }
    const allowedRoots = await allowedRootsWithSessionCwds(req, await getAllowedFileRootsForRequest(req));
    const abs = resolve(path);
    const root = authorizingRoot(abs, allowedRoots);
    if (!root) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }
    if (!stat.isFile()) return NextResponse.json({ error: "只能分享文件" }, { status: 400 });
    if (stat.size > SHARE_MAX_BYTES) {
      return NextResponse.json({ error: `文件过大（> ${SHARE_MAX_BYTES} 字节）` }, { status: 413 });
    }
    const { token, entry } = createShare({
      path,
      fileName,
      ownerId: user.id,
      ownerName: user.username,
      ...(typeof body.ttlMinutes === "number" ? { ttlMinutes: body.ttlMinutes } : {}),
      ...(typeof body.maxDownloads === "number" ? { maxDownloads: body.maxDownloads } : {}),
      ...(body.oneTime === true ? { oneTime: true } : {}),
      host: { hostPath: abs, hostRoot: root, size: stat.size },
    });
    return NextResponse.json(
      {
        url: `${originOf(req)}/api/share/${token}`,
        token,
        expiresAt: new Date(entry.expiresAt).toISOString(),
        downloads: 0,
        maxDownloads: entry.maxDownloads,
        path,
        kind: "host",
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ShareLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// GET /api/share — audit list (admin: all; user: own). Tokens are stored
// hashed, so the list identifies shares by hash prefix only.
export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { user } = identity.session;
  const shares = listShares({ ownerId: user.id, isAdmin: user.role === "admin" }).map((e) => ({
    id: e.tokenHash.slice(0, 10),
    path: e.path,
    kind: e.kind,
    size: e.size,
    fileName: e.fileName,
    ...(e.srcSession ? { srcSession: e.srcSession } : {}),
    owner: e.ownerName,
    ...(e.sessionId ? { sessionId: e.sessionId } : {}),
    createdAt: new Date(e.createdAt).toISOString(),
    expiresAt: new Date(e.expiresAt).toISOString(),
    downloads: e.downloads,
    maxDownloads: e.maxDownloads,
    ...(e.lastDownloadAt ? { lastDownloadAt: new Date(e.lastDownloadAt).toISOString() } : {}),
    ...(e.lastIp ? { lastIp: e.lastIp } : {}),
  }));
  return NextResponse.json({ shares }, { headers: { "Cache-Control": "no-store" } });
}
