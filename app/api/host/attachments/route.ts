import { NextResponse } from "next/server";
import { getAllowedFileRootsForRequest, isExistingFilePathAllowed } from "@/lib/file-access";
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
 */
async function allowedDirectory(req: Request): Promise<{ dir: string } | { response: NextResponse }> {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { response: NextResponse.json({ error: "登录已失效" }, { status: identity.status }) };
  const dir = new URL(req.url).searchParams.get("dir")?.trim() ?? "";
  if (!dir) return { response: NextResponse.json({ error: "dir is required" }, { status: 400 }) };
  const roots = await getAllowedFileRootsForRequest(req);
  if (!isExistingFilePathAllowed(dir, roots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { dir };
}

/** GET /api/host/attachments?dir=... — size of a Host directory's temp store. */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const allowed = await allowedDirectory(req);
  if ("response" in allowed) return allowed.response;
  const dir = projectAttachmentsDir(allowed.dir);
  return NextResponse.json({ ...measureAttachments(dir), dir });
}

/** DELETE /api/host/attachments?dir=... — remove a Host directory's temp store. */
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const allowed = await allowedDirectory(req);
  if ("response" in allowed) return allowed.response;
  const result = cleanAttachments(projectAttachmentsDir(allowed.dir));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ bytes: result.bytes, files: result.files });
}
