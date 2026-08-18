import { execFile } from "child_process";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { TEXT_PREVIEW_MAX_BYTES } from "@/lib/file-types";
import path from "path";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

// GET /api/git/file?cwd=&path= — the HEAD blob of a file, as the "original"
// side of the Monaco diff view. Returns content: null when the file is not
// tracked in HEAD (untracked or newly added), which renders the whole file
// as added on the diff.
export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const filePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    // The file itself may be deleted from the working tree (deleted-file
    // diff) — only require that it would be inside the repo's tree when it
    // existed, which git enforces by rejecting paths that escape the repo.
    if (!isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const repoRoot = (await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: 10_000,
      env: { ...process.env, LC_ALL: "C" },
    })).stdout.trim();
    if (!repoRoot) {
      return NextResponse.json({ content: null });
    }
    // A path outside the repository cannot have a HEAD blob.
    const rel = path.relative(path.resolve(repoRoot), path.resolve(filePath));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return NextResponse.json({ content: null });
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", cwd, "show", `HEAD:${rel.split(path.sep).join("/")}`],
        {
          timeout: 10_000,
          maxBuffer: TEXT_PREVIEW_MAX_BYTES + 64 * 1024,
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
        },
      );
      return NextResponse.json({ content: stdout });
    } catch {
      // Not in HEAD (untracked, added, or any git error) — diff shows all-added.
      return NextResponse.json({ content: null });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
