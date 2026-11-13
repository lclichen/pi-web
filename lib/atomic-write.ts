import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Atomic file replacement: write a sibling temp file, then rename over the
 * target. A crash or write failure never leaves a half-written file at `path`;
 * readers see either the previous complete file or the new complete file.
 *
 * Used by project config sync/rollback and the Host copy of chat attachments
 * so concurrent readers (ResourceLoader, share_file, projection) never observe
 * a partial file.
 */

export type AtomicWriteContent = string | Uint8Array;

function tempPath(target: string): string {
  return join(dirname(target), `.tmp-${process.pid}-${randomUUID()}`);
}

function renameReplacingSync(temp: string, target: string): void {
  try {
    renameSync(temp, target);
  } catch (err) {
    // Windows rename does not always replace an existing destination.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
      unlinkSync(target);
      renameSync(temp, target);
      return;
    }
    throw err;
  }
}

async function renameReplacing(temp: string, target: string): Promise<void> {
  try {
    await rename(temp, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
      await unlink(target);
      await rename(temp, target);
      return;
    }
    throw err;
  }
}

/** Create parent directories, then atomically write `content` to `path`. */
export function atomicWriteFileSync(path: string, content: AtomicWriteContent, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = tempPath(path);
  try {
    writeFileSync(temp, content, { mode });
    renameReplacingSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // temp already moved or never created
    }
    throw err;
  }
}

/** Async variant for route handlers and plan/backup writes. */
export async function atomicWriteFileAsync(path: string, content: AtomicWriteContent, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = tempPath(path);
  try {
    await writeFile(temp, content, { mode });
    await renameReplacing(temp, path);
  } catch (err) {
    try {
      await unlink(temp);
    } catch {
      // temp already moved or never created
    }
    throw err;
  }
}

/** Backwards-compatible string helper (existing callers). */
export function atomicWriteFile(path: string, content: string): void {
  atomicWriteFileSync(path, content);
}
