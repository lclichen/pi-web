import { NextResponse } from "next/server";
import { readFileSync, statSync } from "node:fs";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { streamLocalFile } from "@/lib/file-serve";
import { getPreviewMime } from "@/lib/file-types";
import { sliceByteRange } from "@/lib/http-range";
import {
  consumeShareDownload,
  dropShareByHash,
  hostShareStillFenced,
  lookupShare,
  revokeShare,
  shareSnapshotPath,
} from "@/lib/share-store";

export const dynamic = "force-dynamic";

/** Consumer-facing share headers: never cached, never referred onward. */
const SHARE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

function clientIp(req: Request): string | undefined {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return undefined;
}

/**
 * GET /api/share/<token> — the consumer side. NO cookie: the 128-bit token in
 * the URL is the credential (this is what MCP services fetch). Statuses:
 *   200/206 bytes · 404 不存在 · 410 过期/失效/次数用尽 · 416 Range · 500
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    return NextResponse.json({ error: "分享不存在" }, { status: 404, headers: SHARE_HEADERS });
  }

  const lookup = lookupShare(token);
  if (lookup.status === "missing") {
    return NextResponse.json({ error: "分享不存在" }, { status: 404, headers: SHARE_HEADERS });
  }
  if (lookup.status === "expired") {
    return NextResponse.json({ error: "分享已过期" }, { status: 410, headers: SHARE_HEADERS });
  }
  if (lookup.status === "exhausted") {
    return NextResponse.json({ error: "分享的下载次数已用尽" }, { status: 410, headers: SHARE_HEADERS });
  }
  const entry = lookup.entry;

  // Snapshot shares: bytes captured at creation; serve from the store file.
  if (entry.kind === "snapshot") {
    try {
      const bytes = readFileSync(shareSnapshotPath(entry));
      if (!consumeShareDownload(token, clientIp(req))) {
        return NextResponse.json({ error: "分享的下载次数已用尽" }, { status: 410, headers: SHARE_HEADERS });
      }
      const range = sliceByteRange(bytes, req.headers.get("range"));
      if (range) {
        return new Response(new Uint8Array(range.body), {
          status: 206,
          headers: {
            ...SHARE_HEADERS,
            "Content-Type": entry.mime ?? "application/octet-stream",
            "Content-Length": String(range.body.length),
            "Content-Range": range.contentRange,
            "Accept-Ranges": "bytes",
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(entry.fileName)}`,
          },
        });
      }
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          ...SHARE_HEADERS,
          "Content-Type": entry.mime ?? "application/octet-stream",
          "Content-Length": String(bytes.length),
          "Accept-Ranges": "bytes",
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(entry.fileName)}`,
        },
      });
    } catch {
      // Snapshot file vanished (manual cleanup / disk wipe): drop the entry.
      dropShareByHash(entry.tokenHash);
      return NextResponse.json({ error: "分享内容已失效" }, { status: 410, headers: SHARE_HEADERS });
    }
  }

  // Host shares: live read, re-fenced against the root that authorized it.
  if (!hostShareStillFenced(entry)) {
    dropShareByHash(entry.tokenHash);
    return NextResponse.json(
      { error: "分享已失效（文件被移动、删除或不再位于授权目录内）" },
      { status: 410, headers: SHARE_HEADERS },
    );
  }
  let stat;
  try {
    stat = statSync(entry.hostPath!);
  } catch {
    return NextResponse.json({ error: "文件已被删除" }, { status: 404, headers: SHARE_HEADERS });
  }
  if (!consumeShareDownload(token, clientIp(req))) {
    return NextResponse.json({ error: "分享的下载次数已用尽" }, { status: 410, headers: SHARE_HEADERS });
  }
  const mime = getPreviewMime(entry.hostPath!) ?? "application/octet-stream";
  const download = new URL(req.url).searchParams.get("download") === "1";
  return streamLocalFile(entry.hostPath!, stat, mime, req.headers.get("range"), download, SHARE_HEADERS);
}

// DELETE /api/share/<token> — revoke early (creator or admin; cookie auth).
export async function DELETE(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  const { user } = identity.session;
  const { token } = await params;
  const result = revokeShare(token, { ownerId: user.id, isAdmin: user.role === "admin" });
  if (result === "missing") return NextResponse.json({ error: "分享不存在" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "只能撤销自己的分享" }, { status: 403 });
  return NextResponse.json({ success: true });
}
