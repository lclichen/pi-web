import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/agent-relay/download/<name>
// Serves the prebuilt agent-client binaries and the install script from
// pi-web/agent/dist, enabling `curl …/install.sh | sh` installs and the
// WebUI's "download + run" flow. The name set is a fixed allowlist so the
// route can't be abused for arbitrary file reads.
const DIST_DIR = path.join(process.cwd(), "agent", "dist");
const BINARY = "application/octet-stream";

interface Asset {
  /** File on disk (dist/<file>). */
  file: string;
  type: string;
}

const SERVABLE = new Map<string, Asset>([
  ["agent-client-linux-amd64", { file: "agent-client-linux-amd64", type: BINARY }],
  ["agent-client-linux-arm64", { file: "agent-client-linux-arm64", type: BINARY }],
  ["agent-client-darwin-amd64", { file: "agent-client-darwin-amd64", type: BINARY }],
  ["agent-client-darwin-arm64", { file: "agent-client-darwin-arm64", type: BINARY }],
  ["agent-client-windows-amd64.exe", { file: "agent-client-windows-amd64.exe", type: BINARY }],
  // Legacy pi-agent URLs (pre-0.3 installs / cached commands) serve the same
  // binaries so old instructions keep working after the rename.
  ["pi-agent-linux-amd64", { file: "agent-client-linux-amd64", type: BINARY }],
  ["pi-agent-linux-arm64", { file: "agent-client-linux-arm64", type: BINARY }],
  ["pi-agent-windows-amd64.exe", { file: "agent-client-windows-amd64.exe", type: BINARY }],
  ["install.sh", { file: "install.sh", type: "text/x-shellscript; charset=utf-8" }],
]);

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ file?: string[] }> },
): Promise<Response> {
  const { file } = await ctx.params;
  const name = Array.isArray(file) ? file.join("/") : "";

  const asset = SERVABLE.get(name);
  if (!asset) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const abs = path.join(DIST_DIR, asset.file);
  // Guard against any traversal despite the allowlist (defense in depth).
  const rel = path.relative(DIST_DIR, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let stats;
  let data: Buffer;
  try {
    stats = await stat(abs);
    data = await readFile(abs);
  } catch {
    return NextResponse.json(
      { error: "agent-client binary not built yet — run pi-web/agent/scripts/build.sh on a build host" },
      { status: 404 },
    );
  }

  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": asset.type,
      "Content-Length": String(data.byteLength || stats.size),
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${asset.file}"`,
    },
  });
}
