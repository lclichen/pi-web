import { join } from "path";
import { NextResponse } from "next/server";
import { getAllowedFileRootsForRequest, isExistingFilePathAllowed } from "@/lib/file-access";
import { dataDir } from "@/lib/mode-homes";
import { samePath } from "@/lib/paths";
import {
  cleanAttachments,
  measureAttachments,
  projectAttachmentsDir,
} from "@/lib/project-attachments";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * Host-directory temp attachments (`<dir>/.pi/attachments`) for the sidebar's
 * directory menu. The dir must be an existing path inside the caller's
 * file-access roots (admin/host space) — the same fence the file API uses.
 * Exception: dir may be the caller's own no-project attachment bucket root
 * (`dataDir()/attachments/u<id>`), which lives outside every file-access root
 * but is only reachable for the caller's own user id.
 */
async function allowedDirectory(
  req: Request,
): Promise<{ dir: string; store: string } | { response: NextResponse }> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { response: NextResponse.json({ error: "登录已失效" }, { status: identity.status }) };
  const dir = new URL(req.url).searchParams.get("dir")?.trim() ?? "";
  if (!dir) return { response: NextResponse.json({ error: "dir is required" }, { status: 400 }) };
  // 无项目绑定的远端会话附件不在任何 Host 目录，而在
  // dataDir()/attachments/u<id>/<sessionId>（hostAttachmentsDir 的回退分支），
  // file-access roots 够不到，两个清理入口都漏掉它们。这里仅放行本人的
  // u<id> 桶根，且桶根本身就是存储根（不再追加 .pi/attachments）。
  const userBucket = join(dataDir(), "attachments", `u${identity.session.user.id}`);
  if (samePath(dir, userBucket)) return { dir, store: dir };
  const roots = await getAllowedFileRootsForRequest(req);
  if (!isExistingFilePathAllowed(dir, roots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { dir, store: projectAttachmentsDir(dir) };
}

/** GET /api/host/attachments?dir=... — size of a Host directory's temp store. */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const allowed = await allowedDirectory(req);
  if ("response" in allowed) return allowed.response;
  return NextResponse.json({ ...measureAttachments(allowed.store), dir: allowed.dir });
}

/** DELETE /api/host/attachments?dir=... — remove a Host directory's temp store. */
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const allowed = await allowedDirectory(req);
  if ("response" in allowed) return allowed.response;
  const result = cleanAttachments(allowed.store);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ bytes: result.bytes, files: result.files });
}
