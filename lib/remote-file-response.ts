import { getContentDisposition } from "./file-serve.ts";
import { getPreviewMime } from "./file-types.ts";
import { sliceByteRange } from "./http-range.ts";

/**
 * Remote file responses: downloads must always carry raw bytes — the JSON text
 * read decodes UTF-8 and corrupts binaries such as .zip. Reads only stream
 * bytes for previewable media/documents and fall back to the text read
 * otherwise (the file viewer needs JSON).
 */
export function shouldServeRemoteBytes(type: string, filePath: string): boolean {
  return type === "download" || getPreviewMime(filePath) !== null;
}

/** Raw-byte remote response with the same mime/range/disposition contract as /api/files. */
export function remoteBytesResponse(
  type: string,
  filePath: string,
  bytes: Buffer,
  rangeHeader: string | null,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": getPreviewMime(filePath) ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (type === "download") {
    headers["Content-Disposition"] = getContentDisposition(filePath, true);
  }
  const ranged = sliceByteRange(bytes, rangeHeader);
  if (ranged) {
    headers["Content-Range"] = ranged.contentRange;
    headers["Content-Length"] = String(ranged.body.length);
    return new Response(new Uint8Array(ranged.body), { status: 206, headers });
  }
  headers["Content-Length"] = String(bytes.length);
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
