import { NextResponse } from "next/server";
import { getOwnedProject, projectHome } from "@/lib/projects";
import {
  cleanAttachments,
  measureAttachments,
  projectAttachmentsDir,
} from "@/lib/project-attachments";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

function own(req: Request, id: string) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { error: NextResponse.json({ error: "登录已失效" }, { status: identity.status }) };
  const project = getOwnedProject(id, identity.session.user.id, identity.session.user.role === "admin");
  if (!project) return { error: NextResponse.json({ error: "项目不存在" }, { status: 404 }) };
  return { project };
}

/** GET /api/projects/:id/attachments — size of the Host temp-file store. */
export async function GET(req: Request, ctx: RouteCtx) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const r = own(req, id);
  if (r.error) return r.error;
  const dir = projectAttachmentsDir(projectHome(r.project));
  return NextResponse.json({ ...measureAttachments(dir), dir });
}

/** DELETE /api/projects/:id/attachments — remove the Host temp-file store. */
export async function DELETE(req: Request, ctx: RouteCtx) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const r = own(req, id);
  if (r.error) return r.error;
  const result = cleanAttachments(projectAttachmentsDir(projectHome(r.project)));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ bytes: result.bytes, files: result.files });
}
