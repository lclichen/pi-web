import { writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file atomically: write to a temp file then rename over the target.
 * A crash or write failure never leaves a half-written file at `path`.
 * Creates parent directories as needed.
 */
export function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}
