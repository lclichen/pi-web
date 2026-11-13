import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

/** Chat attachments for a project live in the Host project home; they are
 *  runtime temp files (mirrored per session), never configuration. */
export function projectAttachmentsDir(projectHomePath: string): string {
  return join(projectHomePath, ".pi", "attachments");
}

export interface AttachmentsStats {
  bytes: number;
  files: number;
}

/**
 * Store one attachment atomically: write a sibling temp file, then rename it
 * over the target. Readers see either the previous complete file or the new
 * complete file — never a half-written one. Unlike the old `wx` write this
 * REPLACES an existing file: the Host copy is the primary of the bytes the
 * user just uploaded, so a stale leftover must not win.
 */
export function writeAttachmentAtomic(dir: string, name: string, bytes: Buffer): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  const temp = join(dir, `.upload-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temp, bytes);
    try {
      renameSync(temp, target);
    } catch (err) {
      // Windows rename does not always replace an existing destination.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
        unlinkSync(target);
        renameSync(temp, target);
      } else {
        throw err;
      }
    }
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // temp already moved or never created
    }
    throw err;
  }
}

/** Recursively sum the attachment store. Missing dir = empty. */
export function measureAttachments(dir: string): AttachmentsStats {
  const stats: AttachmentsStats = { bytes: 0, files: 0 };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return stats;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile()) {
      try {
        stats.bytes += lstatSync(full).size;
        stats.files += 1;
      } catch {
        // vanished mid-walk — ignore
      }
    } else if (entry.isDirectory()) {
      const nested = measureAttachments(full);
      stats.bytes += nested.bytes;
      stats.files += nested.files;
    }
  }
  return stats;
}

export type CleanAttachmentsResult =
  | { ok: true; bytes: number; files: number }
  | { ok: false; error: string };

/**
 * Remove the attachment store. Refuses a symlinked/replaced directory so a
 * tampered project home cannot redirect the delete outside the store.
 */
export function cleanAttachments(dir: string): CleanAttachmentsResult {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return { ok: true, bytes: 0, files: 0 };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { ok: false, error: "临时文件目录不可清理" };
  }
  const stats = measureAttachments(dir);
  rmSync(dir, { recursive: true, force: true });
  return { ok: true, ...stats };
}
