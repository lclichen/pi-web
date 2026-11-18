import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { resolveSessionAccess } from "@/lib/session-access";
import { readSessionImage } from "@/lib/session-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/images/[imageId]
 *
 * Durable, content-addressed MCP/tool image. No TTL: the file lives as long as
 * the session. Same-origin `<img>` uses this with the session cookie (or an
 * embed token appended by withEmbedToken).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; imageId: string }> }) {
  const { id, imageId } = await params;
  const searchParams = new URL(req.url).searchParams;
  const access = await resolveSessionAccess(req, id, searchParams);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const image = readSessionImage(id, imageId);
  if (!image) return NextResponse.json({ error: "Image not found" }, { status: 404 });

  const stream = Readable.toWeb(createReadStream(image.path)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": image.meta.mimeType,
      "Content-Length": String(image.size),
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${imageId}.${image.meta.mimeType.split("/")[1] ?? "bin"}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
