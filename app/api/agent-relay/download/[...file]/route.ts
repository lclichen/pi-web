import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/agent-relay/download/<name>
// Serves the prebuilt Go agent binaries and the install script from
// pi-web/agent/dist, enabling `curl …/install.sh | sh` installs. The name set
// is a fixed allowlist so the route can't be abused for arbitrary file reads.
const DIST_DIR = path.join(process.cwd(), "agent", "dist");

const SERVABLE = new Map<string, string>([
  ["pi-agent-linux-amd64", "application/octet-stream"],
  ["pi-agent-linux-arm64", "application/octet-stream"],
  ["install.sh", "text/x-shellscript; charset=utf-8"],
]);

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ file?: string[] }> },
): Promise<Response> {
  const { file } = await ctx.params;
  const name = Array.isArray(file) ? file.join("/") : "";

  if (!SERVABLE.has(name)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const abs = path.join(DIST_DIR, name);
  // Guard against any traversal despite the allowlist (defense in depth).
  const rel = path.relative(DIST_DIR, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let stats;
  try {
    stats = await stat(abs);
  } catch {
    return NextResponse.json(
      { error: "agent binary not built yet — run pi-web/agent/scripts/build.sh on a build host" },
      { status: 404 },
    );
  }

  const nodeStream = createReadStream(abs);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    headers: {
      "Content-Type": SERVABLE.get(name)!,
      "Content-Length": String(stats.size),
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
