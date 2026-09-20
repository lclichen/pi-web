/**
 * Pure utility functions for batch tasks — no session/rpc dependencies so
 * they are directly testable with node --experimental-strip-types.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Resolve the actual working directory: if the requested path already exists,
 * append -2, -3, ... until a fresh directory is available. Always creates the
 * directory. Trust must be done by the caller (needs agentDir context).
 */
export function prepareWorkDirPath(requested: string): string {
  let dir = resolve(requested);
  if (existsSync(dir)) {
    let suffix = 2;
    while (existsSync(`${requested}-${suffix}`)) suffix++;
    dir = resolve(`${requested}-${suffix}`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write inline files ({path: content}) into the workDir. Path traversal
 * is rejected (any path resolving outside workDir throws).
 */
export function materializeFiles(workDir: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const safe = resolve(workDir, relPath);
    if (!safe.startsWith(resolve(workDir))) {
      throw new Error(`File path escapes workDir: ${relPath}`);
    }
    const parent = join(safe, "..");
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(safe, content, "utf8");
  }
}

/**
 * Copy a file or directory tree from sourcePath into workDir (directory
 * contents land at workDir root, not in a subdirectory).
 */
export function copyPathPackage(workDir: string, sourcePath: string): void {
  const src = resolve(sourcePath);
  if (!existsSync(src)) throw new Error(`File package path not found: ${sourcePath}`);
  const stat = statSync(src);
  if (stat.isFile()) {
    copyFileSync(src, join(workDir, src.split("/").pop() ?? "package-file"));
    return;
  }
  if (!stat.isDirectory()) throw new Error(`File package path is neither file nor directory: ${sourcePath}`);
  copyDirRecursive(src, workDir);
}

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * Scan workDir for artifact files (depth ≤3, skipping dotfiles and
 * node_modules), returning relative paths + sizes. Capped at 100 entries.
 */
export function scanArtifacts(workDir: string): Array<{ path: string; size: number }> {
  const results: Array<{ path: string; size: number }> = [];
  try {
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const rel = full.slice(resolve(workDir).length + 1).replace(/\\/g, "/");
          results.push({ path: rel, size: statSync(full).size });
        }
      }
    };
    walk(workDir, 0);
  } catch {
    // best-effort
  }
  return results.slice(0, 100);
}
