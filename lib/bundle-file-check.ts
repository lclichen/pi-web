import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Structural zip check for large streamed bundle uploads.
 *
 * JSZip.loadAsync needs the whole archive in memory; the streaming upload
 * path exists precisely to avoid that. For big files we validate structure
 * instead: local-file-header magic at offset 0 plus an End-of-Central-
 * Directory record in the tail (zip comments are ≤ 64 KiB). A structurally
 * corrupt archive can still slip through — inspect/apply then reports the
 * concrete error — but truncation and wrong-format files are caught here.
 */
export function verifyZipStructure(path: string): { ok: true } | { ok: false; reason: string } {
  const size = statSync(path).size;
  if (size < 22) return { ok: false, reason: "压缩包过小或已截断" };
  const head = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 4, 0);
    const local = head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const empty = head.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (!local && !empty) return { ok: false, reason: "不是有效的 zip 压缩包" };
    const tailLen = Math.min(size, 65557 + 4);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    if (!tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) {
      return { ok: false, reason: "压缩包缺少中央目录（可能已截断）" };
    }
    return { ok: true };
  } finally {
    closeSync(fd);
  }
}
